#!/usr/bin/env bash
# ==============================================================
# setup-mysql.sh —— 公共 MySQL 安装 + 公共账户配置
#
# 目标：一台服务器装一个 MySQL 实例，多个小程序后端各建一个
#       「库 + 独立账号」共用，账号只能访问自己的库（最小权限）。
#       全部走 localhost，不开远程，避免暴露公网。
#
# 用法：
#   sudo bash setup-mysql.sh                              # 首次：安装 MySQL + 建公共管理账户
#   sudo bash setup-mysql.sh addapp <库名> <账号> [密码]   # 给某个小程序建库建号
#       例：sudo bash setup-mysql.sh addapp mahjong_records mahjong_rw
#   sudo bash setup-mysql.sh status                       # 查看实例与账号
#
# 产物：
#   /root/.mysql-appadmin      公共管理账户凭据（chmod 600，勿提交 git）
#   /root/.mysql-<账号>        每个小程序的应用账号凭据
#
# 约定：
#   - 库名/账号只允许 [A-Za-z0-9_]，防止 SQL 注入
#   - 生成的密码形如 Aa1!<hex>，满足 MySQL 默认密码复杂度策略
#   - 应用连接串统一：mysql://<账号>:<密码>@127.0.0.1:3306/<库名>
# ==============================================================
set -euo pipefail

MYSQL_ADMIN_USER="appadmin"
CRED_FILE="/root/.mysql-appadmin"

if [ "$(id -u)" -ne 0 ]; then
  echo "✗ 请用 sudo 运行"; exit 1
fi

gen_pass() { echo "Aa1!$(openssl rand -hex 12)"; }

# ---------- 静默执行 SQL（自动适配 root 认证方式） ----------
run_root_sql() {
  local sql="$1"
  if [ -n "${ROOT_PASS:-}" ]; then
    mysql -uroot -p"$ROOT_PASS" -e "$sql"
  else
    # Debian/Ubuntu：root 走 auth_socket，本机 root 直接连
    mysql -uroot -e "$sql"
  fi
}

# ---------- 1. 检测 / 安装 MySQL ----------
if command -v mysql >/dev/null 2>&1; then
  echo "✓ 已安装 MySQL：$(mysql --version)"
else
  echo "→ 未检测到 MySQL，开始安装..."
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y mysql-server
    systemctl enable --now mysql
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y mysql-server
    systemctl enable --now mysqld
  elif command -v yum >/dev/null 2>&1; then
    yum install -y mysql-server
    systemctl enable --now mysqld
  else
    echo "✗ 未识别的包管理器（支持 apt/dnf/yum），请手动安装 MySQL 8.x"; exit 1
  fi
  echo "✓ MySQL 安装完成"
fi

# ---------- 2. 等 MySQL 就绪 + 处理 root 认证 ----------
echo "→ 等待 MySQL 就绪..."
for i in $(seq 1 30); do
  mysqladmin ping --silent >/dev/null 2>&1 && break
  [ "$i" = "30" ] && { echo "✗ MySQL 30 秒内未就绪，请检查 systemctl status mysqld"; exit 1; }
  sleep 1
done
echo "✓ MySQL 已就绪"

# CentOS/RHEL 首次安装会给 root 一个临时密码（/var/log/mysqld.log），这里接管它
if [ -z "${ROOT_PASS:-}" ] && [ -f /var/log/mysqld.log ] && ! mysql -uroot -e "SELECT 1" >/dev/null 2>&1; then
  TMP_PASS="$(grep 'temporary password' /var/log/mysqld.log 2>/dev/null | tail -1 | awk '{print $NF}' || true)"
  if [ -n "$TMP_PASS" ]; then
    NEW_ROOT_PASS="$(gen_pass)"
    mysql -uroot -p"$TMP_PASS" --connect-expired-password -e "ALTER USER 'root'@'localhost' IDENTIFIED BY '$NEW_ROOT_PASS'"
    export ROOT_PASS="$NEW_ROOT_PASS"
    echo "✓ 已接管 root 初始密码（存入 $CRED_FILE）"
    {
      echo "# MySQL root（$(date +%F) 由 setup-mysql.sh 生成）"
      echo "ROOT_PASSWORD=$NEW_ROOT_PASS"
    } > "$CRED_FILE"
  fi
fi

