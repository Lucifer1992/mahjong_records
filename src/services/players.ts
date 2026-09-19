/**
 * 玩家档案业务（MySQL 异步版）
 */
import { query, queryOne, exec } from '../db';
import { uuid } from '../utils/uuid';

export interface Player {
  id: string;
  user_id: string;
  nickname: string;
  color: string;
  created_at: number;
  total_games: number;
  total_score: number;
  win_rate: number;
  max_win_streak: number;
  max_lose_streak: number;
  current_streak: number;
}

const COLORS = [
  '#4A9D7E', '#1D9E75', '#D85A30', '#378ADD',
  '#BA7517', '#993556', '#0F6E56', '#A32D2D',
  '#3B6D11', '#185FA5'
];

export async function listPlayers(userId: string): Promise<Player[]> {
  return query<Player>(
    'SELECT * FROM players WHERE user_id = ? ORDER BY created_at ASC',
    [userId]
  );
}

export async function getPlayer(userId: string, playerId: string): Promise<Player | undefined> {
  return queryOne<Player>(
    'SELECT * FROM players WHERE user_id = ? AND id = ?',
    [userId, playerId]
  );
}

async function countPlayers(userId: string, conn?: any): Promise<number> {
  if (conn) {
    const [rows] = await conn.query('SELECT COUNT(*) AS c FROM players WHERE user_id = ?', [userId]);
    return (rows as any[])[0].c;
  }
  const row = await queryOne<{ c: number }>('SELECT COUNT(*) AS c FROM players WHERE user_id = ?', [userId]);
  return row?.c ?? 0;
}

export async function findOrCreateByConn(conn: any, userId: string, nickname: string): Promise<Player> {
  const [rows] = await conn.query(
    'SELECT * FROM players WHERE user_id = ? AND nickname = ?',
    [userId, nickname]
  );
  const existing = (rows as any[])[0];
  if (existing) return existing as Player;

  const id = uuid();
  const c = await countPlayers(userId, conn);
  const colorIdx = c % COLORS.length;
  await conn.query(
    'INSERT INTO players (id, user_id, nickname, color, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, nickname, COLORS[colorIdx], Date.now()]
  );
  const [after] = await conn.query('SELECT * FROM players WHERE id = ?', [id]);
  return (after as any[])[0] as Player;
}

/**
 * 查找或创建玩家（同 user 下 nickname 唯一）
 * 业务上由战绩模块调用（非事务场景用），前端不直接调
 */
export async function findOrCreate(userId: string, nickname: string): Promise<Player> {
  const existing = await queryOne<Player>(
    'SELECT * FROM players WHERE user_id = ? AND nickname = ?',
    [userId, nickname]
  );
  if (existing) return existing;

  const id = uuid();
  const c = await countPlayers(userId);
  const colorIdx = c % COLORS.length;
  await exec(
    'INSERT INTO players (id, user_id, nickname, color, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, nickname, COLORS[colorIdx], Date.now()]
  );
  return (await queryOne<Player>('SELECT * FROM players WHERE id = ?', [id]))!;
}

export async function createPlayer(userId: string, nickname: string, color?: string): Promise<Player> {
  if (!nickname?.trim()) throw new Error('nickname 不能为空');
  const exists = await queryOne(
    'SELECT id FROM players WHERE user_id = ? AND nickname = ?',
    [userId, nickname]
  );
  if (exists) throw new Error('玩家昵称已存在');
  const id = uuid();
  const c = await countPlayers(userId);
  const usedColor = color || COLORS[c % COLORS.length];
  await exec(
    'INSERT INTO players (id, user_id, nickname, color, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, nickname, usedColor, Date.now()]
  );
  return (await queryOne<Player>('SELECT * FROM players WHERE id = ?', [id]))!;
}

export async function deletePlayer(userId: string, playerId: string): Promise<boolean> {
  const r = await exec('DELETE FROM players WHERE user_id = ? AND id = ?', [userId, playerId]);
  return r.affectedRows > 0;
}
