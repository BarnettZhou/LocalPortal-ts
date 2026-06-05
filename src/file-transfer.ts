/** 文件传输管理器 - 流式架构，支持大文件 */

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
  receivedSize: number;
  downloadDir: string;
  tempPath: string;
  finalPath: string;
  fd: number | null;
  uploaderLoginId?: string;
}

export class FileTransferManager {
  /** 分片大小：1MB，兼顾内存占用与传输效率 */
  static CHUNK_SIZE = 1024 * 1024;

  downloadDir: string;
  activeTransfers: Map<string, FileInfo> = new Map();

  constructor(downloadDir?: string) {
    this.downloadDir = downloadDir ? path.resolve(downloadDir) : getDefaultDownloadDir();
    if (!fs.existsSync(this.downloadDir)) {
      fs.mkdirSync(this.downloadDir, { recursive: true });
    }
  }

  canAcceptFile(_mimeType: string, _size: number): [boolean, string] {
    // 不再设置硬上限；磁盘空间由调用方或操作系统约束
    return [true, ''];
  }

  startTransfer(name: string, size: number, mimeType: string, uploaderLoginId?: string): [string | null, string] {
    const [canAccept, error] = this.canAcceptFile(mimeType, size);
    if (!canAccept) return [null, error];

    const fileId = Math.random().toString(36).substring(2, 10);
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '');
    const tempName = `lportal_tmp_${timestamp}_${fileId}_${safeName}`;
    const finalName = `lportal_${timestamp}_${safeName}`;
    const tempPath = path.join(this.downloadDir, tempName);
    const finalPath = path.join(this.downloadDir, finalName);

    let fd: number;
    try {
      fd = fs.openSync(tempPath, 'a');
    } catch (e: any) {
      return [null, `创建临时文件失败: ${e.message}`];
    }

    const fileInfo: FileInfo = {
      name,
      size,
      mimeType,
      fileId,
      receivedSize: 0,
      downloadDir: this.downloadDir,
      tempPath,
      finalPath,
      fd,
      uploaderLoginId,
    };
    this.activeTransfers.set(fileId, fileInfo);
    return [fileId, ''];
  }

  receiveChunk(fileId: string, chunkData: Buffer, index: number): [boolean, string] {
    const fileInfo = this.activeTransfers.get(fileId);
    if (!fileInfo) return [false, '传输不存在或已过期'];
    if (fileInfo.fd === null) return [false, '文件描述符已关闭'];

    try {
      // 按分片索引的固定偏移写入，支持断点续传/乱序到达
      const position = index * FileTransferManager.CHUNK_SIZE;
      fs.writeSync(fileInfo.fd, chunkData, 0, chunkData.length, position);
      fileInfo.receivedSize += chunkData.length;
      return [true, ''];
    } catch (e: any) {
      return [false, `写入失败: ${e.message}`];
    }
  }

  completeTransfer(fileId: string): [string | null, string] {
    const fileInfo = this.activeTransfers.get(fileId);
    if (!fileInfo) return [null, '传输不存在或已过期'];

    try {
      if (fileInfo.fd !== null) {
        fs.closeSync(fileInfo.fd);
        fileInfo.fd = null;
      }
      fs.renameSync(fileInfo.tempPath, fileInfo.finalPath);
      this.activeTransfers.delete(fileId);
      return [fileInfo.finalPath, ''];
    } catch (e: any) {
      return [null, `保存文件失败: ${e.message}`];
    }
  }

  cancelTransfer(fileId: string): void {
    const fileInfo = this.activeTransfers.get(fileId);
    if (fileInfo) {
      if (fileInfo.fd !== null) {
        try { fs.closeSync(fileInfo.fd); } catch {}
        fileInfo.fd = null;
      }
      try { fs.unlinkSync(fileInfo.tempPath); } catch {}
      this.activeTransfers.delete(fileId);
    }
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
