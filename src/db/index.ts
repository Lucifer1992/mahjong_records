/**
 * SQLite 数据库连接 + 建表
 * 使用 better-sqlite3（同步 API、性能最好、零依赖）
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';

// 确保目录
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(config.db.path);
db.pragma('journal_mode = WAL');        // 提升并发读写
db.pragma('foreign_keys = ON');        // 启用外键约束
db.pragma('synchronous = NORMAL');     // 性能/安全平衡

/**
 * 初始化表结构
 */
export function initSchema(): void {
  db.exec(`
    -- 用户（微信小程序登录）
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      openid        TEXT UNIQUE NOT NULL,
      nickname      TEXT NOT NULL DEFAULT '麻友',
      avatar        TEXT DEFAULT '',
      tier          TEXT NOT NULL DEFAULT 'free',
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid);

    -- 玩家档案（一个 user 可以有很多 player；跨局通用）
    CREATE TABLE IF NOT EXISTS players (
      id                TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL,
      nickname          TEXT NOT NULL,
      color             TEXT NOT NULL DEFAULT '#4A9D7E',
      created_at        INTEGER NOT NULL,
      total_games       INTEGER NOT NULL DEFAULT 0,
      total_score       INTEGER NOT NULL DEFAULT 0,
      win_rate          REAL NOT NULL DEFAULT 0,
      max_win_streak    INTEGER NOT NULL DEFAULT 0,
      max_lose_streak   INTEGER NOT NULL DEFAULT 0,
      current_streak    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_user_nickname ON players(user_id, nickname);

    -- 战绩主表（软删除：deleted_at 不为空即视为已删除）
    CREATE TABLE IF NOT EXISTS records (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      played_at   INTEGER NOT NULL,
      rule_type   TEXT NOT NULL,
      rule_name   TEXT NOT NULL,
      duration    TEXT NOT NULL,
      total_fee   INTEGER NOT NULL DEFAULT 0,
      note        TEXT DEFAULT '',
      mood        TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      deleted_at  INTEGER DEFAULT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_records_user_played ON records(user_id, played_at DESC);
    CREATE INDEX IF NOT EXISTS idx_records_user_active ON records(user_id, deleted_at, played_at DESC);

    -- 战绩-玩家关联（含分数 / 替补 / 观战）
    CREATE TABLE IF NOT EXISTS record_players (
      id            TEXT PRIMARY KEY,
      record_id     TEXT NOT NULL,
      player_id     TEXT NOT NULL,
      nickname      TEXT NOT NULL,
      score         INTEGER NOT NULL DEFAULT 0,
      is_substitute INTEGER NOT NULL DEFAULT 0,
      is_observer   INTEGER NOT NULL DEFAULT 0,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rp_record ON record_players(record_id);
    CREATE INDEX IF NOT EXISTS idx_rp_player ON record_players(player_id);
  `);

  migrateSchema();

  logger.info('DB schema initialized', { path: config.db.path });
}

/**
 * 增量迁移
 *
 * CREATE TABLE IF NOT EXISTS 只在表不存在时生效，**不会给存量表加列**。
 * 线上库已经有 users 表了，所以 tier 必须单独 ALTER 补一次。
 */
function migrateSchema(): void {
  const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  const hasTier = columns.some(c => c.name === 'tier');

  if (!hasTier) {
    db.exec(`ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'`);
    logger.info('DB migration: users.tier added');
  }
}

initSchema();