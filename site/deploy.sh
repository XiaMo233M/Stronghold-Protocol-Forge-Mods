#!/usr/bin/env bash
# 把工坊包上传站（site/）装到这台服务器上。
#
# **设计前提：这台机器上已经有一个 update 项目在跑（gunicorn + nginx），绝不能干扰它。**
# 所以这个脚本遵守四条铁律：
#   1. **完全不碰 nginx** —— 不读不写 /etc/nginx、不 reload、不 restart。站点走**独立端口**。
#   2. **完全不碰别人的进程与单元** —— 不 stop/restart 任何已有服务，不 daemon-reload 之外的动作，
#      自己的单元名唯一（sp-modsite.service）。
#   3. **不装任何系统包** —— 需要 Node 时把官方二进制下到自己的安装目录里用，不动 apt/yum，
#      不动系统 PATH 里的 node。
#   4. **不做不可逆的事** —— 端口被占、目录已有别的东西、Node 版本不够，一律**停下报错**而不是硬来。
#
# 用法（在服务器上，用 root 或 sudo）：
#   bash deploy.sh --port 25570 --base-url http://47.103.14.217:25570 \
#                  --admin-ips <你的固定IP>            # 强烈建议给管理口加白名单
#
#   bash deploy.sh --uninstall                         # 只卸自己，绝不动别的
#
# 其它选项：--dir /opt/sp-modsite --data /var/lib/sp-modsite --node-version v22.11.0
set -Eeuo pipefail

PORT=25570
BASE_URL=""
DIR=/opt/sp-modsite
DATA=/var/lib/sp-modsite
ADMIN_IPS=""
NODE_VERSION="v22.11.0"
ADMIN_PATH_OPT=""
SERVICE=sp-modsite
USER_NAME=spmodsite
ENV_FILE=/etc/sp-modsite.env
UNIT=/etc/systemd/system/${SERVICE}.service
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2;;
    --base-url) BASE_URL="$2"; shift 2;;
    --dir) DIR="$2"; shift 2;;
    --data) DATA="$2"; shift 2;;
    --admin-ips) ADMIN_IPS="$2"; shift 2;;
    --admin-path) ADMIN_PATH_OPT="$2"; shift 2;;
    --node-version) NODE_VERSION="$2"; shift 2;;
    --uninstall) UNINSTALL=1; shift;;
    -h|--help)
      cat <<'USAGE'
把工坊包上传站装到这台服务器上（绝不干扰已有的 nginx / gunicorn 项目）。

用法：
  sudo bash deploy.sh --port 25570 --base-url http://<IP>:25570 [--admin-ips <你的固定IP>]
  sudo bash deploy.sh --uninstall

选项：
  --port N           监听端口（默认 25570，与线上生产实例一致）——必须是空闲端口，被占就报错退出
  --base-url URL     公开地址（默认 http://<本机IP>:<port>），回执链接用它拼
  --admin-ips LIST   管理口白名单，逗号分隔（强烈建议；本机回环始终放行，SSH 隧道靠它）
  --admin-path NAME  审核入口的路径名（默认 admin）。换成猜不到的名字可少掉自动扫描；
                     **它只是减少噪音，不是安全屏障** —— 真正拦住人的是白名单 + 令牌
  --dir PATH         安装目录（默认 /opt/sp-modsite）
  --data PATH        数据目录（默认 /var/lib/sp-modsite）
  --node-version V   系统 Node <18 时下到自己目录的版本（默认 v22.11.0）
  --uninstall        只卸载本服务（nginx、别人的服务、数据目录都不动）
  -h, --help         这一段

它保证不做的事：不碰 /etc/nginx、不 reload/restart nginx、不 stop/restart 任何已有服务、
不装系统包、不改防火墙。需要 Node 时下进自己的安装目录用。
USAGE
      exit 0;;
    *) echo "不认识的选项：$1（--help 看用法）"; exit 2;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# 取脚本所在目录：不依赖 dirname（极端精简的环境里没有 coreutils 时也能给出个值）
