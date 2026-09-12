#!/bin/bash
# ============================================
# 麻将记录小程序 后端 一键部署脚本
# 适用：Ubuntu 22.04+ / Debian 11+，Node 18+
# 用法：
#   1) 首次部署（推荐）：bash deploy.sh --init
#   2) 后续更新：        bash deploy.sh
#   3) 完全重置：        bash deploy.sh --reset
# ============================================

set -e

# ----- 颜色 -----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR ]${NC} $1"; }
step() { echo -e "\n${BLUE}▶ $1${NC}"; }

# ----- 参数解析 -----
MODE="update"   # update | init | reset
for arg in "$@"; do
  case $arg in
    --init)  MODE="init" ;;
    --reset) MODE="reset" ;;
    -h|--help)
      echo "用法: bash deploy.sh [--init | --reset]"
      echo "  --init   首次部署（强制重建数据）"
      echo "  --reset  清理后全新部署（保留 .env）"
      echo "  默认     增量更新（拉代码 / 装依赖 / reload）"
      exit 0 ;;
    *) err "未知参数: $arg"; exit 1 ;;
  esac
done

# ----- 0. 环境检查 -----
step "0/8 环境检查"

if ! command -v node &> /dev/null; then
  err "未检测到 Node.js"
  echo "  安装: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  err "Node 版本过低 (当前 v$NODE_VER), 需要 18+"
  exit 1
fi
info "Node $(node -v)"

if ! command -v npm &> /dev/null; then
  err "未检测到 npm"
  exit 1
fi

if ! command -v pm2 &> /dev/null; then
  warn "未检测到 PM2,正在全局安装..."
  sudo npm install -g pm2
fi
info "PM2 $(pm2 -v)"

# ----- 1. 拉代码 / 准备目录 -----
step "1/8 准备代码"
if [ -d ".git" ]; then
  info "检测到 git 仓库,拉取最新代码..."
  git pull --rebase --autostash
else
  warn "当前目录不是 git 仓库 (跳过 git pull)"
  warn "提示: 首次部署应在 git clone 后进入目录运行"
fi

# ----- 2. 安装依赖 -----
step "2/8 安装依赖"
if [ "$MODE" = "reset" ] && [ -d "node_modules" ]; then
  warn "--reset 模式,清理 node_modules..."
  rm -rf node_modules
fi

if [ -d "node_modules" ]; then
  info "node_modules 已存在,跳过安装 (重装请加 --reset)"
else
  # 注意：不带 --production！
  # 步骤 4 要跑 `npm run init-db`，步骤 5 要 `npm run build`，都依赖 tsx + typescript（dev deps）
  # 生产环境多 ~50MB dev deps 无影响，换简洁和稳定
  npm install
fi

# ----- 3. 配置 .env -----
step "3/8 配置环境变量"
if [ ! -f ".env" ]; then
  cp .env.example .env
  warn ".env 已生成 (基于 .env.example)"
  echo ""
  warn "⚠️  必须修改 JWT_SECRET,否则等于裸奔!"
  echo "   生成随机密钥: openssl rand -hex 32"
  echo "   编辑 .env:    nano .env"
  echo ""
  if [ "$MODE" = "init" ]; then
    read -p "按回车继续 (已修改 JWT_SECRET 后按回车,跳过则手动重启): " _
  fi
else
  info ".env 已存在"
  # 安全检查
  if grep -q "change-me-to-a-long-random-string" .env; then
    err "❌ JWT_SECRET 还是默认值!请编辑 .env 后重新执行"
    exit 1
  fi
fi

# ----- 4. 初始化数据库 -----
step "4/8 数据库"
mkdir -p data

if [ "$MODE" = "init" ] || [ "$MODE" = "reset" ]; then
  if [ -f "data/mahjong.db" ]; then
    warn "备份现有数据库: data/mahjong.db -> data/mahjong.db.bak.$(date +%Y%m%d%H%M%S)"
    cp data/mahjong.db "data/mahjong.db.bak.$(date +%Y%m%d%H%M%S)"
  fi
  npm run init-db
