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
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.write(JSON.stringify({
      scene: 'from=poster',
      page: 'pages/index/index',
      width: 430,
      auto_color: false,
      line_color: { r: 74, g: 157, b: 126 },
      check_path: true,
      env_version: 'release'
    }));
    req.end();
  });

  // 微信出错时返回 JSON（首字节 '{'），成功时返回图片二进制
  if (raw.length > 0 && raw[0] === 0x7B) {
    let err: any = {};
    try { err = JSON.parse(raw.toString('utf8')); } catch { /* ignore */ }
    logger.warn('getwxacodeunlimit failed', { errcode: err.errcode, errmsg: err.errmsg });
    throw new Error(`生成小程序码失败: ${err.errcode} ${err.errmsg}`);
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
