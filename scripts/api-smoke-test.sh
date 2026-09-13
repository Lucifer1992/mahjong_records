#!/usr/bin/env bash
# ============================================
# 麻将记录小程序 后端 API 烟雾测试
#
# 用法（在部署主机上跑）：
#   bash scripts/api-smoke-test.sh                         # 默认 localhost:3456
#   BASE_URL=https://api.xxx.com bash scripts/api-smoke-test.sh
#   TOKEN=<jwt> BASE_URL=https://api.xxx.com bash scripts/api-smoke-test.sh
#
# 退出码：0 = 全部通过；非 0 = 有失败项
# ============================================

set -u

BASE_URL="${BASE_URL:-http://127.0.0.1:3456}"
TOKEN="${TOKEN:-}"
LOGIN_CODE="${LOGIN_CODE:-smoke-test-$(date +%s)}"

# ----- 颜色 -----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[FAIL]${NC} $1"; }
ok()    { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); }
skip()  { echo -e "${YELLOW}[SKIP]${NC} $1"; SKIP=$((SKIP+1)); }

# ----- 单次请求 -----
# 用法: req METHOD PATH [DATA] [AUTH_HEADER]
# 输出三行：HTTP_CODE / TIME / BODY
req() {
  local method="$1" path="$2" data="${3:-}" auth="${4:-}"
  local url="${BASE_URL}${path}"
  local args=(-s -m 10 -w "\n%{http_code}|%{time_total}" -X "$method" -H "Content-Type: application/json")
  [[ -n "$auth" ]] && args+=(-H "Authorization: Bearer $auth")
  [[ -n "$data" ]] && args+=(-d "$data")
  curl "${args[@]}" "$url"
}

# 校验：期望 HTTP 码 + JSON 中 code 字段
check() {
  local name="$1" expect_code="$2" expect_data_code="$3" raw="$4"
  local meta body code time
  meta=$(echo "$raw" | tail -1)
  body=$(echo "$raw" | sed '$d')
  code=$(echo "$meta" | cut -d'|' -f1)
  time=$(echo "$meta" | cut -d'|' -f2)
  local data_code
  data_code=$(echo "$body" | grep -oE '"code"\s*:\s*[-0-9]+' | head -1 | grep -oE '[-0-9]+$')

  if [[ "$code" != "$expect_code" ]]; then
    err "$name → HTTP $code (期望 $expect_code), ${time}s"
    echo "    body: $body"
    FAIL=$((FAIL+1))
    return 1
  fi
  if [[ -n "$expect_data_code" && "$data_code" != "$expect_data_code" ]]; then
    err "$name → data.code=$data_code (期望 $expect_data_code), ${time}s"
    echo "    body: $body"
    FAIL=$((FAIL+1))
    return 1
  fi
  ok "$name → HTTP $code, data.code=${data_code:-N/A}, ${time}s"
  echo "$body"
  return 0
}

echo -e "${BLUE}===== 麻将记录小程序 API 烟雾测试 =====${NC}"
info "BASE_URL = $BASE_URL"
info "TOKEN    = ${TOKEN:+<已提供>}${TOKEN:-<未提供，将尝试 wx-login>}"
info "时间     : $(date '+%Y-%m-%d %H:%M:%S')"
echo

# ---------- 1. 健康检查 ----------
echo -e "${BLUE}▶ 健康检查${NC}"
raw=$(req GET /api/health)
check "GET /api/health" 200 0 "$raw" >/dev/null || true

# ---------- 2. 鉴权探测 ----------
echo
echo -e "${BLUE}▶ 鉴权中间件探测${NC}"
raw=$(req GET /api/players)
check "GET /api/players (无 token 应 401)" 401 UNAUTHORIZED "$raw" >/dev/null || true

raw=$(req GET /api/players "" "garbage.token.xxx")
check "GET /api/players (无效 token 应 401)" 401 INVALID_TOKEN "$raw" >/dev/null || true

# ---------- 3. 登录拿 token ----------
echo
echo -e "${BLUE}▶ 登录拿 token${NC}"
if [[ -n "$TOKEN" ]]; then
  info "已通过环境变量提供 TOKEN，跳过 wx-login"