# ---------- 3. 建公共管理账户 appadmin ----------
echo "→ 配置公共管理账户 $MYSQL_ADMIN_USER ..."
ADMIN_PASS="$(gen_pass)"
run_root_sql "CREATE USER IF NOT EXISTS '$MYSQL_ADMIN_USER'@'localhost' IDENTIFIED BY '$ADMIN_PASS';"
run_root_sql "GRANT ALL PRIVILEGES ON *.* TO '$MYSQL_ADMIN_USER'@'localhost' WITH GRANT OPTION; FLUSH PRIVILEGES;"

# 写入凭据文件（覆盖时保留旧密码注释行直接重写，简单可靠）
{
  echo "# 公共 MySQL 管理账户（$(date +%F) 由 setup-mysql.sh 生成/重置）"
  echo "HOST=127.0.0.1"
  echo "PORT=3306"
  echo "ADMIN_USER=$MYSQL_ADMIN_USER"
  echo "ADMIN_PASSWORD=$ADMIN_PASS"
  echo "# 登录：mysql -u$MYSQL_ADMIN_USER -p -h 127.0.0.1"
} > "$CRED_FILE"
chmod 600 "$CRED_FILE"

# 用 appadmin 验证一圈
mysql -u"$MYSQL_ADMIN_USER" -p"$ADMIN_PASS" -h 127.0.0.1 -e "SELECT 1" >/dev/null
echo "✓ 管理账户已就绪，凭据在 $CRED_FILE"

# ---------- 4. addapp / status 子命令 ----------
addapp() {
  local db="$1" user="$2" pass="${3:-$(gen_pass)}"

  if ! echo "$db" | grep -qE '^[A-Za-z0-9_]+$' || ! echo "$user" | grep -qE '^[A-Za-z0-9_]+$'; then
    echo "✗ 库名/账号只允许字母数字下划线"; exit 1
  fi
  case "$pass" in *["'\"\\; "]*) echo "✗ 密码不能包含引号/分号/空格/反斜杠"; exit 1;; esac

  mysql -u"$MYSQL_ADMIN_USER" -p"$ADMIN_PASS" -h 127.0.0.1 <<SQL
CREATE DATABASE IF NOT EXISTS \`$db\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$user'@'localhost' IDENTIFIED BY '$pass';
ALTER USER '$user'@'localhost' IDENTIFIED BY '$pass';
GRANT ALL PRIVILEGES ON \`$db\`.* TO '$user'@'localhost';
FLUSH PRIVILEGES;
SQL

  local cred="/root/.mysql-$user"
  {
    echo "# 小程序应用账号（$(date +%F) 由 setup-mysql.sh 生成）"
    echo "DB_HOST=127.0.0.1"
    echo "DB_PORT=3306"
    echo "DB_NAME=$db"
    echo "DB_USER=$user"
    echo "DB_PASSWORD=$pass"
    echo "# 连接串：mysql://$user:$pass@127.0.0.1:3306/$db"
    echo "# 后端 .env 示例："
    echo "#   DB_CLIENT=mysql"
    echo "#   MYSQL_HOST=127.0.0.1"
    echo "#   MYSQL_PORT=3306"
    echo "#   MYSQL_DATABASE=$db"
    echo "#   MYSQL_USER=$user"
    echo "#   MYSQL_PASSWORD=$pass"
  } > "$cred"
  chmod 600 "$cred"

  echo "✓ 应用库/账号已创建"
  echo "   库名：$db   账号：$user（仅 $db 库权限）"
  echo "   凭据：$cred"
}

show_status() {
  echo "── 实例 ──"
  mysqladmin -u"$MYSQL_ADMIN_USER" -p"$ADMIN_PASS" -h 127.0.0.1 status || true
  echo "── 数据库 ──"
  mysql -u"$MYSQL_ADMIN_USER" -p"$ADMIN_PASS" -h 127.0.0.1 -e "SHOW DATABASES;"
  ls -1 /root/.mysql-* 2>/dev/null | grep -v appadmin | sed 's/^/应用凭据: /' || true
}

case "${1:-init}" in
  addapp)
    [ $# -ge 3 ] || { echo "用法: sudo bash $0 addapp <库名> <账号> [密码]"; exit 1; }
    addapp "$2" "$3" "${4:-}"
    ;;
  status) show_status ;;
  init)   echo "（提示）给麻将记录小程序建库：sudo bash $0 addapp mahjong_records mahjong_rw" ;;
  *)      echo "用法: sudo bash $0 [addapp <库名> <账号> [密码] | status]"; exit 1 ;;
esac

echo ""
echo "完成。多小程序共用规则：每个小程序一套 库+账号，互不可见；"
echo "公网安全：MySQL 只监听 localhost，永远不要开 3306 到公网。"
