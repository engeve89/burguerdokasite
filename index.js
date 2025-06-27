const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client } = require('whatsapp-web.js');
const fs = require('fs');
const cors = require('cors');

// Configuração de logs para monitoramento
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

// --- Banco de Dados Simulado ---
const usuariosDB = [
    { 
        telefone: '551191234567',
        nome: 'Cliente Teste', 
        endereco: 'Rua da Simulação, 100, Bairro Demo',
        referencia: 'Em frente ao Code Park'
    }
];

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
    logger.info('🤖 Cliente WhatsApp conectado e pronto para automação!');
    isClientReady = true; 
});

client.on('disconnected', (reason) => {
    logger.error(`WhatsApp desconectado: ${reason}`);
    isClientReady = false;
});

client.initialize();

// --- Rotas da API ---

app.post('/api/identificar-cliente', async (req, res) => {
    if (!isClientReady) { 
        return res.status(503).json({ success: false, message: "Servidor de WhatsApp iniciando. Tente em instantes." }); 
    }
    
    const { telefone } = req.body;
    logger.info(`Recebida requisição para identificar: ${telefone}`);
    
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
        
        const clienteEncontrado = usuariosDB.find(user => user.telefone === telefoneNormalizado);

        if (clienteEncontrado) {
            logger.info(`Cliente encontrado no DB: ${clienteEncontrado.nome}`);
            res.json({ success: true, isNew: false, cliente: clienteEncontrado });
        } else {
            logger.info(`Cliente novo. Telefone normalizado para cadastro: ${telefoneNormalizado}`);
            res.json({ success: true, isNew: true, cliente: { telefone: telefoneNormalizado } });
        }

    } catch (error) {
        logger.error(`❌ Erro no processo de identificação: ${error.message}`);
        res.status(500).json({ success: false, message: "Erro interno no servidor." });
    }
});

app.post('/api/criar-pedido', async (req, res) => {
    if (!isClientReady) { 
        return res.status(503).json({ success: false, message: "Servidor de WhatsApp iniciando. Tente em instantes." }); 
    }
    
    const pedido = req.body;
    logger.info(`📦 Processando pedido para: ${pedido.cliente.nome}`);
    
    const telefoneNormalizado = normalizarTelefone(pedido.cliente.telefoneFormatado);
    if (!telefoneNormalizado) {
        return res.status(400).json({ success: false, message: "Número de telefone inválido." });
    }
    
    const clienteExistente = usuariosDB.find(user => user.telefone === telefoneNormalizado);
    if (!clienteExistente) {
        const novoClienteParaDB = {
            telefone: telefoneNormalizado,
            nome: pedido.cliente.nome,
            endereco: pedido.cliente.endereco,
            referencia: pedido.cliente.referencia
        };
        usuariosDB.push(novoClienteParaDB);
        logger.info(`Cliente novo "${pedido.cliente.nome}" adicionado ao DB.`);
        logger.info(`DB atual: ${JSON.stringify(usuariosDB)}`);
    }

    const numeroClienteParaApi = `${telefoneNormalizado}@c.us`;
    
    try {
        const cupomFiscal = gerarCupomFiscal(pedido);
        await client.sendMessage(numeroClienteParaApi, cupomFiscal);
        logger.info(`✅ Cupom fiscal enviado para ${numeroClienteParaApi}`);
        
        // ---- LÓGICA DE MENSAGENS AUTOMÁTICAS ----
        setTimeout(() => {
            const msgConfirmacao = `✅ PEDIDO CONFIRMADO! 🚀\nSua explosão de sabores está INDO PARA CHAPA🔥️!!! 😋️🍔\n\n⏱ *Tempo estimado:* 40-50 minutos\n📱 *Acompanharemos seu pedido e avisaremos quando sair para entrega!`;
            client.sendMessage(numeroClienteParaApi, msgConfirmacao).then(() => {
                logger.info(`✅ Mensagem de confirmação enviada para ${numeroClienteParaApi}`);
            }).catch(err => {
                logger.error(`❌ Falha ao enviar mensagem de confirmação para ${numeroClienteParaApi}: ${err.message}`);
            });
        }, 30 * 1000);

        setTimeout(() => {
            const msgEntrega = `🛵 *😋️OIEEE!!! SEU PEDIDO ESTÁ A CAMINHO!* 🔔\nDeve chegar em 10 a 15 minutinhos!\n\n_Se já recebeu, por favor ignore esta mensagem._`;
            client.sendMessage(numeroClienteParaApi, msgEntrega).then(() => {
                logger.info(`✅ Mensagem de entrega enviada para ${numeroClienteParaApi}`);
            }).catch(err => {
                logger.error(`❌ Falha ao enviar mensagem de entrega para ${numeroClienteParaApi}: ${err.message}`);
            });
        }, 30 * 60 * 1000);

        res.status(200).json({ success: true });

    } catch (error) {
        logger.error(`❌ Falha ao enviar pedido para ${numeroClienteParaApi}: ${error.message}`);
        res.status(500).json({ success: false, message: "Falha ao enviar o pedido via WhatsApp." });
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
