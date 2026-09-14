/**
 * /api/users
 * - GET  /me     当前用户（含 tier，前端据此渲染免费/Pro 分层）
 * - POST /redeem 兑换码升级 Pro
 */
import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth';
import { getUserById, normalizeTier, redeemPro } from '../services/users';
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

const RedeemSchema = z.object({ code: z.string().min(1).max(64) });

/**
 * POST /redeem - 兑换码升级
 *
 * 注意：prod 且未配置 PRO_UNLOCK_CODE 时，所有码都无效——
 * 这是刻意留的开关，避免上线后被人白嫖 Pro。
 */
router.post('/redeem', (req, res, next) => {
  try {
    const { code } = RedeemSchema.parse(req.body);
    const result = redeemPro(req.user!.id, code);

    if (!result.ok) {
      return next(new BizError('REDEEM_FAILED', 400, result.message));
    }

    res.json({
      code: 0,
      data: { tier: result.tier, message: result.message }
    });
  } catch (e) { next(e); }
});

export default router;
