#!/bin/bash
# ============================================
# 麻将记录小程序 后端 一键部署脚本
# 适用：Ubuntu 22.04+ / Debian 11+，Node 18+
# 用法：
#   1) 首次部署（推荐）：bash deploy.sh --init
#   2) 后续更新：        bash deploy.sh
#   3) 完全重置：        bash deploy.sh --reset
#
# 完整步骤（10 步）：
#   0 环境检查 → 1 拉代码 → 2 装依赖 → 3 .env → 4 数据库
#   → 5 编译 → 6 PM2 → 7 日志治理 → 8 Nginx → 9 HTTPS → 10 健康检查
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

# ---------------------------------------------------------------
# align_env_with_example — 把 .env 缺的 key 从 .env.example 补齐
#
# 规则（重要：绝对不覆盖 .env 里已有 key 的 value）：
#   - .env 已存在 key（即便值是空 / 默认值 / 被注释）：一律保留
#   - .env 没有但 .env.example 有的 key：从 example 抽取「带前后注释」
#     追加到 .env 末尾（追加前自动留分隔注释 + 时间戳）
#   - .env 独有但 .env.example 没有的 key：不删（视为用户自定义）
#
# 解析要点：
#   - KEY = 行首去除行内注释（# 开头整行跳过）后第一个 = 之前的部分
#   - .env 已有的 key 集合 = 「有效赋值行的 key 集合」
#     （含 KEY= 这种空值行；含 # 被注释掉的整段—— 因为用户显式注释，
#      视为不需要此 key 的最新配置）
#   - 取 example 里所有「有效赋值行的 key 集合」减去上面集合 = 待补 key
#
# 幂等：连跑两次结果一致（第一次补完后 .env 已包含所有 key，第二次无操作）
# ---------------------------------------------------------------
align_env_with_example() {
  # 防御：如果 example 不存在就直接返回（异常场景不应阻塞部署）
  [ -f ".env.example" ] || { warn ".env.example 不存在,跳过对齐"; return 0; }

  # 收集 .env 中「已声明的 key」集合：
  #   - 有效赋值行（KEY=xxx，含 KEY= 空值）
  #   - 被注释的赋值行（# KEY=xxx / # KEY=xxx）
  # 用户的注释视为「显式保留此 key 在 .env 中的痕迹」，align 不应重写它的状态
  local env_keys
  env_keys=$(
    {
      grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env || true
      grep -E '^#[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' .env || true
    } | sed -E 's/^#[[:space:]]*//' | cut -d= -f1 | sort -u
  )

  # 收集 example 中所有「有效赋值行」的 key
  local example_keys
  example_keys=$(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.example | cut -d= -f1 | sort -u)

  # 缺失的 key（example 有但 .env 没有）
  local missing
  missing=$(comm -23 <(printf '%s\n' "$example_keys") <(printf '%s\n' "$env_keys"))
  if [ -z "$missing" ]; then
    info ".env 已是最新(包含全部 example 键)"
    return 0
  fi

  local count
  count=$(printf '%s\n' "$missing" | wc -l | tr -d ' ')
  info ".env 缺少 $count 个键,将从 .env.example 追加..."
  # 常驻打印：铁匠要求对齐失败要看到具体哪些 key 没补上
  info "[DEBUG] 待补 keys: $(printf '%s' "$missing" | tr '\n' ',' | sed 's/,$//')"

  # 抽取 example 中「缺失 key 所在行 + 紧邻上方的注释块」，追加到 .env 末尾
  # 策略：对每个缺失 key，向前找最近一段连续注释行（# 开头），整段复制
  local stamp
  stamp=$(date '+%Y-%m-%d %H:%M:%S')
  local added=0
  {
    # 保留 .env 原有内容 + 一个空行
    [ -s .env ] && cat .env
    echo ""
    echo "# ============================================================"
    echo "# 以下键由 deploy.sh 自动追加（与 .env.example 对齐），$stamp"
    echo "# 这些值是 .env.example 的默认值，请按需修改后 reload 服务"
    echo "# ============================================================"
    echo ""

    # 按 example 中出现的顺序逐个抽取缺失 key 段（注释块 + 赋值行）
    local block=""
    while IFS= read -r line; do
      if [[ "$line" =~ ^[[:space:]]*# ]] || [[ -z "$line" ]]; then
        # 注释行 / 空行：暂存为 block 的一部分
        block="${block}${line}"$'\n'
        continue
      fi
      # 赋值行：取 key
      local key="${line%%=*}"
      if printf '%s\n' "$missing" | grep -qxF "$key"; then
        printf '%s' "$block"
        echo "$line"
        echo ""
        added=$((added + 1))
      fi
      block=""
    done < .env.example
  } > .env.tmp

  # 铁匠要求：没对齐就报错退出，告诉我哪里没对齐
  if [ "$added" -eq 0 ]; then
    rm -f .env.tmp
    err ".env 对齐失败：检测到 $count 个待补 key，但 .env.example 遍历后没有任何一行匹配"
    err "可能原因：example 被注释化 / BOM 污染 / 行尾含特殊字符 / key 名前有空格"
    err "建议：手动从 .env.example 把以下 key 复制到 .env 末尾："
    printf '%s\n' "$missing" | while read -r k; do
      [ -n "$k" ] && err "  - $k"
    done
    return 1
  fi

  # 部分对齐成功但 missing 还有未匹配的（理论上不应该，但兜底）
  if [ "$added" -lt "$count" ]; then
    err ".env 部分对齐：期望 $count 个，实际补 $added 个"
    return 1
  fi

  mv .env.tmp .env
  info ".env 已对齐,新增 $added 个键"
}

# ----- 参数解析 -----
MODE="update"   # update | init | reset
ALIGN_ONLY=false
for arg in "$@"; do
  case $arg in
    --init)  MODE="init" ;;
    --reset) MODE="reset" ;;
    --align-env)
      # 单独跑对齐：用于 deploy 失败后想单独补齐 .env 键值
      ALIGN_ONLY=true ;;
    -h|--help)
      echo "用法: bash deploy.sh [--init | --reset | --align-env]"
      echo "  --init        首次部署（强制重建数据）"
      echo "  --reset       清理后全新部署（保留 .env）"
      echo "  --align-env   仅对齐 .env 与 .env.example 的键集合（不动其他）"
      echo "  默认          增量更新（拉代码 / 装依赖 / reload）"
      exit 0 ;;
    *) err "未知参数: $arg"; exit 1 ;;
  esac
