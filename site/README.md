# 上传站（`site/`）

给投稿的人一个**网页上传**的入口，替掉「提 PR」那套。整条链是：

```
投稿人在网页上填「mod 名 + 备注」并传 zip
        ↓  自动过一遍内容：疑似夹带官方素材的**照收不拒**，但存进 flagged/ 单独一处
        ├─ 普通     data/submissions/<编号>/
        └─ 疑似素材 data/flagged/<编号>/          ← 「疑似」不等于「确认」，所以不收也不删
        ↓
维护者（你）在 /admin 里下载下来跑测试、看包内容与自动挑出来的重点
        ↓  改好兼容、测试通过、名称与内容审过
点「通过」→ 它上线到 /mods。**疑似素材的会单独一组、明确标注**（上线前必须勾一次确认）
```

**零依赖**：只用 Node 内置模块，不需要 npm install、不需要数据库、不需要 zip 命令。

### 政策：疑似素材怎么处理

业主裁决：**疑似夹带官方素材的包仍然收**，因为「疑似」不等于「确认」，投稿人也未必知道原件里夹了什么。
但要做到两件事 ——

1. **单独存放**：落在 `data/flagged/`（普通投稿在 `data/submissions/`），便于整体处理或清空
2. **处处标注**：审核列表有「疑似素材」徽标；上线后公开页把它归到**独立的一组**，写明命中了什么特征，
   并提示「这些不是干净的工坊包，素材的版权与可用范围请自行判断」

上线这类包**必须勾一次确认**（服务端要 `acknowledge:true`，少了给 409）—— 可以放行，但不允许默默放过。

> **仓库的红线不变**：从上传站进 GitHub 仓库的 [`packs/`](../packs/README.md) 之前，**必须把素材清掉**。
> 上传站是收件的漏斗（宽进），仓库是发布物（严出）。

---

## 跑起来

```bash
# 本地试试
ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") node site/server.mjs
```

打开 `http://127.0.0.1:8787/`。**先把上面那串令牌抄下来** —— 审核页要它。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | **必填**（≥16 位） | 审核动作的凭据。没设就拒绝启动 |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | **默认只绑回环**（本机试跑不会意外暴露）。对外要显式设 `0.0.0.0` |
| `DATA_DIR` | `site/data` | 投稿与决定的存放处。**要备份的就是它** |
| `MAX_MB` | `100` | 单个 zip 的上限 |
| `BASE_URL` | `http://127.0.0.1:<PORT>` | 生成回执链接用；放到公网要写成真实地址 |
| `ADMIN_IPS` | 空 | 管理口白名单（逗号分隔）。**设了就只允许这些来源**访问审核页与审核 API，本机回环始终放行（SSH 隧道靠它） |
| `ADMIN_PATH` | `admin` | 审核入口的路径名（`/<ADMIN_PATH>` 与 `/api/<ADMIN_PATH>/*`）。换成猜不到的能少掉**自动扫描**；**它只是减少噪音，不是安全屏障** —— 真正拦住人的是 `ADMIN_IPS` + 令牌。改了之后旧名字会**彻底 404** |
| `TRUST_PROXY` | `0` | 设 `1` 才按 `x-forwarded-for` 判来源地址。**只有确实挂在反代后面时才设** —— 那个头谁都能伪造 |

自测（起一个临时实例把整条链走一遍，不碰你的数据）：

```bash
node site/selftest.mjs                                   # 自造合成包
node site/selftest.mjs --pack <某个真实.zip>              # 额外传一个真实包
```

---

## 放到服务器上

用现成的 [`deploy.sh`](deploy.sh)。**它按「这台机器上已经有别的项目在跑」来设计** ——
那个 gunicorn + nginx 的 update 项目**一个字节都不会被碰**：

