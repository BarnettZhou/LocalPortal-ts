/** 终端 UI - 使用 chalk */

import chalk from 'chalk';
import { _ } from './i18n.js';
import type { ServerConfig } from './config.js';
import type { MessageEntry, BeautyEntry } from './history.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let activeRl: any = null;

export function setActiveReadline(rl: any): void {
  activeRl = rl;
}

export function printMessage(msg: string, style?: string): void {
  if (!activeRl) {
    if (style) {
      console.log(styleToChalk(style)(msg));
    } else {
      console.log(msg);
    }
    return;
  }

  const line = activeRl.line || '';
  const prompt = activeRl._prompt || '';
  process.stdout.write('\r\x1b[K');
  if (style) {
    console.log(styleToChalk(style)(msg));
  } else {
    console.log(msg);
  }
  process.stdout.write(prompt + line);
}

function styleToChalk(style: string): (s: string) => string {
  const parts = style.split(' ');
  let fn = chalk;
  for (const p of parts) {
    if (p === 'bold') fn = fn.bold as unknown as typeof chalk;
    else if (p === 'red') fn = fn.red as unknown as typeof chalk;
    else if (p === 'green') fn = fn.green as unknown as typeof chalk;
    else if (p === 'yellow') fn = fn.yellow as unknown as typeof chalk;
    else if (p === 'cyan') fn = fn.cyan as unknown as typeof chalk;
    else if (p === 'dim') fn = fn.dim as unknown as typeof chalk;
  }
  return fn as unknown as (s: string) => string;
}

export function printBanner(config: ServerConfig): void {
  printMessage('');
  printMessage(_('Local Portal starting...'), 'bold green');
  printMessage('-'.repeat(40));
  printMessage('');
  printMessage(`${_('Service address')}:`);
  printMessage(`   ${_('Local')}:   ${config.localUrl}`);
  printMessage(`   ${_('LAN')}: ${config.lanUrl}`);
  printMessage('');
  printMessage(`${_('Pairing code')}: ${config.pairingCode}`);
  printMessage('');
  const modeDesc = config.copyMode === 'add' ? _('append') : _('cover');
  printMessage(`${_('Copy mode')}: ${modeDesc} ${_('Switch with /mode')}`);
  printMessage(_('Hint: use /qr to show QR code'));
  printMessage('');
  printMessage('-'.repeat(40));
  printMessage(_('Hint: type /help for available commands'));
  printMessage('');
}

export function printStatus(config: ServerConfig): void {
  printMessage('');
  printMessage(_('Local Portal status'), 'bold');
  printMessage('');
  printMessage(_('Service address'));
  printMessage(`  ${_('Local')}:   ${config.localUrl}`);
  printMessage(`  ${_('LAN')}: ${config.lanUrl}`);
  printMessage('');
  printMessage(_('Security'));
  printMessage(`  ${_('Pairing code')}:        ${config.pairingCode}`);
  printMessage('');
  printMessage(_('Runtime status'));
  const autoStatus = config.autoCopy ? _('ON [OK]') : _('OFF [X]');
  const modeStatus = config.copyMode === 'add' ? _('append') : _('cover');
  printMessage(`  ${_('Auto copy mode')}:  ${autoStatus}`);
  printMessage(`  ${_('Copy mode')}:      ${modeStatus} (/mode)`);
  if (config.copyMode === 'add' && config.sessionBuffer) {
    const preview = config.sessionBuffer.length > 30 ? config.sessionBuffer.slice(0, 30) + '...' : config.sessionBuffer;
    printMessage(`  ${_('Session buffer')}:    "${preview}"`);
  }
  printMessage(`  ${_('Online clients')}:    ${config.connectedClients.size}`);
  printMessage(`  ${_('History messages')}:    ${config.history.length} / ${config.history.maxSize}`);
  printMessage(`  ${_('Uptime')}:      ${config.uptime}`);
  printMessage('');
  printMessage(_('Recent activity'));
  const lastTime = config.history.lastReceivedTime();
  if (lastTime) {
    const timeStr = formatTime(lastTime);
    const delta = Math.floor((Date.now() - lastTime.getTime()) / 1000);
    let ago: string;
    if (delta < 60) ago = _('Just now');
    else if (delta < 3600) ago = `${Math.floor(delta / 60)}${_('minutes ago')}`;
    else ago = `${Math.floor(delta / 3600)}${_('hours ago')}`;
    printMessage(`  ${_('Last received')}:      ${timeStr} (${ago})`);
    if (config.history.length > 0) {
      const lastMsg = config.history.list()[0];
      const preview = lastMsg.preview.length > 30 ? lastMsg.preview.slice(0, 30) + '...' : lastMsg.preview;
      printMessage(`  ${_('Message preview')}:      "${preview}"`);
    }
  } else {
    printMessage(`  ${_('Last received')}:      ${_('None')}`);
  }
  printMessage('');
}

