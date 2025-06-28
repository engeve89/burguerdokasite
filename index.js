const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const cors = require('cors');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Configuração de logs
const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`)
};

// Configuração do Express
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Middlewares de Segurança
app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      imgSrc: ["'self'", "data:", "https://engeve89.github.io", "https://images.unsplash.com"],
      fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  })
);

app.disable('x-powered-by');
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100, // Ajustado para um valor mais razoável para desenvolvimento/teste
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Muitas requisições. Por favor, tente novamente mais tarde." }
});

app.use('/api/', apiLimiter);

// Configuração do Pool de Conexões PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false 
  },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 5
});

// Função robusta para configuração do banco de dados
async function setupDatabase() {
  let clientDB;
  let retryCount = 0;
  const maxRetries = 3;

  while (retryCount < maxRetries) {
    try {
      clientDB = await pool.connect();
      
      // Verifica se a tabela existe
      const checkTable = await clientDB.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'clientes'
        );
      `);

      if (!checkTable.rows[0].exists) {
        // Cria a tabela se não existir
        await clientDB.query(`
          CREATE TABLE clientes (
            telefone VARCHAR(20) PRIMARY KEY,
            nome VARCHAR(255) NOT NULL,
            endereco TEXT NOT NULL,
            referencia TEXT,
            criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);
        logger.info('Tabela "clientes" criada com sucesso.');
      } else {
        logger.info('Tabela "clientes" já existe. Verificando estrutura...');
        
        // Verifica e adiciona colunas faltantes se necessário
        await clientDB.query(`
          DO $$
          BEGIN
            BEGIN
              ALTER TABLE clientes ADD COLUMN IF NOT EXISTS referencia TEXT;
            EXCEPTION WHEN duplicate_column THEN 
              RAISE NOTICE 'Coluna referencia já existe';
            END;
          END $$;
        `);
      }

      // Verifica conexões ativas
      const connections = await clientDB.query('SELECT COUNT(*) as active_connections FROM pg_stat_activity');
      logger.info(`Conexões ativas com o banco: ${connections.rows[0].active_connections}`);

      return; // Sucesso - sai do loop

    } catch (err) {
      retryCount++;
      logger.error(`Erro ao configurar banco (tentativa ${retryCount}/${maxRetries}):`, err);

      if (retryCount < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * retryCount)); // Backoff exponencial
      }
    } finally {
      if (clientDB) clientDB.release();
    }
  }

  throw new Error('Falha ao configurar o banco de dados após várias tentativas');
}

// Lógica do WhatsApp melhorada
let client;
let whatsappStatus = 'initializing';

function initializeWhatsApp() {
  logger.info('Inicializando cliente WhatsApp...');
  client = new Client({
    authStrategy: new LocalAuth({
      dataPath: './whatsapp-sessions' // Diretório dedicado para sessões
    }),
    puppeteer: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
  });

  client.on('qr', qr => {
    whatsappStatus = 'qr_pending';
    logger.info('Gerando QR Code...');
    qrcode.generate(qr, { small: true });
    const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    logger.info(`\nLink do QR Code (copie e cole no navegador):\n${qrLink}\n`);
  });

  client.on('authenticated', () => {
    whatsappStatus = 'authenticated';
    logger.info('Autenticação WhatsApp realizada com sucesso!');
  });

  client.on('ready', () => {
    whatsappStatus = 'ready';
    logger.info('✅ Cliente WhatsApp pronto para uso!');
  });

  client.on('auth_failure', msg => {
    whatsappStatus = 'auth_failed';
    logger.error(`Falha na autenticação: ${msg}`);
  });

  client.on('disconnected', (reason) => {
    whatsappStatus = 'disconnected';
    logger.error(`WhatsApp desconectado: ${reason}. Tentando reconectar em 20s...`);
    setTimeout(initializeWhatsApp, 20000);
  });

  client.initialize().catch(err => {
    logger.error(`Falha na inicialização: ${err}`);
    setTimeout(initializeWhatsApp, 30000);
  });
}

// Funções auxiliares
function normalizarTelefone(telefone) {
  if (typeof telefone !== 'string') return null;
  let limpo = telefone.replace(/\D/g, '');
  if (limpo.startsWith('55')) limpo = limpo.substring(2);
  if (limpo.length < 10 || limpo.length > 11) return null;
  const ddd = limpo.substring(0, 2);
  let numeroBase = limpo.substring(2);
  if (numeroBase.length === 9 && numeroBase.startsWith('9')) {
    numeroBase = numeroBase.substring(1);
  }
  if (numeroBase.length !== 8) return null;
  return `55${ddd}${numeroBase}`;
}


// ==================================================================
// FUNÇÃO ALTERADA
// ==================================================================
function gerarCupomFiscal(pedido) {
    const { cliente, carrinho, pagamento, troco } = pedido;
    const subtotal = carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
    const taxaEntrega = 5.00;
    const total = subtotal + taxaEntrega;
    const now = new Date();

    // Define as opções de formatação, especificando o fuso horário de São Paulo
    const options = {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    };

    // Cria uma string de data e hora formatada para o Brasil
    const formatter = new Intl.DateTimeFormat('pt-BR', options);
    const dataHoraLocal = formatter.format(now);

    // Separa a data e a hora para usar no cupom
    const [dataLocal, horaLocal] = dataHoraLocal.split(', ');

    let cupom = `==================================================\n`;
    cupom += `     Doka Burger - Pedido em ${dataLocal} às ${horaLocal.substring(0, 5)}\n`;
    cupom += `==================================================\n`;
    cupom += `👤 *DADOS DO CLIENTE*\nNome: ${cliente.nome}\nTelefone: ${cliente.telefoneFormatado}\n\n`;
    cupom += `*ITENS:*\n`;
    
    carrinho.forEach(item => {
        const nomeFormatado = item.nome.padEnd(25, ' ');
        const precoFormatado = `R$ ${(item.preco * item.quantidade).toFixed(2).replace('.', ',')}`;
        cupom += `• ${item.quantidade}x ${nomeFormatado} ${precoFormatado}\n`;
        if (item.observacao) cupom += `  Obs: ${item.observacao}\n`;
    });
    
    cupom += `--------------------------------------------------\n`;
    cupom += `Subtotal:         R$ ${subtotal.toFixed(2).replace('.', ',')}\n`;
    cupom += `Taxa de Entrega:  R$ ${taxaEntrega.toFixed(2).replace('.', ',')}\n`;
    cupom += `*TOTAL:* *R$ ${total.toFixed(2).replace('.', ',')}*\n`;
    cupom += `--------------------------------------------------\n`;
    cupom += `*ENDEREÇO:*\n${cliente.endereco}\n`;
    if (cliente.referencia) cupom += `Ref: ${cliente.referencia}\n`;
    cupom += `--------------------------------------------------\n`;
    cupom += `*FORMA DE PAGAMENTO:*\n${pagamento}\n`;
    if (pagamento === 'Dinheiro' && troco) {
        cupom += `Troco para: R$ ${troco}\n`;
    }
    cupom += `==================================================\n`;
    cupom += `              OBRIGADO PELA PREFERÊNCIA!`;
    
    return cupom;
}
// ==================================================================
// FIM DA FUNÇÃO ALTERADA
// ==================================================================


// Rotas da API
app.get('/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      whatsapp: whatsappStatus,
      database: dbCheck ? 'connected' : 'disconnected',
      uptime: process.uptime()
    });
  } catch (err) {
    res.status(500).json({
      status: 'unhealthy',
      error: err.message
    });
  }
});

app.post('/api/identificar-cliente', async (req, res) => {
  if (whatsappStatus !== 'ready') {
    return res.status(503).json({ 
      success: false, 
      message: "Servidor de WhatsApp iniciando. Tente em instantes." 
    });
  }
  
  const { telefone } = req.body;
  const telefoneNormalizado = normalizarTelefone(telefone);

  if (!telefoneNormalizado) {
    return res.status(400).json({ 
      success: false, 
      message: "Formato de número de telefone inválido." 
    });
  }
  
  let clientDB;
  try {
    const numeroParaApi = `${telefoneNormalizado}@c.us`;
    const isRegistered = await client.isRegisteredUser(numeroParaApi);
    
    if (!isRegistered) {
      return res.status(400).json({ 
        success: false, 
        message: "Este número não possui uma conta de WhatsApp ativa." 
      });
    }
    
    clientDB = await pool.connect();
    const result = await clientDB.query(
      'SELECT * FROM clientes WHERE telefone = $1', 
      [telefoneNormalizado]
    );
    
    if (result.rows.length > 0) {
      const clienteEncontrado = result.rows[0];
      logger.info(`Cliente encontrado: ${clienteEncontrado.nome}`);
      res.json({ 
        success: true, 
        isNew: false, 
        cliente: clienteEncontrado 
      });
    } else {
      logger.info(`Novo cliente: ${telefoneNormalizado}`);
      res.json({ 
        success: true, 
        isNew: true, 
        cliente: { telefone: telefoneNormalizado } 
      });
    }
  } catch (error) {
    logger.error(`Erro na identificação: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: "Erro interno no servidor." 
    });
  } finally {
    if (clientDB) clientDB.release();
  }
});

