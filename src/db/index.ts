/**
 * MySQL 连接池 + 建表（mysql2/promise）
 *
 * 设计约定：
 * - 时间戳统一存毫秒 BIGINT，不用 DATETIME → 彻底规避时区换算问题
 * - 会话时区固定 UTC+8：仅影响 FROM_UNIXTIME 的"打牌日"分组（月历），
 *   与前端/修剪窗口（TZ_OFFSET_MINUTES=480）语义一致
 * - 轻封装 query / queryOne / exec / withTransaction，贴近旧 better-sqlite3
 *   的调用习惯，services 迁移 diff 最小
 */
import mysql from 'mysql2/promise';
import { config } from '../config';
import { logger } from '../logger';

export const pool = mysql.createPool({
  host: config.mysql.host,
  port: config.mysql.port,
  user: config.mysql.user,
  password: config.mysql.password,
  database: config.mysql.database,
  waitForConnections: true,
  connectionLimit: config.mysql.connectionLimit,
  charset: 'utf8mb4'
});

// 每条连接固定会话时区（月历按打牌日分组依赖 FROM_UNIXTIME）
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+08:00'");
});

// ---------- 轻封装 ----------

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}

export async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export interface ExecResult {
  affectedRows: number;
  insertId: number;
}

export async function exec(sql: string, params: any[] = []): Promise<ExecResult> {
  const [result] = await pool.query(sql, params);
  const r = result as any;
  return { affectedRows: r.affectedRows ?? 0, insertId: r.insertId ?? 0 };
}

/** 事务：回调内所有 SQL 用同一个 conn，异常自动回滚 */
export async function withTransaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    throw e;
  } finally {
    conn.release();
  }
}

/** 统一入口：services 里 import { db } 后 db.query / db.exec / db.withTransaction */
export const db = {
  pool,
  query,
  queryOne,
  exec,
  withTransaction
};

// ---------- 建表 ----------

const DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(36)  PRIMARY KEY,
    openid        VARCHAR(64)  NOT NULL,
    nickname      VARCHAR(64)  NOT NULL DEFAULT '麻友',
    avatar        VARCHAR(500) NOT NULL DEFAULT '',
    tier          VARCHAR(16)  NOT NULL DEFAULT 'free',
    session_key   VARCHAR(128) NOT NULL DEFAULT '',
    created_at    BIGINT       NOT NULL,
    last_login_at BIGINT       NOT NULL,
    UNIQUE KEY uk_users_openid (openid)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS players (
    id              VARCHAR(36) PRIMARY KEY,
    user_id         VARCHAR(36) NOT NULL,
    nickname        VARCHAR(64) NOT NULL,
    color           VARCHAR(16) NOT NULL DEFAULT '#4A9D7E',
    created_at      BIGINT      NOT NULL,
    total_games     INT         NOT NULL DEFAULT 0,
    total_score     INT         NOT NULL DEFAULT 0,
    win_rate        DOUBLE      NOT NULL DEFAULT 0,
    max_win_streak  INT         NOT NULL DEFAULT 0,
    max_lose_streak INT         NOT NULL DEFAULT 0,
    current_streak  INT         NOT NULL DEFAULT 0,
    UNIQUE KEY uk_players_user_nickname (user_id, nickname),
    KEY idx_players_user (user_id),
    CONSTRAINT fk_players_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS records (
    id         VARCHAR(36) PRIMARY KEY,
    user_id    VARCHAR(36) NOT NULL,
    played_at  BIGINT      NOT NULL,
    rule_type  VARCHAR(32) NOT NULL,
    rule_name  VARCHAR(64) NOT NULL,
    duration   VARCHAR(16) NOT NULL,
    total_fee  INT         NOT NULL DEFAULT 0,
    note       VARCHAR(255) NOT NULL DEFAULT '',
    mood       VARCHAR(16) NULL,
    created_at BIGINT      NOT NULL,
    updated_at BIGINT      NOT NULL,
    deleted_at BIGINT      NULL,
    KEY idx_records_user_played (user_id, played_at),
    KEY idx_records_user_active (user_id, deleted_at, played_at),
    CONSTRAINT fk_records_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS record_players (
    id            VARCHAR(36) PRIMARY KEY,
    record_id     VARCHAR(36) NOT NULL,
    player_id     VARCHAR(36) NOT NULL,
    nickname      VARCHAR(64) NOT NULL,
    score         INT         NOT NULL DEFAULT 0,
    is_substitute TINYINT     NOT NULL DEFAULT 0,
    is_observer   TINYINT     NOT NULL DEFAULT 0,
    sort_order    INT         NOT NULL DEFAULT 0,
    KEY idx_rp_record (record_id),
    KEY idx_rp_player (player_id),
    -- 注意：player_id 故意不设外键 —— record_players 是历史快照表
    -- （nickname 冗余存储），删玩家档案不应连带删掉历史战绩快照
    CONSTRAINT fk_rp_record FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  CREATE TABLE IF NOT EXISTS vpay_orders (
    id           VARCHAR(36) PRIMARY KEY,
    user_id      VARCHAR(36) NOT NULL,
    out_trade_no VARCHAR(40) NOT NULL,
    product_key  VARCHAR(32) NOT NULL,
    product_id   VARCHAR(64) NOT NULL,
    price_fen    INT         NOT NULL,
    status       VARCHAR(16) NOT NULL DEFAULT 'created',
    created_at   BIGINT      NOT NULL,
    paid_at      BIGINT      NULL,
    UNIQUE KEY uk_vpay_out_trade_no (out_trade_no),
    KEY idx_vpay_orders_user (user_id),
    CONSTRAINT fk_vpay_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

  -- 意见反馈：只存 user_id + 内容 + 时间戳；不收集手机号/姓名/IP 等敏感信息
  -- 防刷：service 层每用户每天最多 5 条；DB 这里只做索引，外键级联删 user 即可清空
  CREATE TABLE IF NOT EXISTS feedback (
    id          VARCHAR(36) PRIMARY KEY,
    user_id     VARCHAR(36) NOT NULL,
    content     VARCHAR(500) NOT NULL,
    created_at  BIGINT       NOT NULL,
    KEY idx_feedback_user_time (user_id, created_at),
    CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;

export async function initSchema(): Promise<void> {
  // 多语句 DDL：mysql2 query 默认可执行多语句? —— 保险起见逐段执行
  for (const stmt of DDL.split(';')) {
    const sql = stmt.trim();
    if (sql) await pool.query(sql);
  }
  await migrateSchema();
  logger.info('MySQL schema initialized', { host: config.mysql.host, database: config.mysql.database });
}

/**
 * 增量列迁移（CREATE TABLE IF NOT EXISTS 不会给存量表加列）
 * 用 information_schema 检查后 ALTER
 */
async function migrateSchema(): Promise<void> {
  const cols = await query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users'`,
    [config.mysql.database]
  );
  const names = new Set(cols.map(c => c.COLUMN_NAME));

  if (!names.has('tier')) {
    await pool.query(`ALTER TABLE users ADD COLUMN tier VARCHAR(16) NOT NULL DEFAULT 'free'`);
    logger.info('MySQL migration: users.tier added');
  }
  // 虚拟支付 signature = HMAC-SHA256(session_key, signData)，服务端必须持久化 session_key
  if (!names.has('session_key')) {
    await pool.query(`ALTER TABLE users ADD COLUMN session_key VARCHAR(128) NOT NULL DEFAULT ''`);
    logger.info('MySQL migration: users.session_key added');
  }
}

// 启动即初始化（连不上直接退出，让 PM2 拉起重试）
initSchema().catch((e) => {
  logger.error('MySQL init failed —— 请检查 MYSQL_* 配置', { err: (e as Error).message });
  process.exit(1);
});
