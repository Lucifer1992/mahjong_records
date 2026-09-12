# 麻将记录小程序 · 后端 API

Node.js + Express + TypeScript + SQLite + PM2，自带部署脚本。

## ✨ 特性

- 🚀 **零运维**：SQLite 单文件，开箱即用
- 🔐 **JWT 鉴权**：微信登录 → 自动签发 token
- 🛡️ **基础防护**：Helmet + CORS + 内存限流
- 📊 **完整业务**：战绩 / 玩家 / 统计 / 福星克星 / 牌运月历
- 🔁 **软删除**：删战绩不影响玩家统计稳定性
- 🔄 **批量同步**：首登 / 离线恢复友好
- 📦 **PM2 部署**：graceful reload，零停机热更新

---

## 🚀 5 分钟本地启动

```bash
# 1. 进入目录
cd server

# 2. 安装依赖（首次）
npm install

# 3. 复制环境变量并按需修改
cp .env.example .env
# ⚠️ 修改 JWT_SECRET 为随机长字符串（至少 32 位）

# 4. 初始化数据库（首次部署）
npm run init-db

# 5. 开发模式（热重载）
npm run dev
# → http://localhost:3456/api/health

# 6. 编译生产产物
npm run build

# 7. PM2 启动
npm run pm2:start
# 查看日志：npm run pm2:logs
# 查看状态：npm run pm2:status
```

---

## 📁 目录结构

```
server/
├── src/
│   ├── index.ts          # 入口（HTTP + 优雅退出）
│   ├── app.ts            # Express 应用
│   ├── config.ts         # 环境变量配置
│   ├── logger.ts         # 控制台 + 文件日志
│   ├── db/index.ts       # SQLite + 建表
│   ├── middleware/
│   │   ├── auth.ts       # JWT 鉴权
│   │   ├── error.ts      # 统一错误处理
│   │   └── rate-limit.ts # IP 限流
│   ├── routes/
│   │   ├── auth.ts       # 微信登录
│   │   ├── records.ts    # 战绩 CRUD + 批量
│   │   ├── players.ts    # 玩家档案
│   │   └── stats.ts      # 统计（总览/福星/月历）
│   ├── services/         # 业务逻辑
│   └── utils/            # uuid 等工具
├── scripts/init-db.ts    # 手动建表脚本
├── ecosystem.config.cjs  # PM2 配置
├── .env.example          # 环境变量模板
└── data/                 # 运行时数据（不入 git）
    ├── mahjong.db        # SQLite 文件
    └── *.log             # 日志
```

---

## 📡 API 速查

> 所有接口返回 `{ code: 0, data: ... }`，失败时 `code` 为错误码。
> 除 `auth` 和 `health` 外，所有接口需 Header `Authorization: Bearer <token>`。

### 鉴权

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/wx-login` | 微信登录，返回 token |

### 战绩

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/records?limit=50&offset=0&ruleType=xuezhan` | 列表（分页） |
| GET | `/api/records/:id` | 单场详情 |
| POST | `/api/records` | 新建 |
| POST | `/api/records/batch` | 批量同步 |
| DELETE | `/api/records/:id` | 软删除 |

### 玩家

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/players` | 列表 |
| POST | `/api/players` | 新建 |
| GET | `/api/players/:id` | 详情 |
| DELETE | `/api/players/:id` | 删除 |

### 统计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/stats/summary?nickname=xxx` | 总览 |
| GET | `/api/stats/fortune?playerId=xxx&topN=5` | 福星克星 |
| GET | `/api/stats/calendar?year=2026&month=9&nickname=xxx` | 牌运月历 |

### 示例请求

```bash
# 登录（dev 模式）
curl -X POST http://localhost:3456/api/auth/wx-login \
  -H "Content-Type: application/json" \
  -d '{"code":"dev_test"}'

# 创建战绩（替换 YOUR_TOKEN）
curl -X POST http://localhost:3456/api/records \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "playedAt": 1726123456789,
    "ruleType": "xuezhan",
    "ruleName": "血战到底",
    "duration": "evening",
    "totalFee": 0,
    "note": "",
    "mood": "peak",
    "players": [
      {"nickname":"我","score":64},
      {"nickname":"老李","score":-24},
      {"nickname":"小张","score":-16},
      {"nickname":"阿伟","score":-24}
    ]
  }'
```

---

## 🚢 生产部署

### 方案 A：单台 VPS（推荐独立开发者）

> **从 2026-09-12 起，`deploy.sh` 已自动完成 PM2 / Nginx / HTTPS 全流程**。
> 手动步骤 3-5 仅作参考，自动化已覆盖。

#### 1. 服务器准备

