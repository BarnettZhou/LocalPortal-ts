/** CLI 入口 */

import readline from 'node:readline';
import process from 'node:process';
import net from 'node:net';
import { Transform } from 'node:stream';
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
  rl?: readline.Interface;
  private inputInterceptor?: Transform;
  private pendingPasteText: string | null = null;
  private pendingPasteLineCount = 0;

  constructor(config: ServerConfig) {
    this.config = config;
    this.server = new Server(config);
    this.cmdHandler = new CommandHandler(config, this.server, this);
  }

  updatePrompt(): void {
    if (!this.rl) return;
    if (this.linkedDeviceName) {
      this.rl.setPrompt(`lportal[${this.linkedDeviceName}]> `);
    } else {
      this.rl.setPrompt('lportal> ');
    }
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

    // 声明 rl 变量供 keypress handler 提前引用
    let rl: readline.Interface;

    // 必须先启用 keypress 事件，这样我们的监听器才能在 readline 之前注册
    readline.emitKeypressEvents(process.stdin);

    // 拦截 Backspace：若当前行是 paste 占位符，则一次性清空整行
    process.stdin.on('keypress', (_str, key) => {
      if (key.name === 'backspace' && this.pendingPasteText !== null) {
        const placeholder = `[pasted ${this.pendingPasteLineCount} lines]`;
        // readline 的 backspace 处理会在之后执行；如果 cursor 已经是 0 且 line 为空，
        // readline 不会做任何事，因此显示保持我们刷新后的空行。
        if (rl.line === placeholder) {
          (rl as any).line = '';
          (rl as any).cursor = 0;
          (rl as any)._refreshLine();
          this.pendingPasteText = null;
          this.pendingPasteLineCount = 0;
        }
      }
    });

    // 自定义 Transform：把多行粘贴内容替换成占位符
    const self = this;
    const interceptor = new Transform({
      transform(chunk, _encoding, callback) {
        const text = chunk.toString();

        // 检测到包含换行符且长度 > 1 的输入块，视为粘贴
        if ((text.includes('\n') || text.includes('\r')) && text.length > 1) {
          const rawText = text.replace(/\r?\n$/, '');
          const lineCount = rawText.split(/\r?\n/).filter((l: string) => l.length > 0).length;

          if (lineCount > 1) {
            self.pendingPasteText = rawText;
            self.pendingPasteLineCount = lineCount;
            callback(null, Buffer.from(`[pasted ${lineCount} lines]`));
            return;
          }
        }

        callback(null, chunk);
      },
    });

    process.stdin.pipe(interceptor);
    this.inputInterceptor = interceptor;

    rl = readline.createInterface({
      input: interceptor,
      output: process.stdout,
      prompt: 'lportal> ',
    });
    this.rl = rl;

    setActiveReadline(rl);

    rl.prompt();

    return new Promise<void>((resolve) => {
      rl.on('line', async (displayLine) => {
        let cmd = displayLine.trim();

        // 若刚才粘贴了多行文本，用实际内容替换占位符
        if (this.pendingPasteText !== null) {
          cmd = this.pendingPasteText;
          this.pendingPasteText = null;
          this.pendingPasteLineCount = 0;
        }

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
    // 解除 stdin 管道并暂停输入，避免 /exit 后进程挂起
    if (this.inputInterceptor) {
      process.stdin.unpipe(this.inputInterceptor);
      this.inputInterceptor.destroy();
    }
    process.stdin.pause();
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
  portal.server.portalApp = portal;
  try {
    await portal.run();
  } catch {
    // ignore
  }
}
