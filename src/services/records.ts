/**
 * 战绩业务（MySQL 异步版）
 * - 单条 / 批量写入（自动创建/更新玩家档案）
 * - 软删除（保留玩家统计稳定）
 * - 免费云端窗口修剪（硬删除，只动云端）
 */
import { db } from '../db';
import type { PoolConnection } from 'mysql2/promise';
import { uuid } from '../utils/uuid';
import { findOrCreate, findOrCreateByConn } from './players';
import { getTier } from './users';
import { config } from '../config';
import { BizError } from '../middleware/error';

export interface PlayerScoreInput {
  playerId?: string;     // 已存在玩家时传；不传则按 nickname 自动建
  nickname: string;
  score: number;
  isSubstitute?: boolean;
  isObserver?: boolean;
}

export interface RecordInput {
  id?: string;           // 前端生成的 UUID；批量同步时用于幂等
  playedAt: number;
  ruleType: string;
  ruleName: string;
  duration: string;
  totalFee?: number;
  note?: string;
  mood?: string | null;
  players: PlayerScoreInput[];
}

export interface RecordOutput {
  id: string;
  playedAt: number;
  ruleType: string;
  ruleName: string;
  duration: string;
  totalFee: number;
  note: string;
  mood: string | null;
  createdAt: number;
  updatedAt: number;
  players: Array<{
    playerId: string;
    nickname: string;
    score: number;
    isSubstitute: boolean;
    isObserver: boolean;
  }>;
}

/**
 * 把毫秒时间戳转成「打牌日期」键（YYYY-MM-DD）
 *
 * 刻意用固定时区偏移，而不是服务器本地时区：线上机器可能跑在 UTC，
 * 按 UTC 切日期会把晚上 8 点后的牌局算到「第二天」，窗口边界就错位了。
 * 麻将用户全在国内，UTC+8 是唯一正确解。
 */
function dateKey(ts: number): string {
  const offsetMs = config.tier.tzOffsetMinutes * 60 * 1000;
  return new Date(ts + offsetMs).toISOString().slice(0, 10);
}

/** 某个日期键当天 00:00（本地时区）对应的真实毫秒时间戳 */
function dayStart(dayKey: string): number {
  const offsetMs = config.tier.tzOffsetMinutes * 60 * 1000;
  return Date.parse(`${dayKey}T00:00:00Z`) - offsetMs;
}

/**
 * 免费用户云端窗口修剪
 *
 * 规则：按打牌日期去重，只保留**最近 N 个有数据的日期**的全部记录。
 * 两个刻意的选择：
 * 1. **硬删除**，不是软删除 —— 表达「云端不留这段历史」的免费额度语义
 * 2. **只动云端，绝不动本地** —— 升级 Pro 后再同步，记录按 id 幂等重新上传
 *
 * @returns 被淘汰的云端记录条数
 */
export async function trimFreeWindow(userId: string): Promise<number> {
  const keep = config.tier.freeWindowDates;
  if (keep <= 0) return 0;

  const rows = await db.query<{ played_at: number }>(
    'SELECT played_at FROM records WHERE user_id = ? AND deleted_at IS NULL ORDER BY played_at DESC',
    [userId]
  );
  if (rows.length === 0) return 0;

  const seen = new Set<string>();
  const keepDates: string[] = [];
  for (const r of rows) {
    const key = dateKey(Number(r.played_at));
    if (seen.has(key)) continue;
    seen.add(key);
    if (keepDates.length < keep) keepDates.push(key);
    else break;
  }

  // 还有富余日期 → 不用淘汰
  if (seen.size <= keep) return 0;

  // 所有被淘汰的记录一定早于「最旧保留日」当天 00:00
  const cutoff = dayStart(keepDates[keepDates.length - 1]);

  // record_players.record_id 已设 ON DELETE CASCADE（见 db/index.ts），
  // 删 records 会自动级联到 record_players，无需手动删子表
  return db.withTransaction(async (conn) => {
    const [result] = await conn.query(
      'DELETE FROM records WHERE user_id = ? AND deleted_at IS NULL AND played_at < ?',
      [userId, cutoff]
    );
    return (result as any).affectedRows ?? 0;
  });
}

