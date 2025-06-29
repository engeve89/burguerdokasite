import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { Pool } from 'pg';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import winston from 'winston';
import Redis from 'ioredis';
import { Worker } from 'worker_threads';

// Configuração de caminhos
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuração de logs
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// Inicialização do Express
const app = express();
const PORT = process.env.PORT || 3000;

// Configuração de middlewares
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cors());
app.use(helmet());
app.disable('x-powered-by');

// Configuração do Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Configuração do PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000
});

// Inicialização do Worker do WhatsApp
let whatsappWorker;
if (process.env.ENABLE_WHATSAPP === 'true') {
  whatsappWorker = new Worker(new URL('./workers/whatsapp-worker.js', import.meta.url));
  
  whatsappWorker.on('message', (message) => {
    logger.info(`WhatsApp Worker: ${message}`);
  });

  whatsappWorker.on('error', (error) => {
    logger.error(`WhatsApp Worker Error: ${error}`);
  });

  whatsappWorker.on('exit', (code) => {
    logger.warn(`WhatsApp Worker exited with code ${code}`);
  });
}

// Funções auxiliares
function normalizarTelefone(telefone) {
  if (typeof telefone !== 'string') return null;
  let limpo = telefone.replace(/\D/g, '');
  if (limpo.startsWith('55')) limpo = limpo.substring(2);
  return limpo.length >= 10 && limpo.length <= 11 ? `55${limpo}` : null;
}

function gerarCupomFiscal(pedido) {
  const { cliente, carrinho, pagamento, troco } = pedido;
  const subtotal = carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
  const taxaEntrega = 5.00;
  const total = subtotal + taxaEntrega;
  const now = new Date();

  const linhas = [
    '==================================================',
    `     Doka Burger - Pedido em ${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
    '==================================================',
    `👤 DADOS DO CLIENTE\nNome: ${cliente.nome}\nTelefone: ${cliente.telefone}\n`,
    `ITENS:`
  ];

  carrinho.forEach(item => {
    linhas.push(`• ${item.quantidade}x ${item.nome} - R$ ${(item.preco * item.quantidade).toFixed(2)}`);
    if (item.observacao) linhas.push(`  Obs: ${item.observacao}`);
  });

  linhas.push(
    '--------------------------------------------------',
    `Subtotal: R$ ${subtotal.toFixed(2)}`,
    `Taxa de Entrega: R$ ${taxaEntrega.toFixed(2)}`,
    `TOTAL: R$ ${total.toFixed(2)}`,
    '--------------------------------------------------',
    `ENDEREÇO:\n${cliente.endereco}`,
    cliente.referencia ? `Ref: ${cliente.referencia}` : '',
    '--------------------------------------------------',
    `FORMA DE PAGAMENTO: ${pagamento}`
  );

  if (pagamento === 'Dinheiro' && troco) {
    linhas.push(`Troco para: R$ ${troco}`);
  }

  linhas.push(
    '==================================================',
    'OBRIGADO PELA PREFERÊNCIA!'
  );

  return linhas.join('\n');
}

// Rotas
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({
      status: 'online',
      whatsapp: whatsappWorker ? 'active' : 'inactive',
      database: 'connected',
      redis: redis.status,
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(500).json({ status: 'degraded', error: error.message });
  }
});

app.post('/api/identificar-cliente', async (req, res) => {
  const telefone = normalizarTelefone(req.body.telefone);
  if (!telefone) {
    return res.status(400).json({ success: false, message: "Telefone inválido" });
  }

  try {
    const cliente = await redis.get(`cliente:${telefone}`) || 
                   await pool.query('SELECT * FROM clientes WHERE telefone = $1', [telefone])
                     .then(result => result.rows[0] || null);

    if (cliente) {
      await redis.setex(`cliente:${telefone}`, 3600, JSON.stringify(cliente));
      return res.json({ success: true, cliente });
    }

    res.json({ success: true, isNew: true });
  } catch (error) {
    logger.error(`Erro identificação: ${error}`);
    res.status(500).json({ success: false, message: "Erro interno" });
  }
});

app.post('/api/criar-pedido', async (req, res) => {
  const { cliente, carrinho } = req.body;
  
  if (!cliente || !carrinho?.length) {
    return res.status(400).json({ success: false, message: "Dados inválidos" });
  }

  try {
    // Processamento do pedido
    const cupom = gerarCupomFiscal(req.body);
    
    if (whatsappWorker) {
      whatsappWorker.postMessage({ 
        type: 'enviar-mensagem', 
        telefone: normalizarTelefone(cliente.telefone),
        mensagem: cupom
      });
    }

    res.json({ success: true, cupom });
  } catch (error) {
    logger.error(`Erro pedido: ${error}`);
    res.status(500).json({ success: false, message: "Erro ao processar pedido" });
  }
});

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname, '../../public')));

// Tratamento de erros
app.use((err, req, res, next) => {
  logger.error(`Erro não tratado: ${err.stack}`);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

// Inicialização do servidor
async function startServer() {
  try {
    // Criar índices se não existirem
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        telefone VARCHAR(20) PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        endereco TEXT NOT NULL,
        referencia TEXT,
        criado_em TIMESTAMP DEFAULT NOW()
      );
      
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY,
        cliente_telefone VARCHAR(20) REFERENCES clientes(telefone),
        dados_pedido JSONB NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      );
      
      CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON clientes(telefone);
    `);

    app.listen(PORT, () => {
      logger.info(`Servidor iniciado na porta ${PORT}`);
    });
  } catch (error) {
    logger.error(`Falha ao iniciar: ${error}`);
    process.exit(1);
  }
}

startServer();
