/**
 * 战绩业务
 * - 单条 / 批量写入（自动创建/更新玩家档案）
 * - 软删除（保留玩家统计稳定）
 */
import { db } from '../db';
import { uuid } from '../utils/uuid';
import { findOrCreate } from './players';
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
 * 例（N=3，本地有 2.3 / 2.5 / 2.10 / 2.22）
 *   → 云端只留 2.5 / 2.10 / 2.22
 *   → 之后新增 2.25，则 2.5 被淘汰，云端变成 2.10 / 2.22 / 2.25
 *
 * 两个刻意的选择：
 * 1. **硬删除**，不是软删除。软删除只标记隐藏、不省空间，也表达不出
 *    「云端不留这段历史」的免费额度语义。
 * 2. **只动云端，绝不动本地**。本地永远是全量；用户升级 Pro 后再同步一次，
 *    这些被淘汰的记录会被重新上传（createRecord 按 id 幂等）。
 *
 * @returns 被淘汰的云端记录条数
 */
export function trimFreeWindow(userId: string): number {
  const keep = config.tier.freeWindowDates;
  if (keep <= 0) return 0;

  const rows = db.prepare(
    'SELECT played_at FROM records WHERE user_id = ? AND deleted_at IS NULL ORDER BY played_at DESC'
  ).all(userId) as Array<{ played_at: number }>;
  if (rows.length === 0) return 0;

  const seen = new Set<string>();
  const keepDates: string[] = [];
  for (const r of rows) {
    const key = dateKey(r.played_at);
    if (seen.has(key)) continue;
    seen.add(key);
    if (keepDates.length < keep) keepDates.push(key);
    else break;
  }

  // 还有富余日期 → 不用淘汰
  if (seen.size <= keep) return 0;

  // 所有被淘汰的记录一定早于「最旧保留日」当天 00:00
  const cutoff = dayStart(keepDates[keepDates.length - 1]);

  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM record_players WHERE record_id IN (
         SELECT id FROM records WHERE user_id = ? AND deleted_at IS NULL AND played_at < ?
       )`
    ).run(userId, cutoff);
    return db.prepare(
      'DELETE FROM records WHERE user_id = ? AND deleted_at IS NULL AND played_at < ?'
    ).run(userId, cutoff).changes;
  });

  return tx();
}

/** 免费用户才需要修剪；Pro 直接跳过（省掉一次全表扫描） */
function trimIfFree(userId: string): number {
  if (getTier(userId) === 'pro') return 0;
  return trimFreeWindow(userId);
}

function validateInput(input: RecordInput) {  if (!input.playedAt || typeof input.playedAt !== 'number') {
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
function loadRecord(userId: string, recordId: string): RecordOutput | null {
  const r = db.prepare(
    'SELECT * FROM records WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
  ).get(userId, recordId) as any;
  if (!r) return null;

  const players = db.prepare(
    'SELECT player_id, nickname, score, is_substitute, is_observer FROM record_players WHERE record_id = ? ORDER BY sort_order ASC'
  ).all(recordId) as any[];

  return {
    id: r.id,
    playedAt: r.played_at,
    ruleType: r.rule_type,
    ruleName: r.rule_name,
    duration: r.duration,
    totalFee: r.total_fee,
    note: r.note || '',
    mood: r.mood,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
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
 * 正向更新玩家战绩统计（写入战绩后调用）
 */
function updatePlayerStats(recordId: string, players: PlayerScoreInput[]) {
  // 找最高分者
  let maxScore = -Infinity;
  for (const p of players) if (p.score > maxScore) maxScore = p.score;

  for (const p of players) {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(p.playerId) as any;
    if (!player) continue;

    const isWinner = p.score === maxScore && maxScore > 0;
    const totalGames = player.total_games + 1;
    const totalScore = player.total_score + p.score;

    // streak：赢家 +1，输家 -1，0 重置
    let currentStreak = player.current_streak;
    let maxWinStreak = player.max_win_streak;
    let maxLoseStreak = player.max_lose_streak;

    if (p.score > 0) {
      currentStreak = currentStreak >= 0 ? currentStreak + 1 : 1;
      if (currentStreak > maxWinStreak) maxWinStreak = currentStreak;
    } else if (p.score < 0) {
      currentStreak = currentStreak <= 0 ? currentStreak - 1 : -1;
      if (-currentStreak > maxLoseStreak) maxLoseStreak = -currentStreak;
    } else {
      currentStreak = 0;
    }

    const winRate = totalGames > 0 ? Math.round((isWinner ? 1 : 0) * 1000) / 10 : 0;
    // 简化的胜率：赢家场次 / 总场次（这里单局赢家有多人时按平均算）
    // v1 简化为：单局里 score>0 算胜
    const winnerCount = players.filter(x => x.score > 0).length || 1;
    const newWinCount = (player.total_games * player.win_rate / 100) + (1 / winnerCount);
    const finalWinRate = Math.round((newWinCount / totalGames) * 1000) / 10;

    db.prepare(`
      UPDATE players
      SET total_games = ?, total_score = ?, win_rate = ?,
          current_streak = ?, max_win_streak = ?, max_lose_streak = ?
      WHERE id = ?
    `).run(totalGames, totalScore, finalWinRate, currentStreak, maxWinStreak, maxLoseStreak, p.playerId);
  }
}

/**
 * 写入单条战绩（**不做**免费窗口修剪）
 *
 * 单独拆出来，是为了让批量同步能「插完一批只修剪一次」——
 * 否则一次 500 条的同步会触发 500 次全表扫描 + 删除。
 */
function insertRecord(userId: string, input: RecordInput): RecordOutput {
  validateInput(input);

  const recordId = input.id || uuid();
  const now = Date.now();

  // 幂等：如果已存在（前端批量同步时），直接返回
  const existing = db.prepare(
    'SELECT id FROM records WHERE user_id = ? AND id = ?'
  ).get(userId, recordId);
  if (existing) {
    const loaded = loadRecord(userId, recordId);
    if (loaded) return loaded;
  }

  // 事务：插入战绩 + 关联玩家
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO records (id, user_id, played_at, rule_type, rule_name, duration,
                           total_fee, note, mood, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId, userId, input.playedAt, input.ruleType, input.ruleName, input.duration,
      input.totalFee || 0, input.note || '', input.mood ?? null, now, now
    );

    // 关联玩家：自动建档
    const resolved = input.players.map((p, idx) => {
      let pid = p.playerId;
      if (!pid) {
        const player = findOrCreate(userId, p.nickname);
        pid = player.id;
      } else {
        // 校验 playerId 归属
        const own = db.prepare('SELECT id FROM players WHERE id = ? AND user_id = ?')
          .get(pid, userId);
        if (!own) throw new BizError('PLAYER_NOT_FOUND', 400, `玩家 ${p.nickname} 不存在`);
      }

      db.prepare(`
        INSERT INTO record_players (id, record_id, player_id, nickname, score, is_substitute, is_observer, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), recordId, pid, p.nickname, p.score, p.isSubstitute ? 1 : 0, p.isObserver ? 1 : 0, idx);

      return { ...p, playerId: pid };
    });

    // 更新玩家统计
    updatePlayerStats(recordId, resolved);
  });

  tx();

  return loadRecord(userId, recordId)!;
}

