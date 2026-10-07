/**
 * 虚拟支付业务（wx.requestVirtualPayment / mode=short_series_goods 道具直购）
 *
 * 双签名规则（与普通微信支付完全不同）：
 *   paySig    = HMAC-SHA256(appKey, "requestVirtualPayment&" + signData)
 *   signature = HMAC-SHA256(session_key, signData)
 *
 * 履约：MP 后台「消息推送」→ xpay_goods_deliver_notify（安全模式下 body 走
 * AES-256-CBC 加密，密钥 = EncodingAESKey+'=' 的 Base64 解码，32 字节），
 * 收到推送后把订单标记 paid 并 setTier('pro') —— 必须幂等（微信会重推）。
 */
import crypto from 'crypto';
import { db } from '../db';
import { uuid } from '../utils/uuid';
import { config } from '../config';
import { logger } from '../logger';
import { setTier } from './users';

export type ProductKey = 'lifetime';

/**
 * 退款政策版本（分层退款规则）
 *
 * 政策内容（须与前端支付弹窗文案 + 用户协议第 4 条保持一致）：
 *   1. 付款 7 天内且未使用 Pro 权益（付费后无新战绩同步）→ 自动全额退款
 *   2. 功能故障 / 产品问题 → 不受期限限制，人工核实处理
 *   3. 付款 7 天内已使用 / 7~30 天 → 人工核实
 *   4. 付款超 30 天 → 虚拟服务已持续提供，不支持退款（质量问题除外）
 *
 * 每次修改政策文案必须升版本号：prepay 时写入 vpay_orders.policy_version，
 * 作为「购买时用户同意了哪个版本」的仲裁证据。
 */
export const REFUND_POLICY_VERSION = '2026-10-02';

export interface VpayOrderRow {
  id: string;
  user_id: string;
  out_trade_no: string;
  wx_order_id: string | null;        // 平台单号，幂等键
  product_key: string;
  product_id: string;
  price_fen: number;
  status: string;
  created_at: number;
  paid_at: number | null;
}

/** 当前生效的 AppKey（沙箱 / 现网） */
export function currentAppKey(): string {
  return config.vpay.env === 1 ? config.vpay.sandboxAppKey : config.vpay.prodAppKey;
}

/** 是否具备调起支付的条件（现网要求现网 key 已配置） */
export function isReady(): { ok: boolean; message: string } {
  if (!config.vpay.offerId) return { ok: false, message: '缺少 VPAY_OFFER_ID' };
  const appKey = currentAppKey();
  if (!appKey) {
    return config.vpay.env === 0
      ? { ok: false, message: '现网模式未配置 VPAY_PROD_APP_KEY' }
      : { ok: false, message: '缺少 VPAY_SANDBOX_APP_KEY' };
  }
  return { ok: true, message: 'ok' };
}

