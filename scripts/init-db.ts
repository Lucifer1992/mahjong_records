/**
 * 初始化数据库（手动调用：npm run init-db）
 *
 * MySQL 版：建表逻辑在 src/db/index.ts 的 initSchema()（服务启动时也会自动执行），
 * 本脚本用于部署流程中显式验证「库可连 + 表可建」，失败即非零退出。
 */
import { initSchema } from '../src/db';
import { logger } from '../src/logger';

initSchema()
  .then(() => {
    logger.info('MySQL database initialized successfully');
    process.exit(0);
  })
  .catch((e) => {
    logger.error('Database init failed', { err: (e as Error).message });
    process.exit(1);
  });