/** 免费用户才需要修剪；Pro 直接跳过（省掉一次全表扫描） */
async function trimIfFree(userId: string): Promise<number> {
  if (await getTier(userId) === 'pro') return 0;
  return trimFreeWindow(userId);
}

function validateInput(input: RecordInput) {
  if (!input.playedAt || typeof input.playedAt !== 'number') {
    throw new BizError('BAD_REQUEST', 400, 'playedAt 必填且为数字');
  }
  if (!input.ruleType || !input.ruleName || !input.duration) {
    throw new BizError('BAD_REQUEST', 400, 'ruleType / ruleName / duration 必填');
  }
  if (!Array.isArray(input.players) || input.players.length < 2) {
    throw new BizError('BAD_REQUEST', 400, '至少 2 名玩家');
  }
  if (input.players.length > 8) {
    throw new BizError('BAD_REQUEST', 400, '单场最多 8 名玩家');
  }
  // 分数总和应为 0（输赢平衡）
  const sum = input.players.reduce((s, p) => s + (p.score || 0), 0);
  if (Math.abs(sum) > 0) {
    throw new BizError('SCORE_NOT_BALANCED', 400, `玩家分数之和必须为 0（当前 ${sum}）`);
  }
}

/**
 * 加载完整战绩（含玩家列表）
 */
async function loadRecord(userId: string, recordId: string): Promise<RecordOutput | null> {
  const r = await db.queryOne<any>(
    'SELECT * FROM records WHERE user_id = ? AND id = ? AND deleted_at IS NULL',
    [userId, recordId]
  );
  if (!r) return null;

  const players = await db.query<any>(
    'SELECT player_id, nickname, score, is_substitute, is_observer FROM record_players WHERE record_id = ? ORDER BY sort_order ASC',
    [recordId]
  );

  return {
    id: r.id,
    playedAt: Number(r.played_at),
    ruleType: r.rule_type,
    ruleName: r.rule_name,
    duration: r.duration,
    totalFee: r.total_fee,
    note: r.note || '',
    mood: r.mood,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    players: players.map(p => ({
      playerId: p.player_id,
      nickname: p.nickname,
      score: p.score,
      isSubstitute: !!p.is_substitute,
      isObserver: !!p.is_observer
    }))
  };
}

/**
 * 正向更新玩家战绩统计（写入战绩后调用；必须在事务内用 conn）
 *
 * 性能：之前每个玩家一次 SELECT + 一次 UPDATE，单局 4-8 人 = 8-16 次往返；
 * 现在每个玩家只一次 SELECT，UPDATE 合并为单条 CASE/WHEN。
 */