done

# ----- 单独跑对齐的快捷模式：尽早执行，不依赖 Node/PM2/git -----
if [ "$ALIGN_ONLY" = true ]; then
  step "对齐 .env"
  # 防御：必须在 server 目录下
  if [ ! -f ".env.example" ]; then
    err ".env.example 不存在,请在 server 目录下执行"
    exit 1
  fi
  align_env_with_example
  exit 0
fi

# ----- 0. 环境检查 -----
step "0/10 环境检查"

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

# 检测 nginx / certbot（步骤 8/9 用）
HAS_NGINX=false
HAS_CERTBOT=false
if command -v nginx >/dev/null 2>&1; then
  HAS_NGINX=true
  info "Nginx $(nginx -v 2>&1 | cut -d'/' -f2)"
fi
if command -v certbot >/dev/null 2>&1; then
  HAS_CERTBOT=true
  info "certbot $(certbot --version 2>&1 | cut -d' ' -f2)"
fi
if [ "$HAS_NGINX" = false ]; then
  warn "未检测到 nginx,步骤 8 将跳过（手动配也行）"
fi
if [ "$HAS_CERTBOT" = false ]; then
  warn "未检测到 certbot,步骤 9 将跳过"
fi

# ----- 1. 拉代码 / 准备目录 -----
step "1/10 准备代码"
if [ -d ".git" ]; then
  info "检测到 git 仓库,拉取最新代码..."
  git pull --rebase --autostash
else
  warn "当前目录不是 git 仓库 (跳过 git pull)"
  warn "提示: 首次部署应在 git clone 后进入目录运行"
fi

# ----- 2. 安装依赖 -----
step "2/10 安装依赖"
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
step "3/10 配置环境变量"
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

  # 对齐 .env 与 .env.example 的键值集合
  # 规则：
  #   - .env 已存在 key（不论值是空/默认/真实）：一律不动
  #   - .env 缺失但 .env.example 有的 key：从 example 抽出「带前后注释」追加到 .env 末尾
  #   - .env 独有但 .env.example 没有的 key：不删（用户自定义配置）
  align_env_with_example