function hmacSha256Hex(key: string, data: string): string {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/**
 * 创建订单并计算双签名，返回可直接传给 wx.requestVirtualPayment 的参数
 *
 * @throws Error('SESSION_KEY_MISSING') 当库中没有该用户的 session_key 时
 *         —— 前端收到后应重新 wx.login 再试
 */
export async function createPrepay(
  userId: string,
  productKey: ProductKey,
  sessionKey: string,
  policy: { version: string; agreedAt: number }
): Promise<{ signData: string; paySig: string; signature: string; outTradeNo: string; priceFen: number; label: string }> {
  const product = config.vpay.products[productKey];
  if (!product) throw new Error(`unknown product key: ${productKey}`);

  if (!sessionKey) {
    throw new Error('SESSION_KEY_MISSING');
  }
  const appKey = currentAppKey();
  if (!appKey) throw new Error('VPAY_APP_KEY_MISSING');

  const outTradeNo = `VP${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  const signData = JSON.stringify({
    offerId: config.vpay.offerId,
    buyQuantity: 1,
    // 官方文档明确：env 必须与 AppKey 匹配（0=现网 AppKey / 1=沙箱 AppKey）
    // —— 用沙箱 AppKey 签 paySig 时，signData 的 env 必须填 1，微信侧才会用沙箱 key 验签
    // 错误码 -15011「现网版本的 env 只能是 0」是反向关系：env=0 必须配现网 key
    env: config.vpay.env,
    currencyType: 'CNY',
    productId: product.productId,
    goodsPrice: product.priceFen,  // ⚠️ 单位是分！1 元 = 100
    outTradeNo,
    attach: userId                 // 透传 userId，回调侧兜底定位用户
  });

  const paySig = hmacSha256Hex(appKey, `requestVirtualPayment&${signData}`);
  const signature = hmacSha256Hex(sessionKey, signData);

  await db.exec(
    `INSERT INTO vpay_orders (id, user_id, out_trade_no, product_key, product_id, price_fen, status, policy_version, policy_agreed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
    [uuid(), userId, outTradeNo, productKey, product.productId, product.priceFen, policy.version, policy.agreedAt, Date.now()]
  );

  return { signData, paySig, signature, outTradeNo, priceFen: product.priceFen, label: product.label };
}

export async function getOrderByOutTradeNo(outTradeNo: string): Promise<VpayOrderRow | undefined> {
  const row = await db.queryOne<any>('SELECT * FROM vpay_orders WHERE out_trade_no = ?', [outTradeNo]);
  if (!row) return undefined;
  return {
    ...row,
    price_fen: Number(row.price_fen),
    created_at: Number(row.created_at),
    paid_at: row.paid_at === null || row.paid_at === undefined ? null : Number(row.paid_at)
  };
}

/**
 * 获取小程序全局接口调用凭证 access_token（内存缓存，提前 5 分钟过期）
 *
 * 服务端 API（/xpay/*）必须挂在 URL query 上（41001 = access_token missing）。
 * 注意：与 wx-login 无关，这是 cgi-bin/token 的凭证，appid+secret 换取。
 */
let accessTokenCache: { token: string; expiresAt: number } | null = null;

export async function getStableAccessToken(): Promise<string | null> {
  if (accessTokenCache && Date.now() < accessTokenCache.expiresAt) {
    return accessTokenCache.token;
  }
  const { appid, secret } = config.wechat;
  if (!appid || !secret) {
    logger.warn('getStableAccessToken: WX_APPID/WX_SECRET 未配置');
    return null;
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  try {
    const resp = await fetch(url);
    const data = (await resp.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!data.access_token) {
      logger.warn('getStableAccessToken failed', { errcode: data.errcode, errmsg: data.errmsg });
      return null;
    }
    const ttl = ((data.expires_in || 7200) - 300) * 1000; // 提前 5 分钟过期
    accessTokenCache = { token: data.access_token, expiresAt: Date.now() + ttl };
    logger.info('getStableAccessToken: refreshed', { keyLen: data.access_token.length, ttlMs: ttl });
    return data.access_token;
  } catch (e: any) {
    logger.warn('getStableAccessToken error', { err: e?.message });
    return null;
  }
}

/**
 * 主动向微信查询订单状态（兜底发货推送）
 *
 * 背景：xpay_goods_deliver_notify 推送在沙箱环境**不会触发**；
 * 即便现网，推送丢失 / 服务重启期间也会漏单。文档明确建议
 * 「推送丢失时调用 query_order 兜底」。本实现用于前端轮询查单时
 * 库内 status='created' 时的兜底。
 *
 * API 规范（主版本文档 2.3 + 2.5 节）：
 *   URL:    POST https://api.weixin.qq.com/xpay/query_order?access_token=xxx&pay_sig=xxx
 *   uri:    /xpay/query_order
 *   body:   { openid, env, order_id }    // order_id = outTradeNo，纯业务字段
 *   sign:   paySig = HMAC-SHA256(AppKey, '/xpay/query_order&' + post_body)
 *   auth:   access_token = cgi-bin/token 获取（服务端 API 必带，缺了报 41001）
 *
 * 返回 order_status 枚举：1=待支付 2=已支付 3=已关闭 4=已退款
 *
 * @returns 微信订单状态；失败 / 超时返回 null（不影响前端轮询）
 */
export async function queryOrderFromWx(
  openid: string,
  outTradeNo: string
): Promise<{ orderStatus: number; wxOrderId: string | null } | null> {
  const appKey = currentAppKey();
  if (!appKey) {
    logger.warn('vpay queryOrderFromWx: appKey missing');
    return null;
  }

  const postBody = JSON.stringify({
    openid,
    env: config.vpay.env,
    order_id: outTradeNo
  });
  const paySig = hmacSha256Hex(appKey, `/xpay/query_order&${postBody}`);

  // 服务端 API 必须带 access_token（41001 = access_token missing，2026-10-01 实测）
  const accessToken = await getStableAccessToken();
  if (!accessToken) {
    logger.warn('vpay queryOrderFromWx: no access_token, skip');
    return null;
  }

  // 硬性 3s 上限：微信 API 通常 <1s 返回，超时直接当 null 让前端继续轮询
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 3000);

  try {
    // pay_sig 挂 URL query（body 保持纯业务字段原文，与签名原文一致）
    const url = `https://api.weixin.qq.com/xpay/query_order?access_token=${accessToken}&pay_sig=${paySig}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postBody,
      signal: ac.signal
    });
    clearTimeout(timer);
    const data = (await resp.json()) as {
      errcode?: number;
      errmsg?: string;
      // 实测响应（2026-10-02 现网抓包）：订单信息嵌在 order 对象里，状态字段名是
      // status（不是文档写的 order_status！），枚举（社区实锤 + 官方文档对照）：
      //   1 = 已创建未支付；2/3/4 = 已支付（不同支付渠道细类）；5-8 = 已关闭/退款
      order?: {
        status?: number;
        order_status?: number;
        wx_order_id?: string;
        out_trade_no?: string;
      };
      // 兼容：旧文档/平铺字段
      order_status?: number;
      mch_order_no?: string;
    };
    const errcode = Number(data.errcode ?? 0);
    if (errcode !== 0) {
      logger.warn('vpay query_order failed', { outTradeNo, errcode: data.errcode, errmsg: data.errmsg });
      return null;
    }
    const orderInfo = (data.order ?? data) as Record<string, unknown>;
    const orderStatus = Number(orderInfo.status ?? orderInfo.order_status ?? 0);
    if (!orderStatus) {
      // errcode=0 但没有状态字段 → 响应结构未知，记原文排查
      logger.warn('vpay query_order: unexpected response shape', {
        outTradeNo, raw: JSON.stringify(data).slice(0, 400)
      });
      return null;
    }
    return {
      orderStatus,
      // 平台单号官方字段 = wx_order_id（嵌在 order 里），mch_order_no 为旧字段兼容
      wxOrderId: String(orderInfo.wx_order_id ?? orderInfo.mch_order_no ?? '') || null
    };
  } catch (e: any) {
    clearTimeout(timer);
    logger.warn('vpay query_order error/timeout', { outTradeNo, err: e?.message });
    return null;
  }
}

/**
 * 标记订单已支付并履约（幂等：重复推送 / 重复查询都不会重复发权益）
 *
 * 幂等键：
 *   1. 首选 wx_order_id（官方要求：平台单号 MchOrderNo 才是跟踪/对账/幂等依据）
 *   2. 兜底 outTradeNo（数据库唯一约束保证）
 *
 * 用事务包裹读+改+履约，避免并发推送时的 TOCTOU 竞态：
 * 比如两个 notify 同时进来，各自 SELECT 都看到 status='created'，然后都 UPDATE 都 SET 都 setTier —— 双发权益。
 * 事务 + UPDATE WHERE status='created' 让第二次的 UPDATE 影响 0 行，履约函数识别后跳过。
 */
export async function markOrderPaid(
  outTradeNo: string,
  wxOrderId: string | null,
  source: 'notify' | 'manual'
): Promise<boolean> {
  return db.withTransaction(async (conn) => {
    // 1. 拿到订单
    const [rows] = await conn.query('SELECT * FROM vpay_orders WHERE out_trade_no = ?', [outTradeNo]);
    const order = (rows as any[])[0];
    if (!order) {
      logger.warn('vpay markOrderPaid: order not found', { outTradeNo, source });
      return false;
    }
    if (order.status === 'paid') return true; // 幂等命中

    // 2. 写入 wx_order_id（幂等键 + 对账用）
    //    首次收到推送时写入；同号重复推送时 DB UNIQUE 约束会让 INSERT 失败，我们靠这个兜底
    if (wxOrderId && order.wx_order_id !== wxOrderId) {
      try {
        await conn.query(
          `UPDATE vpay_orders SET wx_order_id = ? WHERE out_trade_no = ? AND wx_order_id IS NULL`,
          [wxOrderId, outTradeNo]
        );
      } catch (e: any) {
        // UNIQUE 冲突 = 已有相同 wx_order_id 的订单 = 重复推送，跳过
        if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
          logger.warn('vpay wx_order_id duplicate (repeat notify)', { wxOrderId, outTradeNo });
          return true;
        }
        throw e;
      }
    }

    // 3. 标记 paid
    const [result] = await conn.query(
      `UPDATE vpay_orders SET status = 'paid', paid_at = ? WHERE out_trade_no = ? AND status = 'created'`,
      [Date.now(), outTradeNo]
    );
    const affected = (result as any).affectedRows ?? 0;
    if (affected === 0) {
      // 并发竞争中我们输给别的请求了，对方已经履约
      return true;
    }

    // 4. 履约：升 Pro（唯一的升级入口；兑换码通道已下线）
    await setTier(order.user_id, 'pro');
    logger.info('vpay order paid, user upgraded to pro', {
      outTradeNo, wxOrderId, userId: order.user_id, productId: order.product_id, source
    });
    return true;
  });
}

/**
 * 退款完成：标记订单 refunded + 收回 Pro 权益（幂等）
 *
 * 触发：xpay_refund_notify 推送（RetCode=0 = 退款成功）。
 * 规则：
 *   - 只有 status='paid' 的订单才降级（幂等：重复推送第二次 0 行命中直接返回）
 *   - 收回权益前检查该用户是否还有其他已支付订单——有则保留 Pro（多单场景）
 *
 * @returns 是否实际执行了降级（用于日志判断）
 */
export async function markOrderRefunded(outTradeNo: string): Promise<boolean> {
  return db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM vpay_orders WHERE out_trade_no = ?', [outTradeNo]);
    const order = (rows as any[])[0];
    if (!order) {
      logger.warn('vpay markOrderRefunded: order not found', { outTradeNo });
      return false;
    }
    if (order.status !== 'paid') {
      // 未支付单 / 已退过 —— 幂等命中，不动作
      logger.info('vpay markOrderRefunded: skip (status not paid)', { outTradeNo, status: order.status });
      return false;
    }

    const [result] = await conn.query(
      `UPDATE vpay_orders SET status = 'refunded' WHERE out_trade_no = ? AND status = 'paid'`,
      [outTradeNo]
    );
    const affected = (result as any).affectedRows ?? 0;
    if (affected === 0) return false; // 并发竞争中已处理

    // 检查是否还有其他已支付订单（当前只有 lifetime 一档，理论必为 0，防御性查询）
    const [others] = await conn.query(
      `SELECT COUNT(*) AS n FROM vpay_orders WHERE user_id = ? AND status = 'paid' AND out_trade_no <> ?`,
      [order.user_id, outTradeNo]
    );
    const otherPaid = Number((others as any[])[0]?.n ?? 0);

    if (otherPaid === 0) {
      await setTier(order.user_id, 'free');
      logger.info('vpay order refunded, user downgraded to free', {
        outTradeNo, userId: order.user_id
      });
    } else {
      logger.info('vpay order refunded, user keeps pro (has other paid orders)', {
        outTradeNo, userId: order.user_id, otherPaid
      });
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 退款：分层政策评估 + /xpay/refund_order 原路退回
// ---------------------------------------------------------------------------

/** 用户提交的退款原因分类 */
export type RefundCategory = 'unused' | 'quality' | 'other';

/** 分层政策评估结果 */
export type RefundDecision = 'auto_refunded' | 'manual_review' | 'rejected';

export interface RefundRequestResult {
  decision: RefundDecision;
  message: string;
  daysSincePaid: number;
  usedAfterPurchase: boolean;
}

/**
 * 调微信 /xpay/refund_order 启动退款任务（原路退回）
 *
 * API 规范（与 query_order 同族）：
 *   URL:  POST https://api.weixin.qq.com/xpay/refund_order?access_token=xxx&pay_sig=xxx
 *   sign: paySig = HMAC-SHA256(AppKey, '/xpay/refund_order&' + post_body)
 *   body: { openid, env, order_id, refund_order_id, refund_fee, left_fee, refund_reason, req_from }
 *
 * 注意：本接口只是「启动」退款任务，最终状态靠 xpay_refund_notify 推送确认
 * （handlePushBody 里已处理：退款完成 → markOrderRefunded 收回 Pro）。
 *
 * @returns 是否启动成功
 */
export async function refundOrderFromWx(
  openid: string,
  outTradeNo: string,
  refundFeeFen: number
): Promise<boolean> {
  const appKey = currentAppKey();
  if (!appKey) {
    logger.warn('vpay refundOrderFromWx: appKey missing');
    return false;
  }
  const accessToken = await getStableAccessToken();
  if (!accessToken) {
    logger.warn('vpay refundOrderFromWx: no access_token, skip');
    return false;
  }

  // refund_order_id：8-32 字符，字母/数字/_/-（RF + 毫秒时间戳 + 4 位随机 = 19 字符）
  const refundOrderId = `RF${Date.now()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  const postBody = JSON.stringify({
    openid,
    env: config.vpay.env,
    order_id: outTradeNo,
    refund_order_id: refundOrderId,
    refund_fee: refundFeeFen,   // 单位分
    left_fee: refundFeeFen,     // 首笔全额退款：剩余可退 = 全额
    refund_reason: 3,           // 3 = 意愿问题（用户主动退款）
    req_from: 2                 // 2 = 用户自己发起
  });
  const paySig = hmacSha256Hex(appKey, `/xpay/refund_order&${postBody}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);

  try {
    const url = `https://api.weixin.qq.com/xpay/refund_order?access_token=${accessToken}&pay_sig=${paySig}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postBody,
      signal: ac.signal
    });
    clearTimeout(timer);
    const data = (await resp.json()) as { errcode?: number; errmsg?: string; refund_order_id?: string };
    if (Number(data.errcode ?? 0) !== 0) {
      logger.error('vpay refund_order failed', { outTradeNo, errcode: data.errcode, errmsg: data.errmsg });
      return false;
    }
    logger.info('vpay refund_order started', { outTradeNo, refundOrderId: data.refund_order_id ?? refundOrderId });
    return true;
  } catch (e: any) {
    clearTimeout(timer);
    logger.error('vpay refund_order error/timeout', { outTradeNo, err: e?.message });
    return false;
  }
}

/**
 * 判断用户付费后是否「使用过 Pro 权益」
 *
 * 口径：付费时间之后有新的战绩同步（云端写入或更新）即算已使用。
 * （克星榜/月度报表等分析功能在前端本地计算，服务端无法观测，
 *  取「付费后是否还在活跃写数据」作为最接近的可验证口径。）
 */
async function hasUsedProAfterPurchase(userId: string, paidAt: number): Promise<boolean> {
  const row = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM records
     WHERE user_id = ? AND (created_at >= ? OR updated_at >= ?)`,
    [userId, paidAt, paidAt]
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * 用户提交退款申请：按分层政策评估并执行
 *
 * 决策表（政策版本 ${REFUND_POLICY_VERSION}）：
 *   功能故障（quality）     → manual_review（任何时段，人工核实）
 *   付款超 30 天            → rejected（质量问题除外，见上）
 *   ≤7 天且付费后无新同步   → auto_refunded（调 refund_order 全额退 + 立即降级）
 *   ≤7 天但已使用           → manual_review
 *   7~30 天                 → manual_review
 */
export async function createRefundRequest(
  userId: string,
  category: RefundCategory,
  reasonText: string
): Promise<RefundRequestResult> {
  // 1. 找最近的已支付订单
  const order = await db.queryOne<any>(
    `SELECT * FROM vpay_orders WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 1`,
    [userId]
  );
  if (!order) {
    // 已退款 / 未登录过支付 —— 给出明确提示
    const refunded = await db.queryOne<any>(
      `SELECT out_trade_no FROM vpay_orders WHERE user_id = ? AND status = 'refunded' LIMIT 1`,
      [userId]
    );
    return {
      decision: 'rejected',
      message: refunded ? '该订单已退款完成。' : '没有找到可申请退款的订单。',
      daysSincePaid: 0,
      usedAfterPurchase: false
    };
  }
  const outTradeNo = String(order.out_trade_no);
  const paidAt = Number(order.paid_at ?? order.created_at);
  const daysSincePaid = Math.floor((Date.now() - paidAt) / 86400000);
  const usedAfterPurchase = await hasUsedProAfterPurchase(userId, paidAt);

  // 2. 防重复申请：同订单已有未终态/已退款的申请直接幂等返回
  const existing = await db.queryOne<any>(
    `SELECT decision FROM vpay_refund_requests
     WHERE out_trade_no = ? AND decision IN ('auto_refunded', 'manual_review')
     ORDER BY created_at DESC LIMIT 1`,
    [outTradeNo]
  );
  if (existing) {
    return {
      decision: existing.decision,
      message: existing.decision === 'auto_refunded'
        ? '退款已受理，款项原路退回微信支付（1-3 个工作日到账），Pro 权益已收回。'
        : '你的退款申请已在人工核实中，我们会在 48 小时内处理，请勿重复提交。',
      daysSincePaid,
      usedAfterPurchase
    };
  }

  // 3. 分层评估
  let decision: RefundDecision;
  let message: string;
  if (category === 'quality') {
    // 质量问题不受 30 天限制（消法要求 + 平台仲裁倾向）
    decision = 'manual_review';
    message = '已收到你的问题反馈，我们会在 48 小时内人工核实处理，核实属实将全额退款。';
  } else if (daysSincePaid > 30) {
    decision = 'rejected';
    message = '本订单已付款超过 30 天，虚拟服务已持续提供，按购买时同意的退款规则不支持退款。'
      + '如遇功能故障，请以「功能故障」原因重新提交。';
  } else if (daysSincePaid <= 7 && !usedAfterPurchase) {
    decision = 'auto_refunded';
    message = '退款已受理，¥9.9 将原路退回微信支付（1-3 个工作日到账），Pro 权益同步收回。';
  } else if (daysSincePaid <= 7) {
    decision = 'manual_review';
    message = '检测到你在付款后使用过 Pro 权益，申请已转人工核实，48 小时内处理。';
  } else {
    decision = 'manual_review';
    message = `已收到你的申请（付款后第 ${daysSincePaid} 天），转人工核实，48 小时内处理。`;
  }

  // 4. 自动退款：启动微信退款任务；启动成功即收回 Pro（宁可晚到账，不让「已退款仍持有 Pro」）
  let refundOrderId: string | null = null;
  if (decision === 'auto_refunded') {
    const userRow = await db.queryOne<{ openid: string }>('SELECT openid FROM users WHERE id = ?', [userId]);
    if (!userRow?.openid) {
      logger.error('vpay refund request: user openid missing, fallback to manual', { userId, outTradeNo });
      decision = 'manual_review';
      message = '退款申请已提交，转人工核实，48 小时内处理。';
    } else {
      const ok = await refundOrderFromWx(userRow.openid, outTradeNo, Number(order.price_fen));
      if (ok) {
        refundOrderId = 'started';  // 具体单号微信未回传，用标记占位；最终以 refund notify 为准
        await markOrderRefunded(outTradeNo);
      } else {
        // 退款 API 失败（网络/微信侧）→ 转人工，不让用户卡死
        logger.error('vpay refund_order start failed, fallback to manual_review', { outTradeNo });
        decision = 'manual_review';
        message = '退款申请已提交，转人工核实，48 小时内处理。';
      }
    }
  }

  // 5. 留痕（决策依据快照入库，人工核实/仲裁时可追溯）
  await db.exec(
    `INSERT INTO vpay_refund_requests
       (id, user_id, out_trade_no, category, reason, decision, days_since_paid,
        used_after_purchase, policy_version, refund_order_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(), userId, outTradeNo, category, reasonText.slice(0, 255), decision,
      daysSincePaid, usedAfterPurchase ? 1 : 0,
      order.policy_version ?? null, refundOrderId, Date.now()
    ]
  );
  logger.info('vpay refund request created', {
    userId, outTradeNo, category, decision, daysSincePaid, usedAfterPurchase,
    policyVersion: order.policy_version
  });

  return { decision, message, daysSincePaid, usedAfterPurchase };
}

