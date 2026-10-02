/**
 * Express 应用配置
 */
import express, { Application } from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { config } from './config';
import { AVATAR_DIR } from './paths';
import { logger } from './logger';
import { rateLimit } from './middleware/rate-limit';
import { notFound, errorHandler } from './middleware/error';

import authRouter from './routes/auth';
import recordsRouter from './routes/records';
import usersRouter from './routes/users';
import vpayRouter from './routes/vpay';
import uploadRouter from './routes/upload';
import wxacodeRouter from './routes/wxacode';

export function createApp(): Application {
  const app = express();

  // 基础安全
  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: false,  // 允许前端跨域加载
    crossOriginResourcePolicy: false
  }));
  app.use(compression());
  app.use(cors({
    origin: config.cors.origins.length > 0 ? config.cors.origins : true,
    credentials: true
  }));

  // 请求体
  app.use(express.json({ limit: '1mb' }));

  // 日志
  app.use(morgan(config.isDev() ? 'dev' : 'combined', {
    stream: { write: msg => logger.info(msg.trim()) }
  }));

  // 限流
  app.use(rateLimit);

  // 健康检查（无需鉴权）
  app.get('/api/health', (_req, res) => {
    res.json({
      code: 0,
      data: {
        status: 'ok',
        env: config.env,
        uptime: process.uptime(),
        time: Date.now()
      }
    });
  });

  // 业务路由
  app.use('/api/auth', authRouter);
  app.use('/api/records', recordsRouter);
  app.use('/api/users', usersRouter);
app.use('/api/vpay', vpayRouter);
app.use('/api/upload', uploadRouter);
// （/api/feedback 已下线：反馈统一走小程序「联系客服」open-type=contact；feedback 表保留）
app.use('/api/wxacode', wxacodeRouter);

  // 头像等用户素材静态服务（data/avatars → /avatars，经 Nginx 反代同样生效）
  // 目录统一从 paths.ts 取（与 upload 写入同一目录，禁止自算）
  app.use('/avatars', express.static(AVATAR_DIR, {
    maxAge: '30d',
    immutable: true
  }));

  // 404 + 错误处理
  app.use(notFound);
  app.use(errorHandler);

  return app;
}