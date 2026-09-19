/**
 * /api/records
 */
import { Router } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth';
import { listRecords, getRecord, createRecord, deleteRecord, batchCreate } from '../services/records';
import { BizError } from '../middleware/error';

const router = Router();
router.use(authRequired);

const PlayerScoreSchema = z.object({
  playerId: z.string().optional(),
  nickname: z.string().min(1).max(12),
  score: z.number().int(),
  isSubstitute: z.boolean().optional(),
  isObserver: z.boolean().optional()
});

const RecordSchema = z.object({
  id: z.string().optional(),
  playedAt: z.number().int(),
  ruleType: z.string().min(1).max(20),
  ruleName: z.string().min(1).max(30),
  duration: z.enum(['afternoon', 'evening', 'overnight']),
  totalFee: z.number().int().nonnegative().optional(),
  note: z.string().max(200).optional(),
  mood: z.enum(['smooth', 'peak', 'low', 'explosive']).nullable().optional(),
  players: z.array(PlayerScoreSchema).min(2).max(8)
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  ruleType: z.string().optional()
});

/**
 * GET / - 战绩列表
 */
router.get('/', async (req, res, next) => {
  try {
    const opts = ListQuerySchema.parse(req.query);
    const result = await listRecords(req.user!.id, opts);
    res.json({ code: 0, data: result });
  } catch (e) { next(e); }
});

/**
 * POST / - 新建战绩
 */
router.post('/', async (req, res, next) => {
  try {
    const body = RecordSchema.parse(req.body);
    const record = await createRecord(req.user!.id, body);
    res.json({ code: 0, data: record });
  } catch (e) { next(e); }
});

/**
 * POST /batch - 批量同步
 */
router.post('/batch', async (req, res, next) => {
  try {
    const body = z.object({ records: z.array(RecordSchema).max(500) }).parse(req.body);
    const result = await batchCreate(req.user!.id, body.records);
    res.json({ code: 0, data: result });
  } catch (e) { next(e); }
});

/**
 * GET /:id
 */
router.get('/:id', async (req, res, next) => {
  try {
    const r = await getRecord(req.user!.id, req.params.id);
    if (!r) return next(new BizError('NOT_FOUND', 404, '战绩不存在'));
    res.json({ code: 0, data: r });
  } catch (e) { next(e); }
});

/**
 * DELETE /:id - 软删除
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await deleteRecord(req.user!.id, req.params.id);
    if (!ok) return next(new BizError('NOT_FOUND', 404, '战绩不存在'));
    res.json({ code: 0, data: { ok: true } });
  } catch (e) { next(e); }
});

export default router;