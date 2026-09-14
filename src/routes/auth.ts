/**
 * /api/auth
 */
import { Router } from 'express';
import { z } from 'zod';
import { login } from '../services/auth';
import { signToken } from '../middleware/auth';

const router = Router();

const LoginSchema = z.object({
  code: z.string().min(1),
  nickname: z.string().max(20).optional(),
  avatar: z.string().max(500).optional()
});

router.post('/wx-login', async (req, res, next) => {
  try {
    const { code, nickname, avatar } = LoginSchema.parse(req.body);
    const user = await login(code, nickname, avatar);
    const token = signToken({ id: user.id, openid: user.openid });
    res.json({
      code: 0,
      data: {
        token,
        user: {
          id: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
          tier: user.tier
        }
      }
    });
  } catch (e) {
    next(e);
  }
});

export default router;