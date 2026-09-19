/**
 * 应用配置
 * 通过环境变量加载，统一从这里读取
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

function num(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export const config = {
  env: str(process.env.NODE_ENV, 'production'),
  port: num(process.env.PORT, 3456),
  host: str(process.env.HOST, '0.0.0.0'),

  jwt: {
    secret: str(process.env.JWT_SECRET, 'dev-only-secret-do-not-use-in-production'),
    expiresIn: str(process.env.JWT_EXPIRES_IN, '180d')
  },

  db: {
    path: path.resolve(__dirname, '..', str(process.env.DB_PATH, './data/mahjong.db'))
  },

  wechat: {
    appid: str(process.env.WX_APPID, ''),
    secret: str(process.env.WX_SECRET, '')
  },

  cors: {
    origins: str(process.env.CORS_ORIGIN, '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  },

  log: {
    level: str(process.env.LOG_LEVEL, 'info'),
    file: path.resolve(__dirname, '..', str(process.env.LOG_FILE, './data/app.log'))
  },

  rateLimit: {
    perMinute: num(process.env.RATE_LIMIT_PER_MIN, 120)
  },

  // 付费分层（个人主体开不了微信支付，先用兑换码做 MVP 变现通道）
  tier: {
    /** 免费用户云端保留「多少个有数据的日期」，默认 3 */
    freeWindowDates: num(process.env.FREE_WINDOW_DATES, 3),
    /** 兑换码 → 升 Pro。留空则 prod 环境完全关闭兑换入口 */
    proUnlockCode: str(process.env.PRO_UNLOCK_CODE, ''),
    /** 统计"日期"用的时区偏移（分钟）。480 = UTC+8，麻将用户都在国内 */
    tzOffsetMinutes: num(process.env.TZ_OFFSET_MINUTES, 480)
  },

  // 虚拟支付（wx.requestVirtualPayment，与普通微信支付是两套独立商户号）
  vpay: {
    /** 虚拟支付商户号（MP 后台 → 虚拟支付 → 基本配置） */
    offerId: str(process.env.VPAY_OFFER_ID, '1450649440'),
    /** 沙箱 AppKey（测试环境签名密钥） */
    sandboxAppKey: str(process.env.VPAY_SANDBOX_APP_KEY, '16WSLCnFyi2G8mHXkPxvTimiRjRCt6pw'),
    /**
     * ⚠️ 现网 AppKey —— 真实收款的签名密钥，泄露即可被伪造支付签名。
     * 刻意不预置、不进 git：部署时由铁匠手动填服务器 .env 的 VPAY_PROD_APP_KEY。
     */
    prodAppKey: str(process.env.VPAY_PROD_APP_KEY, ''),
    /** 0 = 现网，1 = 沙箱。联调用 1，上线切 0 */
    env: num(process.env.VPAY_ENV, 1),
    products: {
      lifetime: {
        productId: str(process.env.VPAY_PRODUCT_LIFETIME, 'PRO_LIFETIME'),
        priceFen: num(process.env.VPAY_PRICE_LIFETIME, 6800), // ¥68，单位：分
        label: 'Pro 终身'
      },
      yearly: {
        productId: str(process.env.VPAY_PRODUCT_YEARLY, 'PRO_YEARLY'),
        priceFen: num(process.env.VPAY_PRICE_YEARLY, 2800), // ¥28，单位：分
        label: 'Pro 年卡'
      }
    },
    /** MP 后台「消息推送」配置的 Token（GET 握手 + 推送签名校验），与后台保持一致 */
    pushToken: str(process.env.VPAY_PUSH_TOKEN, ''),
    /** MP 后台「消息推送」的 EncodingAESKey（43 位，安全模式解密用），与后台保持一致 */
    aesKey: str(process.env.VPAY_AES_KEY, '')
  },

  isDev(): boolean {
    return this.env === 'development';
  },
  isProd(): boolean {
    return this.env === 'production';
  }
};

export type AppConfig = typeof config;