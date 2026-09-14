/**
 * 用户等级业务
 *
 * 分层设计：
 * - free：云端只保留「最近 N 个有数据的日期」（默认 3 天），每次同步淘汰更早的
 * - pro ：云端全量累积，永不淘汰
 *
 * 为什么用「兑换码」而不是微信支付：
 * 小程序个人主体**无法开通微信支付**，所以 MVP 阶段先做一个能跑通
 * 「付费 → 解锁」闭环的替代通道。将来主体升级或接入其他支付后，
 * 只要把 redeemPro 换成支付回调里的同一个 setTier 调用即可，其余逻辑不用动。
 */
import { db } from '../db';
import { config } from '../config';

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

/**
 * 兑换码升级
 *
 * 校验顺序：先看配置的正式码，再看 dev 环境的万能码。
 * prod 且 PRO_UNLOCK_CODE 未配置时，任何人都无法自助升级——这是刻意的，
 * 避免上线后被人拿到接口白嫖 Pro。
 */
export function redeemPro(userId: string, code: string): { ok: boolean; message: string; tier: Tier } {
  const input = (code || '').trim();
  const current = getTier(userId);

  if (!input) {
    return { ok: false, message: '请输入兑换码', tier: current };
  }

  const formalCode = config.tier.proUnlockCode;
  const devCode = config.isDev() ? 'DEV-PRO' : '';

  const matched = (!!formalCode && input === formalCode) || (!!devCode && input === devCode);
  if (!matched) {
    return { ok: false, message: '兑换码无效', tier: current };
  }

  if (current === 'pro') {
    return { ok: true, message: '你已经是 Pro 了', tier: 'pro' };
  }

  setTier(userId, 'pro');
  return { ok: true, message: '已升级为 Pro', tier: 'pro' };
}
