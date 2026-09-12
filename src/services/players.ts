/**
 * 玩家档案业务
 */
import { db } from '../db';
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

export function listPlayers(userId: string): Player[] {
  return db.prepare(
    'SELECT * FROM players WHERE user_id = ? ORDER BY created_at ASC'
  ).all(userId) as Player[];
}

export function getPlayer(userId: string, playerId: string): Player | undefined {
  return db.prepare(
    'SELECT * FROM players WHERE user_id = ? AND id = ?'
  ).get(userId, playerId) as Player | undefined;
}

/**
 * 查找或创建玩家（同 user 下 nickname 唯一）
 * 业务上由战绩模块调用，前端不直接调
 */
export function findOrCreate(userId: string, nickname: string): Player {
  const existing = db.prepare(
    'SELECT * FROM players WHERE user_id = ? AND nickname = ?'
  ).get(userId, nickname) as Player | undefined;
  if (existing) return existing;

  const id = uuid();
  const colorIdx = (db.prepare('SELECT COUNT(*) AS c FROM players WHERE user_id = ?')
    .get(userId) as { c: number }).c % COLORS.length;
  db.prepare(`
    INSERT INTO players (id, user_id, nickname, color, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, nickname, COLORS[colorIdx], Date.now());

  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player;
}

export function createPlayer(userId: string, nickname: string, color?: string): Player {
  if (!nickname?.trim()) throw new Error('nickname 不能为空');
  const exists = db.prepare(
    'SELECT id FROM players WHERE user_id = ? AND nickname = ?'
  ).get(userId, nickname);
  if (exists) throw new Error('玩家昵称已存在');
  const id = uuid();
  const usedColor = color || COLORS[(db.prepare('SELECT COUNT(*) AS c FROM players WHERE user_id = ?')
    .get(userId) as { c: number }).c % COLORS.length];
  db.prepare(`
    INSERT INTO players (id, user_id, nickname, color, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, nickname, usedColor, Date.now());
  return db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player;
}

export function deletePlayer(userId: string, playerId: string): boolean {
  const r = db.prepare('DELETE FROM players WHERE user_id = ? AND id = ?').run(userId, playerId);
  return r.changes > 0;
}