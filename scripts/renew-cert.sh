#!/bin/bash
# ============================================
# 麻将记录小程序 - SSL 证书自动续期脚本
# Certbot 自动续期 (certbot.timer 每天跑两次，
# 此脚本用于手动 / 定时任务 / 状态检查)
#
# 用法:
#   ./renew-cert.sh                       # 默认：检查证书状态
#   ./renew-cert.sh --auto                # 自动续期（cron 模式）
#   ./renew-cert.sh --check               # 检查证书状态
#   ./renew-cert.sh --dry-run             # 测试续期（不实际执行）
#   ./renew-cert.sh --nginx-test          # 验证 nginx 配置
#   ./renew-cert.sh --domain=api.xxx.com  # 指定域名（覆盖默认值）
#
# Crontab 示例（每月 1 号 03:00 自动续期）:
#   0 3 1 * * /home/sam/mahjong_records/scripts/renew-cert.sh --auto >> /home/sam/mahjong_records/logs/cert-renewal.log 2>&1
#
# Certbot 自带的定时任务查看:
#   systemctl list-timers certbot.timer
#   systemctl status certbot.timer
# ============================================

set -e

# ============ 配置（可通过环境变量覆盖）============
CERT_DOMAIN="${CERT_DOMAIN:-mahjong.your-domain.com}"
PROJECT_DIR="${PROJECT_DIR:-$HOME/mahjong_records}"
LOG_FILE="${LOG_FILE:-$PROJECT_DIR/logs/cert-renewal.log}"

# ============ 颜色 ============
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ============ 日志函数 ============
log() {
  local ts="[$(date '+%Y-%m-%d %H:%M:%S')]"
  if [ -t 1 ]; then
    # 终端：带颜色
    case "${2:-}" in
      err) echo -e "$ts ${RED}[ERR ]${NC} $1" | tee -a "$LOG_FILE" ;;
      warn) echo -e "$ts ${YELLOW}[WARN]${NC} $1" | tee -a "$LOG_FILE" ;;
      ok) echo -e "$ts ${GREEN}[OK  ]${NC} $1" | tee -a "$LOG_FILE" ;;
      *) echo -e "$ts ${GREEN}[INFO]${NC} $1" | tee -a "$LOG_FILE" ;;
    esac
  else
    # cron 模式（无 TTY）：纯文本
    echo "$ts [$2] $1" >> "$LOG_FILE"
  fi
}

# ============ 初始化 ============
init() {
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
}

# ============ 从 .env 读域名 ============
load_domain_from_env() {
  local env_file="$PROJECT_DIR/server/.env"
  if [ -f "$env_file" ]; then
    local domain=$(grep -E "^API_DOMAIN=" "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" | tr -d ' \t\r\n')
    if [ -n "$domain" ] && [ "$domain" != "mahjong.your-domain.com" ]; then
      CERT_DOMAIN="$domain"
      log "Loaded domain from .env: $CERT_DOMAIN" "INFO"
    fi
  fi
}

# ============ 检查证书状态 ============
check_cert() {
  log "Checking certificate for $CERT_DOMAIN..." "INFO"

  local certs=$(sudo certbot certificates 2>/dev/null || true)

  if echo "$certs" | grep -q "Certificate Name: $CERT_DOMAIN"; then
    log "✅ Certificate found" "OK"
    echo "$certs" | grep -A 10 "Certificate Name: $CERT_DOMAIN" | tee -a "$LOG_FILE"

    # 提取过期时间
    local expiry=$(echo "$certs" | grep -A 10 "Certificate Name: $CERT_DOMAIN" | grep "Expiry Date:" | head -1)
    if [ -n "$expiry" ]; then
      log "过期时间: $expiry" "INFO"
      # 距离过期 < 7 天报警
      local days_left=$(echo "$expiry" | sed -E 's/.*\(([0-9]+) days\).*/\1/')
      if [ -n "$days_left" ] && [ "$days_left" -lt 7 ] 2>/dev/null; then
        log "⚠️ 证书将在 $days_left 天后过期，请检查！" "warn"
      fi
    fi
    return 0
  else
    log "❌ Certificate for $CERT_DOMAIN not found" "err"
    log "申请证书: sudo certbot --nginx -d $CERT_DOMAIN" "INFO"
    return 1
  fi
}