fi

# 检查 .env 里的 nginx / certbot 相关配置
ENV_DOMAIN=$(grep -E "^API_DOMAIN=" .env 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' \t\r\n')
ENV_EMAIL=$(grep -E "^CERTBOT_EMAIL=" .env 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' \t\r\n')

if [ -z "$ENV_DOMAIN" ]; then
  warn ".env 未设 API_DOMAIN,步骤 8/9 将跳过 Nginx + HTTPS 配置"
  warn "如需启用,加: API_DOMAIN=mahjong.your-domain.com"
else
  info "API_DOMAIN = $ENV_DOMAIN (步骤 8/9 将自动配置 Nginx + HTTPS)"
fi

# ----- 4. 初始化数据库（MySQL） -----
step "4/10 数据库"

# .env 里必须有 MYSQL_* 配置
if ! grep -qE "^MYSQL_DATABASE=" .env; then
  err ".env 缺少 MYSQL_DATABASE 配置！"
  echo "   首次部署请先在服务器上执行: sudo bash scripts/setup-mysql.sh addapp mahjong_records mahjong_rw"
  echo "   然后把生成的凭据填入 .env 的 MYSQL_HOST / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD"
  exit 1
fi

# 存量迁移提示（SQLite → MySQL 一次性）
if [ -f "data/mahjong.db" ]; then
  warn "检测到旧 SQLite 库 data/mahjong.db"
  warn "如尚未迁移存量数据，请在部署完成后执行一次: npm run migrate-sqlite"
fi

# init-db 幂等：连库 + 建表 + 列迁移，失败即退出
if ! npm run init-db; then
  err "数据库初始化失败，请检查 .env 的 MYSQL_* 配置与 MySQL 服务状态"
  exit 1
fi
info "✅ MySQL 连接与建表验证通过"

# ----- 5. 编译 -----
step "5/10 编译 TypeScript"
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
step "6/10 PM2 启动"

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
step "7/10 日志治理 (pm2-logrotate)"

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

# ----- 8. Nginx 反代配置 -----
step "8/10 Nginx 反代配置"

if [ "$HAS_NGINX" = false ]; then
  warn "nginx 未安装,跳过（手动配可参考 README.md）"
  warn "安装: sudo apt install -y nginx"
elif [ -z "$ENV_DOMAIN" ]; then
  warn ".env 未设 API_DOMAIN,跳过 Nginx 配置"
  warn "启用方法: 编辑 .env 加 API_DOMAIN=mahjong.your-domain.com 后重跑"
else
  info "配置域名: $ENV_DOMAIN"

  NGINX_CONF="/etc/nginx/sites-available/mahjong"
  NGINX_LINK="/etc/nginx/sites-enabled/mahjong"

  # 幂等写入：备份老配置 + 写新配置
  if [ -f "$NGINX_CONF" ]; then
    sudo cp "$NGINX_CONF" "${NGINX_CONF}.bak.$(date +%Y%m%d%H%M%S)"
    info "已备份旧配置: ${NGINX_CONF}.bak.*"
  fi

  sudo tee "$NGINX_CONF" > /dev/null <<NGINX_EOF
# 麻将记录小程序 - 反代配置
# 由 deploy.sh 自动生成（可手动编辑,下次 deploy 会备份后覆盖）
server {
    listen 80;
    server_name ${ENV_DOMAIN};

    # 安全: 禁止直接访问敏感路径
    location ~ /\.(env|git) { deny all; return 404; }

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        proxy_connect_timeout 10s;

        # 客户端真实 IP 给 Express 用
        real_ip_header X-Real-IP;
        set_real_ip_from 127.0.0.1;
    }
}
NGINX_EOF
  info "已写入: $NGINX_CONF"

  # 启用站点（创建软链接）
  if [ ! -L "$NGINX_LINK" ]; then
    sudo ln -s "$NGINX_CONF" "$NGINX_LINK"
    info "已创建软链接: $NGINX_LINK"
  else
    info "软链接已存在"
  fi

  # 移除默认站点（避免占用 80 端口冲突）
  if [ -L "/etc/nginx/sites-enabled/default" ]; then
    sudo rm /etc/nginx/sites-enabled/default
    info "已移除默认站点"
  fi

  # 验证 + 生效
  if sudo nginx -t 2>&1 | grep -q "successful"; then
    sudo systemctl reload nginx
    info "✅ Nginx 配置已 reload"
  else
    err "❌ Nginx 配置有误,请手动: sudo nginx -t"
  fi
