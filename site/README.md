# 上传站（`site/`）

给投稿的人一个**网页上传**的入口，替掉「提 PR」那套。整条链是：

```
投稿人在网页上填「mod 名 + 备注」并传 zip
        ↓  落到 data/submissions/<编号>/
维护者（你）在 /admin 里下载下来跑测试、看包内容与自动挑出来的重点
        ↓  改好兼容、测试通过、名称与内容审过
点「通过」→ 它出现在 /mods 公开列表里，人人可下
```

**零依赖**：只用 Node 内置模块，不需要 npm install、不需要数据库、不需要 zip 命令。

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
| `DATA_DIR` | `site/data` | 投稿与决定的存放处。**要备份的就是它** |
| `MAX_MB` | `100` | 单个 zip 的上限 |
| `BASE_URL` | `http://127.0.0.1:<PORT>` | 生成回执链接用；放到公网要写成真实地址 |

自测（起一个临时实例把整条链走一遍，不碰你的数据）：

```bash
node site/selftest.mjs                                   # 自造合成包
node site/selftest.mjs --pack <某个真实.zip>              # 额外传一个真实包
```

---

## 放到服务器上

### 1. 最简单的起法

```bash
cd /path/to/Stronghold-Protocol-Forge-Mods
ADMIN_TOKEN='<你抄下来的那串>' PORT=8787 DATA_DIR=/var/lib/sp-upsite BASE_URL=https://你的域名 \
  node site/server.mjs
```

### 2. 用 systemd 常驻

`/etc/systemd/system/sp-upsite.service`：

```ini
[Unit]
Description=Stronghold-Protocol-Forge mod upload site
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/Stronghold-Protocol-Forge-Mods
ExecStart=/usr/bin/node site/server.mjs
Environment=PORT=8787
Environment=DATA_DIR=/var/lib/sp-upsite
Environment=BASE_URL=https://你的域名
EnvironmentFile=/etc/sp-upsite.env        # 里面写 ADMIN_TOKEN=...
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

`/etc/sp-upsite.env` 权限设成 `600`。

### 3. 前面挂 nginx（**HTTPS 必须**）

管理员令牌走在请求头里，**不上 HTTPS 就等于公开**。另外强烈建议**把 `/admin` 与 `/api/admin/` 按 IP 限死**：

```nginx
server {
  listen 443 ssl http2;
  server_name 你的域名;
  # ssl_certificate ...; ssl_certificate_key ...;

  client_max_body_size 120m;            # 要 ≥ MAX_MB

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # 审核相关的地址只对维护者的 IP 开放
  location ~ ^/(admin|api/admin/) {
    allow 你的固定IP;
    deny all;
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

> `server.mjs` 认 `x-forwarded-for` 的第一个地址当来源 IP（用于限流与记录）。只在**你信任的反代**后面才成立；直接暴露时它用 socket 地址。

---

## 审核的时候做什么

`/admin` 里填令牌 → 载入列表 → 点一条：

1. **下载 zip**，拿去跑测试（`node tools/check-packs.mjs --engine <引擎目录>`；
   未兼容的原件按 [`../incoming/README.md`](../incoming/README.md) 的流程处理）
2. 看**自动挑出来的重点**。服务端会标三类：
   - `blocker`：疑似官方游戏素材（`.skel` / `.atlas` / `spine/op/` / `char/portrait/` /
     官方语音路径 / `.ab` / `gamedata/`）、可执行与脚本文件、路径穿越 —— **带 blocker 的包点不了「通过」**
   - `warn`：单文件 > 10 MB、音频 ≥ 500 个、名称里有「官方/official/鹰角」这类容易混淆的词、
     包内所有文件套在同一层文件夹里（装包器要的是包内文件放 zip 根）
   - `info`：文件数与解压后大小、有没有 `pack.json`（有 = 已做好的包；没有 = 原件）
3. 看完点**通过并上线**（可以顺手改上线显示名）或**打回**（要写理由，投稿人用回执能查到）

`blocker` 是**提醒不是判决** —— 逐条看文本，确认是误报就走「改 `meta.json` 里的 `blocked` 为 false 再通过」；
脚本不做这件事，因为它不该替人下结论。

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

- 全在 `DATA_DIR`：`submissions/<编号>/{mod.zip, meta.json, decision.json}`
- **备份就备份这一个目录**；没有数据库
- 想清掉一条投稿：删掉对应目录即可（公开列表会立刻少一条）

## 边界（它**不**做什么）

- **不解压、不执行**上传的东西；读 zip 只读中央目录
- **不做病毒扫描** —— 它不替你判断一个 zip 里有没有恶意内容，那是人看内容那一步的事
- **不自动改仓库** —— 通过之后要不要进 `packs/`、要不要发 release，都由人跑
- **不是 Git 的替代品**：它是让不会 git 的人也能投稿的入口，正式收录仍在仓库里