async function updatePlayerStats(conn: PoolConnection, players: PlayerScoreInput[]) {
  if (players.length === 0) return;

  // 每局内 score>0 算胜，多人赢时按均摊累加（保持原有语义）
  const winnerCount = players.filter(x => x.score > 0).length || 1;

  // 一次性 SELECT 所有玩家当前状态（IN 查询）
  const ids = players.map(p => p.playerId);
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await conn.query(
    `SELECT * FROM players WHERE id IN (${placeholders})`,
    ids
  );
  const playerMap = new Map<string, any>();
  for (const r of rows as any[]) playerMap.set(r.id, r);

  // 单条 UPDATE 用 CASE/WHEN 批量累加
  const sets = {
    total_games: 'CASE id',
    total_score: 'CASE id',
    win_rate: 'CASE id',
    current_streak: 'CASE id',
    max_win_streak: 'CASE id',
    max_lose_streak: 'CASE id'
  } as Record<string, string>;
  const params: any[] = [];
  const idsOut: string[] = [];

  for (const p of players) {
    const player = playerMap.get(p.playerId);
    if (!player) continue;

    const totalGames = player.total_games + 1;
    const totalScore = player.total_score + p.score;

    // streak：赢家 +1，输家 -1，0 重置
    let currentStreak: number, maxWinStreak = player.max_win_streak, maxLoseStreak = player.max_lose_streak;
    if (p.score > 0) {
      currentStreak = player.current_streak >= 0 ? player.current_streak + 1 : 1;
      if (currentStreak > maxWinStreak) maxWinStreak = currentStreak;
    } else if (p.score < 0) {
      currentStreak = player.current_streak <= 0 ? player.current_streak - 1 : -1;
      if (-currentStreak > maxLoseStreak) maxLoseStreak = -currentStreak;
    } else {
      currentStreak = 0;
    }

    const newWinCount = (player.total_games * player.win_rate / 100) + (1 / winnerCount);
    const finalWinRate = Math.round((newWinCount / totalGames) * 1000) / 10;

    sets.total_games += ` WHEN ? THEN ?`;
    sets.total_score += ` WHEN ? THEN ?`;
    sets.win_rate += ` WHEN ? THEN ?`;
    sets.current_streak += ` WHEN ? THEN ?`;
    sets.max_win_streak += ` WHEN ? THEN ?`;
    sets.max_lose_streak += ` WHEN ? THEN ?`;
    params.push(p.playerId, totalGames, p.playerId, totalScore, p.playerId, finalWinRate,
                p.playerId, currentStreak, p.playerId, maxWinStreak, p.playerId, maxLoseStreak);
    idsOut.push(p.playerId);
  }

  if (idsOut.length === 0) return;

  // 关闭每个 CASE + 用 IN 限定行
  const whereIn = idsOut.map(() => '?').join(',');
  const sql = `UPDATE players SET
    total_games = ${sets.total_games} END,
    total_score = ${sets.total_score} END,
    win_rate = ${sets.win_rate} END,
    current_streak = ${sets.current_streak} END,
    max_win_streak = ${sets.max_win_streak} END,
    max_lose_streak = ${sets.max_lose_streak} END
    WHERE id IN (${whereIn})`;
  await conn.query(sql, [...params, ...idsOut]);
}

/**
 * 写入单条战绩（**不做**免费窗口修剪）
 *
 * 单独拆出来，是为了让批量同步能「插完一批只修剪一次」——
 * 否则一次 500 条的同步会触发 500 次全表扫描 + 删除。
 */
