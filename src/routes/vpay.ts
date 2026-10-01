/**
 * /api/vpay —— 微信小程序虚拟支付
 *
 * - POST /prepay           前端调 wx.requestVirtualPayment 前先拿双签名参数（需登录）
 * - GET  /notify           MP 后台「消息推送」配置保存时的 URL 握手验证（无需登录）
 * - POST /notify           支付结果推送（安全模式 AES 加密），幂等履约（无需登录）
 * - GET  /order/:outTradeNo  前端支付后轮询订单状态（需登录）
 *
 * ⚠️ notify 必须挂同一 URL 同时支持 GET + POST（后台只允许填一个地址）。
 */
import { Router, json } from 'express';
import { z } from 'zod';
import { authRequired } from '../middleware/auth';
import { getSessionKey, refreshSessionKey } from '../services/auth';
import {
  createPrepay, isReady, getOrderByOutTradeNo, queryOrderFromWx,
  verifyEchoSignature, verifyMsgSignature, handlePushBody, markOrderPaid,
  type ProductKey
} from '../services/vpay';
import { db } from '../db';
import { logger } from '../logger';
import { BizError } from '../middleware/error';

const router = Router();

const PrepaySchema = z.object({
  product: z.enum(['lifetime']),  // 雀战录只提供 Pro 终身一档
  // 前端支付前重新 wx.login 换的新 code：用于刷新 session_key（防过期 → SIGNATURE_INVALID）
  code: z.string().min(1).optional()
});

/**
 * POST /prepay —— 创建订单 + 双签名
 *
 * 前端流程：调本接口（建议带 wx.login 的新 code）→ 拿 signData/paySig/signature
 * 调 wx.requestVirtualPayment → success 后轮询 GET /order/:outTradeNo 等待履约
 * （发货推送是异步的）。
 */
router.post('/prepay', authRequired, async (req, res, next) => {
  try {
    const ready = isReady();
    if (!ready.ok) {
      return next(new BizError('VPAY_NOT_CONFIGURED', 503, `虚拟支付未就绪：${ready.message}`));
    }

    const { product, code } = PrepaySchema.parse(req.body);

    // 优先用前端刚 wx.login 换的新 code 刷新 session_key（旧值可能已过期）；
    // 刷新失败（code 无效/过期）就退回库里的旧值，交给微信侧最终校验
    let sessionKey = code ? await refreshSessionKey(req.user!.id, code) : '';
    const usedFreshKey = !!sessionKey;
    if (!sessionKey) sessionKey = await getSessionKey(req.user!.id);
    if (!sessionKey) {
      // 让前端知道要重新 wx.login 换新 session_key
      return next(new BizError('SESSION_KEY_MISSING', 409, '登录态过期，请重新登录后支付'));
    }
    logger.info('vpay prepay sessionKey source', {
      userId: req.user!.id, codeProvided: !!code, usedFreshKey, keyLen: sessionKey.length
    });

    const params = await createPrepay(req.user!.id, product as ProductKey, sessionKey);
    res.json({ code: 0, data: params });
  } catch (e) {
    if (e instanceof Error && e.message === 'SESSION_KEY_MISSING') {
      return next(new BizError('SESSION_KEY_MISSING', 409, '登录态过期，请重新登录后支付'));
    }
    next(e);
  }
});

/**
 * GET /notify —— URL 握手验证
 * 校验 signature = SHA1(sort(token, timestamp, nonce, echostr))，通过后原样返回 echostr
 */
router.get('/notify', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query as Record<string, string>;
  if (!signature || !timestamp || !nonce || !echostr) {
    return res.status(400).send('missing params');
  }
  if (!verifyEchoSignature(timestamp, nonce, echostr, signature)) {
    logger.warn('vpay notify handshake signature mismatch');
    return res.status(403).send('invalid signature');
  }
  res.send(echostr); // 必须原样返回（纯文本）
});

/**
 * POST /notify —— 支付结果推送
 * 安全模式下 body = { Encrypt: '...' }（即使数据格式选了 JSON 也会被加密）。
 * 履约成功回包 {"ErrCode":0,"ErrMsg":"OK"}，微信收到非 0 会重试推送 → 服务端必须幂等。
 */
router.post('/notify', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query as Record<string, string>;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const encrypt = (body.Encrypt ?? body.encrypt) as string | undefined;

  try {
    // 安全模式：校验推送签名（token, timestamp, nonce, encrypt）
    if (encrypt && msg_signature) {
      if (!verifyMsgSignature(timestamp, nonce, encrypt, msg_signature)) {
        logger.warn('vpay notify msg_signature mismatch');
        return res.status(403).json({ ErrCode: -1, ErrMsg: 'invalid signature' });
      }
    } else if (!encrypt) {
      // 明文/兼容模式（开发期用），生产建议后台配「安全模式」
      logger.warn('vpay notify received without encryption (明文模式)');
    }

    const result = await handlePushBody(body);
    if (!result.ok) {
      return res.status(200).json({ ErrCode: -1, ErrMsg: 'handle failed' }); // 触发微信重推
    }
    return res.status(200).json({ ErrCode: 0, ErrMsg: 'OK' });
  } catch (e) {
    logger.error('vpay notify error', { err: (e as Error).message });
    // 解密/解析失败也要回非 0 让微信重推，避免丢单
    return res.status(200).json({ ErrCode: -1, ErrMsg: 'error' });
  }
});

/**
 * GET /order/:outTradeNo —— 前端支付后轮询（发货推送有延迟 / 沙箱不推）
 * 只能查自己的订单。**订单状态仍为 created 时主动调微信 query_order 兜底**，
 * 解决沙箱环境不发货推送 + 现网推送丢失的问题。
 */
router.get('/order/:outTradeNo', authRequired, async (req, res, next) => {
  try {
    const order = await getOrderByOutTradeNo(req.params.outTradeNo);
    if (!order || order.user_id !== req.user!.id) {
      return next(new BizError('NOT_FOUND', 404, '订单不存在'));
    }

    // 兜底：status=created 时主动查微信（沙箱不推 / 现网推送丢失场景）
    let finalStatus = order.status;
    if (order.status === 'created') {
      const userRow = await db.queryOne<{ openid: string }>('SELECT openid FROM users WHERE id = ?', [order.user_id]);
      if (userRow?.openid) {
        const wx = await queryOrderFromWx(userRow.openid, order.out_trade_no);
        if (wx?.orderStatus === 2) {
          // 微信已支付但我们没收到推送 → 手动履约（幂等靠 wx_order_id UNIQUE + status='created' WHERE）
          await markOrderPaid(order.out_trade_no, wx.wxOrderId, 'manual');
          finalStatus = 'paid';
          logger.info('vpay order reconciled via query_order', {
            outTradeNo: order.out_trade_no, wxOrderId: wx.wxOrderId
          });
        }
        // 其他状态（1/3/4）继续返回 created，由前端继续轮询或提示
      }
    }

    res.json({
      code: 0,
      data: {
        outTradeNo: order.out_trade_no,
        status: finalStatus,         // created → paid（paid 即已升 Pro）
        productKey: order.product_key,
        priceFen: order.price_fen,
        paidAt: finalStatus === 'paid' ? Date.now() : null
      }
    });
  } catch (e) { next(e); }
});

export default router;
