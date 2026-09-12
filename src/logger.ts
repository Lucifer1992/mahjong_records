/**
 * 简单日志工具
 * 生产环境同时输出到文件，方便 PM2 + journalctl 排查
 */
import fs from 'fs';
import path from 'path';
import { config } from './config';

const LEVELS: Record<string, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const currentLevel = LEVELS[config.log.level] ?? LEVELS.info;

// 确保日志目录存在
const logDir = path.dirname(config.log.file);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const fileStream = fs.createWriteStream(config.log.file, { flags: 'a' });

function format(level: string, msg: string, meta?: any): string {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}`;
}

function shouldLog(level: string): boolean {
  return (LEVELS[level] ?? 0) >= currentLevel;
}

function log(level: string, msg: string, meta?: any) {
  if (!shouldLog(level)) return;
  const line = format(level, msg, meta);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
  fileStream.write(line + '\n');
}

export const logger = {
  debug: (msg: string, meta?: any) => log('debug', msg, meta),
  info: (msg: string, meta?: any) => log('info', msg, meta),
  warn: (msg: string, meta?: any) => log('warn', msg, meta),
  error: (msg: string, meta?: any) => log('error', msg, meta)
};