app.post('/api/criar-pedido', async (req, res) => {
  if (whatsappStatus !== 'ready') {
    return res.status(503).json({ 
      success: false, 
      message: "Servidor de WhatsApp iniciando. Tente em instantes." 
    });
  }
  
  const pedido = req.body;
  const cliente = pedido.cliente;
  const telefoneNormalizado = normalizarTelefone(cliente.telefoneFormatado);

  if (!telefoneNormalizado || !cliente || !Array.isArray(pedido.carrinho) || 
      pedido.carrinho.length === 0 || !pedido.pagamento) {
    return res.status(400).json({ 
      success: false, 
      message: "Dados do pedido inválidos." 
    });
  }
  
  const numeroCliente = `${telefoneNormalizado}@c.us`;
  let clientDB;
  
  try {
    clientDB = await pool.connect();
    
    // Verifica e insere/atualiza cliente
    await clientDB.query(`
        INSERT INTO clientes (telefone, nome, endereco, referencia) 
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (telefone) 
        DO UPDATE SET 
            nome = EXCLUDED.nome, 
            endereco = EXCLUDED.endereco, 
            referencia = EXCLUDED.referencia;
    `, [telefoneNormalizado, cliente.nome, cliente.endereco, cliente.referencia]);
    logger.info(`Cliente cadastrado/atualizado: ${cliente.nome}`);

    // Envia cupom fiscal
    const cupom = gerarCupomFiscal(pedido);
    await client.sendMessage(numeroCliente, cupom);
    logger.info(`Cupom enviado para ${numeroCliente}`);
    
    // Mensagens automáticas
    setTimeout(async () => {
      try {
        await client.sendMessage(
          numeroCliente,
          `✅ PEDIDO CONFIRMADO! 🚀\nSeu pedido está sendo preparado! 😋️🍔\n\n⏱ *Tempo estimado:* 40-50 minutos\n📱 *Avisaremos quando sair para entrega!`
        );
      } catch (err) {
        logger.error(`Erro ao enviar confirmação: ${err.message}`);
      }
    }, 30000);

    setTimeout(async () => {
      try {
        await client.sendMessage(
          numeroCliente,
          `🛵 *SEU PEDIDO ESTÁ A CAMINHO!* 🔔\nChegará em 10-15 minutos!\n\n_Se já recebeu, ignore esta mensagem._`
        );
      } catch (err) {
        logger.error(`Erro ao enviar aviso de entrega: ${err.message}`);
      }
    }, 1800000);

    res.status(200).json({ success: true });
    
  } catch (error) {
    logger.error(`Erro no pedido: ${error.message}`);
    res.status(500).json({ 
      success: false, 
      message: "Falha ao processar o pedido." 
    });
  } finally {
    if (clientDB) clientDB.release();
  }
});

// Rota principal
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Tratamento de erros
app.use((err, req, res, next) => {
  logger.error(`Erro não tratado: ${err.stack}`);
  res.status(500).json({ 
    success: false, 
    message: "Ocorreu um erro inesperado no servidor." 
  });
});

// Inicialização do servidor
async function startServer() {
  try {
    await setupDatabase();
    initializeWhatsApp();
    
    app.listen(PORT, () => {
      logger.info(`🚀 Servidor rodando na porta ${PORT}`);
      logger.info(`🔗 Acesse: http://localhost:${PORT}`);
    });
    
  } catch (err) {
    logger.error('Falha ao iniciar o servidor:', err);
    process.exit(1);
  }
}

startServer();
