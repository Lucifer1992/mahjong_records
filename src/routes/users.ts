/**
 * /api/users
 * - GET /me  当前用户（含 tier，前端据此渲染免费/Pro 分层）
 *
 * 兑换码升级接口已下线（2026-09-19）：变现统一走微信虚拟支付，
 * 履约入口在 services/vpay.ts 的 markOrderPaid → setTier('pro')。
 */
import { Router } from 'express';
import { authRequired } from '../middleware/auth';
import { getUserById, normalizeTier } from '../services/users';
import { config } from '../config';
import { BizError } from '../middleware/error';

const router = Router();
router.use(authRequired);

/**
 * GET /me - 当前用户信息 + 当前生效的额度
 */
router.get('/me', (req, res, next) => {
  try {
    const u = getUserById(req.user!.id);
    if (!u) return next(new BizError('NOT_FOUND', 404, '用户不存在'));

    res.json({
      code: 0,
      data: {
        id: u.id,
        nickname: u.nickname,
        avatar: u.avatar,
        tier: normalizeTier(u.tier),
        limits: {
          // 免费用户云端保留「几个有数据的日期」；Pro 为 null 表示不限
          cloudWindowDates: normalizeTier(u.tier) === 'pro' ? null : config.tier.freeWindowDates
        }
      }
    });
  } catch (e) { next(e); }
});

export default router;