_SELF="${BASH_SOURCE[0]:-$0}"
SELF_DIR="$(cd -- "$(dirname -- "$_SELF")" 2>/dev/null && pwd)" || SELF_DIR="$(pwd)"

# ---------------------------------------------------------------- 卸载
if [ "$UNINSTALL" = 1 ]; then
  say "卸载 $SERVICE（只动自己的东西）"
  if systemctl disable --now "$SERVICE" 2>/dev/null; then ok "已停止并禁用 $SERVICE"; else warn "$SERVICE 本来就没在跑"; fi
  if [ -f "$UNIT" ]; then rm -f "$UNIT"; ok "已删除 $UNIT"; fi
  systemctl daemon-reload && ok "daemon-reload"
  if [ -f "$ENV_FILE" ]; then rm -f "$ENV_FILE"; ok "已删除 $ENV_FILE（令牌也在里面，已一并删掉）"; fi
  if [ -d "$DIR" ]; then rm -rf "$DIR"; ok "已删除 $DIR"; fi
  echo
  warn "数据目录 $DATA **保留**（投稿与决定都在里面）。确实不要了就自己删：rm -rf $DATA"
  warn "用户 $USER_NAME 也保留着。确实不要了就：userdel $USER_NAME"
  echo
  ok "nginx 一个字都没碰；update 项目不受影响。"
  exit 0
fi

# ---------------------------------------------------------------- 0. 先看清现状（只读）
[ "$(id -u)" = 0 ] || die "要用 root 跑（sudo bash deploy.sh …）"

say "0. 改动之前的现状（只读，不改任何东西）"
echo "   监听中的端口："
if command -v ss >/dev/null 2>&1; then
  { ss -lntp 2>/dev/null || true; } | sed 's/^/     /' | head -20 || true
else
  { netstat -lntp 2>/dev/null || true; } | sed 's/^/     /' | head -20 || true
fi
echo "   相关服务状态："
for u in nginx gunicorn; do
  printf '     %-10s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || echo '（没有这个单元）')"
done
echo "   gunicorn 进程："
{ pgrep -af gunicorn 2>/dev/null || true; } | sed 's/^/     /' | head -10 || true
echo "   —— 上面这些是本脚本结束后要逐条核对「没变」的基线。"

# ---------------------------------------------------------------- 1. 端口必须是空的
say "1. 检查端口 $PORT 是否空闲"
if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}$"; then
  die "端口 $PORT 已经被占用（很可能是别的项目）。换一个 --port，**不要**去停别人的服务。"
fi
ok "端口 $PORT 空着"

# ---------------------------------------------------------------- 2. 安装目录必须干净
say "2. 检查安装目录 $DIR"
if [ -e "$DIR" ] && [ ! -f "$DIR/.sp-modsite" ]; then
  die "$DIR 已存在且不是本服务的目录。换个 --dir，别覆盖别人的东西。"
fi
ok "$DIR 可以用（或本来就是本服务的）"