function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    width += code > 127 ? 2 : 1;
  }
  return width;
}

function truncateText(text: string, maxWidth: number): string {
  if (textWidth(text) <= maxWidth) return text;
  let result = '';
  let w = 0;
  for (const char of text) {
    const cw = (char.codePointAt(0) || 0) > 127 ? 2 : 1;
    if (w + cw > maxWidth - 3) break;
    result += char;
    w += cw;
  }
  return result + '...';
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

export function printList(entries: MessageEntry[]): void {
  if (!entries.length) {
    printMessage(_('No history messages'));
    return;
  }
  printMessage('');
  const PREVIEW_MAX_WIDTH = 40;
  const header = `${_('ID').padEnd(4)} ${truncateText(_('Preview'), PREVIEW_MAX_WIDTH).padEnd(PREVIEW_MAX_WIDTH)} ${_('Time').padEnd(8)}`;
  printMessage(header, 'dim');
  printMessage('-'.repeat(61), 'dim');
  for (const entry of entries) {
    const timeStr = formatTime(entry.time);
    const preview = truncateText(entry.preview, PREVIEW_MAX_WIDTH);
    const padding = ' '.repeat(PREVIEW_MAX_WIDTH - textWidth(preview));
    const row = `${String(entry.id).padEnd(4)} ${preview}${padding} ${timeStr}`;
    printMessage(row);
  }
  printMessage('');
}

export function printSessionList(entries: MessageEntry[]): void {
  if (!entries.length) {
    printMessage(_('No history messages'));
    return;
  }
  printMessage('');
  const PREVIEW_MAX_WIDTH = 28;
  const SOURCE_MAX_WIDTH = 20;
  const header = `${_('ID').padEnd(4)} ${truncateText(_('Preview'), PREVIEW_MAX_WIDTH).padEnd(PREVIEW_MAX_WIDTH)} ${truncateText(_('Source'), SOURCE_MAX_WIDTH).padEnd(SOURCE_MAX_WIDTH)} ${_('Time').padEnd(8)}`;
  printMessage(header, 'dim');
  printMessage('-'.repeat(4 + 1 + PREVIEW_MAX_WIDTH + 1 + SOURCE_MAX_WIDTH + 1 + 8), 'dim');

  // 按 sessionId 分组（entries 是按时间倒序的）
  const sessions: { id: number; count: number; text: string; time: Date; sessionId: number; deviceName: string; loginId: string }[] = [];
  let i = 0;
  while (i < entries.length) {
    const msg = entries[i];
    const msgs = [msg];
    let j = i + 1;
    while (j < entries.length && entries[j].sessionId === msg.sessionId) {
      msgs.push(entries[j]);
      j++;
    }
    const texts = msgs.map(m => m.text).reverse().join(' | ');
    sessions.push({
      id: msgs[0].id,
      count: msgs.length,
      text: texts,
      time: msgs[0].time,
      sessionId: msg.sessionId,
      deviceName: msgs[0].deviceName,
      loginId: msgs[0].loginId,
    });
    i = j;
  }

  for (const session of sessions) {
    const timeStr = formatTime(session.time);
    let previewText: string;
    if (session.count > 1) {
      previewText = `[${session.count}${_('items')}] ${session.text}`;
    } else {
      previewText = session.text;
    }
    const preview = truncateText(previewText, PREVIEW_MAX_WIDTH);
    const previewPadding = ' '.repeat(PREVIEW_MAX_WIDTH - textWidth(preview));
    const sourceText = session.loginId ? `${session.deviceName}-${session.loginId}` : '-';
    const source = truncateText(sourceText, SOURCE_MAX_WIDTH);
    const sourcePadding = ' '.repeat(SOURCE_MAX_WIDTH - textWidth(source));
    const row = `${String(session.id).padEnd(4)} ${preview}${previewPadding} ${source}${sourcePadding} ${timeStr}`;
    printMessage(row);
  }
  printMessage('');
}

export function printBeautyList(entries: BeautyEntry[]): void {
  if (!entries.length) {
    printMessage(_('No beautification records'));
    return;
  }
  printMessage('');
  const PREVIEW_MAX_WIDTH = 28;
  const SOURCE_MAX_WIDTH = 20;
  const header = `${_('ID').padEnd(4)} ${truncateText(_('Preview'), PREVIEW_MAX_WIDTH).padEnd(PREVIEW_MAX_WIDTH)} ${truncateText(_('Source'), SOURCE_MAX_WIDTH).padEnd(SOURCE_MAX_WIDTH)} ${_('Time').padEnd(8)}`;
  printMessage(header, 'dim');
  printMessage('-'.repeat(4 + 1 + PREVIEW_MAX_WIDTH + 1 + SOURCE_MAX_WIDTH + 1 + 8), 'dim');
  for (const entry of entries) {
    const timeStr = formatTime(entry.time);
    const preview = truncateText(entry.preview, PREVIEW_MAX_WIDTH);
    const previewPadding = ' '.repeat(PREVIEW_MAX_WIDTH - textWidth(preview));
    const sourceText = entry.loginId ? `${entry.deviceName}-${entry.loginId}` : '-';
    const source = truncateText(sourceText, SOURCE_MAX_WIDTH);
    const sourcePadding = ' '.repeat(SOURCE_MAX_WIDTH - textWidth(source));
    const row = `${String(entry.id).padEnd(4)} ${preview}${previewPadding} ${source}${sourcePadding} ${timeStr}`;
    printMessage(row);
  }
  printMessage('');
}

export function printNewMessage(entry: MessageEntry, autoCopied: boolean = false): void {
  const timeStr = formatTime(entry.time);
  const status = autoCopied ? ' [auto]' : '';
  const source = entry.deviceName ? `[${entry.deviceName}]` : '';
  const preview = truncateText(entry.text, 20);
  printMessage(`[${timeStr}] 收到${status} ${source}: ${preview}`);
}

interface DeviceLike {
  deviceName: string;
  loginId: string;
  loginTime: Date;
}

export function printDevices(devices: DeviceLike[]): void {
  if (!devices.length) {
    printMessage(_('No online devices'));
    return;
  }
  printMessage('');
  const header = `${_('Device name').padEnd(16)} ${_('Login ID').padEnd(10)} ${_('Login time').padEnd(20)}`;
  printMessage(header, 'dim');
  printMessage('-'.repeat(50), 'dim');
  for (const info of devices) {
    const timeStr = info.loginTime.toISOString().replace('T', ' ').slice(0, 19);
    const name = truncateText(info.deviceName, 16);
    const namePadding = ' '.repeat(16 - textWidth(name));
    printMessage(`${name}${namePadding} ${info.loginId.padEnd(10)} ${timeStr}`);
  }
  printMessage('');
}

export function printHelp(): string {
  printMessage(`\n${chalk.bold.green(_('Local Portal Command Help'))}\n`);

  const printCmd = (cmd: string, desc: string) => {
    printMessage(`  ${chalk.cyan(cmd.padEnd(22))}${desc}`);
  };

  printMessage(chalk.bold.yellow(_('Basic operations')));
  printCmd('/copy [N]', _('Copy history message (N=1-10, no arg = most recent)'));
  printCmd('/list (/ls)', _('List last 10 message summaries'));
  printCmd('/status', _('Show service runtime status'));
  printCmd('/open', _('Open main page in browser'));
  printCmd('/web', _('Open local web console'));
  printCmd('/qrcode (/qr)', _('Show QR code (scan to connect)'));
  printCmd('/downloads', _('Open download folder'));

  printMessage(chalk.bold.yellow(_('Mode & Session')));
  printCmd('/auto [on|off]', _('Enable/disable auto copy mode'));
  printCmd('/mode [cover|add]', _('Switch copy mode (cover=overwrite, add=append)'));
  printCmd('/new-session', _('Refresh session in append mode, clear buffer'));

  printMessage(chalk.bold.yellow(_('Device management')));
  printCmd('/devices', _('View all logged-in devices'));
  printCmd('/link <name|id>', _('Enter session mode with a specific device'));
  printCmd('/unlink', _('Exit device session mode'));
  printCmd('/send <filepath>', _('Send a file to current session device (use after /link)'));

  printMessage(chalk.bold.yellow(_('Text beautification')));
  printCmd('/beauty [N]', _('Beautify the Nth history message via LLM (default: most recent)'));
  printCmd('/beauty-history', _('View last 10 text beautification tasks'));
  printCmd('/beauty-copy [N]', _('Copy the Nth beautification result (default: most recent)'));

  printMessage(chalk.bold.yellow(_('Others')));
  printCmd('/refresh-qrcode (/rq)', _('Refresh pairing code (all clients need to re-login)'));
  printCmd('/help', _('Show this help'));
  printCmd('/exit', _('Exit program'));

  printMessage(`\n${chalk.bold(_('Mode description'))}:`);
  printMessage(`  ${chalk.dim('cover')} ${_('cover (default) - new message overwrites the previous one, good for single copy')}`);
  printMessage(`  ${chalk.dim('add')}   ${_('add - new message appends to the end, good for merging multiple')}`);

  printMessage(`\n${chalk.bold(_('Download directory settings'))}:`);
  printMessage(`  ${_('Default save to system download folder, customize via')} ${chalk.cyan('LPORTAL_DOWNLOAD_DIR')}`);
  printMessage(`\n  ${chalk.bold(_('Windows (PowerShell)'))}:`);
  printMessage(`    ${chalk.green('$env:LPORTAL_DOWNLOAD_DIR="C:\\Users\\xx\\Downloads"')}`);
  printMessage(`  ${chalk.bold(_('Windows (CMD)'))}:`);
  printMessage(`    ${chalk.green('set LPORTAL_DOWNLOAD_DIR=C:\\Users\\xx\\Downloads')}`);
  printMessage(`\n  ${chalk.bold(_('macOS / Linux (bash / zsh)'))}:`);
  printMessage(`    ${chalk.green('export LPORTAL_DOWNLOAD_DIR=/Users/xx/Downloads')}`);
  printMessage(`  ${chalk.bold(_('Permanent (append to ~/.bashrc or ~/.zshrc)'))}:`);
  printMessage(`    ${chalk.green('echo "export LPORTAL_DOWNLOAD_DIR=/Users/xx/Downloads" >> ~/.zshrc')}`);
  printMessage(`    ${chalk.green('source ~/.zshrc')}`);

  printMessage(`\n${chalk.bold(_('LLM config (text beautification)'))}:`);
  printMessage(`  ${_('Create .env file in one of the following places')}:`);
  printMessage(`    - ${_('Current working directory')}: ${chalk.cyan('./')}`);
  printMessage(`    - ${_('Windows')}: ${chalk.cyan('%APPDATA%\\localportal\\.env')}`);
  printMessage(`    - ${_('macOS')}: ${chalk.cyan('~/Library/Application Support/localportal/.env')}`);
  printMessage(`    - ${_('Linux')}: ${chalk.cyan('~/.config/localportal/.env')}`);
  printMessage(`\n  ${_('Config content')}:`);
  printMessage(`    ${chalk.green('OPENAI_BASE_URL=https://api.openai.com/v1')}`);
  printMessage(`    ${chalk.green('OPENAI_API_KEY=sk-xxxxxx')}`);
  printMessage(`    ${chalk.green('OPENAI_MODEL=gpt-4o-mini')}`);

  printMessage(`\n${chalk.bold(_('Custom prompt'))}:`);
  printMessage(`  ${_('Place text-beauty.md in user config dir to override default prompt')}`);
  printMessage('');
  return '';
}
