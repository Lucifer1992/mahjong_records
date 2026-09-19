/**
 * 用户等级业务（MySQL 异步版）
 *
 * 分层设计：
 * - free：云端只保留「最近 N 个有数据的日期」（默认 3 天），每次同步淘汰更早的
 * - pro ：云端全量累积，永不淘汰
 *
 * 升级入口：微信虚拟支付履约（services/vpay.ts markOrderPaid → setTier('pro')）。
 * 兑换码通道已于 2026-09-19 下线移除。
 */
import { queryOne, exec } from '../db';

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

export async function getUserById(userId: string): Promise<UserRow | undefined> {
  return queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [userId]);
}

export async function getTier(userId: string): Promise<Tier> {
  const row = await queryOne<{ tier: string }>('SELECT tier FROM users WHERE id = ?', [userId]);
  return normalizeTier(row?.tier);
}

export async function setTier(userId: string, tier: Tier): Promise<boolean> {
  const r = await exec('UPDATE users SET tier = ? WHERE id = ?', [tier, userId]);
  return r.affectedRows > 0;
}

/** 修改微信登录用户的昵称（云端身份；返回更新后的值） */
export async function updateNickname(userId: string, nickname: string): Promise<string | null> {
  const name = nickname.trim();
  if (!name) return null;
  const r = await exec('UPDATE users SET nickname = ? WHERE id = ?', [name, userId]);
  return r.affectedRows > 0 ? name : null;
}

/**
 * 修改账户资料（昵称 / 头像 URL，至少一项）
 * 头像由 /api/upload/avatar 上传后拿到 /avatars/xxx 相对 URL 再落库
 */
export async function updateProfile(
  userId: string,
  patch: { nickname?: string; avatar?: string }
): Promise<{ nickname?: string; avatar?: string } | null> {
  const sets: string[] = [];
  const params: any[] = [];

  const nickname = patch.nickname?.trim();
  if (nickname) {
    sets.push('nickname = ?');
    params.push(nickname);
  }
  if (patch.avatar) {
    sets.push('avatar = ?');
    params.push(patch.avatar);
  }
  if (sets.length === 0) return null;

  const r = await exec(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, userId]);
  if (r.affectedRows === 0) return null;
  return { nickname: nickname || undefined, avatar: patch.avatar };
}
