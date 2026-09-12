/**
 * 统计业务（总览 / 福星克星 / 牌运月历）
 */
import { db } from '../db';

export interface Summary {
  totalGames: number;
  totalScore: number;
  totalPlayers: number;
  bestRule: string | null;
  recentTrend: 'up' | 'down' | 'flat';
}

export interface PartnerStat {
  partnerId: string;
  partnerNickname: string;
  gamesTogether: number;
  winsTogether: number;
  winRate: number;
  netScore: number;
}

export interface FortuneResult {
  playerId: string;
  playerNickname: string;
  luckyPartners: PartnerStat[];
  evilPartners: PartnerStat[];
  bestPosition: number;
  worstPosition: number;
}

export interface CalendarDay {
  date: string;
  gamesPlayed: number;
  netScore: number;
  result: 'win' | 'lose' | 'even' | 'none';
}

/**
 * 全局统计概览
 */
export function getSummary(userId: string, currentPlayerNickname?: string): Summary {
  const totalGames = (db.prepare(
    'SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND deleted_at IS NULL'
  ).get(userId) as { c: number }).c;

  // 找当前玩家（昵称匹配的第一个）
  const me = currentPlayerNickname
    ? db.prepare('SELECT id FROM players WHERE user_id = ? AND nickname = ?').get(userId, currentPlayerNickname) as { id: string } | undefined
    : undefined;

  let totalScore = 0;
  let bestRule: string | null = null;
  if (me) {
    const sumRow = db.prepare(`
      SELECT COALESCE(SUM(rp.score), 0) AS s FROM record_players rp
      JOIN records r ON r.id = rp.record_id
      WHERE rp.player_id = ? AND r.deleted_at IS NULL
    `).get(me.id) as { s: number };
    totalScore = sumRow.s;

    const ruleRow = db.prepare(`
      SELECT r.rule_type, SUM(rp.score) AS s FROM record_players rp
      JOIN records r ON r.id = rp.record_id
      WHERE rp.player_id = ? AND r.deleted_at IS NULL
      GROUP BY r.rule_type ORDER BY s DESC LIMIT 1
    `).get(me.id) as { rule_type: string; s: number } | undefined;
    bestRule = ruleRow?.rule_type ?? null;
  }

  // 近 10 局趋势
  let recentTrend: 'up' | 'down' | 'flat' = 'flat';
  if (me) {
    const recent = db.prepare(`
      SELECT rp.score FROM record_players rp
      JOIN records r ON r.id = rp.record_id
      WHERE rp.player_id = ? AND r.deleted_at IS NULL
      ORDER BY r.played_at DESC LIMIT 10
    `).all(me.id) as { score: number }[];
    if (recent.length >= 2) {
      const half = Math.floor(recent.length / 2);
      const newSum = recent.slice(0, half).reduce((s, x) => s + x.score, 0);
      const oldSum = recent.slice(half).reduce((s, x) => s + x.score, 0);
      if (newSum > oldSum + 5) recentTrend = 'up';
      else if (newSum < oldSum - 5) recentTrend = 'down';
    }
  }

  const totalPlayers = (db.prepare(
    'SELECT COUNT(*) AS c FROM players WHERE user_id = ?'
  ).get(userId) as { c: number }).c;

  return { totalGames, totalScore, totalPlayers, bestRule, recentTrend };
}

/**
 * 福星克星分析
 */