fi

# ----- 9. HTTPS 证书 -----
step "9/10 HTTPS 证书 (Let's Encrypt)"

if [ "$HAS_CERTBOT" = false ]; then
  warn "certbot 未安装,跳过"
  warn "安装: sudo apt install -y certbot python3-certbot-nginx"
elif [ -z "$ENV_DOMAIN" ]; then
  warn ".env 未设 API_DOMAIN,跳过证书申请"
elif sudo certbot certificates 2>/dev/null | grep -q "Certificate Name: $ENV_DOMAIN"; then
  info "✅ 证书已存在: $ENV_DOMAIN"
  sudo certbot certificates 2>/dev/null | grep -A 6 "Certificate Name: $ENV_DOMAIN" | tee -a /tmp/cert-check.log 2>/dev/null || true
else
  info "未找到证书,尝试申请: $ENV_DOMAIN"

  # 邮箱
  if [ -z "$ENV_EMAIL" ]; then
    warn ".env 未设 CERTBOT_EMAIL,使用占位邮箱"
    warn "建议在 .env 加 CERTBOT_EMAIL=your-real@email.com 后重新申请"
    ENV_EMAIL="admin@$(echo $ENV_DOMAIN | cut -d. -f2-)"
  fi
  info "使用邮箱: $ENV_EMAIL"

  # 防火墙检查（80 必须开放才能申请）
  if command -v ufw >/dev/null 2>&1; then
    if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
      if ! sudo ufw status 2>/dev/null | grep -q "80/tcp"; then
        warn "UFW 防火墙未开放 80 端口,certbot 申请会失败"
        warn "执行: sudo ufw allow 80/tcp"
      fi
    fi
  fi

  # 申请证书（非交互 + 自动同意 + 自动配 Nginx）
  if sudo certbot --nginx \
      -d "$ENV_DOMAIN" \
      --non-interactive --agree-tos -m "$ENV_EMAIL" \
      --redirect 2>&1 | tee -a /tmp/certbot.log; then
    info "✅ HTTPS 证书申请成功,HTTP → HTTPS 自动重定向已配置"
  else
    err "❌ certbot 申请失败"
    err "常见排查:"
    err "  1. DNS: ping $ENV_DOMAIN 应返回本机公网 IP"
    err "  2. 80 端口: sudo ufw allow 80/tcp && curl http://$ENV_DOMAIN"
    err "  3. 邮箱被拒: 换 gmail 或企业邮箱"
    err "手动重试: sudo certbot --nginx -d $ENV_DOMAIN"
  fi
fi

# ----- 10. 健康检查 -----
step "10/10 健康检查"
sleep 2

# 优先走 HTTPS（如果有证书），否则走 HTTP
HEALTH_URL="http://127.0.0.1:3456/api/health"
if [ -n "$ENV_DOMAIN" ] && sudo certbot certificates 2>/dev/null | grep -q "Certificate Name: $ENV_DOMAIN"; then
  HEALTH_URL="https://$ENV_DOMAIN/api/health"
fi
info "请求: $HEALTH_URL"

if command -v curl >/dev/null 2>&1; then
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -k "$HEALTH_URL" || echo "000")
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

============= Nginx / HTTPS =============
查看配置:   sudo cat /etc/nginx/sites-available/mahjong
验证配置:   sudo nginx -t
reload:     sudo systemctl reload nginx
证书状态:   sudo certbot certificates
证书续期:   bash scripts/renew-cert.sh --auto

============= 日志轮转 (pm2-logrotate) =============
查看配置:   pm2 conf pm2-logrotate
查看日志:   ls -lh data/  (会看到 *.log.gz)
手动触发:   pm2 trigger pm2-logrotate  (测试用)

============= 下一步提醒 =============
1. 编辑 .env 配置 WX_APPID / WX_SECRET (生产环境)
2. 微信公众平台 → 开发管理 → 服务器域名加白名单
3. 配置每日 3 点 DB 备份 (crontab + mysqldump)
EOF