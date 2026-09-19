/**
 * 用户等级业务
 *
 * 分层设计：
 * - free：云端只保留「最近 N 个有数据的日期」（默认 3 天），每次同步淘汰更早的
 * - pro ：云端全量累积，永不淘汰
 *
 * 升级入口：微信虚拟支付履约（services/vpay.ts markOrderPaid → setTier('pro')）。
 * 兑换码通道已于 2026-09-19 下线移除。
 */
import { db } from '../db';

export type Tier = 'free' | 'pro';

export interface UserRow {
  id: string;
  openid: string;
  nickname: string;
  avatar: string;
  tier: string;
  created_at: number;
  last_login_at: number;
}

/** 把库里读出来的 tier 收敛成合法值（防止脏数据把用户卡在中间态） */
export function normalizeTier(raw: unknown): Tier {
  return raw === 'pro' ? 'pro' : 'free';
}

export function getUserById(userId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
}

export function getTier(userId: string): Tier {
  const row = db.prepare('SELECT tier FROM users WHERE id = ?').get(userId) as
    | { tier?: string }
    | undefined;
  return normalizeTier(row?.tier);
}

export function setTier(userId: string, tier: Tier): boolean {
  const r = db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, userId);
  return r.changes > 0;
}
