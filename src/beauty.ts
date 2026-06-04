/** 文本美化 - LLM 结构化处理 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { _ } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BeautyEnv {
  OPENAI_BASE_URL: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
}

export function getUserConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'localportal');
  } else if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'localportal');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) return path.join(xdgConfig, 'localportal');
  return path.join(os.homedir(), '.config', 'localportal');
}

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const paths = [
    path.join(getUserConfigDir(), '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const envPath of paths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
  return env;
}

function loadPrompt(): string {
  const userPrompt = path.join(getUserConfigDir(), 'text-beauty.md');
  if (fs.existsSync(userPrompt)) {
    return fs.readFileSync(userPrompt, 'utf-8');
  }

  const packagePrompt = path.join(__dirname, 'prompt', 'text-beauty.md');
  if (fs.existsSync(packagePrompt)) {
    return fs.readFileSync(packagePrompt, 'utf-8');
  }

  const devPrompt = path.join(__dirname, '..', '..', 'src', 'prompt', 'text-beauty.md');
  if (fs.existsSync(devPrompt)) {
    return fs.readFileSync(devPrompt, 'utf-8');
  }

  return '';
}

interface Segment {
  text: string;
  style: 'white' | 'dim';
}

function processContentChunk(chunk: string, inThink: boolean): [Segment[], boolean] {
  const result: Segment[] = [];
  let remaining = chunk;

  while (remaining) {
    if (!inThink) {
      if (remaining.includes('<think>')) {
        const idx = remaining.indexOf('<think>');
        const before = remaining.slice(0, idx);
        if (before) result.push({ text: before, style: 'white' });
        inThink = true;
        remaining = remaining.slice(idx + 7);
      } else {
        result.push({ text: remaining, style: 'white' });
        remaining = '';
      }
    } else {
      if (remaining.includes('</think>')) {
        const idx = remaining.indexOf('</think>');
        const thinkPart = remaining.slice(0, idx);
        if (thinkPart) result.push({ text: thinkPart, style: 'dim' });
        inThink = false;
        remaining = remaining.slice(idx + 8);
      } else {
        result.push({ text: remaining, style: 'dim' });
        remaining = '';
      }
    }
  }

  return [result, inThink];
}

export async function beautifyText(text: string): Promise<string> {
  const env = loadEnv();
  const baseUrl = env.OPENAI_BASE_URL || '';
  const apiKey = env.OPENAI_API_KEY || '';
  const model = env.OPENAI_MODEL || '';
  const prompt = loadPrompt();

  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      `${_('Missing LLM config. Please create a .env file in one of the following locations')}:\n` +
      `  1. ${_('Current working directory')}: ${path.join(process.cwd(), '.env')}\n` +
      `  2. ${_('User config directory')}: ${path.join(getUserConfigDir(), '.env')}\n` +
      `\n${_('Required configs')}:\n` +
      `  OPENAI_BASE_URL=https://api.openai.com/v1\n` +
      `  OPENAI_API_KEY=sk-xxxxxx\n` +
      `  OPENAI_MODEL=gpt-4o-mini`
    );
  }

  if (!prompt) {
    throw new Error(_('System prompt file not found, please check src/prompt/text-beauty.md'));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const payload = {
    model,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: text },
    ],
    stream: true,
  };

  const response = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(_('LLM request failed ({status}): {text}', { status: response.status, text: errorText }));
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let fullReasoning = '';
  let inThink = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;
      const jsonStr = trimmed.slice(6);
      try {
        const data = JSON.parse(jsonStr);
        const choices = data.choices || [];
        if (!choices.length) continue;
        const delta = choices[0].delta || {};
        const reasoningChunk = delta.reasoning_content || '';
        const contentChunk = delta.content || '';

        if (reasoningChunk) {
          fullReasoning += reasoningChunk;
          process.stdout.write(chalk.gray(reasoningChunk));
        }

        if (contentChunk) {
          const [segments, newInThink] = processContentChunk(contentChunk, inThink);
          inThink = newInThink;
          for (const seg of segments) {
            if (seg.style === 'white') {
              fullContent += seg.text;
              process.stdout.write(chalk.white(seg.text));
            } else {
              fullReasoning += seg.text;
              process.stdout.write(chalk.gray(seg.text));
            }
          }
        }
      } catch {
        // ignore parse error
      }
    }
  }

  process.stdout.write('\n');
  return fullContent;
}
