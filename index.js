const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client } = require('whatsapp-web.js');
const fs = require('fs');
const cors = require('cors');

// Configuração de logs
const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`)
};

// Configuração do Express
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// --- Estado do Cliente WhatsApp ---
let isClientReady = false;

// Inicialização do cliente WhatsApp
const client = new Client({
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: true
  },
  session: fs.existsSync('./session.json') ? require('./session.json') : null
});

// --- Funções Auxiliares ---
function normalizarTelefone(telefone) {
    let limpo = telefone.replace(/\D/g, '');
    if (limpo.startsWith('55')) {
        limpo = limpo.substring(2);
    }
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
    cupom += `==================================================\n`
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
    if (pagamento === 'Dinheiro' && troco) { cupom += `Troco para: R$ ${troco}\n`; }
    cupom += `==================================================\n`;
    cupom += `             OBRIGADO PELA PREFERENCIA!`;
    return cupom;
}

// --- Eventos do WhatsApp ---
client.on('qr', qr => {
    logger.info('Gerando QR Code...');
    qrcode.generate(qr, { small: true });
    const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    logger.info(`\nLink do QR Code (copie e cole no navegador):\n${qrLink}\n`);
});

client.on('authenticated', (session) => {
    logger.info('Sessão autenticada! Salvando...');
    if (session) {
        fs.writeFileSync('./session.json', JSON.stringify(session));
    }
});

client.on('ready', () => { 
    logger.info('🤖 Cliente WhatsApp conectado!');
    isClientReady = true; 
});

client.on('disconnected', (reason) => { 
    isClientReady = false; 
    logger.error(`WhatsApp desconectado: ${reason}`); 
});

client.initialize();

// --- Rotas da API (Simplificadas sem banco de dados) ---

app.post('/api/identificar-cliente', async (req, res) => {
    if (!isClientReady) { return res.status(503).json({ success: false, message: "Servidor de WhatsApp iniciando. Tente em instantes." }); }
    
    const { telefone } = req.body;
    const telefoneNormalizado = normalizarTelefone(telefone);

    if (!telefoneNormalizado) {
        return res.json({ success: false, message: "Formato de número inválido." });
    }
    
    try {
        const numeroParaApi = `${telefoneNormalizado}@c.us`;
        const isRegistered = await client.isRegisteredUser(numeroParaApi);
        if (!isRegistered) {
            return res.json({ success: false, message: "Este número não possui uma conta de WhatsApp ativa." });
        }
        
        // Sem banco de dados, sempre retorna como novo cliente
        res.json({ success: true, isNew: true, cliente: { telefone: telefoneNormalizado } });

    } catch (error) {
        logger.error(`❌ Erro no processo de identificação: ${error.message}`);
        res.status(500).json({ success: false, message: "Erro interno no servidor." });
    }
});

app.post('/api/criar-pedido', async (req, res) => {
    if (!isClientReady) { return res.status(503).json({ success: false, message: "Servidor de WhatsApp iniciando. Tente em instantes." }); }
    
    const pedido = req.body;
    const cliente = pedido.cliente;
    const telefoneNormalizado = normalizarTelefone(cliente.telefoneFormatado);

    if (!telefoneNormalizado) { return res.status(400).json({ success: false, message: "Número de telefone inválido." }); }

    const numeroClienteParaApi = `${telefoneNormalizado}@c.us`;
    
    try {
        // Sem banco de dados, apenas registra no log
        logger.info(`Processando pedido para cliente: ${cliente.nome}`);

        const cupomFiscal = gerarCupomFiscal(pedido);
        await client.sendMessage(numeroClienteParaApi, cupomFiscal);
        logger.info(`✅ Cupom enviado para ${numeroClienteParaApi}`);
        
        // Mensagens automáticas de acompanhamento
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
    }
});

// --- Rota para servir o site ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Iniciar o Servidor ---
app.listen(PORT, () => {
    logger.info(`🚀 Servidor rodando na porta ${PORT}.`);
});
