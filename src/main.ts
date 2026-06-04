/** CLI 入口 */

import readline from 'node:readline';
import process from 'node:process';
import net from 'node:net';
import { CommandHandler, SystemExit } from './commands.js';
import { ServerConfig, validatePairingCode } from './config.js';
import { setLocale, _ } from './i18n.js';
import { generateQrAscii, getLocalIp } from './qr.js';
import { Server } from './server.js';
import { printBanner, printMessage, setActiveReadline, printNewMessage } from './ui.js';

export { SystemExit };

async function checkPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(true));
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port, '0.0.0.0');
  });
}

export class PortalApp {
  config: ServerConfig;
  server: Server;
  cmdHandler: CommandHandler;
  running = true;
  linkedDeviceName = '';
  linkedLoginId = '';

  constructor(config: ServerConfig) {
    this.config = config;
    this.server = new Server(config);
    this.cmdHandler = new CommandHandler(config, this.server, this);
  }

  async run(): Promise<void> {
    let actualPort: number;
    try {
      actualPort = await this.server.start();
    } catch (e: any) {
      printMessage(_('[ERROR] Startup failed: {e}', { e: e.message }), 'bold red');
      return;
    }

    printBanner(this.config);

    const qrUrl = this.config.qrUrl;
    const qrAscii = await generateQrAscii(qrUrl);
    printMessage(_('Scan QR code with phone to connect'));
    printMessage(qrAscii);
    printMessage(`${_('Pairing code')}: ${this.config.pairingCode}`);
    printMessage(`${_('Address')}: ${qrUrl}`);
    printMessage('');

    this.processTerminalMessages();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'lportal> ',
    });

    setActiveReadline(rl);

    rl.prompt();

    return new Promise<void>((resolve) => {
      rl.on('line', async (line) => {
        const cmd = line.trim();
        if (!cmd) {
          rl.prompt();
          return;
        }

        if (this.linkedLoginId && !cmd.startsWith('/')) {
          const entry = await this.server.sendServerText(cmd, this.linkedLoginId);
          if (entry) {
            const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
            printMessage(`[${timeStr}] -> ${this.linkedDeviceName}: ${entry.preview.slice(0, 30)}...`);
          } else {
            printMessage(_('Failed to send, device may be offline'));
          }
          rl.prompt();
          return;
        }

        try {
          const result = await this.cmdHandler.handle(cmd);
          if (result) printMessage(result);
        } catch (e) {
          if (e instanceof SystemExit) {
            rl.close();
            return;
          }
          if (e instanceof Error) {
            printMessage(_('[ERROR] Error: {e}', { e: e.message }), 'red');
          }
        }
        rl.prompt();
      });

      rl.on('SIGINT', () => {
        printMessage(_('[Hint] Ctrl+C is disabled for exit, use /exit to quit'));
        rl.prompt();
      });

      rl.on('close', async () => {
        await this.shutdown();
        resolve();
      });
    });
  }

  private async processTerminalMessages(): Promise<void> {
    while (this.running) {
      try {
        const msg = await this.server.terminalQueue.get();
        if (msg === null) break;

        switch (msg.type) {
          case 'new_message':
            if (msg.entry) printNewMessage(msg.entry, msg.autoCopied);
            break;
          case 'clipboard_error':
            printMessage(`[WARN] ${_('Clipboard error')}: ${msg.error || _('Unknown error')}`);
            break;
          case 'file_received':
            {
              const timeStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
              printMessage(`[${timeStr}] ${_('File received')}: ${msg.path}`);
            }
            break;
          case 'server_message_sent':
            // 已在发送时打印，这里不再重复
            break;
        }
      } catch {
        continue;
      }
    }
  }

  async shutdown(): Promise<void> {
    setActiveReadline(null);
    printMessage(_('Closing service...'));
    this.server.terminalQueue.put(null);
    this.running = false;
    await this.server.stop(true);
    printMessage(_('Service closed'));
  }
}

export interface RunOptions {
  port: number;
  autoCopy: boolean;
  maxHistory: number;
  code?: string;
  zh?: boolean;
  en?: boolean;
}

export async function main(options: RunOptions): Promise<void> {
  if (options.zh) setLocale('zh');
  else if (options.en) setLocale('en');

  if (await checkPortInUse(options.port)) {
    printMessage(_('Another instance is already running'), 'bold red');
    printMessage(_('Please stop the existing service first, or use /exit to quit'));
    process.exit(1);
  }

  if (options.code !== undefined) {
    if (!validatePairingCode(options.code)) {
      printMessage(_('Invalid pairing code: {code}', { code: options.code }), 'bold red');
      printMessage(_('Pairing code must be 4 digits'));
      process.exit(1);
    }
  }

  const config = new ServerConfig(
    options.autoCopy,
    options.port,
    options.maxHistory,
    '0.0.0.0',
    options.code
  );

  const portal = new PortalApp(config);
  try {
    await portal.run();
  } catch {
    // ignore
  }
}
