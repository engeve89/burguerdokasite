const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js'); // Usando LocalAuth da versão estável
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

// --- Middlewares de Segurança e Funcionalidade ---
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

// --- Conexão com o Banco de Dados PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 5
});

// --- Função para criar a tabela de clientes (da sua versão funcional) ---
async function setupDatabase() {
    let clientDB;
    try {
        clientDB = await pool.connect();
        await clientDB.query(`
            CREATE TABLE IF NOT EXISTS clientes (
                telefone VARCHAR(20) PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                endereco TEXT NOT NULL,
                referencia TEXT,
                criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        logger.info('✅ Tabela "clientes" verificada/criada com sucesso no banco de dados.');
    } catch (err) {
        logger.error('❌ Erro ao configurar o banco de dados:', err);
        throw err; // Lança o erro para impedir a inicialização do servidor
    } finally {
        if (clientDB) clientDB.release();
    }
}

// ==================================================================
// LÓGICA DE WHATSAPP ESTÁVEL E COM RECONEXÃO AUTOMÁTICA
// ==================================================================
let client;
let whatsappStatus = 'initializing';
let isInitializing = false;

async function initializeWhatsApp() {
    if (isInitializing) return;
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

// --- Funções Auxiliares ---
function normalizarTelefone(telefone) {
    if (typeof telefone !== 'string') return null;
    let limpo = telefone.replace(/\D/g, '');
    if (limpo.startsWith('55')) { limpo = limpo.substring(2); }
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

// --- Rotas da API ---
app.get('/health', (req, res) => {
    res.json({
        whatsapp: whatsappStatus,
        database: pool.totalCount > 0 ? 'connected' : 'disconnected',
        uptime_seconds: process.uptime()
    });
});

app.post('/api/identificar-cliente', async (req, res) => {
    if (whatsappStatus !== 'ready') { return res.status(503).json({ success: false, message: "Servidor de WhatsApp iniciando. Tente em instantes." }); }
    
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
        logger.error(`❌ Erro no processo de identificação: ${error.message}`);
        res.status(500).json({ success: false, message: "Erro interno no servidor." });
    } finally {
        if (clientDB) clientDB.release();
    }
});

app.post('/api/criar-pedido', async (req, res) => {
    if (whatsappStatus !== 'ready') { return res.status(503).json({ success: false, message: "Servidor de WhatsApp iniciando. Tente em instantes." }); }
    
    const pedido = req.body;
    const cliente = pedido.cliente;
    const telefoneNormalizado = normalizarTelefone(cliente.telefoneFormatado);

    if (!telefoneNormalizado || !cliente || !Array.isArray(pedido.carrinho) || pedido.carrinho.length === 0 || !pedido.pagamento) {
        return res.status(400).json({ success: false, message: "Dados do pedido inválidos." });
    }
    
    const numeroClienteParaApi = `${telefoneNormalizado}@c.us`;
    let clientDB;
    try {
        // ==================================================================
        // INÍCIO DA CORREÇÃO FINAL E DEFINITIVA DE SQL
        // ==================================================================
        const cleanInput = (input) => {
            if (typeof input !== 'string' || !input) return null;
            return input.replace(/\s+/g, ' ').trim();
        };

        const nome = cleanInput(cliente.nome) || '';
        const endereco = cleanInput(cliente.endereco) || '';
        const referencia = cleanInput(cliente.referencia);
        // ==================================================================
        // FIM DA CORREÇÃO FINAL E DEFINITIVA DE SQL
        // ==================================================================
        clientDB = await pool.connect();
        await clientDB.query(
            'INSERT INTO clientes (telefone, nome, endereco, referencia) VALUES ($1, $2, $3, $4) ON CONFLICT (telefone) DO UPDATE SET nome = EXCLUDED.nome, endereco = EXCLUDED.endereco, referencia = EXCLUDED.referencia',
            [telefoneNormalizado, nome, endereco, referencia]
        );
        
        const cupomFiscal = gerarCupomFiscal(pedido);
        await client.sendMessage(numeroClienteParaApi, cupomFiscal);
        logger.info(`✅ Cupom enviado para ${numeroClienteParaApi}`);
        
        setTimeout(() => {
            const msgConfirmacao = `✅ PEDIDO CONFIRMADO! 🚀\nSeu pedido está sendo preparado! 😋️🍔\n\n⏱ *Tempo estimado:* 40-50 minutos\n📱 *Avisaremos quando sair para entrega!`;
            client.sendMessage(numeroClienteParaApi, msgConfirmacao).catch(err => logger.error(`Falha ao enviar msg de confirmação: ${err.message}`));
        }, 30 * 1000);

        setTimeout(() => {
            const msgEntrega = `🛵 *SEU PEDIDO ESTÁ A CAMINHO!* 🔔\nChegará em 10 a 15 minutinhos!\n\n_Se já recebeu, por favor ignore esta mensagem._`;
            client.sendMessage(numeroClienteParaApi, msgEntrega).catch(err => logger.error(`Falha ao enviar msg de entrega: ${err.message}`));
        }, 30 * 60 * 1000);

        res.status(200).json({ success: true });
    } catch (error) {
        logger.error(`❌ Falha ao processar pedido para ${numeroClienteParaApi}: ${error.message}`);
        res.status(500).json({ success: false, message: "Falha ao processar o pedido." });
    } finally {
        if(clientDB) clientDB.release();
    }
});

// --- Rota para servir o site ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware global para tratamento de erros
app.use((err, req, res, next) => {
    logger.error(`Erro não tratado: ${err.stack}`);
    res.status(500).json({ success: false, message: "Ocorreu um erro inesperado no servidor." });
});

// --- INICIALIZAÇÃO SEGURA DO SERVIDOR ---
async function startServer() {
    try {
        await setupDatabase();
        logger.info('Conexão com o banco de dados pronta. Iniciando servidor e WhatsApp...');
        
        app.listen(PORT, () => {
            logger.info(`🚀 Servidor rodando na porta ${PORT}`);
            initializeWhatsApp();
        });
    } catch (err) {
        logger.error('Falha crítica na inicialização. O servidor não será iniciado.', err);
        process.exit(1);
    }
}

startServer();
