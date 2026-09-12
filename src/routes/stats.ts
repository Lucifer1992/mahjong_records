/**
 * /api/stats
 */
import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth';
import { getSummary, getFortune, getCalendar } from '../services/stats';

const router = Router();
router.use(authRequired);

router.get('/summary', (req, res, next) => {
  try {
    const nickname = (req.query.nickname as string) || undefined;
    res.json({ code: 0, data: getSummary(req.user!.id, nickname) });
  } catch (e) { next(e); }
});

router.get('/fortune', (req, res, next) => {
  try {
    const playerId = String(req.query.playerId || '');
    if (!playerId) return res.status(400).json({ code: 'BAD_REQUEST', message: 'playerId 必填' });
    const topN = req.query.topN ? Math.min(Number(req.query.topN), 20) : 5;
    const result = getFortune(req.user!.id, playerId, topN);
    if (!result) return res.status(404).json({ code: 'NOT_FOUND', message: '玩家不存在' });
    res.json({ code: 0, data: result });
  } catch (e) { next(e); }
});

const CalendarQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  nickname: z.string().optional()
});

router.get('/calendar', (req, res, next) => {
  try {
    const { year, month, nickname } = CalendarQuery.parse(req.query);
    const data = getCalendar(req.user!.id, year, month, nickname);
    res.json({ code: 0, data });
  } catch (e) { next(e); }
});

export default router;