/**
 * 用户 / 登录业务
 */
import { db } from '../db';
import { uuid } from '../utils/uuid';
import { config } from '../config';
import { logger } from '../logger';
import { normalizeTier, type Tier } from './users';

export interface User {
  id: string;
  openid: string;
  nickname: string;
  avatar: string;
  tier: Tier;
}

/**
 * 通过 jscode2session 拿 openid + session_key（v1 接通后启用）
 * 失败 / 未配置 WX_APPID 时进入 dev 模式：用固定 dev openid 放行
 *
 * session_key 必须落库：虚拟支付的第二签名 signature = HMAC-SHA256(session_key, signData)。
 * 注意 session_key 会过期，前端在支付前若收到 SESSION_KEY_MISSING 应重新 wx.login。
 */
async function fetchOpenidByCode(code: string): Promise<{ openid: string; sessionKey: string } | null> {
  if (!config.wechat.appid || !config.wechat.secret) {
    logger.warn('WX_APPID 未配置，使用 dev 模式');
    return null;
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${config.wechat.appid}&secret=${config.wechat.secret}&js_code=${code}&grant_type=authorization_code`;
  try {
    const resp = await fetch(url);
    const data = (await resp.json()) as { openid?: string; session_key?: string; errcode?: number; errmsg?: string };
    if (data.openid) return { openid: data.openid, sessionKey: data.session_key || '' };
    logger.warn('jscode2session failed', data);
    return null;
  } catch (e) {
    logger.error('jscode2session request error', { err: (e as Error).message });
    return null;
  }
}

/**
 * 登录：根据 code 拿到 openid → 查找或创建用户 → 返回 user
 */
export async function login(code: string, nickname?: string, avatar?: string): Promise<User> {
  const real = await fetchOpenidByCode(code);

  // dev 模式：用 code 模拟一个稳定 openid（仅开发环境生效）
  const openid = real?.openid ?? (config.isDev() ? `dev_${code}` : '');
  const sessionKey = real?.sessionKey || '';

  if (!openid) {
    throw new Error('login failed: cannot resolve openid');
  }

  const existing = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid) as
    | (Omit<User, 'tier'> & { tier?: string; session_key?: string })
    | undefined;
  if (existing) {
    if (sessionKey) {
      // 新的 session_key 覆盖旧值；拿不到（理论上不会）就保留旧值
      db.prepare('UPDATE users SET last_login_at = ?, nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar), session_key = ? WHERE id = ?')
        .run(Date.now(), nickname ?? null, avatar ?? null, sessionKey, existing.id);
    } else {
      db.prepare('UPDATE users SET last_login_at = ?, nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar) WHERE id = ?')
        .run(Date.now(), nickname ?? null, avatar ?? null, existing.id);
    }
    return {
      id: existing.id,
      openid: existing.openid,
      nickname: existing.nickname,
      avatar: existing.avatar,
      tier: normalizeTier(existing.tier)
    };
  }

  const id = uuid();
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, openid, nickname, avatar, tier, session_key, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, openid, nickname || '麻友', avatar || '', 'free', sessionKey, now, now);

  return { id, openid, nickname: nickname || '麻友', avatar: avatar || '', tier: 'free' };
}

/** 读取用户当前 session_key（虚拟支付签名用；可能为空 = 需重新登录） */
export function getSessionKey(userId: string): string {
  const row = db.prepare('SELECT session_key FROM users WHERE id = ?').get(userId) as
    | { session_key?: string }
    | undefined;
  return row?.session_key || '';
}