async function insertRecord(userId: string, input: RecordInput): Promise<RecordOutput> {
  validateInput(input);

  const recordId = input.id || uuid();
  const now = Date.now();

  // 幂等：如果已存在（前端批量同步时），直接返回
  const existing = await db.queryOne(
    'SELECT id FROM records WHERE user_id = ? AND id = ?',
    [userId, recordId]
  );
  if (existing) {
    const loaded = await loadRecord(userId, recordId);
    if (loaded) return loaded;
  }

  // 事务：插入战绩 + 关联玩家 + 更新统计
  await db.withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO records (id, user_id, played_at, rule_type, rule_name, duration,
                            total_fee, note, mood, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [recordId, userId, input.playedAt, input.ruleType, input.ruleName, input.duration,
       input.totalFee || 0, input.note || '', input.mood ?? null, now, now]
    );

    // 关联玩家：自动建档（事务内建档也要走 conn）
    const resolved = [] as PlayerScoreInput[];
    for (let idx = 0; idx < input.players.length; idx++) {
      const p = input.players[idx];
      let pid = p.playerId;
      if (!pid) {
        const player = await findOrCreateByConn(conn, userId, p.nickname);
        pid = player.id;
      } else {
        // 校验 playerId 归属
        const [own] = await conn.query(
          'SELECT id FROM players WHERE id = ? AND user_id = ?',
          [pid, userId]
        );
        if (!(own as any[])[0]) throw new BizError('PLAYER_NOT_FOUND', 400, `玩家 ${p.nickname} 不存在`);
      }

      await conn.query(
        `INSERT INTO record_players (id, record_id, player_id, nickname, score, is_substitute, is_observer, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), recordId, pid, p.nickname, p.score, p.isSubstitute ? 1 : 0, p.isObserver ? 1 : 0, idx]
      );

      resolved.push({ ...p, playerId: pid });
    }

    // 更新玩家统计
    await updatePlayerStats(conn, resolved);
  });

  return (await loadRecord(userId, recordId))!;
}

/**
 * 创建战绩（单条入口）
 * 写入后按用户等级修剪云端窗口：免费用户只留最近 N 个有数据的日期
 */
export async function createRecord(userId: string, input: RecordInput): Promise<RecordOutput> {
  const out = await insertRecord(userId, input);
  await trimIfFree(userId);
  return out;
}

/**
 * 批量同步（首登 / 离线恢复 / 用户手动「立即同步」）
 *
 * 全批插入完成后**只修剪一次**，并回传本次淘汰条数，
 * 让前端能明确告诉用户"免费版云端只留了最近 3 天"。
 */
export async function batchCreate(userId: string, records: RecordInput[]): Promise<{
  success: number;
  failed: number;
  results: Array<{ id?: string; ok: boolean; error?: string }>;
  tier: string;
  trimmed: number;
}> {
  const results: Array<{ id?: string; ok: boolean; error?: string }> = [];
  let success = 0, failed = 0;
  for (const r of records) {
    try {
      const out = await insertRecord(userId, r);
      results.push({ id: out.id, ok: true });
      success++;
    } catch (e: any) {
      results.push({ id: r.id, ok: false, error: e.message });
      failed++;
    }
  }

  const tier = await getTier(userId);
  const trimmed = await trimIfFree(userId);

  return { success, failed, results, tier, trimmed };
}

/**
 * 战绩列表（分页）
 */
export async function listRecords(userId: string, opts: { limit?: number; offset?: number; ruleType?: string }) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const ruleFilter = opts.ruleType ? 'AND rule_type = ?' : '';
  const params: any[] = ruleFilter ? [userId, opts.ruleType, limit, offset] : [userId, limit, offset];

  const rows = await db.query<any>(
    `SELECT * FROM records WHERE user_id = ? AND deleted_at IS NULL ${ruleFilter}
     ORDER BY played_at DESC LIMIT ? OFFSET ?`,
    params
  );

  const ids = rows.map(r => r.id);
  if (ids.length === 0) return { total: 0, items: [] };

  const placeholders = ids.map(() => '?').join(',');
  const players = await db.query<any>(
    `SELECT record_id, player_id, nickname, score, is_substitute, is_observer, sort_order
     FROM record_players WHERE record_id IN (${placeholders}) ORDER BY sort_order ASC`,
    ids
  );

  const grouped: Record<string, any[]> = {};
  for (const p of players) {
    (grouped[p.record_id] ||= []).push(p);
  }

  const items = rows.map(r => ({
    id: r.id,
    playedAt: Number(r.played_at),
    ruleType: r.rule_type,
    ruleName: r.rule_name,
    duration: r.duration,
    totalFee: r.total_fee,
    note: r.note || '',
    mood: r.mood,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    players: (grouped[r.id] || []).map(p => ({
      playerId: p.player_id,
      nickname: p.nickname,
      score: p.score,
      isSubstitute: !!p.is_substitute,
      isObserver: !!p.is_observer
    }))
  }));

  const total = (await db.queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND deleted_at IS NULL ${ruleFilter}`,
    ruleFilter ? [userId, opts.ruleType] : [userId]
  ))?.c ?? 0;

  return { total, items };
}

/**
 * 单条战绩
 */
export async function getRecord(userId: string, id: string): Promise<RecordOutput | null> {
  return loadRecord(userId, id);
}

/**
 * 软删除战绩
 */
export async function deleteRecord(userId: string, id: string): Promise<boolean> {
  const r = await db.exec(
    'UPDATE records SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL',
    [Date.now(), Date.now(), userId, id]
  );
  return r.affectedRows > 0;
}
