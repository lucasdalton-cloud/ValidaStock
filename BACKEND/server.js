import Fastify from 'fastify'
import cors from '@fastify/cors'
import { Pool } from 'pg'

// =====================================================================
// CONFIG — conexao com o PostgreSQL (fonte unica de Pool)
// =====================================================================
const pool = new Pool({
    user: 'postgres',
    password: 'senai',
    host: 'localhost',
    port: 5432,
    database: 'validastock'
})

// =====================================================================
// ERROR — erro de negocio com status HTTP, usado pelos services
// =====================================================================
class AppError extends Error {
    constructor(mensagem, status = 400) {
        super(mensagem)
        this.status = status
    }
}

// =====================================================================
// SERVICES — regras de negocio (RF/RN do documento) + acesso ao banco.
// =====================================================================
const PERFIS_VALIDOS = ['GERENTE', 'OPERADOR']

class UsuarioService {
    async listar() {
        const resultado = await pool.query(
            'SELECT id, nome, email, perfil, ativo, criado_em FROM usuario ORDER BY id'
        )
        return resultado.rows
    }

    async cadastrar({ nome, email, senha, perfil }) {
        if (!nome || !email || !senha) {
            throw new AppError('Nome, email e senha sao obrigatorios!', 400)
        }

        const perfilFinal = perfil ?? 'OPERADOR'
        if (!PERFIS_VALIDOS.includes(perfilFinal)) {
            throw new AppError(`Perfil invalido! Use: ${PERFIS_VALIDOS.join(' ou ')}`, 400)
        }

        const existente = await pool.query('SELECT id FROM usuario WHERE email = $1', [email])
        if (existente.rows.length > 0) {
            throw new AppError('Ja existe um usuario cadastrado com esse email!', 409)
        }

        const resultado = await pool.query(
            `INSERT INTO usuario (nome, email, senha, perfil)
             VALUES ($1, $2, $3, $4)
             RETURNING id, nome, email, perfil, ativo, criado_em`,
            [nome, email, senha, perfilFinal]
        )
        return resultado.rows[0]
    }

    async atualizar(id, { nome, email, senha, perfil }) {
        if (!nome || !email || !senha) {
            throw new AppError('Nome, email e senha sao obrigatorios!', 400)
        }

        const perfilFinal = perfil ?? 'OPERADOR'
        if (!PERFIS_VALIDOS.includes(perfilFinal)) {
            throw new AppError(`Perfil invalido! Use: ${PERFIS_VALIDOS.join(' ou ')}`, 400)
        }

        const usuario = await pool.query('SELECT id FROM usuario WHERE id = $1', [id])
        if (usuario.rows.length === 0) {
            throw new AppError('Usuario nao encontrado!', 404)
        }

        const resultado = await pool.query(
            `UPDATE usuario
             SET nome = $1, email = $2, senha = $3, perfil = $4
             WHERE id = $5
             RETURNING id, nome, email, perfil, ativo, criado_em`,
            [nome, email, senha, perfilFinal, id]
        )
        return resultado.rows[0]
    }

    async excluir(id) {
        const usuario = await pool.query('SELECT id FROM usuario WHERE id = $1', [id])
        if (usuario.rows.length === 0) {
            throw new AppError('Usuario nao encontrado!', 404)
        }
        await pool.query('DELETE FROM usuario WHERE id = $1', [id])
    }

    async login({ email, senha }) {
        if (!email || !senha) {
            throw new AppError('Email e senha sao obrigatorios!', 400)
        }

        const resultado = await pool.query(
            'SELECT id, nome, email, perfil FROM usuario WHERE email = $1 AND senha = $2',
            [email, senha]
        )
        if (resultado.rows.length === 0) {
            throw new AppError('Usuario ou senha invalidos!', 401)
        }

        return resultado.rows[0]
    }
}

const DIAS_ALERTA_VALIDADE = 7 // RN-001: alerta preventivo de vencimento

