/** HTTP + WebSocket 服务 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import clipboardy from 'clipboardy';
import type { ServerConfig } from './config.js';
import type { MessageEntry } from './history.js';
import type { PortalApp } from './main.js';
import { _ } from './i18n.js';
import { generateQrPng, generateQrHtml } from './qr.js';
import { getFileTransferManager, FileTransferManager } from './file-transfer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];
  private closed = false;

  put(item: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!.resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  putError(error: Error) {
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!.reject(error);
    } else {
      this.queue.push(error as unknown as T);
    }
  }

  async get(): Promise<T> {
    if (this.queue.length > 0) {
      const item = this.queue.shift()!;
      if (item instanceof Error) throw item;
      return item;
    }
    return new Promise((resolve, reject) => {
      this.resolvers.push({ resolve, reject });
    });
  }

  close(error?: Error) {
    this.closed = true;
    const err = error || new Error('Queue closed');
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!.reject(err);
    }
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }).catch((e) => { clearTimeout(timer); reject(e); });
  });
}

function isLocalhost(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export interface TerminalMessage {
  type: 'new_message' | 'clipboard_error' | 'file_received' | 'server_message_sent';
  entry?: MessageEntry;
  autoCopied?: boolean;
  error?: string;
  path?: string;
  name?: string;
  size?: number;
}

export interface DeviceInfo {
  deviceName: string;
  loginId: string;
  loginTime: Date;
  ws: WebSocket | null;
}

export class Server {
  config: ServerConfig;
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  terminalQueue = new AsyncQueue<TerminalMessage | null>();
  portalApp?: PortalApp;

  verifiedClients: Set<WebSocket> = new Set();
  devices: Map<string, DeviceInfo> = new Map(); // loginId -> DeviceInfo
  wsToLoginId: WeakMap<WebSocket, string> = new WeakMap();
  deviceRegistry: Map<string, string> = new Map(); // deviceName -> loginId
  fileRegistry: Map<string, string> = new Map(); // fileId -> filepath

  constructor(config: ServerConfig) {
    this.config = config;
  }

  private findStaticFile(filename: string): string | null {
    const candidates = [
      path.join(__dirname, 'static', filename),
      path.join(__dirname, '..', 'static', filename),
      path.join(__dirname, '..', '..', 'static', filename),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async start(): Promise<number> {
    this.httpServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const pathname = url.pathname;

      // /web 及 /api/* 仅限本机访问
      if ((pathname === '/web' || pathname.startsWith('/api/')) && !isLocalhost(req)) {
        sendError(res, 403, _('Forbidden: local access only'));
        return;
      }

      if (pathname === '/') {
        this.handleIndex(req, res);
      } else if (pathname === '/web') {
        this.handleWeb(req, res);
      } else if (pathname === '/api/devices') {
        this.handleApiDevices(req, res);
      } else if (pathname === '/api/link-status') {
        this.handleApiLinkStatus(req, res);
      } else if (pathname === '/api/link') {
        this.handleApiLink(req, res);
      } else if (pathname === '/api/unlink') {
        this.handleApiUnlink(req, res);
      } else if (pathname === '/api/history') {
        this.handleApiHistory(req, res);
      } else if (pathname === '/api/send-text') {
        this.handleApiSendText(req, res);
      } else if (pathname === '/api/send-file') {
        this.handleApiSendFile(req, res);
      } else if (pathname === '/qr') {
        this.handleQrPage(req, res);
      } else if (pathname === '/qr.png') {
        this.handleQrImage(req, res);
      } else if (pathname === '/upload/init') {
        this.handleUploadInit(req, res);
      } else if (pathname.startsWith('/upload/chunk/')) {
        this.handleUploadChunk(req, res);
      } else if (pathname.startsWith('/upload/complete/')) {
        this.handleUploadComplete(req, res);
      } else if (pathname.startsWith('/files/')) {
        this.handleFileDownload(req, res);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (ws) => {
      this.handleWebsocket(ws);
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url || '/', `http://${request.headers.host}`);
      if (url.pathname === '/ws') {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    let port = this.config.port;
    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          this.httpServer!.once('error', reject);
          this.httpServer!.listen(port, this.config.host, () => {
            this.httpServer!.off('error', reject);
            resolve();
          });
        });
        this.config.port = port;
        return port;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
          port += 1;
        } else {
          throw new Error(_('Could not bind port {start}-{end}', { start: this.config.port, end: port }));
        }
      }
    }
    return port;
  }

  async stop(force: boolean = true): Promise<void> {
    if (this.verifiedClients.size > 0) {
      const closeMsg = JSON.stringify({ type: 'server_close', message: _('Service closed') });
      for (const client of this.verifiedClients) {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(closeMsg); } catch {}
        }
      }
      for (const client of this.verifiedClients) {
        if (client.readyState === WebSocket.OPEN) {
          try { client.close(); } catch {}
        }
      }
      this.verifiedClients.clear();
      this.config.connectedClients.clear();
    }

    return new Promise((resolve) => {
      // 强制关闭仍保持的 HTTP 连接，避免 /exit 因浏览器长连接而卡住
      try { (this.httpServer as any).closeAllConnections?.(); } catch {}
      this.wss?.close(() => {
        this.httpServer?.close(() => {
          resolve();
        });
      });
    });
  }

  private handleIndex(_req: http.IncomingMessage, res: http.ServerResponse) {
    const indexFile = this.findStaticFile('index.html');
    if (indexFile) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      fs.createReadStream(indexFile).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(_('index.html not found'));
    }
  }

  private handleQrPage(_req: http.IncomingMessage, res: http.ServerResponse) {
    const html = generateQrHtml(this.config.qrUrl);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(html);
  }

  private async handleQrImage(_req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const buffer = await generateQrPng(this.config.qrUrl);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(buffer);
    } catch {
      res.writeHead(500);
      res.end('QR generation failed');
    }
  }

  // ==================== 本地网页控制台 /web ====================

  private handleWeb(_req: http.IncomingMessage, res: http.ServerResponse) {
    const webFile = this.findStaticFile('web.html');
    if (webFile) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(webFile).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(_('web.html not found'));
    }
  }

  private handleApiDevices(_req: http.IncomingMessage, res: http.ServerResponse) {
    const onlineDevices = Array.from(this.devices.values())
      .filter(info => info.ws && info.ws.readyState === WebSocket.OPEN)
      .map(info => ({
        deviceName: info.deviceName,
        loginId: info.loginId,
        loginTime: info.loginTime.toISOString(),
      }));
    sendJson(res, 200, { devices: onlineDevices });
  }

  private handleApiLinkStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
    const app = this.portalApp;
    sendJson(res, 200, {
      linked: !!(app && app.linkedLoginId),
      deviceName: app?.linkedDeviceName || '',
      loginId: app?.linkedLoginId || '',
    });
  }

  private async handleApiLink(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') {
      sendError(res, 405, _('Method not allowed'));
      return;
    }
    const body = await readJsonBody(req);
    const target = String(body.target || '').trim();
    if (!target) {
      sendError(res, 400, _('Missing target device'));
      return;
    }
    let device = this.devices.get(target);
    if (!device) {
      for (const info of this.devices.values()) {
        if (info.deviceName === target && info.ws && info.ws.readyState === WebSocket.OPEN) {
          device = info;
          break;
        }
      }
    }
    if (!device || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
      sendError(res, 404, _('Online device not found'));
      return;
    }
    if (this.portalApp) {
      this.portalApp.linkedDeviceName = device.deviceName;
      this.portalApp.linkedLoginId = device.loginId;
      this.portalApp.updatePrompt();
    }
    sendJson(res, 200, { success: true, deviceName: device.deviceName, loginId: device.loginId });
  }

  private async handleApiUnlink(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') {
      sendError(res, 405, _('Method not allowed'));
      return;
    }
    if (this.portalApp) {
      this.portalApp.linkedDeviceName = '';
      this.portalApp.linkedLoginId = '';
      this.portalApp.updatePrompt();
    }
    sendJson(res, 200, { success: true });
  }

  private handleApiHistory(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const loginId = url.searchParams.get('login_id') || '';
    if (!loginId) {
      sendError(res, 400, _('Missing login_id'));
      return;
    }
    const entries = this.config.history.list()
      .filter(e => e.loginId === loginId || e.targetLoginId === loginId)
      .reverse()
      .map(e => ({
        id: e.id,
        text: e.text,
        preview: e.preview,
        time: e.time.toISOString(),
        session_id: e.sessionId,
        device_name: e.deviceName,
        login_id: e.loginId,
        target_login_id: e.targetLoginId,
        file_id: e.fileId,
        file_name: e.fileName,
        file_size: e.fileSize,
        mime_type: e.mimeType,
      }));
    sendJson(res, 200, { history: entries });
  }

  private async handleApiSendText(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') {
      sendError(res, 405, _('Method not allowed'));
      return;
    }
    const body = await readJsonBody(req);
    const content = String(body.content || '').trim();
    if (!content) {
      sendError(res, 400, _('Message content is empty'));
      return;
    }
    const app = this.portalApp;
    if (!app || !app.linkedLoginId) {
      sendError(res, 400, _('Not linked to any device'));
      return;
    }
    try {
      const entry = await this.sendServerText(content, app.linkedLoginId);
      if (!entry) {
        sendError(res, 502, _('Failed to send, device may be offline'));
        return;
      }
      sendJson(res, 200, {
        success: true,
        id: entry.id,
        text: entry.text,
        preview: entry.preview,
        time: entry.time.toISOString(),
        session_id: entry.sessionId,
      });
    } catch (e: any) {
      sendError(res, 500, e.message || _('Send failed'));
    }
  }

  private handleApiSendFile(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') {
      sendError(res, 405, _('Method not allowed'));
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const loginId = url.searchParams.get('login_id') || '';
    const name = decodeURIComponent(url.searchParams.get('name') || '');
    const mimeType = decodeURIComponent(url.searchParams.get('mime') || 'application/octet-stream');
    const expectedSize = Number(url.searchParams.get('size') || 0);
    if (!loginId || !name) {
      sendError(res, 400, _('Missing file parameters'));
      return;
    }
    const app = this.portalApp;
    if (!app || app.linkedLoginId !== loginId) {
      sendError(res, 400, _('Not linked to target device'));
      return;
    }
    const tmpDir = path.join(os.tmpdir(), `lportal-web-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const safeName = path.basename(name) || 'file';
    const tmpPath = path.join(tmpDir, safeName);
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch (e: any) {
      sendError(res, 500, e.message || _('Failed to receive file'));
      return;
    }
    const writeStream = fs.createWriteStream(tmpPath);
    req.pipe(writeStream);
    writeStream.on('error', (err) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      sendError(res, 500, err.message || _('Failed to receive file'));
    });
    writeStream.on('finish', async () => {
      try {
        const stats = fs.statSync(tmpPath);
        if (expectedSize > 0 && stats.size !== expectedSize) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          sendError(res, 400, _('File size mismatch'));
          return;
        }
        const result = await this.sendServerFile(tmpPath, loginId);
        if (!result) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          sendError(res, 502, _('Failed to send, device may be offline'));
          return;
        }
        sendJson(res, 200, { success: true, file_id: result.file_id, name, size: stats.size, mime_type: mimeType });
      } catch (e: any) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        sendError(res, 500, e.message || _('Send failed'));
      }
    });
  }

  // ==================== HTTP 流式上传 ====================

  private handleUploadInit(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const name = decodeURIComponent(url.searchParams.get('name') || '');
    const size = Number(url.searchParams.get('size') || 0);
    const mimeType = decodeURIComponent(url.searchParams.get('mime') || '');
    const loginId = url.searchParams.get('login_id') || '';

    if (!name) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing file name' }));
      return;
    }

    const ftm = getFileTransferManager();
    const [fileId, error] = ftm.startTransfer(name, size, mimeType, loginId || undefined);

    if (fileId) {
      console.log(`[upload] init ${fileId} name=${name} size=${size} mime=${mimeType} loginId=${loginId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fileId, chunkSize: FileTransferManager.CHUNK_SIZE }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    }
  }

  private handleUploadChunk(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const parts = url.pathname.split('/');
    const fileId = parts[3] || '';
    const index = Number(parts[4] || 0);

    const ftm = getFileTransferManager();
    const fileInfo = ftm.activeTransfers.get(fileId);
    if (!fileInfo) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '传输不存在或已过期' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const [success, error] = ftm.receiveChunk(fileId, buffer, index);
      if (success) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, received: fileInfo.receivedSize }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error }));
      }
    });
    req.on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Upload error: ${err.message}` }));
    });
  }

  private handleUploadComplete(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const parts = url.pathname.split('/');
    const transferId = parts[3] || '';

    const ftm = getFileTransferManager();
    const fileInfo = ftm.activeTransfers.get(transferId);
    const [savePath, error] = ftm.completeTransfer(transferId);

    if (savePath && fileInfo) {
      const stats = fs.statSync(savePath);
      const fileName = path.basename(savePath);
      console.log(`[upload] complete transfer=${transferId} saved=${fileName} size=${stats.size} uploader=${fileInfo.uploaderLoginId}`);

      // 注册 HTTP 下载路径
      const downloadFileId = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      this.fileRegistry.set(downloadFileId, savePath);

      // 记录到历史，便于手机端和 web 控制台回放
      const uploader = this.devices.get(fileInfo.uploaderLoginId || '');
      const deviceName = uploader?.deviceName || '';
      const loginId = fileInfo.uploaderLoginId || '';
      const sessionId = this.config.currentSessionId;
      this.config.history.add(
        `[文件] ${fileName}`,
        sessionId,
        deviceName,
        loginId,
        '',
        downloadFileId,
        fileName,
        stats.size,
        fileInfo.mimeType
      );

      // 通知上传者（手机端），让它显示在聊天窗口里
      if (uploader?.ws && uploader.ws.readyState === WebSocket.OPEN) {
        uploader.ws.send(JSON.stringify({
          type: 'server_file_ready',
          file_id: downloadFileId,
          name: fileName,
          size: stats.size,
          mime_type: fileInfo.mimeType,
          download_url: `/files/${downloadFileId}`,
          session_id: sessionId,
          device_name: deviceName,
          login_id: loginId,
        }));
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, path: savePath, size: stats.size, file_id: downloadFileId }));
      this.terminalQueue.put({ type: 'file_received', path: savePath, name: fileName, size: stats.size });
    } else {
      console.log(`[upload] complete failed transfer=${transferId} error=${error || 'unknown'}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error || '传输不存在或已过期' }));
    }
  }

  // ==================== HTTP 文件下载（支持 Range）====================

  private handleFileDownload(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const fileId = url.pathname.replace('/files/', '');
    const filePath = this.fileRegistry.get(fileId);
    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(_('File not found'));
      return;
    }

    const stats = fs.statSync(filePath);
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.mp4': 'video/mp4',
      '.mov': 'video/quicktime', '.webm': 'video/webm',
      '.avi': 'video/x-msvideo', '.pdf': 'application/pdf',
      '.txt': 'text/plain', '.json': 'application/json',
      '.md': 'text/markdown', '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.zip': 'application/zip',
    };
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = mimeMap[ext] || 'application/octet-stream';

    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      if (isNaN(start) || start >= stats.size || end >= stats.size || start > end) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stats.size}`,
          'Content-Type': mimeType,
        });
        res.end();
        return;
      }
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': mimeType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  }

  private _generateLoginId(): string {
    return Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  }

  private _getOnlineDeviceNames(): Set<string> {
    const names = new Set<string>();
    for (const info of this.devices.values()) {
      if (info.ws && info.ws.readyState === WebSocket.OPEN) {
        names.add(info.deviceName);
      }
    }
    return names;
  }

  getDeviceByWs(ws: WebSocket): DeviceInfo | null {
    const loginId = this.wsToLoginId.get(ws);
    if (loginId) return this.devices.get(loginId) || null;
    return null;
  }

  async sendToDevice(loginId: string, message: object): Promise<boolean> {
    const device = this.devices.get(loginId);
    if (device?.ws && device.ws.readyState === WebSocket.OPEN) {
      try {
        device.ws.send(JSON.stringify(message));
        return true;
      } catch {}
    }
    return false;
  }

  async broadcast(message: object): Promise<void> {
    const data = JSON.stringify(message);
    for (const client of this.verifiedClients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch {}
      }
    }
  }

  private async handleWebsocket(ws: WebSocket) {
    const messageQueue = new AsyncQueue<WebSocket.RawData>();
    ws.on('message', (data) => messageQueue.put(data));
    ws.on('close', () => messageQueue.close());

    // 1. 等待配对码验证
    let authenticated = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rawData = await withTimeout(messageQueue.get(), 10000);
        const data = JSON.parse(rawData.toString());
        if (data.type === 'auth') {
          if (data.code !== this.config.pairingCode) {
            ws.send(JSON.stringify({ type: 'auth_failed', message: _('Incorrect pairing code') }));
            continue;
          }
          ws.send(JSON.stringify({ type: 'auth_success' }));
          authenticated = true;
          break;
        } else {
          ws.send(JSON.stringify({ type: 'auth_failed', message: _('Please send pairing code first') }));
          continue;
        }
      } catch {
        ws.send(JSON.stringify({ type: 'auth_failed', message: _('Connection timed out, please re-enter pairing code') }));
        continue;
      }
    }

    if (!authenticated) {
      ws.close();
      return;
    }

    // 2. 等待设备注册
    let registered = false;
    let deviceInfo: DeviceInfo | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const rawData = await withTimeout(messageQueue.get(), 10000);
        const data = JSON.parse(rawData.toString());
        if (data.type === 'register') {
          const deviceName = String(data.device_name || '').trim();
          if (!deviceName) {
            ws.send(JSON.stringify({ type: 'register_failed', message: _('Device name cannot be empty') }));
            continue;
          }
          const onlineNames = this._getOnlineDeviceNames();
          if (onlineNames.has(deviceName)) {
            ws.send(JSON.stringify({ type: 'register_failed', message: _("Device name '{name}' is already in use", { name: deviceName }) }));
            continue;
          }

          let loginId: string;
          if (this.deviceRegistry.has(deviceName)) {
            loginId = this.deviceRegistry.get(deviceName)!;
          } else {
            loginId = this._generateLoginId();
            while (this.devices.has(loginId)) {
              loginId = this._generateLoginId();
            }
            this.deviceRegistry.set(deviceName, loginId);
          }

          deviceInfo = {
            deviceName,
            loginId,
            loginTime: new Date(),
            ws,
          };
          this.devices.set(loginId, deviceInfo);
          this.wsToLoginId.set(ws, loginId);

          ws.send(JSON.stringify({
            type: 'register_success',
            login_id: loginId,
            device_name: deviceName,
          }));
          registered = true;
          break;
        } else {
          ws.send(JSON.stringify({ type: 'register_failed', message: _('Please send device registration info first') }));
          continue;
        }
      } catch {
        ws.send(JSON.stringify({ type: 'register_failed', message: _('Registration timed out, please reconnect') }));
        continue;
      }
    }

    if (!registered || !deviceInfo) {
      ws.close();
      return;
    }

    // 3. 注册客户端到在线集合
    this.config.connectedClients.add(ws);
    this.verifiedClients.add(ws);

    try {
      // 4. 发送历史记录（只发送与该设备相关的）
      const currentLoginId = deviceInfo.loginId;
      const filteredHistory = this.config.history.list()
        .filter(e => e.loginId === currentLoginId || e.targetLoginId === currentLoginId)
        .map(e => ({
          id: e.id,
          text: e.text,
          time: e.time.toISOString(),
          preview: e.preview,
          session_id: e.sessionId,
          device_name: e.deviceName,
          login_id: e.loginId,
          target_login_id: e.targetLoginId,
          file_id: e.fileId,
          file_name: e.fileName,
          file_size: e.fileSize,
          mime_type: e.mimeType,
        }));
      ws.send(JSON.stringify({ type: 'history', data: filteredHistory }));

      // 5. 监听消息
      while (true) {
        const rawData = await messageQueue.get();
        try {
          const data = JSON.parse(rawData.toString());
          const msgType = data.type;
          if (msgType === 'text') {
            await this._handleTextMessage(String(data.content || ''), ws, data.client_id);
          } else if (msgType === 'file_start') {
            await this._handleFileStart(data, ws);
          } else if (msgType === 'file_chunk') {
            await this._handleFileChunk(data, ws);
          } else if (msgType === 'file_end') {
            await this._handleFileEnd(data, ws);
          } else if (msgType === 'file_cancel') {
            await this._handleFileCancel(data, ws);
          } else if (msgType === 'command') {
            await this._handleCommand(data, ws);
          }
        } catch {
          // ignore parse error
        }
      }
    } catch {
      // connection closed or queue closed
    } finally {
      // 6. 注销客户端
      this.config.connectedClients.delete(ws);
      this.verifiedClients.delete(ws);
      const loginId = this.wsToLoginId.get(ws);
      if (loginId) {
        this.wsToLoginId.delete(ws);
        const dev = this.devices.get(loginId);
        if (dev) dev.ws = null;
      }
    }
  }

  private async _handleTextMessage(text: string, sender: WebSocket, clientId?: string) {
    if (!text) return;
    const device = this.getDeviceByWs(sender);
    const deviceName = device?.deviceName || '';
    const loginId = device?.loginId || '';

    if (this.config.copyMode === 'cover') {
      this.config.newSession();
    }
    const sessionId = this.config.currentSessionId;
    const entry = this.config.history.add(text, sessionId, deviceName, loginId);

    let autoCopied = false;
    if (this.config.autoCopy) {
      try {
        let copyText: string;
        if (this.config.copyMode === 'add') {
          if (this.config.sessionBuffer) {
            this.config.sessionBuffer += '\n' + text;
          } else {
            this.config.sessionBuffer = text;
          }
          copyText = this.config.sessionBuffer;
        } else {
          copyText = text;
        }
        await clipboardy.write(copyText);
        autoCopied = true;
      } catch (e: any) {
        this.terminalQueue.put({ type: 'clipboard_error', error: e.message || _('Unknown error') });
      }
    }

    this.terminalQueue.put({ type: 'new_message', entry, autoCopied });

    const messageData = {
      type: 'new',
      data: {
        id: entry.id,
        text: entry.text,
        time: entry.time.toISOString(),
        preview: entry.preview,
        client_id: clientId,
        session_id: entry.sessionId,
        device_name: entry.deviceName,
        login_id: entry.loginId,
      },
    };

    if (device) {
      await this.sendToDevice(device.loginId, messageData);
    }
  }

  // ---------------- 兼容 WS 文件传输（内部已改为流式） ----------------

  private async _handleFileStart(data: any, sender: WebSocket) {
    const ftm = getFileTransferManager();
    const name = String(data.name || '');
    const size = Number(data.size || 0);
    const mimeType = String(data.mime_type || '');
    const device = this.getDeviceByWs(sender);
    const loginId = device?.loginId || '';
    const [fileId, error] = ftm.startTransfer(name, size, mimeType, loginId || undefined);
    if (fileId) {
      sender.send(JSON.stringify({ type: 'file_accept', file_id: fileId }));
    } else {
      sender.send(JSON.stringify({ type: 'file_error', error }));
    }
  }

  private async _handleFileChunk(data: any, sender: WebSocket) {
    const ftm = getFileTransferManager();
    const fileId = String(data.file_id || '');
    const chunkData = Buffer.from(String(data.data || ''), 'base64');
    const index = Number(data.index || 0);
    const [success, error] = ftm.receiveChunk(fileId, chunkData, index);
    if (success) {
      const [received, total] = ftm.getTransferProgress(fileId);
      sender.send(JSON.stringify({ type: 'file_progress', file_id: fileId, received, total }));
    } else {
      sender.send(JSON.stringify({ type: 'file_error', file_id: fileId, error }));
    }
  }

  private async _handleFileEnd(data: any, sender: WebSocket) {
    const ftm = getFileTransferManager();
    const fileId = String(data.file_id || '');
    const [savePath, error] = ftm.completeTransfer(fileId);
    if (savePath) {
      const stats = fs.statSync(savePath);
      sender.send(JSON.stringify({ type: 'file_saved', file_id: fileId, path: savePath, size: stats.size }));
      this.terminalQueue.put({ type: 'file_received', path: savePath, name: path.basename(savePath), size: stats.size });
    } else {
      sender.send(JSON.stringify({ type: 'file_error', file_id: fileId, error }));
    }
  }

  private async _handleFileCancel(data: any, _sender: WebSocket) {
    const ftm = getFileTransferManager();
    const fileId = String(data.file_id || '');
    ftm.cancelTransfer(fileId);
  }

  async sendServerText(text: string, targetLoginId: string): Promise<MessageEntry | null> {
    if (!text || !targetLoginId) return null;
    const sessionId = -(this.config.history.counterValue + 1);
    const entry = this.config.history.add(text, sessionId, _('Server'), 'server', targetLoginId);

    const messageData = {
      type: 'server_text',
      data: {
        id: entry.id,
        text: entry.text,
        time: entry.time.toISOString(),
        preview: entry.preview,
        session_id: entry.sessionId,
        device_name: entry.deviceName,
        login_id: entry.loginId,
      },
    };

    await this.sendToDevice(targetLoginId, messageData);
    this.terminalQueue.put({ type: 'server_message_sent', entry });
    return entry;
  }

  // ---------------- 服务端发文件：改用 HTTP 下载链接 ----------------

  async sendServerFile(filepath: string, targetLoginId: string): Promise<Record<string, unknown> | null> {
    if (!filepath || !targetLoginId) return null;
    if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) return null;

    const device = this.devices.get(targetLoginId);
    if (!device?.ws || device.ws.readyState !== WebSocket.OPEN) return null;

    const stats = fs.statSync(filepath);
    const fileSize = stats.size;
    const fileName = path.basename(filepath);

    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.gif': 'image/gif',
      '.webp': 'image/webp', '.mp4': 'video/mp4',
      '.mov': 'video/quicktime', '.webm': 'video/webm',
      '.avi': 'video/x-msvideo', '.pdf': 'application/pdf',
      '.txt': 'text/plain', '.json': 'application/json',
      '.md': 'text/markdown', '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.zip': 'application/zip',
    };
    const ext = path.extname(filepath).toLowerCase();
    let mimeType = mimeMap[ext] || 'application/octet-stream';

    const fileId = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    this.fileRegistry.set(fileId, filepath);

    const sessionId = -(this.config.history.counterValue + 1);
    this.config.history.add(
      `[文件] ${fileName}`, sessionId, _('Server'), 'server', targetLoginId,
      fileId, fileName, fileSize, mimeType
    );

    // 发送轻量 WS 消息，客户端通过 HTTP 流式下载
    await this.sendToDevice(targetLoginId, {
      type: 'server_file_ready',
      file_id: fileId,
      name: fileName,
      size: fileSize,
      mime_type: mimeType,
      download_url: `/files/${fileId}`,
      session_id: sessionId,
      device_name: _('Server'),
      login_id: 'server',
    });

    return { file_id: fileId, name: fileName, size: fileSize, mime_type: mimeType };
  }

  private async _handleCommand(data: any, sender: WebSocket) {
    const command = String(data.command || '');
    if (command === 'new_session') {
      if (this.config.copyMode === 'add') {
        this.config.newSession();
        sender.send(JSON.stringify({ type: 'session_reset', message: _('Session refreshed') }));
      }
    } else if (command === 'set_mode') {
      const mode = String(data.mode || '');
      if (mode === 'cover' || mode === 'add') {
        const oldMode = this.config.copyMode;
        if (oldMode !== mode) {
          this.config.copyMode = mode;
          this.config.newSession();
          if (mode === 'cover') this.config.sessionBuffer = '';
        }
        await this.broadcast({
          type: 'mode_changed',
          mode,
          message: mode === 'add' ? _('Switched to append mode') : _('Switched to cover mode'),
        });
      }
    }
  }
}
