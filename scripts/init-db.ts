/**
 * 初始化数据库（手动调用：npm run init-db）
 * 用于部署后建表
 */
import { initSchema } from '../src/db';
import { logger } from '../src/logger';

initSchema();
logger.info('Database initialized successfully');
process.exit(0);