// ---------------------------------------------------------------------------
// 对账兜底：推送丢失时主动查单收回 Pro
// ---------------------------------------------------------------------------

/**
 * 每用户节流（内存 Map，重启即重置——只是限频手段，不影响正确性）。
 * 背景：MP 后台退款后 xpay_refund_notify 可能不推送（2026-10-02 现网实锤：
 * 退款完成但服务器日志无任何 refund 推送，订单永远停在 paid）。
 * 兜底：Pro 用户请求 /me 时节流查一次 query_order，微信侧已退款则收回。
 */
const reconcileThrottle = new Map<string, number>();
const RECONCILE_INTERVAL_MS = 60 * 60 * 1000; // 每用户 1 小时最多查一次

/**
 * 对账单个 Pro 用户：查其最近一笔 paid 订单在微信侧的真实状态。
 *
 * 口径（与 scripts/vpay-reconcile.js 一致，已在现网验证可行）：
 *   query_order 返回 status：1=已创建未支付；2/3/4=已支付；5-8=已关闭/退款
 *   status >= 5 且本地仍是 paid → markOrderRefunded（内部幂等 + 会检查
 *   其他 paid 订单，多单场景不会误降）→ setTier('free')
 *
 * 安全性：查不到 / 超时 / errcode 非 0 一律返回 null（不降级），绝不因
 * 兜底链路故障误伤正常 Pro 用户。
 *
 * @returns 'free' 表示本次对账实际降级了；null 表示无需动作或查询失败
 */