else
  info "尝试 wx-login (code=$LOGIN_CODE)..."
  login_payload=$(printf '{"code":"%s","nickname":"冒烟测试","avatar":""}' "$LOGIN_CODE")
  raw=$(req POST /api/auth/wx-login "$login_payload")
  login_body=$(check "POST /api/auth/wx-login" 200 0 "$raw" || true)

  # 从 body 里抠 token
  TOKEN=$(echo "$login_body" | grep -oE '"token"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  if [[ -z "$TOKEN" ]]; then
    warn "wx-login 未返回 token（prod 模式 + 未配 WX_APPID 时必然如此）"
    warn "解决："
    warn "  1) 临时切 dev：pm2 delete mahjong-records && pm2 start ecosystem.config.cjs --env dev"
    warn "  2) 配 WX_APPID / WX_SECRET 后重启"
    warn "  3) 跳过鉴权测试，单独验证 health 即可"
  fi
fi

if [[ -z "$TOKEN" ]]; then
  echo
  warn "未拿到 TOKEN，鉴权类 API 全部跳过"
  echo
  echo -e "${BLUE}===== 汇总 =====${NC}"
  echo -e "${GREEN}通过${NC}: $PASS    ${RED}失败${NC}: $FAIL    ${YELLOW}跳过${NC}: $SKIP"
  exit 0
fi

# ---------- 4. 业务 API（需鉴权）----------
echo
echo -e "${BLUE}▶ 业务 API（需鉴权）${NC}"

# 4.1 玩家 CRUD
echo
info "--- 玩家 ---"
raw=$(req GET /api/players "" "$TOKEN")
check "GET /api/players" 200 0 "$raw" >/dev/null || true

nick="smoke_$(date +%s | tail -c 5)"
raw=$(req POST /api/players "$(printf '{"nickname":"%s","color":"#ff6b6b"}' "$nick")" "$TOKEN")
player_body=$(check "POST /api/players" 200 0 "$raw" || true)
PLAYER_ID=$(echo "$player_body" | grep -oE '"id"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
info "新建玩家: $nick → $PLAYER_ID"

if [[ -n "$PLAYER_ID" ]]; then
  raw=$(req GET "/api/players/$PLAYER_ID" "" "$TOKEN")
  check "GET /api/players/:id" 200 0 "$raw" >/dev/null || true
fi

# 4.2 战绩 CRUD（必须分数之和=0）
echo
info "--- 战绩 ---"
raw=$(req GET /api/records "" "$TOKEN")
check "GET /api/records" 200 0 "$raw" >/dev/null || true

# 准备 4 人战绩，分数 [+12, -4, -4, -4]
NOW_MS=$(date +%s)000
RECORD_PAYLOAD=$(cat <<EOF
{
  "playedAt": $NOW_MS,
  "ruleType": "sichuan",
  "ruleName": "血战到底",
  "duration": "afternoon",
  "totalFee": 0,
  "note": "smoke test",
  "mood": "smooth",
  "players": [
    {"nickname":"$nick","score":12},
    {"nickname":"guest_a","score":-4},
    {"nickname":"guest_b","score":-4},
    {"nickname":"guest_c","score":-4}
  ]
}
EOF
)
raw=$(req POST /api/records "$RECORD_PAYLOAD" "$TOKEN")
record_body=$(check "POST /api/records" 200 0 "$raw" || true)
RECORD_ID=$(echo "$record_body" | grep -oE '"id"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
info "新建战绩: $RECORD_ID"

if [[ -n "$RECORD_ID" ]]; then
  raw=$(req GET "/api/records/$RECORD_ID" "" "$TOKEN")
  check "GET /api/records/:id" 200 0 "$raw" >/dev/null || true
fi

# 4.3 批量同步（幂等：同 id 重复提交应不报错）
echo
info "--- 批量同步 ---"
BATCH_PAYLOAD=$(cat <<EOF
{"records":[
  {"id":"smoke-batch-1","playedAt":$NOW_MS,"ruleType":"guobiao","ruleName":"国标","duration":"evening","players":[{"nickname":"$nick","score":8},{"nickname":"x1","score":-8}]},
  {"id":"smoke-batch-1","playedAt":$NOW_MS,"ruleType":"guobiao","ruleName":"国标","duration":"evening","players":[{"nickname":"$nick","score":8},{"nickname":"x1","score":-8}]}
]}
EOF
)
raw=$(req POST /api/records/batch "$BATCH_PAYLOAD" "$TOKEN")
check "POST /api/records/batch (幂等去重)" 200 0 "$raw" >/dev/null || true

# 4.4 校验：分数不平衡应 400
echo
info "--- 校验 ---"
BAD_PAYLOAD=$(cat <<EOF
{"playedAt":$NOW_MS,"ruleType":"sichuan","ruleName":"x","duration":"afternoon","players":[{"nickname":"$nick","score":10},{"nickname":"y","score":5}]}
EOF
)
raw=$(req POST /api/records "$BAD_PAYLOAD" "$TOKEN")
check "POST /api/records (分数不平→400)" 400 SCORE_NOT_BALANCED "$raw" >/dev/null || true

# 4.5 统计
echo
info "--- 统计 ---"
raw=$(req GET "/api/stats/summary?nickname=$nick" "" "$TOKEN")
check "GET /api/stats/summary" 200 0 "$raw" >/dev/null || true

if [[ -n "$PLAYER_ID" ]]; then
  raw=$(req GET "/api/stats/fortune?playerId=$PLAYER_ID&topN=5" "" "$TOKEN")
  check "GET /api/stats/fortune" 200 0 "$raw" >/dev/null || true
fi

Y=$(date +%Y)
M=$(date +%-m)
raw=$(req GET "/api/stats/calendar?year=$Y&month=$M" "" "$TOKEN")
check "GET /api/stats/calendar" 200 0 "$raw" >/dev/null || true

# ---------- 5. 清理 ----------
echo
echo -e "${BLUE}▶ 清理测试数据${NC}"
if [[ -n "$RECORD_ID" ]]; then
  raw=$(req DELETE "/api/records/$RECORD_ID" "" "$TOKEN")
  check "DELETE /api/records/:id" 200 0 "$raw" >/dev/null || true
fi
if [[ -n "$PLAYER_ID" ]]; then
  raw=$(req DELETE "/api/players/$PLAYER_ID" "" "$TOKEN")
  check "DELETE /api/players/:id" 200 0 "$raw" >/dev/null || true
fi

# ---------- 汇总 ----------
echo
echo -e "${BLUE}===== 汇总 =====${NC}"
echo -e "${GREEN}通过${NC}: $PASS    ${RED}失败${NC}: $FAIL    ${YELLOW}跳过${NC}: $SKIP"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
