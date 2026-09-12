/**
 * /api/players
 */
import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth';
import { listPlayers, createPlayer, getPlayer, deletePlayer } from '../services/players';
import { BizError } from '../middleware/error';

const router = Router();
router.use(authRequired);

router.get('/', (req, res, next) => {
  try {
    res.json({ code: 0, data: listPlayers(req.user!.id) });
  } catch (e) { next(e); }
});

const CreateSchema = z.object({
  nickname: z.string().min(1).max(12),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional()
});

router.post('/', (req, res, next) => {
  try {
    const body = CreateSchema.parse(req.body);
    const player = createPlayer(req.user!.id, body.nickname, body.color);
    res.json({ code: 0, data: player });
  } catch (e: any) {
    if (e.message === '玩家昵称已存在') return next(new BizError('PLAYER_EXISTS', 400, e.message));
    next(e);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const p = getPlayer(req.user!.id, req.params.id);
    if (!p) return next(new BizError('NOT_FOUND', 404, '玩家不存在'));
    res.json({ code: 0, data: p });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const ok = deletePlayer(req.user!.id, req.params.id);
    if (!ok) return next(new BizError('NOT_FOUND', 404, '玩家不存在'));
    res.json({ code: 0, data: { ok: true } });
  } catch (e) { next(e); }
});

export default router;