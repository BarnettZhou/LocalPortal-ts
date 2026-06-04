/** 配置状态管理 */

import { History, BeautyHistory } from './history.js';
import { getLocalIp } from './qr.js';

export function generatePairingCode(): string {
  return Math.floor(Math.random() * 10000).toString().padStart(4, '0');
}

export function validatePairingCode(code: string): boolean {
  if (!code || code.length !== 4) return false;
  return /^\d{4}$/.test(code);
}

export class ServerConfig {
  autoCopy: boolean;
  port: number;
  maxHistory: number;
  host: string;
  startTime: Date;
  connectedClients: Set<unknown> = new Set();
  pairingCode: string;
  copyMode: 'cover' | 'add' = 'cover';
  sessionBuffer: string = '';
  currentSessionId: number = 1;
  private _history: History;
  private _beautyHistory: BeautyHistory;

  constructor(
    autoCopy: boolean = true,
    port: number = 14554,
    maxHistory: number = 10,
    host: string = '0.0.0.0',
    pairingCode: string | null = null
  ) {
    this.autoCopy = autoCopy;
    this.port = port;
    this.maxHistory = maxHistory;
    this.host = host;
    this.startTime = new Date();
    this._history = new History(this.maxHistory);
    this._beautyHistory = new BeautyHistory(10);
    this.pairingCode = pairingCode ?? generatePairingCode();
  }

  newSession(): number {
    this.currentSessionId += 1;
    this.sessionBuffer = '';
    return this.currentSessionId;
  }

  refreshPairingCode(): string {
    this.pairingCode = generatePairingCode();
    return this.pairingCode;
  }

  get history(): History {
    return this._history;
  }

  get beautyHistory(): BeautyHistory {
    return this._beautyHistory;
  }

  get localUrl(): string {
    return `http://localhost:${this.port}`;
  }

  get lanUrl(): string {
    return `http://${getLocalIp()}:${this.port}`;
  }

  get qrUrl(): string {
    return `http://${getLocalIp()}:${this.port}/?code=${this.pairingCode}`;
  }

  get uptime(): string {
    const delta = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    const hours = Math.floor(delta / 3600);
    const minutes = Math.floor((delta % 3600) / 60);
    const seconds = delta % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
}
