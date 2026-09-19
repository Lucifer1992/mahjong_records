/**
 * /api/upload —— 头像等用户素材上传
 *
 * POST /avatar  上传头像（authRequired，multipart 字段名 file）
 *   - 仅 png / jpg / webp，最大 1MB
 *   - 存 server/data/avatars/，返回相对 URL /avatars/<file>
 *   - 静态访问：app.ts 挂 express.static('/avatars')
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authRequired } from '../middleware/auth';
import { uuid } from '../utils/uuid';
import { logger } from '../logger';

const AVATAR_DIR = path.resolve(__dirname, '..', 'data', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
    filename: (_req, file, cb) => cb(null, `${uuid()}.${EXT_BY_MIME[file.mimetype] || 'png'}`)
  }),
  limits: { fileSize: 1024 * 1024 }, // 1MB
  fileFilter: (_req, file, cb) => {
    if (!EXT_BY_MIME[file.mimetype]) {
      return cb(new Error('仅支持 png / jpg / webp 图片'));
    }
    cb(null, true);
  }
});

const router = Router();

router.post('/avatar', authRequired, (req: Request, res: Response, next: NextFunction) => {
  upload.single('file')(req, res, (err: any) => {
    if (err) {
      logger.warn('avatar upload rejected', { err: err.message });
      return res.status(400).json({ code: 'UPLOAD_FAILED', message: err.message || '上传失败' });
    }
    const file = (req as any).file;
    if (!file) {
      return res.status(400).json({ code: 'UPLOAD_FAILED', message: '缺少文件字段 file' });
    }
    res.json({ code: 0, data: { url: `/avatars/${file.filename}` } });
  });
});

export default router;
