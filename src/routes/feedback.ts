/**
 * /api/feedback
 *
 * POST / - 提交反馈（必须登录；不收集手机号/IP 等敏感信息）
 */
import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth';
import { submitFeedback } from '../services/feedback';

const router = Router();

const SubmitSchema = z.object({
  content: z.string().min(1).max(500)
});

router.post('/', authRequired, async (req, res, next) => {
  try {
    const body = SubmitSchema.parse(req.body);
    const out = await submitFeedback(req.user!.id, body);
    res.json({ code: 0, data: out });
  } catch (e) { next(e); }
});

export default router;