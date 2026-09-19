/**
 * 存量数据迁移：SQLite (data/mahjong.db) → MySQL（一次性工具）
 *
 * 用法：
 *   npm run migrate-sqlite                                # 默认读 ./data/mahjong.db
 *   npm run migrate-sqlite -- --sqlite /path/mahjong.db   # 指定旧库路径
 *
 * 行为：
 * - 目标 MySQL 库必须已配好（.env 的 MYSQL_*），脚本会先跑 initSchema 建表
 * - 幂等：INSERT IGNORE，重复执行不会产生重复数据（按主键 id 去重）
 * - 迁移表：users / players / records / record_players / vpay_orders（存在才迁）
 * - 只读旧库，绝不修改/删除 SQLite 文件
 */
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { pool, query, exec, initSchema } from '../src/db';
import { logger } from '../src/logger';

// ---------- 参数 ----------
const sqliteArgIdx = process.argv.indexOf('--sqlite');
const sqlitePath = path.resolve(
  sqliteArgIdx > -1 ? process.argv[sqliteArgIdx + 1] : path.resolve(__dirname, '..', 'data', 'mahjong.db')
);

if (!fs.existsSync(sqlitePath)) {
  console.error(`✗ 旧库不存在: ${sqlitePath}`);
  process.exit(1);
}

interface Counters { [table: string]: number }
const counters: Counters = {};

async function migrateTable(name: string, cols: string[], rows: any[], insertSql: string) {
  let inserted = 0;
  for (const row of rows) {
    const params = cols.map(c => {
      const v = row[c];
      // SQLite 布尔 → 0/1；undefined → null
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v === undefined ? null : v;
    });
    const r = await exec(insertSql, params);
    inserted += r.affectedRows;
  }
  counters[name] = inserted;
  console.log(`  ${name}: 读取 ${rows.length} 条，新插入 ${inserted} 条（其余为已存在的幂等跳过）`);
}

async function main() {
  console.log(`→ 旧库: ${sqlitePath}`);
  const old = new Database(sqlitePath, { readonly: true });

  // 目标库建表（幂等）
  await initSchema();

  // users
  {
    const cols = ['id', 'openid', 'nickname', 'avatar', 'tier', 'created_at', 'last_login_at'];
    const oldCols = (old.pragma(`table_info(users)`) as any[]).map(c => c.name);
    const useCols = cols.filter(c => oldCols.includes(c));
    // session_key 旧库没有 → 迁移后用户支付前重新 wx.login 即可
    const rows = old.prepare(`SELECT * FROM users`).all();
    const placeholders = ['id', 'openid', 'nickname', 'avatar', 'tier', 'created_at', 'last_login_at'].map(() => '?').join(', ');
    await migrateTable('users', useCols, rows,
      `INSERT IGNORE INTO users (id, openid, nickname, avatar, tier, session_key, created_at, last_login_at)
       VALUES (${placeholders}, '')`);
    // session_key 列不在 useCols 中时上面直接给了空串默认值；若旧库有该列则补更新
    if (oldCols.includes('session_key')) {
      for (const row of rows as any[]) {
        if (row.session_key) {
          await query('UPDATE users SET session_key = ? WHERE id = ? AND (session_key = "" OR session_key IS NULL)',
            [row.session_key, row.id]);
        }
      }
    }
  }

  // players
  {
    const cols = ['id', 'user_id', 'nickname', 'color', 'created_at',
      'total_games', 'total_score', 'win_rate', 'max_win_streak', 'max_lose_streak', 'current_streak'];
    const rows = old.prepare('SELECT * FROM players').all();
    const placeholders = cols.map(() => '?').join(', ');
    await migrateTable('players', cols, rows,
      `INSERT IGNORE INTO players (${cols.join(', ')}) VALUES (${placeholders})`);
  }

  // records
  {
    const cols = ['id', 'user_id', 'played_at', 'rule_type', 'rule_name', 'duration',
      'total_fee', 'note', 'mood', 'created_at', 'updated_at', 'deleted_at'];
    const rows = old.prepare('SELECT * FROM records').all();
    const placeholders = cols.map(() => '?').join(', ');
    await migrateTable('records', cols, rows,
      `INSERT IGNORE INTO records (${cols.join(', ')}) VALUES (${placeholders})`);
  }

  // record_players
  {
    const cols = ['id', 'record_id', 'player_id', 'nickname', 'score',
      'is_substitute', 'is_observer', 'sort_order'];
    const rows = old.prepare('SELECT * FROM record_players').all();
    const placeholders = cols.map(() => '?').join(', ');
    await migrateTable('record_players', cols, rows,
      `INSERT IGNORE INTO record_players (${cols.join(', ')}) VALUES (${placeholders})`);
  }

  // vpay_orders（旧库有才迁）
  {
    const has = (old.pragma(`table_info(vpay_orders)`) as any[]).length > 0;
    if (has) {
      const cols = ['id', 'user_id', 'out_trade_no', 'product_key', 'product_id',
        'price_fen', 'status', 'created_at', 'paid_at'];
      const rows = old.prepare('SELECT * FROM vpay_orders').all();
      const placeholders = cols.map(() => '?').join(', ');
      await migrateTable('vpay_orders', cols, rows,
        `INSERT IGNORE INTO vpay_orders (${cols.join(', ')}) VALUES (${placeholders})`);
    } else {
      console.log('  vpay_orders: 旧库无此表，跳过');
    }
  }

  old.close();

  // 校验：两边行数对比
  const checks: Array<[string, number]> = [];
  for (const t of ['users', 'players', 'records', 'record_players']) {
    const [{ c }] = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM ${t}`);
    checks.push([t, Number(c)]);
  }

  console.log('\n===== 迁移完成 =====');
  for (const [t, n] of checks) console.log(`  MySQL ${t}: ${n} 条`);
  console.log('\n后续步骤：');
  console.log('  1. 抽查几条战绩（前端登录后对比列表）');
  console.log('  2. 旧 SQLite 文件保留原处作为备份，确认无误后可自行归档');
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  logger.error('migration failed', { err: (e as Error).message });
  console.error('✗ 迁移失败:', (e as Error).message);
  process.exit(1);
});