| 脚本保证不做的事 | 怎么做到的 |
|---|---|
| 不读不写 `/etc/nginx`、不 reload/restart nginx | 站点走**自己的端口**，压根不需要 nginx |
| 不 stop/restart 任何已有服务 | 自己的单元名唯一（`sp-modsite.service`），只 `enable --now` 自己 |
| 不装系统包 | 需要 Node 就把官方二进制下进自己的安装目录用；**系统 PATH 里的 node 不动** |
| 不做不可逆的事 | 端口被占、目录里已有别的东西、Node 版本不够 → **停下报错**，不硬来 |
| 不改防火墙 | 放不放行端口由你决定，脚本只打印命令 |

### 粘这几行

```bash
# 在服务器上（root 或 sudo）
git clone https://github.com/XiaMo233M/Stronghold-Protocol-Forge-Mods.git
cd Stronghold-Protocol-Forge-Mods/site

sudo bash deploy.sh \
  --port 8787 \
  --base-url http://47.103.14.217:8787 \
  --admin-ips <你的固定IP>          # 强烈建议：管理口只对你开放
```

脚本会依次：打印**改动前的基线**（监听端口、nginx/gunicorn 状态、gunicorn 进程）→ 检查端口空不空 →
放代码 → 备好 Node → 建专用系统用户与数据目录 → 生成管理令牌 → 装自己的单元并启动 → 本机自测 →
打印「**没有**动什么」的清单与令牌 → 打印核对「update 项目没受影响」的命令。

**收尾时把下面三条与脚本开头的基线逐条比一遍**，应当一模一样：

```bash
systemctl is-active nginx gunicorn
pgrep -af gunicorn
ss -lntp | grep -E ':(80|443)\b'
```

卸载（只卸自己，数据目录保留并提示你自己删）：

```bash
sudo bash deploy.sh --uninstall
```

### 只有 HTTP，所以管理口要额外保护

这台机器 **443 没开**、也只给了 IP（没有域名，Let's Encrypt 签不了纯 IP），所以**没有 HTTPS**：
令牌会以明文过网。**审核入口默认只认回环**（`ADMIN_IPS=127.0.0.1`），走公网 IP 直接 403：

```bash
# 审核页必须走隧道（把本机的 25570 接到服务器的回环 25570）
ssh -L 8787:127.0.0.1:8787 <user>@<服务器>
# 然后浏览器开 http://127.0.0.1:8787/<ADMIN_PATH>
```

**审核登录用浏览器原生登录框**（HTTP Basic）：用户名 `admin`，密码就是 `ADMIN_TOKEN`。
浏览器会记住，不用每次翻服务器。
（这个认证卡在**审核页本身**上 —— 因为 `fetch()` 拿到 401 是不弹登录框的，只有顶层导航才弹。）

**想把审核路径换个名字**（少掉自动扫描）：

```bash
sudo sed -i 's|^ADMIN_PATH=.*|ADMIN_PATH=review-你随便起|' /etc/sp-modsite.env
sudo systemctl restart sp-modsite     # 改了之后旧名字立刻 404
```

> 换名字**不提高**实际安全性 —— 挡人的是白名单 + 令牌。它只让全网那些按字典扫 `/admin` 的
> 扫描器**注意不到这里**。别把它当唯一防线。

白名单**只认真实 socket 地址**，不认 `x-forwarded-for`（那个头谁都能伪造）——
除非你确实挂在反代后面并显式设了 `TRUST_PROXY=1`。

### 挂到已有 nginx 上（**可选，谨慎**）

不做也完全能用（直接访问 `http://47.103.14.217:8787`）。真要做，**必须**按这个顺序，
并且**只新增一个文件**、绝不改已有的 server 块：

```bash
# 1) 只新增一个 conf（用独立端口，与现有站点不冲突）
sudo tee /etc/nginx/conf.d/sp-modsite.conf >/dev/null <<'EOF'
server {
  listen 8080;
  server_name _;
  client_max_body_size 120m;                 # 要 ≥ MAX_MB
  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;      # 用 X-Real-IP，覆盖不可信的 XFF
  }
}
EOF

# 2) 先验配置 —— 不过就删掉这个文件，什么都别 reload
sudo nginx -t || { sudo rm -f /etc/nginx/conf.d/sp-modsite.conf; echo '配置没过，已删除，nginx 未重启'; }

# 3) 配置过了才 reload（reload 是平滑的：已有连接跑完，更新项目不中断）
sudo systemctl reload nginx

# 回滚
sudo rm -f /etc/nginx/conf.d/sp-modsite.conf && sudo systemctl reload nginx
```

