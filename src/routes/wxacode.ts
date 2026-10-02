/**
 * /api/wxacode —— 小程序码（战绩海报「扫码进入」用）
 *
 * GET /  返回 PNG 二进制（authRequired，防滥用）
 * 码对所有用户相同（scene 固定 from=poster → 落地首页），
 * 服务端生成一次后落盘缓存，之后零微信 API 调用。
 */
import { Router, Request, Response, NextFunction } from 'express';
import { authRequired } from '../middleware/auth';
import { getPosterWxacode } from '../services/wxacode';
import { logger } from '../logger';

const router = Router();

router.get('/', authRequired, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const png = await getPosterWxacode();
    res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(png);
  } catch (e: any) {
    logger.warn('wxacode route failed', { err: e.message });
    next(e);
  }
});

export default router;