```bash
# Ubuntu 22.04+
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx

# 安装 Node 18+（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 安装 PM2
sudo npm install -g pm2

# 创建部署用户（可选）
sudo useradd -m -s /bin/bash deploy
sudo su - deploy
```

#### 2. 一键部署（推荐）

```bash
# 把 server 目录 scp/rsync 到服务器
scp -r server/ deploy@your-server:/home/deploy/mahjong/

ssh deploy@your-server
cd /home/deploy/mahjong/server

# 首次部署：自动完成 10 步
cp .env.example .env
nano .env  # 必改 JWT_SECRET + 加 API_DOMAIN=mahjong.your-domain.com + CERTBOT_EMAIL=you@xxx.com
bash deploy.sh --init
```

`deploy.sh` 会自动完成：

| 步骤 | 内容 |
|---|---|
| 0/10 | 环境检查（Node / PM2 / Nginx / certbot） |
| 1/10 | 拉最新代码（git pull） |
| 2/10 | 装依赖（含 tsx/typescript） |
| 3/10 | 校验 `.env`（强制改 JWT_SECRET） |
| 4/10 | 初始化 SQLite |
| 5/10 | TypeScript 编译 |
| 6/10 | PM2 启动 / reload（0 停机） |
| 7/10 | pm2-logrotate 安装 + 配置 |
| 8/10 | **写 Nginx 反代配置**（读 `API_DOMAIN`） |
| 9/10 | **certbot 申请 HTTPS 证书**（HTTP 自动 301 → HTTPS） |
| 10/10 | 健康检查（走 HTTPS） |

#### 3. 小程序后台加白名单

微信公众平台 → 开发管理 → 服务器域名 → 添加 `https://mahjong.your-domain.com`

> ⚠️ **必须 https://** 且**不能带端口**（小程序强制 443）。

#### 4. 后续更新（已自动化）

```bash
# 服务器（直接跑 deploy.sh，会自动 git pull + reload）
ssh deploy@your-server
cd /home/deploy/mahjong/server
bash deploy.sh
```

部署脚本检测到已有进程会 `pm2 reload`（0 停机），检测到 `.env` 已存在会跳过，检测到证书已存在会跳过。所以**同一命令既能首次部署又能增量更新**，幂等。

### 方案 B：PM2 远程部署（适合多服务器）

参考 `ecosystem.config.cjs` 中的 `deploy` 段，先配 ssh 免密登录，然后：

```bash
pm2 deploy production setup
pm2 deploy production
```

---

## 🔒 安全清单

部署前必检：

- [ ] `JWT_SECRET` 已改为随机长字符串（≥ 32 位）
- [ ] 已配置 `WX_APPID` / `WX_SECRET`（生产环境关闭 dev 模式）
- [ ] Nginx 强制 HTTPS
- [ ] 防火墙只开 22/80/443，3456 仅本机访问
- [ ] 定期 `pm2 logs` + 备份 `data/mahjong.db`
- [ ] `.env` 不入 git

---

## 🛠️ 运维速查

```bash
# 查看进程
pm2 status
pm2 monit               # 实时 CPU/内存

# 日志
pm2 logs mahjong-records --lines 200
# 或直接看
tail -f data/pm2-combined.log

# 重启 / 重载
pm2 restart mahjong-records   # 硬重启（有短暂停机）
pm2 reload mahjong-records    # 优雅重载（推荐）

# 数据库备份
cp data/mahjong.db data/backup-$(date +%Y%m%d).db
# 加 crontab 每日 3 点自动备份：
# 0 3 * * * cp /home/deploy/mahjong/server/data/mahjong.db /home/deploy/mahjong/backup/mahjong-$(date +\%Y\%m\%d).db

# 升级 Node
nvm install 20 && nvm use 20
npm install && npm run build
pm2 reload all
```

---

## 🧪 数据迁移到 MySQL/PostgreSQL（未来）

1. 在 `db/index.ts` 拆出 adapter，引入 `mysql2` 或 `pg`
2. 调整 SQL 方言差异
3. 一次性的数据导出脚本：`sqlite3 data/mahjong.db .dump > dump.sql` → 转换导入

v1 用 SQLite 完全够用（日均 < 10 万场无压力）。需要时再迁。

---

## 📞 故障排查

| 现象 | 原因 | 解决 |
|---|---|---|
| `EADDRINUSE :::3456` | 端口被占 | `lsof -i:3456` 查 pid，`kill -9` |
| 401 Unauthorized | token 过期 / 无 token | 重新登录拿 token |
| 数据库锁 | SQLite 写并发 | 已开 WAL，正常不会；高并发换 PG |
| 小程序报"不在白名单" | 服务器域名未配 | 微信公众平台 → 开发管理 → 加白名单 |
| `pm2 reload` 后访问 502 | 新进程没起来 | `pm2 logs` 看启动错误 |