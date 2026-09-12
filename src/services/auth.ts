/**
 * 用户 / 登录业务
 */
import { db } from '../db';
import { uuid } from '../utils/uuid';
import { config } from '../config';
import { logger } from '../logger';

export interface User {
  id: string;
  openid: string;
  nickname: string;
  avatar: string;
}

/**
 * 通过 jscode2session 拿 openid（v1 接通后启用）
 * 失败 / 未配置 WX_APPID 时进入 dev 模式：用固定 dev openid 放行
 */
async function fetchOpenidByCode(code: string): Promise<string | null> {
  if (!config.wechat.appid || !config.wechat.secret) {
    logger.warn('WX_APPID 未配置，使用 dev 模式');
    return null;
  }
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${config.wechat.appid}&secret=${config.wechat.secret}&js_code=${code}&grant_type=authorization_code`;
  try {
    const resp = await fetch(url);
    const data = (await resp.json()) as { openid?: string; errcode?: number; errmsg?: string };
    if (data.openid) return data.openid;
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
  const realOpenid = await fetchOpenidByCode(code);

  // dev 模式：用 code 模拟一个稳定 openid（仅开发环境生效）
  const openid = realOpenid ?? (config.isDev() ? `dev_${code}` : '');

  if (!openid) {
    throw new Error('login failed: cannot resolve openid');
  }

  const existing = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid) as User | undefined;
  if (existing) {
    db.prepare('UPDATE users SET last_login_at = ?, nickname = COALESCE(?, nickname), avatar = COALESCE(?, avatar) WHERE id = ?')
      .run(Date.now(), nickname ?? null, avatar ?? null, existing.id);
    return { ...existing, last_login_at: Date.now() } as User;
  }

  const id = uuid();
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, openid, nickname, avatar, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, openid, nickname || '麻友', avatar || '', now, now);

  return { id, openid, nickname: nickname || '麻友', avatar: avatar || '' };
}