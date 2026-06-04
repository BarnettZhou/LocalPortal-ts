/** 历史记录管理 - 循环缓冲区实现 */

export interface MessageEntry {
  id: number;
  text: string;
  time: Date;
  preview: string;
  sessionId: number;
  deviceName: string;
  loginId: string;
  targetLoginId: string;
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
}

export interface BeautyEntry {
  id: number;
  text: string; // 原始文本
  result: string; // 美化后的文本
  time: Date;
  preview: string;
  deviceName: string;
  loginId: string;
}

export class History {
  private queue: MessageEntry[] = [];
  private counter = 0;
  private maxsize: number;

  constructor(maxsize: number = 10) {
    this.maxsize = maxsize;
  }

  add(
    text: string,
    sessionId: number = 1,
    deviceName: string = '',
    loginId: string = '',
    targetLoginId: string = '',
    fileId: string = '',
    fileName: string = '',
    fileSize: number = 0,
    mimeType: string = ''
  ): MessageEntry {
    this.counter += 1;
    const preview = text.length > 50 ? text.slice(0, 50) + '...' : text;
    const entry: MessageEntry = {
      id: this.counter,
      text,
      time: new Date(),
      preview,
      sessionId,
      deviceName,
      loginId,
      targetLoginId,
      fileId,
      fileName,
      fileSize,
      mimeType,
    };
    this.queue.unshift(entry);
    if (this.queue.length > this.maxsize) {
      this.queue.pop();
    }
    return entry;
  }

  get(index: number): MessageEntry {
    if (index < 1 || index > this.queue.length) {
      throw new Error(`无效索引 ${index}，当前有 ${this.queue.length} 条消息`);
    }
    return this.queue[index - 1];
  }

  list(): MessageEntry[] {
    const entries = [...this.queue];
    for (let i = 0; i < entries.length; i++) {
      entries[i] = { ...entries[i], id: i + 1 };
    }
    return entries;
  }

  lastReceivedTime(): Date | null {
    return this.queue.length > 0 ? this.queue[0].time : null;
  }

  get length(): number {
    return this.queue.length;
  }

  get maxSize(): number {
    return this.maxsize;
  }

  get counterValue(): number {
    return this.counter;
  }
}

export class BeautyHistory {
  private queue: BeautyEntry[] = [];
  private counter = 0;
  private maxsize: number;

  constructor(maxsize: number = 10) {
    this.maxsize = maxsize;
  }

  add(
    original: string,
    result: string,
    deviceName: string = '',
    loginId: string = ''
  ): BeautyEntry {
    this.counter += 1;
    const preview = result.length > 50 ? result.slice(0, 50) + '...' : result;
    const entry: BeautyEntry = {
      id: this.counter,
      text: original,
      result,
      time: new Date(),
      preview,
      deviceName,
      loginId,
    };
    this.queue.unshift(entry);
    if (this.queue.length > this.maxsize) {
      this.queue.pop();
    }
    return entry;
  }

  get(index: number): BeautyEntry {
    if (index < 1 || index > this.queue.length) {
      throw new Error(`无效索引 ${index}，当前有 ${this.queue.length} 条记录`);
    }
    return this.queue[index - 1];
  }

  list(): BeautyEntry[] {
    const entries = [...this.queue];
    for (let i = 0; i < entries.length; i++) {
      entries[i] = { ...entries[i], id: i + 1 };
    }
    return entries;
  }

  get length(): number {
    return this.queue.length;
  }
}
