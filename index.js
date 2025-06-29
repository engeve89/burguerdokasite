const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qrcode = require('qrcode-terminal');
// 1. ATUALIZAÇÃO: Importa o Client e a estratégia LocalAuth
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

// Informa ao Express para confiar no proxy do Render (ou outro serviço de hospedagem)
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

// Configuração do Rate Limiter
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutos
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
  connectionTimeoutMillis: 5000
});

// --- Função para criar as tabelas se não existirem ---
async function setupDatabase() {
    let clientDB;
    try {
        clientDB = await pool.connect();
        
        // Tabela de clientes
        await clientDB.query(`
            CREATE TABLE IF NOT EXISTS clientes (
                telefone VARCHAR(20) PRIMARY KEY,
                nome VARCHAR(255) NOT NULL,
                endereco TEXT NOT NULL,
                referencia TEXT,
                criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        // Tabela de pedidos
        await clientDB.query(`
            CREATE TABLE IF NOT EXISTS pedidos (
                id SERIAL PRIMARY KEY,
                cliente_telefone VARCHAR(20) NOT NULL REFERENCES clientes(telefone),
                dados_pedido JSONB NOT NULL,
                mensagem_confirmacao_enviada BOOLEAN NOT NULL DEFAULT false,
                mensagem_entrega_enviada BOOLEAN NOT NULL DEFAULT false,
                criado_em TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        logger.info('Tabelas verificadas/criadas com sucesso no banco de dados.');
    } catch (err) {
        logger.error(`Erro ao criar as tabelas: ${err}`);
    } finally {
        if (clientDB) clientDB.release();
    }
}

// --- Estado e Inicialização do Cliente WhatsApp ---
let whatsappStatus = 'initializing';

// 2. ATUALIZAÇÃO: Inicialização do Client com as correções
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    },
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
});

// --- Função de Normalização de Telefone Atualizada ---
function normalizarTelefone(telefone) {
  if (typeof telefone !== 'string') return null;
  
  // Remove tudo que não for dígito
  let limpo = telefone.replace(/\D/g, '');
  
  // Remove todos os prefixos '0' e '55' iniciais
  limpo = limpo.replace(/^(0+|55+)/, '');
  
  // Verifica comprimento após limpeza
  if (limpo.length === 10 || limpo.length === 11) {
    // Números com 10 dígitos: DDD (2) + número (8)
    // Números com 11 dígitos: DDD (2) + número (9)
    const ddd = limpo.substring(0, 2);
    const numero = limpo.substring(2);
    
    // Remove o nono dígito se necessário
    const numeroFinal = (numero.length === 9 && numero.startsWith('9'))
      ? numero.substring(1)  // Remove o primeiro '9'
      : numero;
    
    return `55${ddd}${numeroFinal}`;
  }
  
  return null;
}

function gerarCupomFiscal(pedido) {
    const { cliente, carrinho, pagamento, troco } = pedido;
    const subtotal = carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
    const taxaEntrega = 5.00;
    const total = subtotal + taxaEntrega;
    const now = new Date();
    let cupom = `==================================================\n`;
    cupom += `     Doka Burger - Pedido em ${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-br', { hour: '2-digit', minute: '2-digit' })}\n`;
    cupom += `==================================================\n`
    cupom += `👤 *DADOS DO CLIENTE*\nNome: ${cliente.nome}\nTelefone: ${cliente.telefoneFormatado}\n\n`;
    cupom += `*ITENS:*\n`;
    carrinho.forEach(item => {
        const nomeFormatado = item.nome.padEnd(25, ' ');
        const precoFormatado = `R$ ${(item.preco * item.quantidade).toFixed(2).replace('.', ',')}`;
        cupom += `• ${item.quantidade}x ${nomeFormatado} ${precoFormatado}\n`;
        if (item.observacao) { cupom += `  Obs: ${item.observacao}\n`; }
    });
    cupom += `--------------------------------------------------\n`;
    cupom += `Subtotal:           R$ ${subtotal.toFixed(2).replace('.', ',')}\n`;
    cupom += `Taxa de Entrega:    R$ ${taxaEntrega.toFixed(2).replace('.', ',')}\n`;
    cupom += `*TOTAL:* *R$ ${total.toFixed(2).replace('.', ',')}*\n`;
    cupom += `--------------------------------------------------\n`;
    cupom += `*ENDEREÇO:*\n${cliente.endereco}\n`;
    if (cliente.referencia) { cupom += `Ref: ${cliente.referencia}\n`; }
    cupom += `--------------------------------------------------\n`;
    cupom += `*FORMA DE PAGAMENTO:*\n${pagamento}\n`;
    if (pagamento === 'Dinheiro' && troco) {
        const valorTroco = parseFloat(troco.replace(',', '.')) - total;
        cupom += `Troco para: R$ ${parseFloat(troco.replace(',', '.')).toFixed(2).replace('.', ',')} (Levar R$ ${valorTroco.toFixed(2).replace('.',',')})\n`;
    }
    cupom += `==================================================\n`;
    cupom += `           OBRIGADO PELA PREFERENCIA!`;
    return cupom;
}

