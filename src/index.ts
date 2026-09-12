/**
 * 服务入口
 */
import { createApp } from './app';
import { config } from './config';
import { logger } from './logger';

const app = createApp();

const server = app.listen(config.port, config.host, () => {
  logger.info(`🚀 Mahjong records server listening`, {
    url: `http://${config.host}:${config.port}`,
    env: config.env
  });
});

// 优雅退出（PM2 reload 0 停机）
function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  // 兜底：10s 强制退出
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception', { err: err.stack });
  process.exit(1);
});