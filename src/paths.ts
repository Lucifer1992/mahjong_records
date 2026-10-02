/**
 * 用户素材目录统一收口
 *
 * ⚠️ 历史坑（2026-10-02 实锤）：upload.ts 曾用 `__dirname + '..'` 自算目录，
 * 它编译后在 dist/routes/ 下，算出 dist/data/avatars；而 app.ts 在 dist/ 下
 * 算出 server/data/avatars —— 写入和读取是两个目录，头像永远 404，
 * 且 deploy.sh rm -rf dist 会把 dist/data 里的上传文件一起清掉。
 * 以后凡是磁盘素材路径必须从本文件取，禁止各模块自算。
 */
import path from 'path';

/** server/data —— 编译后 __dirname = dist/，.. 即 server/ */
export const DATA_DIR = path.resolve(__dirname, '..', 'data');

/** 头像存放目录（/avatars 静态服务 + 上传目标，同一个目录） */
export const AVATAR_DIR = path.resolve(DATA_DIR, 'avatars');