# ============ 续期 + reload nginx ============
renew_cert() {
  log "Starting certificate renewal..." "INFO"

  local output
  if output=$(sudo certbot renew --quiet 2>&1); then
    log "✅ certbot renew 执行成功" "OK"

    # 尝试 reload nginx（仅在有 nginx 时）
    if command -v nginx >/dev/null 2>&1; then
      if sudo nginx -t >/dev/null 2>&1; then
        sudo systemctl reload nginx && log "✅ Nginx reloaded" "OK" || log "⚠️ Nginx reload failed" "warn"
      else
        log "⚠️ Nginx config 无效，未 reload（先运行 --nginx-test 检查）" "warn"
      fi
    else
      log "ℹ️ 未检测到 nginx，跳过 reload" "INFO"
    fi
    return 0
  else
    log "ℹ️ 证书无需续期（仍 > 30 天有效）或续期失败" "warn"
    log "certbot 输出: $output" "INFO"
    return 0  # 不视为失败（无需续期是常态）
  fi
}

# ============ Dry-run ============
dry_run() {
  log "Running certbot renew --dry-run..." "INFO"
  if sudo certbot renew --dry-run 2>&1 | tee -a "$LOG_FILE"; then
    log "✅ Dry-run 成功" "OK"
  else
    log "❌ Dry-run 失败" "err"
    return 1
  fi
}

# ============ 检查 certbot 定时任务 ============
show_timer() {
  log "Certbot auto-renewal timer status:" "INFO"
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl list-timers certbot.timer 2>/dev/null | tee -a "$LOG_FILE" || log "ℹ️ certbot.timer 未配置（不影响 cron 续期）" "INFO"
  else
    log "ℹ️ 当前系统无 systemctl（可能不是 systemd）" "INFO"
  fi
}

# ============ Nginx 配置检查 ============
nginx_test() {
  log "Testing nginx configuration..." "INFO"
  if sudo nginx -t 2>&1 | tee -a "$LOG_FILE"; then
    log "✅ Nginx 配置有效" "OK"
  else
    log "❌ Nginx 配置有误" "err"
    return 1
  fi
}

# ============ 帮助 ============
show_help() {
  cat << EOF
用法: $(basename "$0") [选项] [--domain=NAME]

选项:
  --auto                自动续期（cron 友好，失败静默）
  --check               检查证书状态 + 剩余有效期
  --dry-run             测试续期（不实际执行）
  --nginx-test          验证 nginx 配置
  --domain=NAME         指定域名（覆盖默认值 + .env）
  --help, -h            显示此帮助

环境变量（可选，用于覆盖默认值）:
  CERT_DOMAIN           证书域名（默认: mahjong.your-domain.com）
  PROJECT_DIR           项目目录（默认: ~/mahjong_records）
  LOG_FILE              日志路径

Cron 示例（每月 1 号 03:00 自动续期）:
  0 3 1 * * \$PROJECT_DIR/scripts/renew-cert.sh --auto >> \$LOG_FILE 2>&1

Certbot 自带的定时任务（每天两次）也已配置:
  systemctl list-timers certbot.timer
  systemctl status certbot.timer
  journalctl -u certbot -f    # 实时日志

常见问题:
  Q: 如何申请首个证书？
  A: sudo certbot --nginx -d mahjong.your-domain.com

  Q: 域名改了怎么办？
  A: 在 server/.env 加 API_DOMAIN=api.newdomain.com，下次自动读取

  Q: crontab 不执行？
  A: 检查 PATH（certbot 在 /usr/bin/certbot）+ 绝对路径
EOF
}

# ============ 解析参数 ============
AUTO_MODE=false
ACTION="default"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto)         AUTO_MODE=true; shift ;;
    --check)        ACTION="check"; shift ;;
    --dry-run)      ACTION="dryrun"; shift ;;
    --nginx-test)   ACTION="nginxtest"; shift ;;
    --domain=*)     CERT_DOMAIN="${1#*=}"; shift ;;
    --help|-h)      show_help; exit 0 ;;
    *)              log "Unknown arg: $1" "err"; show_help; exit 1 ;;
  esac
done

# ============ 主逻辑 ============
init
load_domain_from_env

case "$ACTION" in
  check)
    check_cert
    ;;
  dryrun)
    dry_run
    ;;
  nginxtest)
    nginx_test
    ;;
  default)
    if [ "$AUTO_MODE" = true ]; then
      # cron 模式：续期 + 静默
      log "===== 自动续期开始 =====" "INFO"
      renew_cert || log "Auto renewal finished with warnings" "warn"
      log "===== 自动续期结束 =====" "INFO"
    else
      # 手动模式：完整状态报告
      echo "=========================================="
      show_timer
      echo ""
      check_cert
      echo ""
      log "提示: 使用 --auto 触发续期，--dry-run 测试" "INFO"
    fi
    ;;
esac