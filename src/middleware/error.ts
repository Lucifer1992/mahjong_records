/**
 * 全局错误处理
 */
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../logger';

export class BizError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ code: 'NOT_FOUND', message: '接口不存在' });
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  // 业务错误
  if (err instanceof BizError) {
    return res.status(err.status).json({ code: err.code, message: err.message });
  }
  // 参数校验错误
  if (err instanceof ZodError) {
    return res.status(400).json({
      code: 'VALIDATION_FAILED',
      message: '参数校验失败',
      details: err.errors.map(e => ({ path: e.path.join('.'), message: e.message }))
    });
  }
  // 其他未知错误
  logger.error('Unhandled error', { url: req.url, method: req.method, err: err.stack });
  res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误' });
}