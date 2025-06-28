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

// Variáveis de estado para saúde do serviço
let isDbReady = false;
let whatsappStatus = 'initializing';

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
  max: 100,
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

// FUNÇÃO DE BANCO DE DADOS ATUALIZADA COM LOGS DE ERRO DETALHADOS E CONTROLE DE ESTADO
async function setupDatabase() {
    let clientDB;
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
        try {
            clientDB = await pool.connect();
            
            const checkTable = await clientDB.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' AND table_name = 'clientes'
                );
            `);

            if (!checkTable.rows[0].exists) {
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
                logger.info('Tabela "clientes" já existe.');
            }
            logger.info('✅ Conexão com o banco de dados estabelecida com sucesso!');
            isDbReady = true; // ATUALIZA O ESTADO GLOBAL
            return;
        } catch (err) {
            retryCount++;
            logger.error(`Erro ao configurar banco (tentativa ${retryCount}/${maxRetries}): ${err.message}`);
            console.error('Detalhes completos do erro de conexão:', err);
            
            if (retryCount < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
            } else {
                 throw new Error('Falha ao configurar o banco de dados após várias tentativas');
            }
        } finally {
            if (clientDB) clientDB.release();
        }
    }
}

// Lógica do WhatsApp estável e com reconexão automática
let client;
let isInitializing = false;

async function initializeWhatsApp() {
    if (isInitializing) {
        logger.info('Inicialização do WhatsApp já em andamento. Aguardando...');
        return;
    }
    isInitializing = true;
    whatsappStatus = 'initializing';
    logger.info('Iniciando processo de inicialização do WhatsApp...');

    try {
        if (client) {
            await client.destroy();
            client = null;
        }

        client = new Client({
            authStrategy: new LocalAuth({ dataPath: './whatsapp-sessions' }),
            puppeteer: {
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu'],
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

        client.on('ready', () => {
            whatsappStatus = 'ready';
            logger.info('✅ Cliente WhatsApp pronto para uso!');
        });

        client.on('disconnected', (reason) => {
            whatsappStatus = 'disconnected';
            logger.error(`WhatsApp desconectado: ${reason}. Tentando reconectar...`);
            setTimeout(initializeWhatsApp, 20000);
        });

        await client.initialize();
    } catch (err) {
        logger.error(`Falha grave durante a inicialização do WhatsApp: ${err}`);
        setTimeout(initializeWhatsApp, 30000);
    } finally {
        isInitializing = false;
    }
}

// Funções auxiliares
function normalizarTelefone(telefone) {
  if (typeof telefone !== 'string') return null;
  let limpo = telefone.replace(/\D/g, '');
  if (limpo.startsWith('55')) limpo = limpo.substring(2);
  if (limpo.length < 10 || limpo.length > 11) return null;
  return `55${limpo}`;
}

function gerarCupomFiscal(pedido) {
    const { cliente, carrinho, pagamento, troco } = pedido;
    const subtotal = carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
    const taxaEntrega = 5.00;
    const total = subtotal + taxaEntrega;
    const now = new Date();
    const options = { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
    const formatter = new Intl.DateTimeFormat('pt-BR', options);
    const [dataLocal, horaLocal] = formatter.format(now).split(', ');

    let cupom = `================================\n`;
    cupom += `      Doka Burger - Pedido\n`;
    cupom += `   ${dataLocal} às ${horaLocal}\n`;
    cupom += `================================\n`;
    cupom += `👤 *DADOS DO CLIENTE*\nNome: ${cliente.nome}\nTelefone: ${cliente.telefoneFormatado}\n\n`;
    cupom += `*ITENS DO PEDIDO:*\n`;
    carrinho.forEach(item => {
        const nomeFormatado = item.nome.padEnd(20, ' ');
        const precoFormatado = `R$ ${(item.preco * item.quantidade).toFixed(2).replace('.', ',')}`;
        cupom += `• ${item.quantidade}x ${nomeFormatado} ${precoFormatado}\n`;
        if (item.observacao) cupom += `  Obs: ${item.observacao}\n`;
    });
    cupom += `------------------------------------------------\n`;
    cupom += `Subtotal:      R$ ${subtotal.toFixed(2).replace('.', ',')}\n`;
    cupom += `Taxa de Entrega: R$ ${taxaEntrega.toFixed(2).replace('.', ',')}\n`;
    cupom += `*TOTAL:* *R$ ${total.toFixed(2).replace('.', ',')}*\n`;
    cupom += `------------------------------------------------\n`;
    cupom += `*ENDEREÇO DE ENTREGA:*\n${cliente.endereco}\n`;
    if (cliente.referencia) cupom += `Ref: ${cliente.referencia}\n`;
    cupom += `------------------------------------------------\n`;
    cupom += `*FORMA DE PAGAMENTO:*\n${pagamento}\n`;
    if (pagamento === 'Dinheiro' && troco) {
        cupom += `Troco para: R$ ${troco}\n`;
    }
    cupom += `================================\n`;
    cupom += `      OBRIGADO PELA PREFERÊNCIA!`;
    return cupom;
}

// Rotas da API
app.get('/health', (req, res) => {
    const dbStatus = isDbReady ? 'connected' : 'connecting_or_failed';
    res.json({
        status: isDbReady && whatsappStatus === 'ready' ? 'healthy' : 'degraded',
        whatsapp: whatsappStatus,
        database: dbStatus,
        uptime: process.uptime()
    });
});

// Middleware para checar a prontidão dos serviços nas rotas críticas
function checkServicesReady(req, res, next) {
    if (!isDbReady) {
        return res.status(503).json({ success: false, message: "Serviço indisponível, o banco de dados não está conectado. Tente novamente em instantes." });
    }
    if (whatsappStatus !== 'ready') {
        return res.status(503).json({ success: false, message: "Serviço indisponível, o WhatsApp não está conectado. Tente novamente em instantes." });
    }
    next();
}

app.post('/api/identificar-cliente', checkServicesReady, async (req, res) => {
  const { telefone } = req.body;
  const telefoneNormalizado = normalizarTelefone(telefone);

  if (!telefoneNormalizado) {
    return res.status(400).json({ success: false, message: "Formato de número de telefone inválido." });
  }
  
  let clientDB;
  try {
    const numeroParaApi = `${telefoneNormalizado}@c.us`;
    const isRegistered = await client.isRegisteredUser(numeroParaApi);
    
    if (!isRegistered) {
      return res.status(400).json({ success: false, message: "Este número não possui uma conta de WhatsApp ativa." });
    }
    
    clientDB = await pool.connect();
    const result = await clientDB.query('SELECT * FROM clientes WHERE telefone = $1', [telefoneNormalizado]);
    
    if (result.rows.length > 0) {
      res.json({ success: true, isNew: false, cliente: result.rows[0] });
    } else {
      res.json({ success: true, isNew: true, cliente: { telefone: telefoneNormalizado } });
    }
  } catch (error) {
    logger.error(`Erro na identificação: ${error.message}`);
    res.status(500).json({ success: false, message: "Erro interno no servidor." });
  } finally {
    if (clientDB) clientDB.release();
  }
});

app.post('/api/criar-pedido', checkServicesReady, async (req, res) => {
  const pedido = req.body;
  const cliente = pedido.cliente;
  const telefoneNormalizado = normalizarTelefone(cliente.telefoneFormatado);

  if (!telefoneNormalizado || !cliente || !Array.isArray(pedido.carrinho) || pedido.carrinho.length === 0 || !pedido.pagamento) {
    return res.status(400).json({ success: false, message: "Dados do pedido inválidos." });
  }
  
  const numeroCliente = `${telefoneNormalizado}@c.us`;
  let clientDB;
  
  try {
    clientDB = await pool.connect();

    // ==================================================================
    // INÍCIO DA CORREÇÃO FINAL DE SQL
    // ==================================================================
    // Função para limpar os inputs, removendo espaços não-separáveis (\u00A0)
    // e aparando espaços no início e no fim.
    const cleanInput = (input) => {
        if (!input) return null;
        return input.replace(/\u00A0/g, ' ').trim();
    };

    const nome = cleanInput(cliente.nome) || ''; // Nome não pode ser nulo
    const endereco = cleanInput(cliente.endereco) || ''; // Endereço não pode ser nulo
    const referencia = cleanInput(cliente.referencia); // Referência pode ser nula
    // ==================================================================
    // FIM DA CORREÇÃO FINAL DE SQL
    // ==================================================================

    await clientDB.query(`
        INSERT INTO clientes (telefone, nome, endereco, referencia) 
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (telefone) DO UPDATE SET 
            nome = EXCLUDED.nome, 
            endereco = EXCLUDED.endereco, 
            referencia = EXCLUDED.referencia;
    `, [telefoneNormalizado, nome, endereco, referencia]); // Usa as variáveis limpas

    const cupom = gerarCupomFiscal(pedido);
    await client.sendMessage(numeroCliente, cupom);
    logger.info(`Cupom enviado para ${numeroCliente}`);
    
    setTimeout(() => {
      client.sendMessage(numeroCliente, `✅ PEDIDO CONFIRMADO! 🚀\nSeu pedido está sendo preparado! 😋️🍔\n\n⏱ *Tempo estimado:* 40-50 minutos\n📱 *Avisaremos quando sair para entrega!`).catch(err => logger.error(`Erro ao enviar msg de confirmação: ${err.message}`));
    }, 30000);

    setTimeout(() => {
      client.sendMessage(numeroCliente, `🛵 *SEU PEDIDO ESTÁ A CAMINHO!* 🔔\nChegará em 10-15 minutos!\n\n_Se já recebeu, ignore esta mensagem._`).catch(err => logger.error(`Erro ao enviar msg de "a caminho": ${err.message}`));
    }, 1800000);

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error(`Erro no processamento do pedido: ${error.message}`);
    res.status(500).json({ success: false, message: "Falha ao processar o pedido." });
  } finally {
    if (clientDB) clientDB.release();
  }
});

// Rota principal que serve o frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Tratamento genérico de erros
app.use((err, req, res, next) => {
  logger.error(`Erro não tratado: ${err.stack}`);
  res.status(500).json({ success: false, message: "Ocorreu um erro inesperado no servidor." });
});

// INICIALIZAÇÃO SEGURA E ROBUSTA DO SERVIDOR
function startServer() {
    app.listen(PORT, () => {
        logger.info(`🚀 Servidor rodando e ouvindo na porta ${PORT}`);
        
        // Agora que o servidor está online, tentamos conectar aos serviços dependentes.
        logger.info('Servidor online. Iniciando conexões com Banco de Dados e WhatsApp...');
        
        setupDatabase().catch(err => {
            logger.error('Falha final e crítica na configuração do banco de dados. O servidor continuará rodando, mas as rotas de API falharão.');
        });

        initializeWhatsApp();
    });

    app.on('error', (err) => {
        logger.error('Erro geral no servidor Express:', err);
        process.exit(1); // Encerra se o próprio servidor Express falhar
    });
}

startServer();
