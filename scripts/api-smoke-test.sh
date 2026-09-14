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
# 1 = token 由使用者提供（跑真实账号），此时禁止执行会动数据的破坏性用例
TOKEN_FROM_ENV=0

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
# PASS/FAIL 走 stderr，避免 check ... >/dev/null 吞掉标签
err()   { echo -e "${RED}[FAIL]${NC} $1" >&2; }
ok()    { echo -e "${GREEN}[PASS]${NC} $1" >&2; PASS=$((PASS+1)); }
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
  data_code=$(echo "$body" | grep -oE '"code"[[:space:]]*:[[:space:]]*("[^"]*"|[-0-9]+)' | head -1 | sed -E 's/"code"[[:space:]]*:[[:space:]]*//' | tr -d '"')

  if [[ "$code" != "$expect_code" ]]; then
    err "$name → HTTP $code (期望 $expect_code), ${time}s"
    echo "    body: $body" >&2
    FAIL=$((FAIL+1))
    return 1
  fi
  if [[ -n "$expect_data_code" && "$data_code" != "$expect_data_code" ]]; then
    err "$name → data.code=$data_code (期望 $expect_data_code), ${time}s"
    echo "    body: $body" >&2
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
health_body=$(check "GET /api/health" 200 0 "$raw" >/dev/null || true)
ENV_NAME=$(echo "$health_body" | grep -oE '"env"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"env"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
info "服务环境 env = ${ENV_NAME:-unknown}"

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
  TOKEN_FROM_ENV=1
  info "已通过环境变量提供 TOKEN，跳过 wx-login"
else
  TOKEN_FROM_ENV=0
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

# 4.6 用户等级 / 免费云端窗口
echo
info "--- 用户等级 / 免费云端窗口 ---"

raw=$(req GET /api/users/me "" "$TOKEN")
me_body=$(check "GET /api/users/me" 200 0 "$raw" || true)
MY_TIER=$(echo "$me_body" | grep -oE '"tier"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"tier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
info "当前等级 tier = ${MY_TIER:-unknown}"

raw=$(req POST /api/users/redeem '{"code":"__definitely_not_a_real_code__"}' "$TOKEN")
check "POST /api/users/redeem (无效码→400)" 400 REDEEM_FAILED "$raw" >/dev/null || true

# 免费窗口修剪：造 4 个不同日期的战绩，云端应只剩最新 3 个日期
# ⚠️ 破坏性用例：会新增/淘汰记录，因此仅在「自己 wx-login 出来的临时账号」上跑。
#    若 TOKEN 是使用者给的（可能是真实账号），直接跳过。
WIN_IDS=()
if [[ "$TOKEN_FROM_ENV" -eq 1 ]]; then
  skip "免费窗口修剪（TOKEN 由外部提供，跳过破坏性用例）"
elif [[ "$MY_TIER" != "free" ]]; then
  skip "免费窗口修剪（当前非免费用户，跳过）"
else
  WIN_NOW=$(date +%s)
  DAY=86400
  WIN_PAYLOAD=$(cat <<EOF
{"records":[
  {"id":"smoke-win-d1","playedAt":$(( (WIN_NOW - 3*DAY) * 1000 )),"ruleType":"guobiao","ruleName":"国标","duration":"evening","players":[{"nickname":"$nick","score":5},{"nickname":"wf","score":-5}]},
  {"id":"smoke-win-d2","playedAt":$(( (WIN_NOW - 2*DAY) * 1000 )),"ruleType":"guobiao","ruleName":"国标","duration":"evening","players":[{"nickname":"$nick","score":5},{"nickname":"wf","score":-5}]},
  {"id":"smoke-win-d3","playedAt":$(( (WIN_NOW - 1*DAY) * 1000 )),"ruleType":"guobiao","ruleName":"国标","duration":"evening","players":[{"nickname":"$nick","score":5},{"nickname":"wf","score":-5}]},
  {"id":"smoke-win-d4","playedAt":$(( WIN_NOW * 1000 )),"ruleType":"guobiao","ruleName":"国标","duration":"evening","players":[{"nickname":"$nick","score":5},{"nickname":"wf","score":-5}]}
]}
EOF
)
  WIN_IDS=(smoke-win-d2 smoke-win-d3 smoke-win-d4)
  raw=$(req POST /api/records/batch "$WIN_PAYLOAD" "$TOKEN")
  win_body=$(check "POST /api/records/batch (4 个不同日期)" 200 0 "$raw" || true)
  TRIMMED=$(echo "$win_body" | grep -oE '"trimmed"\s*:\s*[0-9]+' | head -1 | sed 's/.*:[[:space:]]*//')

  if [[ "$TRIMMED" == "1" ]]; then
    ok "免费窗口修剪 → 淘汰最旧那天 1 条 (trimmed=1)"
  else
    err "免费窗口修剪 → 期望 trimmed=1，实际 ${TRIMMED:-N/A}"
    FAIL=$((FAIL+1))
  fi

  # 被淘汰的那条必须真的查不到了
  raw=$(req GET "/api/records/smoke-win-d1" "" "$TOKEN")
  check "GET 被淘汰记录 (应 404)" 404 NOT_FOUND "$raw" >/dev/null || true
fi

# dev 环境下验收「兑换码 → Pro」闭环（跑完这个账号就变 pro 了，故放最后）
if [[ "$TOKEN_FROM_ENV" -eq 0 && "$ENV_NAME" == "development" && "$MY_TIER" == "free" ]]; then
  raw=$(req POST /api/users/redeem '{"code":"DEV-PRO"}' "$TOKEN")
  check "POST /api/users/redeem (dev 万能码)" 200 0 "$raw" >/dev/null || true

  raw=$(req GET /api/users/me "" "$TOKEN")
  pro_body=$(check "GET /api/users/me (升级后)" 200 0 "$raw" || true)
  NOW_TIER=$(echo "$pro_body" | grep -oE '"tier"\s*:\s*"[^"]+"' | head -1 | sed 's/.*"tier"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  if [[ "$NOW_TIER" == "pro" ]]; then
    ok "兑换码升级 → tier=pro"
  else
    err "兑换码升级 → 期望 tier=pro，实际 ${NOW_TIER:-N/A}"
    FAIL=$((FAIL+1))
  fi
else
  skip "兑换码升级（非 dev 环境 或 使用了外部 TOKEN）"
fi

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

# 免费窗口用例留下的记录
if [[ ${#WIN_IDS[@]} -gt 0 ]]; then
  for wid in "${WIN_IDS[@]}"; do
    req DELETE "/api/records/$wid" "" "$TOKEN" >/dev/null 2>&1 || true
  done
  info "已清理免费窗口用例的 ${#WIN_IDS[@]} 条记录"
fi

# ---------- 汇总 ----------
echo
echo -e "${BLUE}===== 汇总 =====${NC}"
echo -e "${GREEN}通过${NC}: $PASS    ${RED}失败${NC}: $FAIL    ${YELLOW}跳过${NC}: $SKIP"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
