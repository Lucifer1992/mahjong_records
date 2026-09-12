/**
 * JWT 鉴权中间件
 * - 从 Authorization: Bearer <token> 提取
 * - 校验通过后挂载 req.user = { id, openid }
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export interface AuthUser {
  id: string;
  openid: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, openid: user.openid },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn } as jwt.SignOptions
  );
}

export function authRequired(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.secret) as any;
    req.user = { id: payload.sub, openid: payload.openid };
    next();
  } catch (e: any) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ code: 'TOKEN_EXPIRED', message: '登录已过期' });
    }
    return res.status(401).json({ code: 'INVALID_TOKEN', message: '无效 token' });
  }
}

/**
 * 可选鉴权：有 token 就解析，没有也不报错
 * 用于「首登批量同步」等允许匿名访问的接口
 */
export function authOptional(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), config.jwt.secret) as any;
      req.user = { id: payload.sub, openid: payload.openid };
    } catch {
      // 忽略错误，继续
    }
  }
  next();
}