// --- Eventos do WhatsApp ---
client.on('qr', qr => {
    logger.info('Gerando QR Code...');
    qrcode.generate(qr, { small: true });
    const qrLink = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    logger.info(`\nLink do QR Code (copie e cole no navegador):\n${qrLink}\n`);
});

/* 3. ATUALIZAÇÃO: O LocalAuth agora gerencia a sessão automaticamente. Este bloco não é mais necessário.
client.on('authenticated', (session) => {
    logger.info('Sessão autenticada! Salvando...');
    if (session) { fs.writeFileSync('./session.json', JSON.stringify(session)); }
});
*/

client.on('auth_failure', msg => {
    logger.error(`FALHA NA AUTENTICAÇÃO: ${msg}. Removendo sessão...`);
    // Com LocalAuth, a remoção da pasta .wwebjs_auth pode ser necessária em caso de falha grave.
    // Por enquanto, apenas logar o erro é suficiente.
    whatsappStatus = 'disconnected';
});

client.on('ready', () => { 
    whatsappStatus = 'ready';
    logger.info('✅ 🤖 Cliente WhatsApp conectado e pronto para automação!');
});

client.on('disconnected', (reason) => { 
    whatsappStatus = 'disconnected'; 
    logger.error(`WhatsApp desconectado: ${reason}`); 
});

client.initialize().catch(err => {
  logger.error(`Falha crítica ao inicializar o cliente: ${err}`);
});

// --- Rotas da API ---

app.get('/health', (req, res) => {
    res.json({
        whatsapp: whatsappStatus,
        database_connections: pool.totalCount,
        uptime_seconds: process.uptime()
    });
});