class InsumoService {
    async listar() {
        const resultado = await pool.query('SELECT * FROM insumo ORDER BY data_validade ASC')
        return resultado.rows.map((insumo) => this.#adicionarStatus(insumo))
    }

    async buscarPorId(id) {
        const insumo = await this.#buscarOuFalhar(id)
        return this.#adicionarStatus(insumo)
    }

    async cadastrar(dados) {
        this.#validarCamposObrigatorios(dados)
        this.#validarDatas(dados.dataFabricacao, dados.dataValidade)

        const { nome, unidadeMedida, codigoLote, quantidadeAtual, estoqueMinimo, dataFabricacao, dataValidade, usuarioId } = dados
        const resultado = await pool.query(
            `INSERT INTO insumo
                (nome, unidade_medida, codigo_lote, quantidade_atual, estoque_minimo, data_fabricacao, data_validade, usuario_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [nome, unidadeMedida, codigoLote, quantidadeAtual, estoqueMinimo, dataFabricacao, dataValidade, usuarioId]
        )
        return resultado.rows[0]
    }

    async atualizar(id, dados) {
        this.#validarCamposObrigatorios(dados)
        this.#validarDatas(dados.dataFabricacao, dados.dataValidade)
        await this.#buscarOuFalhar(id)

        const { nome, unidadeMedida, codigoLote, quantidadeAtual, estoqueMinimo, dataFabricacao, dataValidade } = dados
        const resultado = await pool.query(
            `UPDATE insumo
             SET nome = $1, unidade_medida = $2, codigo_lote = $3, quantidade_atual = $4,
                 estoque_minimo = $5, data_fabricacao = $6, data_validade = $7
             WHERE id = $8
             RETURNING *`,
            [nome, unidadeMedida, codigoLote, quantidadeAtual, estoqueMinimo, dataFabricacao, dataValidade, id]
        )
        return resultado.rows[0]
    }

    async excluir(id) {
        await this.#buscarOuFalhar(id)
        await pool.query('DELETE FROM insumo WHERE id = $1', [id])
    }

    // RF04 + RF06: baixa de estoque (consumo/descarte) com bloqueio
    // automatico de lotes vencidos (RN-002).
    async registrarSaida(id, quantidade) {
        if (!quantidade || quantidade <= 0) {
            throw new AppError('Quantidade deve ser maior que zero!', 400)
        }

        const insumo = await this.#buscarOuFalhar(id)

        if (this.#estaVencido(insumo.data_validade)) {
            throw new AppError('Bloqueado: este lote esta vencido e nao pode ser consumido!', 422)
        }

        const quantidadeAtual = Number(insumo.quantidade_atual)
        if (quantidade > quantidadeAtual) {
            throw new AppError('Quantidade insuficiente em estoque!', 422)
        }

        const novaQuantidade = quantidadeAtual - quantidade
        const resultado = await pool.query(
            'UPDATE insumo SET quantidade_atual = $1 WHERE id = $2 RETURNING *',
            [novaQuantidade, id]
        )
        return resultado.rows[0]
    }

    // RF05: alertas de validade critica e estoque baixo.
    async listarAlertas() {
        const resultado = await pool.query(
            `SELECT * FROM insumo
             WHERE data_validade <= (CURRENT_DATE + INTERVAL '7 days')
                OR quantidade_atual <= estoque_minimo
             ORDER BY data_validade ASC`
        )
        return resultado.rows.map((insumo) => this.#adicionarStatus(insumo))
    }

    async #buscarOuFalhar(id) {
        const resultado = await pool.query('SELECT * FROM insumo WHERE id = $1', [id])
        if (resultado.rows.length === 0) {
            throw new AppError('Insumo nao encontrado!', 404)
        }
        return resultado.rows[0]
    }

    #validarCamposObrigatorios({ nome, unidadeMedida, codigoLote, quantidadeAtual, estoqueMinimo, dataFabricacao, dataValidade, usuarioId }) {
        if (!nome || !unidadeMedida || !codigoLote || !dataFabricacao || !dataValidade || !usuarioId) {
            throw new AppError(
                'Nome, unidade de medida, codigo do lote, data de fabricacao, data de validade e usuario sao obrigatorios!',
                400
            )
        }
        if (quantidadeAtual == null || quantidadeAtual < 0) {
            throw new AppError('Quantidade atual invalida!', 400)
        }
        if (estoqueMinimo == null || estoqueMinimo < 0) {
            throw new AppError('Estoque minimo invalido!', 400)
        }
    }

    #validarDatas(dataFabricacao, dataValidade) {
        if (new Date(dataValidade) < new Date(dataFabricacao)) {
            throw new AppError('Data de validade nao pode ser anterior a data de fabricacao!', 400)
        }
    }

    #estaVencido(dataValidade) {
        return new Date(dataValidade) < new Date(new Date().toDateString())
    }

    #adicionarStatus(insumo) {
        const hoje = new Date(new Date().toDateString())
        const validade = new Date(insumo.data_validade)
        const diasParaVencer = Math.ceil((validade - hoje) / (1000 * 60 * 60 * 24))

        return {
            ...insumo,
            vencido: diasParaVencer < 0,
            validade_critica: diasParaVencer >= 0 && diasParaVencer <= DIAS_ALERTA_VALIDADE,
            estoque_baixo: Number(insumo.quantidade_atual) <= Number(insumo.estoque_minimo)
        }
    }
}

// =====================================================================
// CONTROLLERS — traduzem HTTP <-> Service. Sem SQL, sem regra de negocio.
// =====================================================================
class UsuarioController {
    constructor(usuarioService) {
        this.usuarioService = usuarioService
    }

    listar = async (request, reply) => {
        const usuarios = await this.usuarioService.listar()
        return reply.status(200).send(usuarios)
    }

    cadastrar = async (request, reply) => {
        const usuario = await this.usuarioService.cadastrar(request.body ?? {})
        return reply.status(201).send({ message: 'Usuario criado!', usuario })
    }

    atualizar = async (request, reply) => {
        const { id } = request.params
        const usuario = await this.usuarioService.atualizar(id, request.body ?? {})
        return reply.status(200).send({ message: `Usuario ${usuario.nome} alterado!`, usuario })
    }

    excluir = async (request, reply) => {
        const { id } = request.params
        await this.usuarioService.excluir(id)
        return reply.status(200).send({ message: 'Usuario deletado!' })
    }

    login = async (request, reply) => {
        const usuario = await this.usuarioService.login(request.body ?? {})
        return reply.status(200).send({ message: 'Usuario logado!', login: true, usuario })
    }
}

class InsumoController {
    constructor(insumoService) {
        this.insumoService = insumoService
    }

    listar = async (request, reply) => {
        const insumos = await this.insumoService.listar()
        return reply.status(200).send(insumos)
    }

    buscarPorId = async (request, reply) => {
        const { id } = request.params
        const insumo = await this.insumoService.buscarPorId(id)
        return reply.status(200).send(insumo)
    }

    cadastrar = async (request, reply) => {
        const dados = this.#mapearCorpo(request.body)
        const insumo = await this.insumoService.cadastrar(dados)
        return reply.status(201).send({ message: 'Insumo cadastrado!', insumo })
    }

    atualizar = async (request, reply) => {
        const { id } = request.params
        const dados = this.#mapearCorpo(request.body)
        const insumo = await this.insumoService.atualizar(id, dados)
        return reply.status(200).send({ message: 'Insumo atualizado!', insumo })
    }

    excluir = async (request, reply) => {
        const { id } = request.params
        await this.insumoService.excluir(id)
        return reply.status(200).send({ message: 'Insumo deletado!' })
    }

    registrarSaida = async (request, reply) => {
        const { id } = request.params
        const { quantidade } = request.body ?? {}
        const insumo = await this.insumoService.registrarSaida(id, Number(quantidade))
        return reply.status(200).send({ message: 'Baixa registrada!', insumo })
    }

    listarAlertas = async (request, reply) => {
        const alertas = await this.insumoService.listarAlertas()
        return reply.status(200).send(alertas)
    }

    #mapearCorpo(body = {}) {
        return {
            nome: body.nome,
            unidadeMedida: body.unidade_medida,
            codigoLote: body.codigo_lote,
            quantidadeAtual: body.quantidade_atual,
            estoqueMinimo: body.estoque_minimo,
            dataFabricacao: body.data_fabricacao,
            dataValidade: body.data_validade,
            usuarioId: body.usuario_id
        }
    }
}

// =====================================================================
// COMPOSITION ROOT — injeta as dependencias (service -> controller) e
// registra as rotas no Fastify.
// =====================================================================
const servidor = Fastify()

await servidor.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
})

const usuarioController = new UsuarioController(new UsuarioService())
const insumoController = new InsumoController(new InsumoService())

// Rotas de usuario
servidor.get('/usuarios', usuarioController.listar)
servidor.post('/usuarios', usuarioController.cadastrar)
servidor.put('/usuarios/:id', usuarioController.atualizar)
servidor.delete('/usuarios/:id', usuarioController.excluir)
servidor.post('/login', usuarioController.login)

// Rotas de insumo (alertas antes de :id para nao ser capturada como id)
servidor.get('/insumos', insumoController.listar)
servidor.get('/insumos/alertas', insumoController.listarAlertas)
servidor.get('/insumos/:id', insumoController.buscarPorId)
servidor.post('/insumos', insumoController.cadastrar)
servidor.put('/insumos/:id', insumoController.atualizar)
servidor.delete('/insumos/:id', insumoController.excluir)
servidor.post('/insumos/:id/saida', insumoController.registrarSaida)

// Tratamento de erro centralizado: erros de negocio (AppError) viram a
// resposta HTTP correta, erros inesperados viram 500.
servidor.setErrorHandler((erro, request, reply) => {
    if (erro instanceof AppError) {
        return reply.status(erro.status).send({ message: erro.message })
    }
    console.error(erro)
    return reply.status(500).send({ message: 'Erro interno no servidor!' })
})

servidor.listen({ port: 3000 })
    .then(() => console.log('ValidaStock rodando em http://localhost:3000'))
    .catch((erro) => {
        console.error(erro)
        process.exit(1)
    })