import { parentPort } from 'worker_threads';
import { Client } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Configura caminhos absolutos para o Render
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE_PATH = path.join(__dirname, '../../session.json');

class WhatsAppWorker {
  constructor() {
    this.client = new Client({
      puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
      },
      session: null
    });
    this.initialize();
  }

  async loadSession() {
    try {
      const sessionData = await fs.readFile(SESSION_FILE_PATH, 'utf-8');
      return JSON.parse(sessionData);
    } catch (error) {
      return null;
    }
  }

  async saveSession(session) {
    await fs.writeFile(SESSION_FILE_PATH, JSON.stringify(session));
  }

  initialize() {
    this.client.on('qr', qr => {
      qrcode.generate(qr, { small: true });
      parentPort.postMessage({ type: 'qr', qr });
    });

    this.client.on('authenticated', async (session) => {
      await this.saveSession(session);
      parentPort.postMessage({ type: 'authenticated' });
    });

    this.client.on('ready', () => {
      parentPort.postMessage({ type: 'ready' });
    });

    this.client.on('disconnected', (reason) => {
      parentPort.postMessage({ type: 'disconnected', reason });
    });

    // Carrega a sessão antes de inicializar
    this.loadSession().then(session => {
      this.client.options.session = session;
      this.client.initialize();
    });
  }
}

new WhatsAppWorker();

// Processa mensagens do thread principal
parentPort.on('message', async (message) => {
  if (message.type === 'send_message') {
    try {
      const { number, content } = message;
      await this.client.sendMessage(number, content);
      parentPort.postMessage({ 
        type: 'message_sent', 
        number 
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        error: error.message
      });
    }
  }
});