/**
 * 创建战绩（单条入口）
 * 写入后按用户等级修剪云端窗口：免费用户只留最近 N 个有数据的日期
 */
export function createRecord(userId: string, input: RecordInput): RecordOutput {
  const out = insertRecord(userId, input);
  trimIfFree(userId);
  return out;
}

/**
 * 批量同步（首登 / 离线恢复 / 用户手动「立即同步」）
 *
 * 全批插入完成后**只修剪一次**，并回传本次淘汰条数，
 * 让前端能明确告诉用户"免费版云端只留了最近 3 天"。
 */
export function batchCreate(userId: string, records: RecordInput[]): {
  success: number;
  failed: number;
  results: Array<{ id?: string; ok: boolean; error?: string }>;
  tier: string;
  trimmed: number;
} {
  const results: Array<{ id?: string; ok: boolean; error?: string }> = [];
  let success = 0, failed = 0;
  for (const r of records) {
    try {
      const out = insertRecord(userId, r);
      results.push({ id: out.id, ok: true });
      success++;
    } catch (e: any) {
      results.push({ id: r.id, ok: false, error: e.message });
      failed++;
    }
  }

  const tier = getTier(userId);
  const trimmed = trimIfFree(userId);

  return { success, failed, results, tier, trimmed };
}

/**
 * 战绩列表（分页）
 */
export function listRecords(userId: string, opts: { limit?: number; offset?: number; ruleType?: string }) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const ruleFilter = opts.ruleType ? 'AND rule_type = ?' : '';
  const params: any[] = ruleFilter ? [userId, opts.ruleType, limit, offset] : [userId, limit, offset];

  const rows = db.prepare(
    `SELECT * FROM records WHERE user_id = ? AND deleted_at IS NULL ${ruleFilter}
     ORDER BY played_at DESC LIMIT ? OFFSET ?`
  ).all(...params) as any[];

  const ids = rows.map(r => r.id);
  if (ids.length === 0) return { total: 0, items: [] };

  const placeholders = ids.map(() => '?').join(',');
  const players = db.prepare(
    `SELECT record_id, player_id, nickname, score, is_substitute, is_observer, sort_order
     FROM record_players WHERE record_id IN (${placeholders}) ORDER BY sort_order ASC`
  ).all(...ids) as any[];

  const grouped: Record<string, any[]> = {};
  for (const p of players) {
    (grouped[p.record_id] ||= []).push(p);
  }

  const items = rows.map(r => ({
    id: r.id,
    playedAt: r.played_at,
    ruleType: r.rule_type,
    ruleName: r.rule_name,
    duration: r.duration,
    totalFee: r.total_fee,
    note: r.note || '',
    mood: r.mood,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    players: (grouped[r.id] || []).map(p => ({
      playerId: p.player_id,
      nickname: p.nickname,
      score: p.score,
      isSubstitute: !!p.is_substitute,
      isObserver: !!p.is_observer
    }))
  }));

  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND deleted_at IS NULL ${ruleFilter}`
  ).get(...(ruleFilter ? [userId, opts.ruleType] : [userId])) as { c: number }).c;

  return { total, items };
}

/**
 * 单条战绩
 */
export function getRecord(userId: string, id: string): RecordOutput | null {
  return loadRecord(userId, id);
}

/**
 * 软删除战绩
 */
export function deleteRecord(userId: string, id: string): boolean {
  const r = db.prepare(
    'UPDATE records SET deleted_at = ?, updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL'
  ).run(Date.now(), Date.now(), userId, id);
  return r.changes > 0;
}