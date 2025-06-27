const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js'); // Alterado aqui
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
	max: 19,
	standardHeaders: true,
	legacyHeaders: false,
    message: { success: false, message: "Muitas requisições. Por favor, tente novamente mais tarde." }
});

app.use('/api/', apiLimiter);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000
});

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
        logger.info('Tabela "clientes" verificada/criada com sucesso no banco de dados.');
    } catch (err) {
        logger.error('Erro ao criar a tabela de clientes:', err);
    } finally {
        if (clientDB) clientDB.release();
    }
}

// --- LÓGICA DO WHATSAPP MELHORADA ---
let client;
let whatsappStatus = 'initializing';

function initializeWhatsApp() {
    logger.info('Inicializando cliente WhatsApp...');
    client = new Client({
        authStrategy: new LocalAuth(), // Estratégia recomendada para salvar a sessão
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            headless: true
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
        logger.info('✅ 🤖 Cliente WhatsApp conectado e pronto para automação!');
    });

    client.on('auth_failure', msg => {
        logger.error(`FALHA NA AUTENTICAÇÃO: ${msg}. A sessão pode estar inválida.`);
        // A lógica de reconexão no 'disconnected' cuidará disso.
    });
    
    client.on('disconnected', (reason) => {
        whatsappStatus = 'disconnected';
        logger.error(`WhatsApp desconectado: ${reason}. Tentando reconectar em 20 segundos...`);
        // Destroi o cliente antigo para limpar tudo
        client.destroy();
        // Tenta reinicializar após um intervalo
        setTimeout(initializeWhatsApp, 20000); // Espera 20 segundos
    });

    client.initialize().catch(err => {
        logger.error(`Falha crítica ao inicializar o cliente: ${err}`);
        // Se a inicialização falhar, tenta novamente
        setTimeout(initializeWhatsApp, 60000); // Espera 1 minuto antes de tentar de novo
    });
}

// --- Funções Auxiliares (sem alterações) ---
function normalizarTelefone(telefone) {
    if (typeof telefone !== 'string') return null;
    let limpo = telefone.replace(/\D/g, '');
    if (limpo.startsWith('55')) { limpo = limpo.substring(2); }
    if (limpo.length < 10 || limpo.length > 11) return null;
    const ddd = limpo.substring(0, 2);
    let numeroBase = limpo.substring(2);
    if (numeroBase.length === 9 && numeroBase.startsWith('9')) {
        numeroBase = numeroBase.substring(1);
    }
    if (numeroBase.length !== 8) return null;
    return `55${ddd}${numeroBase}`;
}

function gerarCupomFiscal(pedido) {
    const { cliente, carrinho, pagamento, troco } = pedido;
    const subtotal = carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
    const taxaEntrega = 5.00;
    const total = subtotal + taxaEntrega;
    const now = new Date();
    let cupom = `==================================================\n`;
    cupom += `      Doka Burger - Pedido em ${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}\n`;
    cupom += `==================================================\n`;
    cupom += `👤 *DADOS DO CLIENTE*\nNome: ${cliente.nome}\nTelefone: ${cliente.telefoneFormatado}\n\n`;
    cupom += `*ITENS:*\n`;
    carrinho.forEach(item => {
        const nomeFormatado = item.nome.padEnd(25, ' ');
        const precoFormatado = `R$ ${(item.preco * item.quantidade).toFixed(2).replace('.', ',')}`;
        cupom += `• ${item.quantidade}x ${nomeFormatado} ${precoFormatado}\n`;
        if (item.observacao) { cupom += `  Obs: ${item.observacao}\n`; }
    });
    cupom += `--------------------------------------------------\n`;
    cupom += `Subtotal:         R$ ${subtotal.toFixed(2).replace('.', ',')}\n`;
    cupom += `Taxa de Entrega:  R$ ${taxaEntrega.toFixed(2).replace('.', ',')}\n`;
    cupom += `*TOTAL:* *R$ ${total.toFixed(2).replace('.', ',')}*\n`;
    cupom += `--------------------------------------------------\n`;
    cupom += `*ENDEREÇO:*\n${cliente.endereco}\n`;
    if (cliente.referencia) { cupom += `Ref: ${cliente.referencia}\n`; }
    cupom += `--------------------------------------------------\n`;
    cupom += `*FORMA DE PAGAMENTO:*\n${pagamento}\n`;
    if (pagamento === 'Dinheiro' && troco) {
        cupom += `Troco para: R$ ${troco}\n`;
    }
    cupom += `==================================================\n`;
    cupom += `               OBRIGADO PELA PREFERENCIA!`;
    return cupom;
}

// --- Rotas da API (sem alterações) ---
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
            const clienteEncontrado = result.rows[0];
            logger.info(`Cliente encontrado no DB: ${clienteEncontrado.nome}`);
            res.json({ success: true, isNew: false, cliente: clienteEncontrado });
        } else {
            logger.info(`Cliente novo. Telefone validado: ${telefoneNormalizado}`);
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
        clientDB = await pool.connect();
        const clienteNoDB = await clientDB.query('SELECT * FROM clientes WHERE telefone = $1', [telefoneNormalizado]);
        if (clienteNoDB.rows.length === 0) {
            await clientDB.query(
                'INSERT INTO clientes (telefone, nome, endereco, referencia) VALUES ($1, $2, $3, $4)',
                [telefoneNormalizado, cliente.nome, cliente.endereco, cliente.referencia]
            );
            logger.info(`Cliente novo "${cliente.nome}" salvo no banco de dados.`);
        }
        
        const cupomFiscal = gerarCupomFiscal(pedido);
        await client.sendMessage(numeroClienteParaApi, cupomFiscal);
        logger.info(`✅ Cupom enviado para ${numeroClienteParaApi}`);
        
        setTimeout(() => {
            const msgConfirmacao = `✅ PEDIDO CONFIRMADO! 🚀\nSua explosão de sabores está INDO PARA CHAPA🔥️!!! 😋️🍔\n\n⏱ *Tempo estimado:* 40-50 minutos\n📱 *Acompanharemos seu pedido e avisaremos quando sair para entrega!`;
            client.sendMessage(numeroClienteParaApi, msgConfirmacao).catch(err => logger.error(`Falha ao enviar msg de confirmação: ${err.message}`));
        }, 30 * 1000);

        setTimeout(() => {
            const msgEntrega = `🛵 *😋️OIEEE!!! SEU PEDIDO ESTÁ A CAMINHO!* 🔔\nDeve chegar em 10 a 15 minutinhos!\n\n_Se já recebeu, por favor ignore esta mensagem._`;
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

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    logger.error(`Erro não tratado: ${err.stack}`);
    res.status(500).json({ success: false, message: "Ocorreu um erro inesperado no servidor." });
});

// --- Iniciar o Servidor ---
app.listen(PORT, async () => {
    await setupDatabase().catch(logger.error);
    initializeWhatsApp(); // Inicia o processo do WhatsApp
    logger.info(`🚀 Servidor rodando na porta ${PORT}.`);
});
