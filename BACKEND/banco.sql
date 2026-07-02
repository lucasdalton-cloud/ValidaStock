-- ===================================================================
-- ValidaStock - Modelagem de Dados (PostgreSQL / pgAdmin 4)
-- 2 tabelas, seguindo os conceitos do documento de especificacao:
--   - Chave primaria auto-incremento (SERIAL)
--   - Chave estrangeira com integridade referencial (REFERENCES)
--   - Restricoes de dominio (CHECK) para o campo "perfil"
--   - Campos obrigatorios (NOT NULL) e valores padrao (DEFAULT)
--   - Tipos adequados para quantidade (DECIMAL) e datas (DATE)
-- ===================================================================
 
CREATE TABLE USUARIO (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    senha VARCHAR(255) NOT NULL,
    perfil VARCHAR(20)  NOT NULL DEFAULT 'OPERADOR' CHECK (perfil IN ('GERENTE', 'OPERADOR')),
    ativo BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
 
-- A tabela INSUMO concentra, de forma simplificada, os dados de
-- catalogo do insumo (RF02) e de lote/validade (RF03), permitindo
-- controlar estoque minimo (RF05) e bloqueio de vencidos (RF06)
-- usando apenas 2 tabelas no banco.

CREATE TABLE INSUMO (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(255) NOT NULL,
    unidade_medida VARCHAR(10) NOT NULL,
    codigo_lote VARCHAR(50) NOT NULL,
    quantidade_atual DECIMAL(10,2) NOT NULL DEFAULT 0,
    estoque_minimo DECIMAL(10,2) NOT NULL DEFAULT 0,
    data_fabricacao DATE NOT NULL,
    data_validade DATE NOT NULL,
    usuario_id INTEGER NOT NULL REFERENCES USUARIO(id) ON DELETE CASCADE,
    criado_em TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);