/** 斜杠命令处理器 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import clipboardy from 'clipboardy';
import { WebSocket } from 'ws';
import { _ } from './i18n.js';
import { beautifyText } from './beauty.js';
import { getFileTransferManager } from './file-transfer.js';
import { printMessage, printSessionList, printList, printStatus, printBeautyList, printDevices, printHelp } from './ui.js';
import { generateQrAscii, openBrowser } from './qr.js';
import type { ServerConfig } from './config.js';
import type { Server } from './server.js';
import type { PortalApp } from './main.js';

export class CommandHandler {
  config: ServerConfig;
  server: Server;
  app: PortalApp | null;

  constructor(config: ServerConfig, server: Server, app: PortalApp | null = null) {
    this.config = config;
    this.server = server;
    this.app = app;
  }

  async handle(cmdLine: string): Promise<string> {
    let parts: string[];
    try {
      parts = shlexSplit(cmdLine.trim());
    } catch {
      parts = cmdLine.trim().split(/\s+/);
    }
    if (!parts.length) return '';

    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/auto': return this._handleAuto(args);
      case '/copy': return this._handleCopy(args);
      case '/list':
      case '/ls': return this._handleList();
      case '/status': return this._handleStatus();
      case '/open': return this._handleOpen();
      case '/qrcode':
      case '/qr': return await this._handleQrcode();
      case '/downloads': return this._handleDownloads();
      case '/help': return this._handleHelp();
      case '/exit': return this._handleExit();
      case '/refresh-qrcode':
      case '/rq': return this._handleRefreshQrcode();
      case '/mode': return await this._handleMode(args);
      case '/new-session': return this._handleNewSession();
      case '/beauty': return await this._handleBeauty(args);
      case '/beauty-history': return this._handleBeautyHistory();
      case '/beauty-copy': return this._handleBeautyCopy(args);
      case '/devices': return this._handleDevices();
      case '/link': return await this._handleLink(args);
      case '/unlink': return this._handleUnlink();
      case '/send': return await this._handleSend(args);
      default:
        return `${_('[?] Unknown command')}: ${cmd}, ${_('type /help for available commands')}`;
    }
  }

  private _handleAuto(args: string[]): string {
    if (!args.length) {
      const status = this.config.autoCopy ? _('ON [OK]') : _('OFF [X]');
      return _('Auto copy mode: {status}', { status });
    }
    const arg = args[0].toLowerCase();
    if (arg === 'on' || arg === '1' || arg === 'true') {
      this.config.autoCopy = true;
      return _('[OK] Auto copy mode: ON');
    } else if (arg === 'off' || arg === '0' || arg === 'false') {
      this.config.autoCopy = false;
      return _('[OK] Auto copy mode: OFF');
    }
    return _('Usage: /auto [on|off]');
  }

  private _handleCopy(args: string[]): string {
    try {
      let entry;
      if (!args.length) {
        if (this.config.history.length === 0) return _('[!] No history messages');
        entry = this.config.history.get(1);
      } else {
        entry = this.config.history.get(parseInt(args[0], 10));
      }
      const sessionEntries = this.config.history.list().filter(e => e.sessionId === entry.sessionId);
      sessionEntries.reverse();
      const copyText = sessionEntries.map(e => e.text).join('\n');
      const count = sessionEntries.length;
      let preview: string;
      if (count > 1) {
        preview = `[${count}${_('items')}] ${entry.preview.slice(0, 20)}...`;
      } else {
        preview = entry.preview.length > 30 ? entry.preview.slice(0, 30) + '...' : entry.preview;
      }
      clipboardy.writeSync(copyText);
      return `${_('[OK] Copied')}: ${preview}`;
    } catch (e: any) {
      return _('[!] {e}', { e: e.message });
    }
  }

  private _handleList(): string {
    const entries = this.config.history.list();
    if (!entries.length) return _('No history messages');
    printSessionList(entries);
    return '';
  }

  private _handleStatus(): string {
    printStatus(this.config);
    return '';
  }

  private _handleOpen(): string {
    openBrowser(this.config.localUrl);
    return `${_('[OK] Opened in browser')} ${this.config.localUrl}`;
  }

  private async _handleQrcode(): Promise<string> {
    const url = this.config.qrUrl;
    const pairingCode = this.config.pairingCode;
    const qrAscii = await generateQrAscii(url);
    const lines = [
      '',
      '='.repeat(50),
      _('Scan the QR code with your phone or visit the address below'),
      '',
      qrAscii,
      '',
      `${_('Pairing code')}: ${pairingCode}`,
      `${_('Address')}: ${url}`,
      '='.repeat(50),
      '',
    ];
    return lines.join('\n');
  }

  private _handleHelp(): string {
    return printHelp();
  }

  private _handleDownloads(): string {
    try {
      const ftm = getFileTransferManager();
      ftm.openDownloadsFolder();
      return `${_('[OK] Download folder opened')}: ${ftm.downloadDir}`;
    } catch (e: any) {
      return `${_('[!] Failed to open download folder')}: ${e.message}`;
    }
  }

  private _handleExit(): string {
    throw new SystemExit();
  }

  private _handleRefreshQrcode(): string {
    const oldCode = this.config.pairingCode;
    const newCode = this.config.refreshPairingCode();
    for (const client of this.server.verifiedClients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify({ type: 'auth_failed', message: _('Pairing code refreshed, please re-login') }));
          client.close();
        } catch {}
      }
    }
    this.server.verifiedClients.clear();
    return `${_('[OK] Pairing code refreshed')}: ${oldCode} -> ${newCode}, ${_('All clients disconnected')}`;
  }

  private async _handleMode(args: string[]): Promise<string> {
    if (!args.length) {
      const modeDesc = this.config.copyMode === 'add' ? _('append') : _('cover');
      return `${_('Current copy mode')}: ${this.config.copyMode} (${modeDesc})`;
    }
    const mode = args[0].toLowerCase();
    if (mode === 'cover') {
      if (this.config.copyMode !== 'cover') {
        this.config.copyMode = 'cover';
        this.config.newSession();
        this.config.sessionBuffer = '';
        await this.server.broadcast({ type: 'mode_changed', mode: 'cover', message: _('Switched to cover mode') });
      }
      return _('[OK] Copy mode: cover (overwrite)');
    } else if (mode === 'add') {
      if (this.config.copyMode !== 'add') {
        this.config.copyMode = 'add';
        this.config.newSession();
        await this.server.broadcast({ type: 'mode_changed', mode: 'add', message: _('Switched to append mode') });
      }
      return _('[OK] Copy mode: add (append)');
    }
    return _('Usage: /mode [cover|add]\n  cover - overwrite mode, new message overwrites previous (default)\n  add   - append mode, new message appends to end');
  }

  private _handleNewSession(): string {
    if (this.config.copyMode !== 'add') {
      return _('[!] /new-session is only available in append mode, currently in overwrite mode');
    }
    this.config.sessionBuffer = '';
    return _('[OK] Session refreshed, next message will be the first');
  }

  private async _handleBeauty(args: string[]): Promise<string> {
    try {
      let entry;
      if (!args.length) {
        if (this.config.history.length === 0) return _('[!] No history messages');
        entry = this.config.history.get(1);
      } else {
        entry = this.config.history.get(parseInt(args[0], 10));
      }
      const sessionEntries = this.config.history.list().filter(e => e.sessionId === entry.sessionId);
      sessionEntries.reverse();
      const originalText = sessionEntries.map(e => e.text).join('\n');

      const result = await beautifyText(originalText);
      this.config.beautyHistory.add(originalText, result, entry.deviceName, entry.loginId);
      await clipboardy.write(result);
      return _('[OK] Beautified and copied to clipboard');
    } catch (e: any) {
      return `${_('[!] Beautification failed')}: ${e.message}`;
    }
  }

  private _handleBeautyHistory(): string {
    const entries = this.config.beautyHistory.list();
    if (!entries.length) return _('No beautification records');
    printBeautyList(entries);
    return '';
  }

  private _handleBeautyCopy(args: string[]): string {
    try {
      let entry;
      if (!args.length) {
        if (this.config.beautyHistory.length === 0) return _('[!] No beautification records');
        entry = this.config.beautyHistory.get(1);
      } else {
        entry = this.config.beautyHistory.get(parseInt(args[0], 10));
      }
      clipboardy.writeSync(entry.result);
      const preview = entry.preview.length > 30 ? entry.preview.slice(0, 30) + '...' : entry.preview;
      return `${_('[OK] Copied')}: ${preview}`;
    } catch (e: any) {
      return _('[!] {e}', { e: e.message });
    }
  }

  private _handleDevices(): string {
    const onlineDevices = Array.from(this.server.devices.values()).filter(
      info => info.ws && info.ws.readyState === WebSocket.OPEN
    );
    if (!onlineDevices.length) return _('No online devices');
    printDevices(onlineDevices);
    return '';
  }

  private async _handleLink(args: string[]): Promise<string> {
    if (!args.length) {
      if (this.app?.linkedDeviceName) {
        return `${_('Currently linked device')}: ${this.app.linkedDeviceName} (${this.app.linkedLoginId})`;
      }
      return _('Usage: /link <device_name or login_id>');
    }
    const target = args[0].trim();
    let device = this.server.devices.get(target);
    if (!device) {
      for (const info of this.server.devices.values()) {
        if (info.deviceName === target && info.ws && info.ws.readyState === WebSocket.OPEN) {
          device = info;
          break;
        }
      }
    }
    if (!device || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
      return `${_('[!] Online device not found')}: ${target}`;
    }
    if (this.app) {
      this.app.linkedDeviceName = device.deviceName;
      this.app.linkedLoginId = device.loginId;
      this.app.updatePrompt();
    }
    return `${_('[OK] Entered device session mode')}: ${device.deviceName} (${device.loginId})\n${_('Hint: type directly to send, /unlink to exit')}`;
  }

  private _handleUnlink(): string {
    if (this.app) {
      const oldName = this.app.linkedDeviceName;
      this.app.linkedDeviceName = '';
      this.app.linkedLoginId = '';
      this.app.updatePrompt();
      if (oldName) return _('[OK] Exited session mode with {name}', { name: oldName });
    }
    return _('[!] Not in any device session mode');
  }

  private async _handleSend(args: string[]): Promise<string> {
    if (!this.app || !this.app.linkedLoginId) {
      return _('[!] /send must be used after /link session mode, please run /link <device_name> first');
    }
    if (!args.length) {
      return _('Usage: /send <filepath> [<filepath2> ...]\nExample: /send C:\\Users\\xx\\Documents\\file.pdf "C:\\path with spaces\\file2.jpg"');
    }

    const results: string[] = [];
    for (const filepath of args) {
      let resolved = filepath;
      if (resolved.startsWith('~/')) resolved = path.join(os.homedir(), resolved.slice(1));
      resolved = path.resolve(resolved);

      if (!fs.existsSync(resolved)) {
        results.push(`${_('[!] File does not exist')}: ${filepath}`);
        continue;
      }
      if (!fs.statSync(resolved).isFile()) {
        results.push(`${_('[!] Not a file')}: ${filepath}`);
        continue;
      }
      const fileSize = fs.statSync(resolved).size;
      try {
        const result = await this.server.sendServerFile(resolved, this.app.linkedLoginId);
        if (result) {
          results.push(`${_('[OK] File sent to')} ${this.app.linkedDeviceName}: ${path.basename(resolved)} (${(fileSize / 1024).toFixed(1)}KB)`);
        } else {
          results.push(_('[!] Send failed, device may be offline'));
        }
      } catch (e: any) {
        results.push(`${_('[!] Send failed')}: ${e.message}`);
      }
    }
    return results.join('\n');
  }
}

export class SystemExit extends Error {
  constructor() {
    super('SystemExit');
    this.name = 'SystemExit';
  }
}

function shlexSplit(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
    } else if (!inQuotes && /\s/.test(char)) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) result.push(current);
  return result;
}