app.post('/api/identificar-cliente', async (req, res) => {
    const { telefone } = req.body;
    const telefoneNormalizado = normalizarTelefone(telefone);

    if (!telefoneNormalizado) {
        return res.status(400).json({ 
            success: false, 
            message: "Formato de número de telefone inválido. Use DDD + número (10 ou 11 dígitos)" 
        });
    }
    
    // Verificação adicional de comprimento
    if (telefoneNormalizado.length !== 12) {
        return res.status(400).json({
            success: false,
            message: "Número inválido após normalização. Por favor, verifique o formato."
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
    if (whatsappStatus !== 'ready') { 
        return res.status(503).json({ 
            success: false, 
            message: "Servidor de WhatsApp iniciando. Tente em instantes." 
        }); 
    }
    
    const pedido = req.body;
    const { cliente } = pedido;
    const telefoneNormalizado = normalizarTelefone(cliente.telefone);

    if (!telefoneNormalizado || !cliente || !Array.isArray(pedido.carrinho) || pedido.carrinho.length === 0 || !pedido.pagamento) {
        return res.status(400).json({ success: false, message: "Dados do pedido inválidos." });
    }
    
    // Verificação adicional de comprimento
    if (telefoneNormalizado.length !== 12) {
        return res.status(400).json({
            success: false,
            message: "Número de telefone inválido após normalização. Por favor, verifique o formato."
        });
    }
    
    pedido.cliente.telefoneFormatado = cliente.telefone;

    const numeroClienteParaApi = `${telefoneNormalizado}@c.us`;
    let clientDB;
    try {
        clientDB = await pool.connect();
        
        await clientDB.query(
            `INSERT INTO clientes (telefone, nome, endereco, referencia) VALUES ($1, $2, $3, $4)
             ON CONFLICT (telefone) DO UPDATE SET nome = $2, endereco = $3, referencia = $4`,
            [telefoneNormalizado, cliente.nome, cliente.endereco, cliente.referencia]
        );
        logger.info(`Cliente "${cliente.nome}" salvo/atualizado no banco de dados.`);
        
        const resultPedido = await clientDB.query(
            `INSERT INTO pedidos (cliente_telefone, dados_pedido) 
             VALUES ($1, $2) RETURNING id`,
            [telefoneNormalizado, JSON.stringify(pedido)]
        );
        
        const pedidoId = resultPedido.rows[0].id;
        logger.info(`Pedido #${pedidoId} registrado no banco de dados.`);
        
        const cupomFiscal = gerarCupomFiscal(pedido);
        await client.sendMessage(numeroClienteParaApi, cupomFiscal);
        logger.info(`✅ Cupom enviado para ${numeroClienteParaApi}`);
        
        // Lógica de acompanhamento (com verificação para não reenviar)
        setTimeout(async () => {
            let clientDBInternal = null;
            try {
                clientDBInternal = await pool.connect();
                const result = await clientDBInternal.query(
                    'SELECT mensagem_confirmacao_enviada FROM pedidos WHERE id = $1',
                    [pedidoId]
                );
                
                if (result.rows.length > 0 && !result.rows[0].mensagem_confirmacao_enviada) {
                    const msgConfirmacao = `✅ *Doka Burger* - Seu pedido #${pedidoId} foi confirmado e já está em preparo! 🍔⏳\n\nAgradecemos sua preferência!`;
                    await client.sendMessage(numeroClienteParaApi, msgConfirmacao);
                    
                    await clientDBInternal.query(
                        'UPDATE pedidos SET mensagem_confirmacao_enviada = true WHERE id = $1',
                        [pedidoId]
                    );
                    logger.info(`Mensagem de confirmação enviada para pedido #${pedidoId}`);
                }
            } catch (error) {
                logger.error(`Erro ao enviar mensagem de confirmação: ${error}`);
            } finally {
                if (clientDBInternal) {
                    try {
                        clientDBInternal.release();
                    } catch (releaseError) {
                        logger.error(`Erro ao liberar conexão de confirmação: ${releaseError.message}`);
                    }
                }
            }
        }, 30 * 1000); // 30 segundos

        setTimeout(async () => {
            let clientDBInternal = null;
            try {
                clientDBInternal = await pool.connect();
                const result = await clientDBInternal.query(
                    'SELECT mensagem_entrega_enviada FROM pedidos WHERE id = $1',
                    [pedidoId]
                );
                
                if (result.rows.length > 0 && !result.rows[0].mensagem_entrega_enviada) {
                    const msgEntrega = `🚚 *Doka Burger* - Seu pedido #${pedidoId} saiu para entrega! Deve chegar em instantes!\n\nPor favor, tenha o valor do pedido pronto.`;
                    await client.sendMessage(numeroClienteParaApi, msgEntrega);
                    
                    await clientDBInternal.query(
                        'UPDATE pedidos SET mensagem_entrega_enviada = true WHERE id = $1',
                        [pedidoId]
                    );
                    logger.info(`Mensagem de entrega enviada para pedido #${pedidoId}`);
                }
            } catch (error) {
                logger.error(`Erro ao enviar mensagem de entrega: ${error}`);
            } finally {
                if (clientDBInternal) {
                    try {
                        clientDBInternal.release();
                    } catch (releaseError) {
                        logger.error(`Erro ao liberar conexão de entrega: ${releaseError.message}`);
                    }
                }
            }
        }, 30 * 60 * 1000); // 30 minutos

        res.status(200).json({ success: true, pedidoId: pedidoId });
    } catch (error) {
        logger.error(`❌ Falha ao processar pedido para ${numeroClienteParaApi}: ${error.message}`);
        res.status(500).json({ success: false, message: "Falha ao processar o pedido." });
    } finally {
        if(clientDB) clientDB.release();
    }
});

app.get('/api/historico/:telefone', async (req, res) => {
    const { telefone } = req.params;
    const telefoneNormalizado = normalizarTelefone(telefone);

    if (!telefoneNormalizado) {
        return res.status(400).json({ success: false, message: "Formato de número de telefone inválido." });
    }

    let clientDB;
    try {
        clientDB = await pool.connect();
        
        const result = await clientDB.query(
            `SELECT id, dados_pedido, criado_em FROM pedidos 
             WHERE cliente_telefone = $1 
             ORDER BY criado_em DESC`,
            [telefoneNormalizado]
        );

        if (result.rows.length === 0) {
            return res.json([]); 
        }

        const historico = result.rows.map(pedido => {
            const dados = pedido.dados_pedido;
            const subtotal = dados.carrinho.reduce((total, item) => total + (item.preco * item.quantidade), 0);
            const valorTotal = subtotal + 5.00; // 5.00 é a taxa de entrega fixa

            return {
                id: pedido.id,
                dataPedido: pedido.criado_em,
                valorTotal: valorTotal,
                status: dados.status || "Entregue",
                itens: dados.carrinho.map(item => ({
                    nomeProduto: item.nome,
                    quantidade: item.quantidade,
                    observacao: item.observacao || ""
                }))
            };
        });
        
        logger.info(`Histórico de ${historico.length} pedido(s) retornado para o telefone ${telefoneNormalizado}`);
        res.json(historico);

    } catch (error) {
        logger.error(`❌ Erro ao buscar histórico para ${telefoneNormalizado}: ${error.message}`);
        res.status(500).json({ success: false, message: "Erro interno ao buscar o histórico de pedidos." });
    } finally {
        if (clientDB) clientDB.release();
    }
});

// Rota para servir o site
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware global para tratamento de erros
app.use((err, req, res, next) => {
    logger.error(`Erro não tratado: ${err.stack}`);
    res.status(500).json({ success: false, message: "Ocorreu um erro inesperado no servidor." });
});

// --- Iniciar o Servidor ---
app.listen(PORT, async () => {
    await setupDatabase().catch(logger.error);
    logger.info(`🚀 Servidor rodando na porta ${PORT}.`);
});
