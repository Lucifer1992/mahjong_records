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

export type ProductKey = 'lifetime' | 'yearly';

export interface VpayOrderRow {
  id: string;
  user_id: string;
  out_trade_no: string;
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
  sessionKey: string
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
    env: config.vpay.env,          // 0=现网 1=沙箱
    currencyType: 'CNY',
    productId: product.productId,
    goodsPrice: product.priceFen,  // ⚠️ 单位是分！1 元 = 100
    outTradeNo,
    attach: userId                 // 透传 userId，回调侧兜底定位用户
  });

  const paySig = hmacSha256Hex(appKey, `requestVirtualPayment&${signData}`);
  const signature = hmacSha256Hex(sessionKey, signData);

  await db.exec(
    `INSERT INTO vpay_orders (id, user_id, out_trade_no, product_key, product_id, price_fen, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'created', ?)`,
    [uuid(), userId, outTradeNo, productKey, product.productId, product.priceFen, Date.now()]
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
 * 标记订单已支付并履约（幂等：重复推送 / 重复查询都不会重复发权益）
 *
 * 用事务包裹读+改+履约，避免并发推送时的 TOCTOU 竞态：
 * 比如两个 notify 同时进来，各自 SELECT 都看到 status='created'，然后都 UPDATE 都 SET 都 setTier —— 双发权益。
 * 事务 + UPDATE WHERE status='created' 让第二次的 UPDATE 影响 0 行，履约函数识别后跳过。
 */
export async function markOrderPaid(outTradeNo: string, source: 'notify' | 'manual'): Promise<boolean> {
  return db.withTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT * FROM vpay_orders WHERE out_trade_no = ?', [outTradeNo]);
    const order = (rows as any[])[0];
    if (!order) {
      logger.warn('vpay markOrderPaid: order not found', { outTradeNo, source });
      return false;
    }
    if (order.status === 'paid') return true; // 幂等命中

    const [result] = await conn.query(
      `UPDATE vpay_orders SET status = 'paid', paid_at = ? WHERE out_trade_no = ? AND status = 'created'`,
      [Date.now(), outTradeNo]
    );
    const affected = (result as any).affectedRows ?? 0;
    if (affected === 0) {
      // 并发竞争中我们输给别的请求了，对方已经履约
      return true;
    }

    // 履约：升 Pro（唯一的升级入口；兑换码通道已下线）
    await setTier(order.user_id, 'pro');
    logger.info('vpay order paid, user upgraded to pro', {
      outTradeNo, userId: order.user_id, productId: order.product_id, source
    });
    return true;
  });
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
    const outTradeNo = String(data.OutTradeNo ?? data.out_trade_no ?? data.OutTradeNo ?? '');
    if (!outTradeNo) {
      logger.error('vpay deliver notify missing OutTradeNo', { payload });
      return { ok: false, handled: false, event };
    }
    await markOrderPaid(outTradeNo, 'notify');
    return { ok: true, handled: true, event };
  }

  // 其他事件（退款 xpay_refund_notify / 代币变动等）先记日志，后续按需扩展
  logger.info('vpay push event (ignored)', { event });
  return { ok: true, handled: false, event };
}
