/**
 * 简易内存限流（生产建议接 Redis）
 * 默认每 IP 每分钟 120 次
 */
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
}, 60_000).unref();

export function rateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.socket.remoteAddress
    || 'unknown';
  const now = Date.now();
  const window = 60_000;
  const limit = config.rateLimit.perMinute;

  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + window };
    buckets.set(ip, bucket);
  }
  bucket.count++;

  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));

  if (bucket.count > limit) {
    return res.status(429).json({ code: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' });
  }
  next();
}