走反代的话，把 `TRUST_PROXY=1` 加上、并把 `server.mjs` 的信赖头改成 `x-real-ip` 更稳
（当前实现读 `x-forwarded-for`）。**不改也能用**：那就把 `ADMIN_IPS` 留空、只靠令牌，
并接受「来源 IP 只能记到反代地址」这一点。

---

## 审核的时候做什么

`/admin` 里填令牌 → 载入列表 → 点一条：

1. **下载 zip**，拿去跑测试（`node tools/check-packs.mjs --engine <引擎目录>`；
   未兼容的原件按 [`../incoming/README.md`](../incoming/README.md) 的流程处理）
2. 看**自动挑出来的重点**。服务端会标三类：
   - `blocker`（**疑似官方素材**）：`.skel` / `.atlas` / `spine/op/` / `char/portrait/` /
     官方语音路径 / `.ab` / `gamedata/`；另外**可执行与脚本**、**路径穿越**也在这档。
     命中的包**会被收下并单独存放**（见上面的政策），上线时要勾一次确认
   - `warn`：单文件 > 10 MB、音频 ≥ 500 个、名称里有「官方/official/鹰角」这类容易混淆的词、
     包内所有文件套在同一层文件夹里（装包器要的是包内文件放 zip 根）
   - `info`：文件数与解压后大小、有没有 `pack.json`（有 = 已做好的包；没有 = 原件）
3. 看完点**通过并上线**（可以顺手改上线显示名）或**打回**（要写理由，投稿人用回执能查到）

`blocker` 是**提醒不是判决** —— 逐条看文本，确认是误报或可以放行，就勾上确认后上线。
脚本不做「替人下结论」这件事，所以它既不自动拒收，也不自动放行。

## 通过之后怎么进 GitHub 仓库

上传站只是入口，**仓库里的 [`packs/`](../packs/README.md) 才是正式收录**：

```bash
# 从审核页下载 zip（或 curl http://127.0.0.1:8787/api/file/<编号> -H "x-admin-token: ..."）
mkdir -p /tmp/pkg && cd /tmp/pkg && tar -xf ~/Downloads/<编号>-xxx.zip
# 包内文件放在 zip 根，所以直接就是一个包目录的内容 → 放进仓库的 packs/<包 id>/
cp -r /tmp/pkg /path/to/Stronghold-Protocol-Forge-Mods/packs/<包 id>
node tools/check-packs.mjs --engine <引擎目录> --root packs     # 闸门必须过
git add packs/<包 id> && git commit -m "收录 <包 id>（来源：<URL>）" && git push
```

## 数据与备份

- 全在 `DATA_DIR`：
  - `submissions/<编号>/{mod.zip, meta.json, decision.json}` —— 普通投稿
  - `flagged/<编号>/{mod.zip, meta.json, decision.json}` —— **疑似素材**的投稿
- **备份就备份这一个目录**；没有数据库
- 想清掉一条投稿：删掉对应目录即可（公开列表会立刻少一条）
- 想**一次清掉所有疑似素材**：`rm -rf <DATA_DIR>/flagged`（它们本来就是为了便于整体处理才分开存的）

## 边界（它**不**做什么）

- **不解压、不执行**上传的东西；读 zip 只读中央目录
- **不做病毒扫描** —— 它不替你判断一个 zip 里有没有恶意内容，那是人看内容那一步的事
- **不自动拒收疑似素材** —— 它只把特征挑出来、单独存放、标注；收不收、上不上线都归人
- **不自动改仓库** —— 通过之后要不要进 `packs/`、要不要发 release，都由人跑
- **不是 Git 的替代品**：它是让不会 git 的人也能投稿的入口，正式收录仍在仓库里
