/**
 * 战绩业务
 * - 单条 / 批量写入（自动创建/更新玩家档案）
 * - 软删除（保留玩家统计稳定）
 */
import { db } from '../db';
import { uuid } from '../utils/uuid';
import { findOrCreate } from './players';
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
 * 创建战绩
 */
export function createRecord(userId: string, input: RecordInput): RecordOutput {
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
 * 批量同步（首登 / 离线恢复）
 * 返回每条结果
 */
export function batchCreate(userId: string, records: RecordInput[]): {
  success: number;
  failed: number;
  results: Array<{ id?: string; ok: boolean; error?: string }>;
} {
  const results: Array<{ id?: string; ok: boolean; error?: string }> = [];
  let success = 0, failed = 0;
  for (const r of records) {
    try {
      const out = createRecord(userId, r);
      results.push({ id: out.id, ok: true });
      success++;
    } catch (e: any) {
      results.push({ id: r.id, ok: false, error: e.message });
      failed++;
    }
  }
  return { success, failed, results };
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