/**
 * 应用配置
 * 通过环境变量加载，统一从这里读取
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function num(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export const config = {
  env: str(process.env.NODE_ENV, 'production'),
  port: num(process.env.PORT, 3456),
  host: str(process.env.HOST, '0.0.0.0'),

  jwt: {
    secret: str(process.env.JWT_SECRET, 'dev-only-secret-do-not-use-in-production'),
    expiresIn: str(process.env.JWT_EXPIRES_IN, '180d')
  },

  db: {
    path: path.resolve(__dirname, '..', str(process.env.DB_PATH, './data/mahjong.db'))
  },

  wechat: {
    appid: str(process.env.WX_APPID, ''),
    secret: str(process.env.WX_SECRET, '')
  },

  cors: {
    origins: str(process.env.CORS_ORIGIN, '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  },

  log: {
    level: str(process.env.LOG_LEVEL, 'info'),
    file: path.resolve(__dirname, '..', str(process.env.LOG_FILE, './data/app.log'))
  },

  rateLimit: {
    perMinute: num(process.env.RATE_LIMIT_PER_MIN, 120)
  },

  isDev(): boolean {
    return this.env === 'development';
  },
  isProd(): boolean {
    return this.env === 'production';
  }
};

export type AppConfig = typeof config;