/**
 * /api/users
 * - GET   /me  当前用户（含 tier，前端据此渲染免费/Pro 分层）
 * - PATCH /me  修改当前用户昵称
 *
 * 兑换码升级接口已下线（2026-09-19）：变现统一走微信虚拟支付，
 * 履约入口在 services/vpay.ts 的 markOrderPaid → setTier('pro')。
 */
import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth';
import { getUserById, normalizeTier, updateNickname, updateProfile } from '../services/users';
import { reconcileProUser } from '../services/vpay';
import { config } from '../config';
import { BizError } from '../middleware/error';

const router = Router();
router.use(authRequired);

/**
 * GET /me - 当前用户信息 + 当前生效的额度
 */
router.get('/me', async (req, res, next) => {
  try {
    const u = await getUserById(req.user!.id);
    if (!u) return next(new BizError('NOT_FOUND', 404, '用户不存在'));

    // 对账兜底：Pro 用户在读取资料时节流查一次微信侧订单状态，
    // 推送（xpay_refund_notify）丢失导致「已退款仍持有 Pro」时自动收回。
    // 查询失败/超时一律静默跳过，不影响本接口响应。
    let tier = normalizeTier(u.tier);
    if (tier === 'pro') {
      const reconciled = await reconcileProUser(u.id);
      if (reconciled === 'free') {
        const fresh = await getUserById(req.user!.id);
        if (fresh) tier = normalizeTier(fresh.tier);
      }
    }

    res.json({
      code: 0,
      data: {
        id: u.id,
        nickname: u.nickname,
        avatar: u.avatar,
        tier,
        limits: {
          // 免费用户云端保留「几个有数据的日期」；Pro 为 null 表示不限
          cloudWindowDates: tier === 'pro' ? null : config.tier.freeWindowDates
        }
      }
    });
  } catch (e) { next(e); }
});

const NicknameSchema = z.object({ nickname: z.string().min(1).max(20) });

/** 资料更新：昵称 / 头像 URL 至少一项（头像先经 /api/upload/avatar 上传） */
const ProfileSchema = z.object({
  nickname: z.string().min(1).max(20).optional(),
  avatar: z.string().max(500).optional()
});

/**
 * PATCH /me - 修改昵称或账户资料（头像 URL）
 */
router.patch('/me', async (req, res, next) => {
  try {
    const body = ProfileSchema.parse(req.body);

    // 兼容旧客户端：只传 nickname 走原语义（返回单个 nickname 字符串）
    if (body.nickname && !body.avatar) {
      const updated = await updateNickname(req.user!.id, body.nickname);
      if (updated === null) {
        return next(new BizError('NOT_FOUND', 404, '用户不存在或昵称为空'));
      }
      return res.json({ code: 0, data: { nickname: updated } });
    }

    const updated = await updateProfile(req.user!.id, body);
    if (updated === null) {
      return next(new BizError('NOT_FOUND', 404, '用户不存在或无可更新字段'));
    }
    res.json({ code: 0, data: updated });
  } catch (e) { next(e); }
});

export default router;