export async function reconcileProUser(userId: string): Promise<'free' | null> {
  const last = reconcileThrottle.get(userId) ?? 0;
  if (Date.now() - last < RECONCILE_INTERVAL_MS) return null;
  reconcileThrottle.set(userId, Date.now());

  try {
    // 1. 找最近一笔本地 paid 订单（没有 → 权益状态异常但无从对账，放行）
    const order = await db.queryOne<{ out_trade_no: string }>(
      `SELECT out_trade_no FROM vpay_orders WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 1`,
      [userId]
    );
    if (!order) return null;

    // 2. 拿 openid（query_order 必填）
    const userRow = await db.queryOne<{ openid: string }>('SELECT openid FROM users WHERE id = ?', [userId]);
    if (!userRow?.openid) {
      logger.warn('vpay reconcile: user openid missing', { userId });
      return null;
    }

    // 3. 查微信侧真实状态
    const wx = await queryOrderFromWx(userRow.openid, order.out_trade_no);
    if (!wx) return null; // 查询失败 → 不动作，等下个节流窗口

    if (wx.orderStatus >= 5) {
      logger.warn('vpay reconcile: wx side refunded/closed but local paid, revoking', {
        userId, outTradeNo: order.out_trade_no, wxStatus: wx.orderStatus
      });
      const changed = await markOrderRefunded(order.out_trade_no);
      return changed ? 'free' : null;
    }
    return null;
  } catch (e: any) {
    logger.warn('vpay reconcile error', { userId, err: e?.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// 消息推送：GET 握手 + POST 推送（安全模式 AES 解密）
// ---------------------------------------------------------------------------

/**
 * MP 后台保存「消息推送」配置时，微信会 GET 请求回调 URL：
 * 校验 signature = SHA1(sort(token, timestamp, nonce, echostr))，通过后原样返回 echostr
 */
export function verifyEchoSignature(timestamp: string, nonce: string, echostr: string, signature: string): boolean {
  if (!config.vpay.pushToken) return false;
  const expected = sha1([config.vpay.pushToken, timestamp, nonce, echostr].sort().join(''));
  return expected === signature;
}

/** POST 推送签名校验：signature = SHA1(sort(token, timestamp, nonce, encrypt)) */
export function verifyMsgSignature(timestamp: string, nonce: string, encrypt: string, signature: string): boolean {
  if (!config.vpay.pushToken) return false;
  const expected = sha1([config.vpay.pushToken, timestamp, nonce, encrypt].sort().join(''));
  return expected === signature;
}

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

/**
 * 安全模式解密：AES-256-CBC，Key = Base64Decode(EncodingAESKey + '=')（32 字节），IV = Key 前 16 字节。
 * 明文结构：random(16B) + msg_len(4B, 大端) + msg + appid
 */
export function decryptPush(encryptBase64: string): string {
  const key = Buffer.from(config.vpay.aesKey + '=', 'base64');
  if (key.length !== 32) throw new Error('VPAY_AES_KEY 无效（需 43 位 EncodingAESKey）');
  const iv = key.subarray(0, 16);

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  // PKCS#7 填充由 Node 自动去除
  const deciphered = Buffer.concat([decipher.update(encryptBase64, 'base64'), decipher.final()]);

  const msgLen = deciphered.readUInt32BE(16);
  return deciphered.subarray(20, 20 + msgLen).toString('utf8');
}

/**
 * 处理推送消息体（JSON 格式）。
 * 明文模式：body 就是事件对象；安全模式：body = { Encrypt }，需先解密。
 * 关键事件：xpay_goods_deliver_notify（发货/支付成功）→ 幂等履约。
 *
 * @returns 是否成功处理（调用方据此决定回包）
 */
export async function handlePushBody(body: Record<string, unknown>): Promise<{ ok: boolean; handled: boolean; event: string }> {
  let payload: Record<string, unknown> = body;
  const encrypt = (body.Encrypt ?? body.encrypt) as string | undefined;
  if (encrypt) {
    payload = JSON.parse(decryptPush(encrypt)) as Record<string, unknown>;
  }

  const event = String(payload.Event ?? payload.event ?? '');
  if (event === 'xpay_goods_deliver_notify') {
    // 字段兼容：不同文档版本里可能是 OutTradeNo / out_trade_no，外层或 data 里
    const data = (payload.Data ?? payload.data ?? payload) as Record<string, unknown>;
    const outTradeNo = String(data.OutTradeNo ?? data.out_trade_no ?? '');
    if (!outTradeNo) {
      logger.error('vpay deliver notify missing OutTradeNo', { payload });
      return { ok: false, handled: false, event };
    }
    // 官方幂等键：WeChatPayInfo.MchOrderNo = wx_order_id（平台单号）
    const wxPayInfo = (data.WeChatPayInfo ?? data.wechatpay_info ?? {}) as Record<string, unknown>;
    const wxOrderId = String(wxPayInfo.MchOrderNo ?? wxPayInfo.mch_order_no ?? '') || null;
    await markOrderPaid(outTradeNo, wxOrderId, 'notify');
    return { ok: true, handled: true, event };
  }

  if (event === 'xpay_refund_notify') {
    // 退款推送（文档 6.1）：MchOrderId = 原支付单的商户单号（outTradeNo），
    // RetCode = 0 表示退款完成；收款后收回 Pro 权益（合规要求：退款不保留已购权益）
    const data = (payload.Data ?? payload.data ?? payload) as Record<string, unknown>;
    const outTradeNo = String(data.MchOrderId ?? data.mch_order_id ?? data.OutTradeNo ?? data.out_trade_no ?? '');
    const retCode = Number(data.RetCode ?? data.ret_code ?? -1);
    if (!outTradeNo) {
      logger.error('vpay refund notify missing MchOrderId', { payload });
      return { ok: false, handled: false, event };
    }
    if (retCode !== 0) {
      // 退款未完成（进行中/失败），不动权益，等重推
      logger.info('vpay refund notify: not completed, ignore', { outTradeNo, retCode, retMsg: data.RetMsg });
      return { ok: true, handled: true, event };
    }
    await markOrderRefunded(outTradeNo);
    return { ok: true, handled: true, event };
  }

  // 其他事件（退款 xpay_refund_notify / 代币变动等）先记日志，后续按需扩展
  logger.info('vpay push event (ignored)', { event });
  return { ok: true, handled: false, event };
}