elif [ ! -f "data/mahjong.db" ]; then
  info "首次运行,初始化数据库..."
  npm run init-db
else
  info "data/mahjong.db 已存在,跳过建表"
fi

# ----- 5. 编译 -----
step "5/8 编译 TypeScript"
if [ -d "dist" ] && [ "$MODE" != "reset" ]; then
  info "dist 已存在,增量编译..."
else
  rm -rf dist
  npm run build
fi

if [ ! -f "dist/index.js" ]; then
  err "编译失败: dist/index.js 不存在"
  exit 1
fi
info "编译产物: dist/index.js ✓"

# ----- 6. PM2 启动 / 重载 -----
step "6/8 PM2 启动"

if pm2 list 2>/dev/null | grep -q "mahjong-records"; then
  info "检测到已有进程,执行 graceful reload (0 停机)..."
  pm2 reload ecosystem.config.cjs
else
  info "首次启动..."
  pm2 start ecosystem.config.cjs
  pm2 save

  # 检查开机自启
  if ! systemctl is-enabled pm2-deploy &> /dev/null 2>&1; then
    warn "建议配置开机自启: pm2 startup (复制输出的 sudo 命令执行)"
  fi
fi

# ----- 7. 日志治理 (pm2-logrotate) -----
step "7/8 日志治理 (pm2-logrotate)"

# 幂等安装：已装则跳过
if pm2 module:list 2>/dev/null | grep -q "pm2-logrotate"; then
  info "pm2-logrotate 已安装,跳过安装步骤"
else
  info "安装 pm2-logrotate..."
  # 用 | cat 防止某些环境 stdout 异常阻塞
  pm2 install pm2-logrotate 2>&1 | cat || {
    warn "pm2-logrotate 安装失败 (通常是网络问题),可手动执行: pm2 install pm2-logrotate"
  }
fi

# 推荐配置（pm2 set 幂等）
info "配置日志轮转参数..."
pm2 set pm2-logrotate:max_size 10M            # 单文件 10M 触发切分
pm2 set pm2-logrotate:retain 30               # 保留 30 份（≈ 1 个月）
pm2 set pm2-logrotate:compress true           # 旧日志 gzip 压缩
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD-HH-mm-ss
pm2 set pm2-logrotate:workerInterval 30       # 30 秒检查一次
pm2 set pm2-logrotate:rotateInterval '0 0 0 * * *'  # 每日 0 点强制切

# ----- 8. 健康检查 -----
step "8/8 健康检查"
sleep 2

HEALTH_URL="http://127.0.0.1:3456/api/health"
info "请求: $HEALTH_URL"

if command -v curl >/dev/null 2>&1; then
  RESP=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" || echo "000")
  if [ "$RESP" = "200" ]; then
    info "✅ 健康检查通过 (HTTP $RESP)"
  else
    warn "⚠️  健康检查返回 HTTP $RESP"
    warn "查看日志: pm2 logs mahjong-records --lines 50"
  fi
else
  warn "未安装 curl,跳过健康检查"
fi

# ----- 完成 -----
step "🎉 部署完成"
cat <<'EOF'

============= 后续运维 =============
查看状态:   pm2 status
查看日志:   pm2 logs mahjong-records
实时监控:   pm2 monit
硬重启:     pm2 restart mahjong-records
优雅重载:   pm2 reload mahjong-records
数据库备份: cp data/mahjong.db data/backup-$(date +%Y%m%d).db

============= 日志轮转 (pm2-logrotate) =============
查看配置:   pm2 conf pm2-logrotate
查看日志:   ls -lh data/  (会看到 *.log.gz)
手动触发:   pm2 trigger pm2-logrotate  (测试用)

============= 下一步提醒 =============
1. 编辑 .env 配置 WX_APPID / WX_SECRET (生产环境)
2. 配置 Nginx 反代 + HTTPS (certbot --nginx -d api.xxx.com)
3. 微信公众平台 → 开发管理 → 服务器域名加白名单
4. 配置每日 3 点 DB 备份 (crontab)
EOF