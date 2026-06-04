/** 文件传输管理器 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync } from 'node:child_process';

export function getDefaultDownloadDir(): string {
  const envDir = process.env.LPORTAL_DOWNLOAD_DIR;
  if (envDir) return path.resolve(envDir);

  if (process.platform === 'win32') {
    try {
      const result = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders" /v {374DE290-123F-4565-9164-39C4925E467B}',
        { encoding: 'utf-8', timeout: 5000 }
      );
      const match = result.match(/REG_EXPAND_SZ\s+(.+)/);
      if (match) {
        const raw = match[1].trim();
        // Expand %USERPROFILE% style env vars in the registry value
        const resolved = raw.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
        return path.resolve(resolved);
      }
    } catch {
      // fall through to USERPROFILE guess
    }
    const userProfile = process.env.USERPROFILE;
    if (userProfile) return path.join(userProfile, 'Downloads');
  }

  return path.join(os.homedir(), 'Downloads');
}

export interface FileInfo {
  name: string;
  size: number;
  mimeType: string;
  fileId: string;
  chunks: (Buffer | null)[];
  receivedSize: number;
  downloadDir: string;
}

export class FileTransferManager {
  static MAX_FILE_SIZE = 100 * 1024 * 1024;
  static CHUNK_SIZE = 64 * 1024;

  downloadDir: string;
  activeTransfers: Map<string, FileInfo> = new Map();

  constructor(downloadDir?: string) {
    this.downloadDir = downloadDir ? path.resolve(downloadDir) : getDefaultDownloadDir();
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  canAcceptFile(_mimeType: string, size: number): [boolean, string] {
    if (size > FileTransferManager.MAX_FILE_SIZE) {
      return [false, `文件过大: ${size} bytes (最大 ${FileTransferManager.MAX_FILE_SIZE} bytes)`];
    }
    return [true, ''];
  }

  startTransfer(name: string, size: number, mimeType: string): [string | null, string] {
    const [canAccept, error] = this.canAcceptFile(mimeType, size);
    if (!canAccept) return [null, error];

    const fileId = Math.random().toString(36).substring(2, 10);
    const fileInfo: FileInfo = {
      name,
      size,
      mimeType,
      fileId,
      chunks: [],
      receivedSize: 0,
      downloadDir: this.downloadDir,
    };
    this.activeTransfers.set(fileId, fileInfo);
    return [fileId, ''];
  }

  receiveChunk(fileId: string, chunkData: Buffer, index: number): [boolean, string] {
    const fileInfo = this.activeTransfers.get(fileId);
    if (!fileInfo) return [false, '传输不存在或已过期'];

    while (fileInfo.chunks.length <= index) {
      fileInfo.chunks.push(null);
    }
    fileInfo.chunks[index] = chunkData;
    fileInfo.receivedSize += chunkData.length;
    return [true, ''];
  }

  completeTransfer(fileId: string): [string | null, string] {
    const fileInfo = this.activeTransfers.get(fileId);
    if (!fileInfo) return [null, '传输不存在或已过期'];

    try {
      const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
      const safeName = fileInfo.name.replace(/[^a-zA-Z0-9._-]/g, '');
      const savePath = path.join(fileInfo.downloadDir, `lportal_${timestamp}_${safeName}`);

      const fd = fs.openSync(savePath, 'w');
      for (const chunk of fileInfo.chunks) {
        if (chunk) {
          fs.writeSync(fd, chunk);
        }
      }
      fs.closeSync(fd);
      this.activeTransfers.delete(fileId);
      return [savePath, ''];
    } catch (e: any) {
      return [null, `保存文件失败: ${e.message}`];
    }
  }

  cancelTransfer(fileId: string): void {
    this.activeTransfers.delete(fileId);
  }

  getTransferProgress(fileId: string): [number, number] {
    const fileInfo = this.activeTransfers.get(fileId);
    if (!fileInfo) return [0, 0];
    return [fileInfo.receivedSize, fileInfo.size];
  }

  openDownloadsFolder(): void {
    const p = this.downloadDir;
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'explorer', p], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawn('open', [p], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [p], { detached: true, stdio: 'ignore' });
    }
  }
}

let ftmInstance: FileTransferManager | null = null;

export function getFileTransferManager(): FileTransferManager {
  if (!ftmInstance) ftmInstance = new FileTransferManager();
  return ftmInstance;
}