export function getFortune(userId: string, playerId: string, topN = 5): FortuneResult | null {
  const player = db.prepare('SELECT * FROM players WHERE id = ? AND user_id = ?')
    .get(playerId, userId) as any;
  if (!player) return null;

  // 找所有和该玩家同场的记录 ID
  const myRecordIds = (db.prepare(`
    SELECT DISTINCT record_id FROM record_players WHERE player_id = ?
  `).all(playerId) as { record_id: string }[]).map(r => r.record_id);

  if (myRecordIds.length === 0) {
    return {
      playerId,
      playerNickname: player.nickname,
      luckyPartners: [],
      evilPartners: [],
      bestPosition: 0,
      worstPosition: 0
    };
  }

  const placeholders = myRecordIds.map(() => '?').join(',');

  // 聚合每个搭档的 stats
  const partners = db.prepare(`
    SELECT rp.player_id AS pid, p.nickname AS nickname,
           COUNT(*) AS games,
           SUM(CASE WHEN rp.score > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(rp.score) AS net_score
    FROM record_players rp
    JOIN players p ON p.id = rp.player_id
    JOIN records r ON r.id = rp.record_id
    WHERE rp.record_id IN (${placeholders})
      AND rp.player_id != ?
      AND r.deleted_at IS NULL
    GROUP BY rp.player_id
  `).all(...myRecordIds, playerId) as any[];

  const partnerStats: PartnerStat[] = partners.map(p => ({
    partnerId: p.pid,
    partnerNickname: p.nickname,
    gamesTogether: p.games,
    winsTogether: p.wins,
    winRate: Math.round((p.wins / p.games) * 1000) / 10,
    netScore: p.net_score
  }));

  // 福星：净分高、按胜率排序取 topN
  const lucky = [...partnerStats].sort((a, b) => b.netScore - a.netScore || b.winRate - a.winRate).slice(0, topN);
  // 克星：净分低
  const evil = [...partnerStats].sort((a, b) => a.netScore - b.netScore || a.winRate - b.winRate).slice(0, topN);

  // 最佳/最差位置（按座位号统计净分）
  const posStats = db.prepare(`
    SELECT sort_order AS pos, SUM(rp.score) AS s, COUNT(*) AS c
    FROM record_players rp
    JOIN records r ON r.id = rp.record_id
    WHERE rp.player_id = ? AND r.deleted_at IS NULL
    GROUP BY sort_order
  `).all(playerId) as any[];

  let bestPosition = 0, worstPosition = 0;
  if (posStats.length > 0) {
    let bestAvg = -Infinity, worstAvg = Infinity;
    for (const ps of posStats) {
      const avg = ps.s / ps.c;
      if (avg > bestAvg) { bestAvg = avg; bestPosition = ps.pos; }
      if (avg < worstAvg) { worstAvg = avg; worstPosition = ps.pos; }
    }
  }

  return {
    playerId,
    playerNickname: player.nickname,
    luckyPartners: lucky,
    evilPartners: evil,
    bestPosition,
    worstPosition
  };
}

/**
 * 牌运月历：返回某月每天的净分与场次
 */
export function getCalendar(userId: string, year: number, month: number, playerNickname?: string): CalendarDay[] {
  const start = new Date(year, month - 1, 1).getTime();
  const end = new Date(year, month, 1).getTime();

  // 找到该用户在该月有战绩的日期（按玩家过滤）
  let rows: { day: string; games: number; score: number }[];

  if (playerNickname) {
    const me = db.prepare('SELECT id FROM players WHERE user_id = ? AND nickname = ?')
      .get(userId, playerNickname) as { id: string } | undefined;
    if (!me) return [];
    rows = db.prepare(`
      SELECT strftime('%Y-%m-%d', datetime(r.played_at/1000, 'unixepoch', 'localtime')) AS day,
             COUNT(*) AS games,
             SUM(rp.score) AS score
      FROM record_players rp
      JOIN records r ON r.id = rp.record_id
      WHERE rp.player_id = ? AND r.deleted_at IS NULL
        AND r.played_at >= ? AND r.played_at < ?
      GROUP BY day
    `).all(me.id, start, end) as any[];
  } else {
    // 整月所有战绩（按局计）
    rows = db.prepare(`
      SELECT strftime('%Y-%m-%d', datetime(played_at/1000, 'unixepoch', 'localtime')) AS day,
             COUNT(*) AS games, 0 AS score
      FROM records
      WHERE user_id = ? AND deleted_at IS NULL
        AND played_at >= ? AND played_at < ?
      GROUP BY day
    `).all(userId, start, end) as any;
  }

  const map = new Map(rows.map(r => [r.day, r]));
  const daysInMonth = new Date(year, month, 0).getDate();
  const result: CalendarDay[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const row = map.get(date);
    if (!row) {
      result.push({ date, gamesPlayed: 0, netScore: 0, result: 'none' });
    } else {
      const score = row.score || 0;
      result.push({
        date,
        gamesPlayed: row.games,
        netScore: score,
        result: score > 0 ? 'win' : score < 0 ? 'lose' : 'even'
      });
    }
  }
  return result;
}