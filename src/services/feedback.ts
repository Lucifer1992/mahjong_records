/**
 * 意见反馈业务
 *
 * 隐私原则：
 * - 只存 user_id + content + created_at，不收集手机号 / 姓名 / 微信昵称 / IP 等
 * - 提交必须登录（JWT），user_id 由 token 注入，前端不能伪造
 * - 频率限制：每用户 24h 内最多 5 条（防灌水 + 服务端不需要审核也能抗住基本骚扰）
 */
import { db, queryOne } from '../db';
import { BizError } from '../middleware/error';

/** 生成新 id（Node 原生 crypto.randomUUID，UUIDv4） */
function uuid(): string {
  return crypto.randomUUID();
}

const MAX_LEN = 500;       // 单条上限（与 DB VARCHAR(500) 一致）
const MIN_LEN = 5;         // 太短没意义（"好"、"不错" 这类不算反馈）
const DAILY_LIMIT = 5;     // 每 24h 每用户最多 5 条

export interface FeedbackInput {
  content: string;
}

/**
 * 提交反馈
 * - 校验长度
 * - 校验频率（同用户 24h 内最多 5 条，超额 429）
 * - 写入 DB 并返回 id
 */
export async function submitFeedback(userId: string, input: FeedbackInput): Promise<{ id: string; createdAt: number }> {
  const content = (input.content || '').trim();
  if (content.length < MIN_LEN) {
    throw new BizError('FEEDBACK_TOO_SHORT', 400, `反馈内容至少 ${MIN_LEN} 个字`);
  }
  if (content.length > MAX_LEN) {
    throw new BizError('FEEDBACK_TOO_LONG', 400, `反馈内容不超过 ${MAX_LEN} 个字`);
  }

  // 24h 内同用户提交数
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM feedback WHERE user_id = ? AND created_at >= ?`,
    [userId, since]
  );
  if (recent && recent.cnt >= DAILY_LIMIT) {
    throw new BizError('FEEDBACK_RATE_LIMIT', 429, `今天已提交 ${recent.cnt} 条反馈，明天再来吧`);
  }

  const id = uuid();
  const createdAt = Date.now();
  await db.exec(
    `INSERT INTO feedback (id, user_id, content, created_at) VALUES (?, ?, ?, ?)`,
    [id, userId, content, createdAt]
  );
  return { id, createdAt };
}