# ---------------------------------------------------------------- 3. 源码就位
say "3. 放代码（从 $SELF_DIR 复制）"
mkdir -p "$DIR"
for f in server.mjs zip.mjs review.mjs; do cp "$SELF_DIR/$f" "$DIR/$f"; done
mkdir -p "$DIR/pages"
cp "$SELF_DIR"/pages/*.html "$DIR/pages/"
# 样式表也要一起搬：server.mjs 的 `GET /theme.css` 读的就是 pages/theme.css（site/server.mjs:858）。
# 漏了它，照本脚本重新部署出来的站就没有样式（页面里 __CSS__ 换出来的链接是 404）。
cp "$SELF_DIR"/pages/*.css "$DIR/pages/"
# 四个自测也一起搬：site/README.md「改完必跑」的就是它们（在 $DIR 里 `node selftest*.mjs`）。
# 它们各自起一个实例、数据目录指向自己造的临时目录（不碰 $DATA），只读同目录的
# server.mjs / zip.mjs / pages/，所以必须和 server.mjs 放在同一层 —— 也就是上面这几步先做完。
for f in selftest.mjs selftest-admin.mjs selftest-compat.mjs selftest-publisher.mjs; do cp "$SELF_DIR/$f" "$DIR/$f"; done
cp "$SELF_DIR/README.md" "$DIR/site-README.md" 2>/dev/null || true
touch "$DIR/.sp-modsite"
ok "代码在 $DIR（server.mjs / zip.mjs / review.mjs / pages/ / 四个 selftest*.mjs）"

# ---------------------------------------------------------------- 4. Node：优先用系统的，不够就把官方二进制下进自己目录
say "4. 准备 Node（不装系统包）"
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  CUR="$(node -v)"
  MAJ="$(echo "$CUR" | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$MAJ" -ge 18 ]; then NODE_BIN="$(command -v node)"; ok "用系统已有的 node $CUR（$NODE_BIN）"
  else warn "系统 node 是 $CUR（<18），不用它"; fi
fi
if [ -z "$NODE_BIN" ]; then
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) NARCH=x64;; aarch64|arm64) NARCH=arm64;; *) die "不认识的架构 $ARCH";; esac
  TARBALL="node-${NODE_VERSION}-linux-${NARCH}.tar.xz"
  URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"
  mkdir -p "$DIR/runtime"
  if [ ! -x "$DIR/runtime/node/bin/node" ]; then
    warn "把官方 Node 下到 $DIR/runtime（不动系统）"
    echo "     来源：$URL"
    if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 -o "$DIR/runtime/$TARBALL" "$URL" || die "下载失败：$URL（服务器能上外网吗？）"
    elif command -v wget >/dev/null 2>&1; then wget -O "$DIR/runtime/$TARBALL" "$URL" || die "下载失败：$URL（服务器能上外网吗？）"
    else die "既没有 curl 也没有 wget，没法下 Node。装一个，或自己装 Node≥18 后重跑。"; fi
    if tar -xJf "$DIR/runtime/$TARBALL" -C "$DIR/runtime"; then rm -f "$DIR/runtime/$TARBALL"
    else die "解压 $TARBALL 失败（缺 xz？）"; fi
    if [ -d "$DIR/runtime/node-${NODE_VERSION}-linux-${NARCH}" ]; then mv "$DIR/runtime/node-${NODE_VERSION}-linux-${NARCH}" "$DIR/runtime/node"; fi
  fi
  NODE_BIN="$DIR/runtime/node/bin/node"
  [ -x "$NODE_BIN" ] || die "Node 没准备好：$NODE_BIN 不可执行。服务器能上外网吗？或自己装 Node≥18。"
  ok "用自带的 $("$NODE_BIN" -v)（$NODE_BIN）—— 系统 PATH 里的 node 没被动过"
fi

# ---------------------------------------------------------------- 5. 专用用户 + 数据目录
say "5. 建专用用户与数据目录"
if id "$USER_NAME" >/dev/null 2>&1; then ok "用户 $USER_NAME 已存在"; else
  if useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"; then ok "建了系统用户 $USER_NAME（不给 shell）"
  else die "建用户失败（useradd）。手动建一个再重跑，或改 --user。"; fi
fi
mkdir -p "$DATA"; chown -R "$USER_NAME":"$USER_NAME" "$DATA"; chmod 750 "$DATA"
ok "数据目录 $DATA（属 $USER_NAME）"

# ---------------------------------------------------------------- 6. 令牌与环境文件
say "6. 生成管理令牌"
if [ -f "$ENV_FILE" ] && grep -q '^ADMIN_TOKEN=' "$ENV_FILE"; then
  TOKEN="$(grep '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
  ok "沿用 $ENV_FILE 里已有的令牌"
else
  TOKEN="$("$NODE_BIN" -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
  ok "新生成一枚令牌"
fi
if [ -z "$BASE_URL" ]; then
  BASE_URL="http://$( { hostname -I 2>/dev/null || true; } | awk '{print $1}' ):$PORT"
  [ "$BASE_URL" = "http://:$PORT" ] && BASE_URL="http://127.0.0.1:$PORT"
fi

# 审核路径名：命令行给了就用给的；没给就沿用环境文件里已有的；都没有才用 admin。
if [ -z "$ADMIN_PATH_OPT" ]; then
  if [ -f "$ENV_FILE" ] && grep -q '^ADMIN_PATH=' "$ENV_FILE"; then
    ADMIN_PATH_OPT="$(grep '^ADMIN_PATH=' "$ENV_FILE" | cut -d= -f2-)"
  fi
fi
[ -z "$ADMIN_PATH_OPT" ] && ADMIN_PATH_OPT=admin
case "$ADMIN_PATH_OPT" in
  *[!a-z0-9_-]*|'') die "ADMIN_PATH 只能用小写字母/数字/-/_：$ADMIN_PATH_OPT";;
esac
ok "审核入口路径：/$ADMIN_PATH_OPT"

cat > "$ENV_FILE" <<EOF
# 工坊包上传站（$SERVICE）—— 由 site/deploy.sh 生成
ADMIN_TOKEN=$TOKEN
PORT=$PORT
HOST=0.0.0.0
DATA_DIR=$DATA
BASE_URL=$BASE_URL
MAX_MB=100
# 审核入口的路径名。换成猜不到的能少掉自动扫描；**不是安全屏障**（那靠白名单+令牌）。
ADMIN_PATH=$ADMIN_PATH_OPT
# 管理口白名单：设了就只允许这些来源访问审核页与审核 API（本机回环始终放行）
ADMIN_IPS=$ADMIN_IPS
# 没有反代就别设 1（x-forwarded-for 可以伪造）
TRUST_PROXY=0
EOF
chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"
ok "$ENV_FILE 写好（chmod 600）"

# ---------------------------------------------------------------- 7. 自己的 systemd 单元
say "7. 装自己的 systemd 单元（名字唯一，不覆盖任何东西）"
if [ -f "$UNIT" ]; then warn "覆盖同名单元 $UNIT（它本来就是本服务的）"; fi
cat > "$UNIT" <<EOF
[Unit]
Description=Stronghold-Protocol-Forge mod upload site (standalone, own port)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $DIR/server.mjs
Restart=always
RestartSec=2
# 收紧一点权限；它只需要读自己的代码、写自己的数据目录
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
ok "写好 $UNIT"

systemctl daemon-reload
systemctl enable --now "$SERVICE" >/dev/null
sleep 1
if systemctl is-active --quiet "$SERVICE"; then ok "$SERVICE 已启动并在跑"
else
  echo; journalctl -u "$SERVICE" -n 30 --no-pager | sed 's/^/     /'
  die "$SERVICE 没起来（日志见上）"
fi

# ---------------------------------------------------------------- 8. 自测
say "8. 自测"
if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null; then ok "本机 /healthz 通（$PORT）"
else die "本机访问 $PORT 不通"; fi

# 「起来了」不等于「改对了」：真正的回归判据是 site/README.md「改完必跑」那四个自测。
# 脚本**不代跑**（每一个都自己起临时实例，四个串着跑要一会儿），只按本机实际路径把命令打出来。
# ⚠️ 四个必须**串行**：selftest-compat 与 selftest-publisher 同用 PORT 8807，同时跑会互相抢端口。
warn "改完请再跑四个自测（本脚本不代跑；⚠️ 必须串行）"
cat <<EOF
       cd $DIR
       $NODE_BIN selftest.mjs             # ① 公网投稿链（上传 → 下载 → 审核 → 上线）
       $NODE_BIN selftest-admin.mjs       # ② 审核台 / 公网列表跑不跑得起来
       $NODE_BIN selftest-compat.mjs      # ③ 兼容包整条链 + 反例
       $NODE_BIN selftest-publisher.mjs   # ④ 发布者自助 + 管理员确认 + 审计日志
       四个全绿才算改完。⚠️ 必须串行：compat 与 publisher 同用 PORT 8807。
       （$NODE_BIN 是本脚本刚选定的 Node：系统 Node ≥18 时就是它，
         否则是 $DIR/runtime/node/bin/node。）
EOF

if [ -n "$ADMIN_IPS" ]; then
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/admin/list")"
  [ "$CODE" = "401" ] && ok "管理口要令牌（无令牌得 401）" || warn "管理口无令牌返回 $CODE（预期 401）"
else
  warn "没设 --admin-ips：管理口只靠令牌保护，而这是 HTTP。强烈建议重跑时加上，或用 SSH 隧道。"
fi

# ---------------------------------------------------------------- 9. 收尾：明确说「什么没动」
say "9. 说清楚这一步**没有**动什么"
cat <<'EOF'
   ✓ 没有读写 /etc/nginx（一个字节都没碰）
   ✓ 没有 reload / restart nginx
   ✓ 没有 stop / restart 任何已存在的服务
   ✓ 没有装系统包（Node 是下到自己目录里用的）
   ✓ 没有改防火墙规则
   自己的东西只有：安装目录、数据目录、专用的系统用户、一个 sp-modsite.service、一个 /etc/sp-modsite.env
EOF

IP="$( { hostname -I 2>/dev/null || true; } | awk '{print $1}' )"
[ -z "$IP" ] && IP="<服务器IP>"
cat <<EOF

$(printf '\033[1m')下一步（都是你自己的决定，脚本不替你做）$(printf '\033[0m')

 1) 放开端口（脚本不动防火墙，这步要你确认）：
      ufw allow $PORT/tcp        # 用了 ufw 的话
    以及**云控制台的安全组**里放行 $PORT/tcp。

 2) 打开看看：  http://${IP}:$PORT/         公开列表：  http://${IP}:$PORT/mods
    **审核页**：   http://127.0.0.1:$PORT/${ADMIN_PATH_OPT}
                  注意是 **127.0.0.1**，不是公网 IP —— 管理口只认回环，走 IP 会 403。
                  所以要先开隧道（下面第 4 条），然后浏览器会弹登录框：
                  用户名 admin，密码是下面的令牌。

 3) 你的管理令牌（也写在 $ENV_FILE 里，chmod 600）：
      $TOKEN

 4) **强烈建议**：这台机器只有 HTTP（443 没开），令牌是明文过网的。两种更稳的用法：
      a. 给管理口加白名单后重启本服务：
           sudo sed -i 's|^ADMIN_IPS=.*|ADMIN_IPS=<你的固定IP>|' $ENV_FILE && sudo systemctl restart $SERVICE
      b. 或者干脆走 SSH 隧道访问审核页（回环地址永远放行，不占公网）：
           ssh -L $PORT:127.0.0.1:$PORT <user>@${IP}
         然后本机浏览器开 http://127.0.0.1:$PORT/${ADMIN_PATH_OPT}

 5) 想让它挂在 nginx 上（可选，且**不要**在本脚本里做）：见 site/README.md 的
    「挂到已有 nginx 上（可选，谨慎）」一节 —— 那里写了先 nginx -t 再 reload、以及回滚办法。

$(printf '\033[1m')核对「update 项目没受影响」$(printf '\033[0m')
     systemctl is-active nginx gunicorn
     pgrep -af gunicorn
     ss -lntp | grep -E ':(80|443)\b'
   与脚本开头打印的基线逐条比一下：应当一模一样。
EOF
