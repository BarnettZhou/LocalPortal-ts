/** 二维码生成和浏览器唤起 */

import os from 'node:os';
import { spawn } from 'node:child_process';
import QRCode from 'qrcode';

export function getLocalIp(): string {
  const nets = os.networkInterfaces();
  const candidates: string[] = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        if (net.address.startsWith('192.168.')) {
          candidates.unshift(net.address);
        } else if (net.address.startsWith('10.')) {
          candidates.push(net.address);
        } else if (net.address.startsWith('172.')) {
          const second = parseInt(net.address.split('.')[1], 10);
          if (second >= 16 && second <= 31) {
            candidates.push(net.address);
          }
        }
      }
    }
  }

  if (candidates.length > 0) return candidates[0];
  return '127.0.0.1';
}

export async function generateQrPng(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    errorCorrectionLevel: 'H',
    type: 'png',
    margin: 4,
    scale: 10,
  });
}

export async function generateQrAscii(url: string): Promise<string> {
  const qr = await QRCode.create(url, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;

  const lines: string[] = [];
  for (let i = 0; i < size; i += 2) {
    let line = '';
    for (let j = 0; j < size; j++) {
      const top = data[i * size + j];
      const bottom = i + 1 < size ? data[(i + 1) * size + j] : false;
      if (top && bottom) line += '\u2588';
      else if (top && !bottom) line += '\u2580';
      else if (!top && bottom) line += '\u2584';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function generateQrHtml(url: string): string {
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Local Portal - 扫码访问</title>
    <style>
        body {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            background: #1a1a2e;
            color: #eee;
        }
        .container {
            text-align: center;
            padding: 40px;
        }
        h1 { margin-bottom: 10px; }
        .subtitle { color: #888; margin-bottom: 30px; }
        img {
            max-width: 300px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
        }
        .url {
            margin-top: 20px;
            padding: 10px 20px;
            background: #0f3460;
            border-radius: 8px;
            font-family: monospace;
            word-break: break-all;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Local Portal</h1>
        <div class="subtitle">手机扫码访问语音输入页面</div>
        <img src="/qr.png" alt="QR Code">
        <div class="url">${url}</div>
    </div>
</body>
</html>`;
}

export function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', ' "" ', url], { detached: true, stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' });
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  }
}
