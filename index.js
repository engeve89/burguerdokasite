// ==================================================
// Configurações Iniciais e Importações
// ==================================================
require('dotenv').config(); // Carrega variáveis do .env
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js'); // Autenticação melhorada
const fs = require('fs');
const cors = require('cors');
const { Pool } = require('pg'); // PostgreSQL para Railway
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// ==================================================
// Configuração de Logs (Melhorada para Railway)
// ==================================================
const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`)
};

// ==================================================
// Configuração do Express
// ==================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy para HTTPS no Railway
app.set('trust proxy', 1); 

// Middlewares
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://*"],
      connectSrc: ["'self'"],
    }
  }
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*', // Restrinja em produção!
  methods: ['GET', 'POST']
}));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter (Proteção contra DDoS)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // Limite por IP
  message: { 
    success: false, 
    message: "Muitas requisições. Tente novamente mais tarde." 
  }
});
app.use('/api/', apiLimiter);

// ==================================================
// Banco de Dados PostgreSQL (Railway)
// ==================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necessário para Railway
  },
  connectionTimeoutMillis: 5000
});

// Cria tabelas se não existirem
async function setupDatabase() {
  const clientDB = await pool.connect();
  try {
    await clientDB.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        telefone VARCHAR(20) PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        endereco TEXT NOT NULL,
        referencia TEXT,
        criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await clientDB.query(`
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        cliente_telefone VARCHAR(20) NOT NULL REFERENCES clientes(telefone),
        dados_pedido JSONB NOT NULL,
        mensagem_confirmacao_enviada BOOLEAN DEFAULT false,
        mensagem_entrega_enviada BOOLEAN DEFAULT false,
        criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    logger.info('✅ Banco de dados configurado');
  } catch (err) {
    logger.error(`❌ Erro no banco de dados: ${err}`);
  } finally {
    clientDB.release();
  }
}

// ==================================================
// WhatsApp Web Client (Configuração para Railway)
// ==================================================
const client = new Client({
  authStrategy: new LocalAuth({ 
    dataPath: '/tmp/.wwebjs_auth' // Armazenamento temporário
  }),
  puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process'
    ],
    headless: true
  }
});

// Eventos do WhatsApp
client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  logger.info('QR Code gerado. Escaneie no WhatsApp.');
});

client.on('authenticated', () => {
  logger.info('✅ Autenticado no WhatsApp');
});

client.on('ready', () => {
  logger.info('🚀 Cliente WhatsApp pronto');
});

client.on('disconnected', (reason) => {
  logger.error(`❌ WhatsApp desconectado: ${reason}`);
  // Reconecta automaticamente
  setTimeout(() => client.initialize(), 5000);
});

// Inicializa o cliente
client.initialize().catch(err => {
  logger.error(`❌ Falha ao iniciar WhatsApp: ${err}`);
  process.exit(1); // Encerra o app se falhar
});

// ==================================================
// Funções Auxiliares
// ==================================================
function normalizarTelefone(telefone) {
  if (!telefone) return null;
  const limpo = telefone.replace(/\D/g, '');
  if (limpo.startsWith('55')) return limpo;
  return `55${limpo}`;
}

function gerarCupomFiscal(pedido) {
  // ... (mantenha sua função existente)
}

// ==================================================
// Rotas da API
// ==================================================

// Health Check (Obrigatório para Railway)
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    whatsapp: client.info ? 'Conectado' : 'Desconectado',
    database: pool.totalCount > 0 ? 'Conectado' : 'Erro',
    uptime: process.uptime()
  });
});

