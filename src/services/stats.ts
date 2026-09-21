/**
 * 统计业务（总览 / 福星克星 / 牌局月历）—— MySQL 异步版
 *
 * 注意：前端实际不调用这些接口（分析全在本地算），保留是为了
 * 后台 / 未来版本可用；语义与旧 SQLite 版保持一致。
 *
 * 月历按「打牌日」分组：played_at 存毫秒 BIGINT，
 * FROM_UNIXTIME(played_at/1000) 受会话时区影响 —— 连接池已固定 +08:00，
 * 与修剪窗口（TZ_OFFSET_MINUTES=480）同一套时区语义。
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
export async function getSummary(userId: string, currentPlayerNickname?: string): Promise<Summary> {
  const totalGames = (await db.queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND deleted_at IS NULL',
    [userId]
  ))?.c ?? 0;

  // 找当前玩家（昵称匹配的第一个）
  const me = currentPlayerNickname
    ? await db.queryOne<{ id: string }>(
        'SELECT id FROM players WHERE user_id = ? AND nickname = ?',
        [userId, currentPlayerNickname]
      )
    : undefined;

  let totalScore = 0;
  let bestRule: string | null = null;
  if (me) {
    const sumRow = await db.queryOne<{ s: number }>(
      `SELECT COALESCE(SUM(rp.score), 0) AS s FROM record_players rp
       JOIN records r ON r.id = rp.record_id
       WHERE rp.player_id = ? AND r.deleted_at IS NULL`,
      [me.id]
    );
    totalScore = sumRow?.s ?? 0;

    const ruleRow = await db.queryOne<{ rule_type: string }>(
      `SELECT r.rule_type FROM record_players rp
       JOIN records r ON r.id = rp.record_id
       WHERE rp.player_id = ? AND r.deleted_at IS NULL
       GROUP BY r.rule_type ORDER BY SUM(rp.score) DESC LIMIT 1`,
      [me.id]
    );
    bestRule = ruleRow?.rule_type ?? null;
  }

  // 近 10 局趋势
  let recentTrend: 'up' | 'down' | 'flat' = 'flat';
  if (me) {
    const recent = await db.query<{ score: number }>(
      `SELECT rp.score FROM record_players rp
       JOIN records r ON r.id = rp.record_id
       WHERE rp.player_id = ? AND r.deleted_at IS NULL
       ORDER BY r.played_at DESC LIMIT 10`,
      [me.id]
    );
    if (recent.length >= 2) {
      const half = Math.floor(recent.length / 2);
      const newSum = recent.slice(0, half).reduce((s, x) => s + Number(x.score), 0);
      const oldSum = recent.slice(half).reduce((s, x) => s + Number(x.score), 0);
      if (newSum > oldSum + 5) recentTrend = 'up';
      else if (newSum < oldSum - 5) recentTrend = 'down';
    }
  }

  const totalPlayers = (await db.queryOne<{ c: number }>(
    'SELECT COUNT(*) AS c FROM players WHERE user_id = ?',
    [userId]
  ))?.c ?? 0;

  return { totalGames, totalScore, totalPlayers, bestRule, recentTrend };
}

/**
 * 福星克星分析
 */
export async function getFortune(userId: string, playerId: string, topN = 5): Promise<FortuneResult | null> {
  const player = await db.queryOne<any>(
    'SELECT * FROM players WHERE id = ? AND user_id = ?',
    [playerId, userId]
  );
  if (!player) return null;

  // 找所有和该玩家同场的记录 ID
  const myRecordIds = (await db.query<{ record_id: string }>(
    'SELECT DISTINCT record_id FROM record_players WHERE player_id = ?',
    [playerId]
  )).map(r => r.record_id);

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
  const partners = await db.query<any>(
    `SELECT rp.player_id AS pid, p.nickname AS nickname,
            COUNT(*) AS games,
            SUM(CASE WHEN rp.score > 0 THEN 1 ELSE 0 END) AS wins,
            SUM(rp.score) AS net_score
     FROM record_players rp
     JOIN players p ON p.id = rp.player_id
     JOIN records r ON r.id = rp.record_id
     WHERE rp.record_id IN (${placeholders})
       AND rp.player_id != ?
       AND r.deleted_at IS NULL
     GROUP BY rp.player_id, p.nickname`,
    [...myRecordIds, playerId]
  );

  const partnerStats: PartnerStat[] = partners.map(p => ({
    partnerId: p.pid,
    partnerNickname: p.nickname,
    gamesTogether: Number(p.games),
    winsTogether: Number(p.wins),
    winRate: Math.round((Number(p.wins) / Number(p.games)) * 1000) / 10,
    netScore: Number(p.net_score)
  }));

  // 福星：净分高、按胜率排序取 topN
  const lucky = [...partnerStats].sort((a, b) => b.netScore - a.netScore || b.winRate - a.winRate).slice(0, topN);
  // 克星：净分低
  const evil = [...partnerStats].sort((a, b) => a.netScore - b.netScore || a.winRate - b.winRate).slice(0, topN);

  // 最佳/最差位置（按座位号统计净分）
  const posStats = await db.query<any>(
    `SELECT rp.sort_order AS pos, SUM(rp.score) AS s, COUNT(*) AS c
     FROM record_players rp
     JOIN records r ON r.id = rp.record_id
     WHERE rp.player_id = ? AND r.deleted_at IS NULL
     GROUP BY rp.sort_order`,
    [playerId]
  );

  let bestPosition = 0, worstPosition = 0;
  if (posStats.length > 0) {
    let bestAvg = -Infinity, worstAvg = Infinity;
    for (const ps of posStats) {
      const avg = Number(ps.s) / Number(ps.c);
      if (avg > bestAvg) { bestAvg = avg; bestPosition = Number(ps.pos); }
      if (avg < worstAvg) { worstAvg = avg; worstPosition = Number(ps.pos); }
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
 * 牌局月历：返回某月每天的净分与场次
 */
export async function getCalendar(userId: string, year: number, month: number, playerNickname?: string): Promise<CalendarDay[]> {
  const start = new Date(year, month - 1, 1).getTime();
  const end = new Date(year, month, 1).getTime();

  let rows: { day: string; games: number; score: number }[];

  if (playerNickname) {
    const me = await db.queryOne<{ id: string }>(
      'SELECT id FROM players WHERE user_id = ? AND nickname = ?',
      [userId, playerNickname]
    );
    if (!me) return [];
    rows = await db.query<any>(
      `SELECT DATE_FORMAT(FROM_UNIXTIME(r.played_at / 1000), '%Y-%m-%d') AS day,
              COUNT(*) AS games,
              SUM(rp.score) AS score
       FROM record_players rp
       JOIN records r ON r.id = rp.record_id
       WHERE rp.player_id = ? AND r.deleted_at IS NULL
         AND r.played_at >= ? AND r.played_at < ?
       GROUP BY day`,
      [me.id, start, end]
    );
  } else {
    // 整月所有战绩（按局计）
    rows = await db.query<any>(
      `SELECT DATE_FORMAT(FROM_UNIXTIME(played_at / 1000), '%Y-%m-%d') AS day,
              COUNT(*) AS games, 0 AS score
       FROM records
       WHERE user_id = ? AND deleted_at IS NULL
         AND played_at >= ? AND played_at < ?
       GROUP BY day`,
      [userId, start, end]
    );
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
      const score = Number(row.score) || 0;
      result.push({
        date,
        gamesPlayed: Number(row.games),
        netScore: score,
        result: score > 0 ? 'win' : score < 0 ? 'lose' : 'even'
      });
    }
  }
  return result;
}
