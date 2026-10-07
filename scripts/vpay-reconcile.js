#!/usr/bin/env node
/**
 * 虚拟支付订单对账脚本（dry-run 验证 → --fix 收回）
 *
 * 背景：Pro 权益收回依赖微信 xpay_refund_notify 推送；推送丢失/沙箱不推时，
 * 用微信 query_order 主动核验订单真实状态（2026-10-07 验证中，可行后并入 refreshTier 兜底）。
 *
 * 用法（服务器 ~/mahjong_records 下）：
 *   node scripts/vpay-reconcile.js --env=0                      # 查现网全部待核验订单（dry-run）
 *   node scripts/vpay-reconcile.js --env=0 --fix                # 查到已退款/关闭 → 自动收回 Pro
 *   node scripts/vpay-reconcile.js --env=0 --order=VP17xxxxxxxx
 *
 * ⚠️ --env 必须与下单环境一致：0=现网 1=沙箱（AppKey 按 env 配对，查错环境=查无此单）。
 *
 * order_status 映射（2026-10-02 现网实测，非文档版）：
 *   1=已创建未支付；2/3/4=已支付（不同支付渠道细类）；5-8=已关闭/退款
 */
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-z]+)=(.+)$/i);
  if (m) args[m[1]] = m[2];
  else args[a.replace(/^--/, '')] = true;
}
// --env 必须在 require dist 模块之前生效（config.ts 在 require 时读入）
if (args.env !== undefined) process.env.VPAY_ENV = String(args.env);

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const mysql = require('mysql2/promise');
const config = require('../dist/config').config;
const { queryOrderFromWx, markOrderRefunded } = require('../dist/services/vpay');

const STATUS_TEXT = {
  1: '已创建未支付',
  2: '已支付', 3: '已支付', 4: '已支付',
  5: '已关闭/退款', 6: '已关闭/退款', 7: '已关闭/退款', 8: '已关闭/退款'
};

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    user: process.env.MYSQL_USER || 'mahjong_rw',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'mahjong_records'
  });

  const [orders] = await conn.query(
    `SELECT o.out_trade_no, o.status AS local_status, o.wx_order_id,
            o.user_id, u.openid, u.nickname, u.tier
     FROM vpay_orders o JOIN users u ON u.id = o.user_id
     ORDER BY o.created_at DESC LIMIT 20`
  );
  const list = args.order ? orders.filter(o => o.out_trade_no === args.order) : orders;

  console.log(`对账环境 env=${config.vpay.env}，待核验 ${list.length} 笔\n`);

  for (const o of list) {
    const line = [];
    line.push(`订单 ${o.out_trade_no}`);
    line.push(`本地=${o.local_status}`);
    line.push(`用户=${o.nickname || o.user_id} (${o.tier})`);

    if (!o.openid) {
      console.log(`${line.join(' | ')} | ⚠️ 用户无 openid，跳过`);
      continue;
    }

    const wx = await queryOrderFromWx(o.openid, o.out_trade_no);
    if (!wx) {
      console.log(`${line.join(' | ')} | ❌ 微信查询失败（超时/签名/网络）`);
      continue;
    }

    const statusText = STATUS_TEXT[wx.orderStatus] || `未知状态 ${wx.orderStatus}`;
    line.push(`微信=${wx.orderStatus}(${statusText})`);

    const isRefunded = wx.orderStatus >= 5;
    if (isRefunded && o.local_status === 'paid') {
      if (args.fix) {
        const ok = await markOrderRefunded(o.out_trade_no);
        line.push(ok ? '✅ 已收回 Pro' : '（收回跳过：状态已变化）');
      } else {
        line.push('⚠️ 需要收回（加 --fix 执行）');
      }
    } else if (isRefunded) {
      line.push('（本地已标记，无需处理）');
    } else if (wx.orderStatus >= 2 && wx.orderStatus <= 4 && o.local_status !== 'paid') {
      line.push('⚠️ 微信已支付但本地未履约（漏发货推送），可考虑补履约');
    }

    console.log(line.join(' | '));
  }

  await conn.end();
  console.log(`\n完成。${args.fix ? '' : '本次为 dry-run，确认无误后加 --fix 执行收回。'}`);
  process.exit(0);
})().catch(e => {
  console.error('对账脚本失败:', e.message);
  process.exit(1);
});
