/**
 * 小程序码服务（getwxacodeunlimit）
 *
 * 用途：战绩海报右下角的「扫码进入」二维码，拉新入口。
 * - access_token 用 WX_APPID/WX_SECRET 换取，内存缓存（7200s，提前 5 分钟刷新）
 * - 小程序码本身对所有用户相同（scene 固定 from=poster），生成一次后落盘
 *   server/data/wxacode/poster.png，之后直接读文件，不打微信接口
 */
import https from 'https';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../logger';

const CACHE_DIR = path.resolve(__dirname, '..', 'data', 'wxacode');
const CACHE_FILE = path.join(CACHE_DIR, 'poster.png');

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

function requestJson(url: string, payload?: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request(url, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : undefined,
      timeout: 10000
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiresAt) {
    return accessToken;
  }
  const { appid, secret } = config.wechat;
  if (!appid || !secret) {
    throw new Error('WX_APPID / WX_SECRET 未配置');
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`;
  const res = await requestJson(url);
  if (!res.access_token) {
    logger.warn('getAccessToken failed', { errcode: res.errcode, errmsg: res.errmsg });
    throw new Error(`获取 access_token 失败: ${res.errcode} ${res.errmsg}`);
  }
  const token: string = res.access_token;
  accessToken = token;
  // 官方 7200s 有效，提前 5 分钟刷新
  accessTokenExpiresAt = Date.now() + (res.expires_in - 300) * 1000;
  return token;
}

/**
 * 获取战绩海报用的小程序码 PNG buffer（scene 固定，落盘缓存）
 *
 * 环境策略：
 * 1. 优先按 WXACODE_ENV_VERSION（默认 release，体验期设 trial）生成，check_path=true
 * 2. trial 生成遇 41030（体验版未上传/页面不存在）→ **自动降级**：
 *    用 env=release + check_path=false 生成正式版码。该码发布前扫码提示
 *    「小程序不存在」，正式发布后即变为可正常跳转的正式码（无需重新生成）
 * 3. release 环境遇 41030 → 真问题（页面路径改名），抛错带提示
 */
export async function getPosterWxacode(): Promise<Buffer> {
  // 磁盘缓存命中 → 直接返回
  try {
    const stat = fs.statSync(CACHE_FILE);
    if (stat.size > 0) {
      return fs.readFileSync(CACHE_FILE);
    }
  } catch {
    // 文件不存在，走生成
  }

  const token = await getAccessToken();
  const url = `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${token}`;
  const page = 'pages/index/index';

  const genCode = async (envVersion: string, checkPath: boolean): Promise<Buffer> => {
    const body = JSON.stringify({
      scene: 'from=poster',
      page,
      width: 430,
      auto_color: false,
      line_color: { r: 74, g: 157, b: 126 },
      check_path: checkPath,
      env_version: envVersion
    });
    // ⚠️ 必须显式带 Content-Length：Node 默认 chunked 传输，api.weixin.qq.com
    // 有概率直接 socket hang up（2026-10-03 现网实锤）
    return new Promise<Buffer>((resolve, reject) => {
      const attempt = (retries: number) => {
        const req = https.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
          timeout: 15000
        }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', (e) => {
          if (retries > 0) return attempt(retries - 1);
          reject(e);
        });
        req.on('timeout', () => { req.destroy(new Error('request timeout')); });
        req.write(body);
        req.end();
      };
      attempt(1);
    });
  };

  /** 解析微信错误响应；非 JSON 错误返回 null */
  const parseWxError = (raw: Buffer): { errcode: number; errmsg: string } | null => {
    if (raw.length > 0 && raw[0] === 0x7B) {
      try {
        const err = JSON.parse(raw.toString('utf8'));
        return { errcode: err.errcode, errmsg: err.errmsg };
      } catch { /* ignore */ }
    }
    return null;
  };

  let raw = await genCode(config.wechat.wxacodeEnv, true);
  let wxErr = parseWxError(raw);

  // 体验版 41030（未上传体验版/页面缺失）→ 降级生成 release 码（发布前仅展示，发布后即可扫）
  if (wxErr?.errcode === 41030 && config.wechat.wxacodeEnv !== 'release') {
    logger.warn('wxacode trial 41030, fallback to release + check_path=false', { page });
    raw = await genCode('release', false);
    wxErr = parseWxError(raw);
  }

  if (wxErr) {
    logger.warn('getwxacodeunlimit failed', { ...wxErr, env: config.wechat.wxacodeEnv });
    if (wxErr.errcode === 41030) {
      throw new Error(`生成小程序码失败: 41030 page 不存在 —— env=release 校验失败，请确认 appid 对应的小程序已包含页面 ${page}`);
    }
    throw new Error(`生成小程序码失败: ${wxErr.errcode} ${wxErr.errmsg}`);
  }

  // 空响应（连接被掐断等）绝不能当成功缓存 —— 2026-10-03 实锤缓存了 0 字节文件
  if (raw.length === 0) {
    throw new Error('生成小程序码失败: 微信返回空响应（已重试）');
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, raw);
  logger.info('wxacode generated and cached', { bytes: raw.length });
  return raw;
}

/** 删除落盘缓存（scene/落地页变化时手动触发重新生成） */
export function clearWxacodeCache(): void {
  try { fs.unlinkSync(CACHE_FILE); } catch { /* ignore */ }
}