// Identificação do Cliente
app.post('/api/identificar-cliente', async (req, res) => {
  const { telefone } = req.body;
  const telefoneNormalizado = normalizarTelefone(telefone);

  if (!telefoneNormalizado || telefoneNormalizado.length < 12) {
    return res.status(400).json({ 
      success: false, 
      message: "Telefone inválido. Use DDD + número (ex: 11999999999)." 
    });
  }

  try {
    const numeroApi = `${telefoneNormalizado}@c.us`;
    const isRegistered = await client.isRegisteredUser(numeroApi);
    
    if (!isRegistered) {
      return res.status(400).json({ 
        success: false, 
        message: "Número não registrado no WhatsApp." 
      });
    }

    const clientDB = await pool.connect();
    const result = await clientDB.query(
      'SELECT * FROM clientes WHERE telefone = $1', 
      [telefoneNormalizado]
    );

    if (result.rows.length > 0) {
      res.json({ 
        success: true, 
        isNew: false, 
        cliente: result.rows[0] 
      });
    } else {
      res.json({ 
        success: true, 
        isNew: true, 
        cliente: { telefone: telefoneNormalizado } 
      });
    }
  } catch (error) {
    logger.error(`Erro ao identificar cliente: ${error}`);
    res.status(500).json({ 
      success: false, 
      message: "Erro interno no servidor." 
    });
  }
});

// Criar Pedido
app.post('/api/criar-pedido', async (req, res) => {
  const pedido = req.body;
  
  // Validação básica
  if (!pedido.cliente || !pedido.carrinho?.length) {
    return res.status(400).json({ 
      success: false, 
      message: "Dados do pedido inválidos." 
    });
  }

  try {
    const clientDB = await pool.connect();
    
    // Salva/Atualiza cliente
    await clientDB.query(
      `INSERT INTO clientes (telefone, nome, endereco, referencia) 
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telefone) DO UPDATE 
       SET nome = $2, endereco = $3, referencia = $4`,
      [
        normalizarTelefone(pedido.cliente.telefone),
        pedido.cliente.nome,
        pedido.cliente.endereco,
        pedido.cliente.referencia || null
      ]
    );

    // Salva pedido
    const result = await clientDB.query(
      `INSERT INTO pedidos (cliente_telefone, dados_pedido) 
       VALUES ($1, $2) 
       RETURNING id`,
      [
        normalizarTelefone(pedido.cliente.telefone),
        JSON.stringify(pedido)
      ]
    );

    // Envia mensagem via WhatsApp
    const cupom = gerarCupomFiscal(pedido);
    await client.sendMessage(
      `${normalizarTelefone(pedido.cliente.telefone)}@c.us`,
      cupom
    );

    res.json({ 
      success: true, 
      pedidoId: result.rows[0].id 
    });

  } catch (error) {
    logger.error(`Erro ao criar pedido: ${error}`);
    res.status(500).json({ 
      success: false, 
      message: "Falha ao processar pedido." 
    });
  }
});

// Histórico de Pedidos
app.get('/api/historico/:telefone', async (req, res) => {
  const telefone = normalizarTelefone(req.params.telefone);
  
  if (!telefone) {
    return res.status(400).json([]);
  }

  try {
    const clientDB = await pool.connect();
    const result = await clientDB.query(
      `SELECT id, dados_pedido, criado_em 
       FROM pedidos 
       WHERE cliente_telefone = $1 
       ORDER BY criado_em DESC`,
      [telefone]
    );

    const historico = result.rows.map(row => ({
      id: row.id,
      data: row.criado_em,
      itens: row.dados_pedido.carrinho,
      total: row.dados_pedido.carrinho.reduce(
        (sum, item) => sum + (item.preco * item.quantidade), 0) + 5
    }));

    res.json(historico);
  } catch (error) {
    logger.error(`Erro ao buscar histórico: ${error}`);
    res.status(500).json([]);
  }
});

// Rota para o frontend (React/Vue/etc)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================================================
// Inicialização do Servidor
// ==================================================
async function startServer() {
  await setupDatabase();
  
  app.listen(PORT, () => {
    logger.info(`Servidor rodando na porta ${PORT}`);
    logger.info(`Modo: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer().catch(err => {
  logger.error(`Falha ao iniciar servidor: ${err}`);
  process.exit(1);
});
