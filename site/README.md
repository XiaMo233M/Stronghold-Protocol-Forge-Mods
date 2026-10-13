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

## 维护者侧：兼容包上传与发布

组员把**未兼容的原件**投到公网上传页（`/`）；维护者把它兼容改写好之后，**从审核页把改写版发出去**。
这条路不是给组员的，它整套挂在管理 API 下，和 `/api/submit` 不是一回事 —— `ADMIN_IPS` 白名单与令牌两道防线照旧先过。

### 怎么用（照着做）

1. `ssh -L 25570:127.0.0.1:25570 <user>@<服务器>`，浏览器开 `http://127.0.0.1:25570/<ADMIN_PATH>`，登录（用户名 `admin`，密码 = `ADMIN_TOKEN`）。
2. 在**投稿列表**里点一条投稿看详情。入口就在**那条投稿的详情视图、下载按钮那一行**：
   点那个**独立的上传按钮**「上传并发布兼容包…」，表单**内联展开**在详情下方（不跳页、也不跳到同页另一个区 ——
   详情里的编号、原件名、包内结构与三档结果就在眼前，「由哪个待审原件改写来」还会**预填成当前这一条的编号**）。填：

   | 栏位 | 必填 | 说明 |
   |---|---|---|
   | zip 文件 | 要 | **已经兼容改写完的成品包**。包内文件放 zip 根，且必须有能解析的 `pack.json`；否则拒收（400） |
   | 上线显示名 | 要 | 列表里显示的名字（按当前那条预填成「某包（兼容版）」） |
   | **原作者** | 要 | **留空会从包里的 `pack.json` 的 `author` 自动预填**，可核对后改写。包里没有、人也不填 → 400 拒收 |
   | **兼容者** | **字段必填，值可以为空** | 做兼容改写的那个人。**不预填、不兜底**：留空就如实存空并显示「未填」；报文里**缺这一栏**才拒收（400，点名「缺少兼容者字段」）。存下来用 `compatAuthorSource` 标明是 `form`（手填）还是 `empty`（未填）——**没有兜底这一档**。`Mo233` 只可能是维护者自己敲进去的字面值 |
   | 由哪个待审原件改写来 | 建议 | 填那个待审投稿的编号（默认已预填当前这条）。填了就把原件的 sha256 与来源一并记下，并把原件**拷贝一份**进本条留档 |
   | 原件来源链接 | 选填 | **可以为空**（业主口径 2026-10-11：「第三方来源也能为空，因为大部分备注里都有了」）。留空就如实留白，**不再 409**；追溯靠上面那条「由哪条待审原件改写来」+ 留档原件的 sha256 |
   | 改了什么 | 选填 | 兼容说明，会显示在审核详情与公开列表上 |

3. 点表单底部的「上传并发布」。**这一下就是一步到位**：上传 + 通过 + 发布
   （请求带 `publish=1`，打的是 `POST /api/<ADMIN_PATH>/compat-submit`）。
   它和普通投稿走**同一套三档检查**（`blocker` / `warn` / `info`，见 `review.mjs`）。
4. **发布成功后原投稿按 B 口径处置**：状态置 `superseded`（不是 pending，也不是 rejected）、
   `replacedBy` 指向刚发布的那个兼容包编号、**移出待审队列**；但它的 `meta.json` 与 `mod.zip`
   **一个字节都不动**，`decision.json` 只加不删 —— 记录保留、可追溯。
   兼容包是**另起的一条记录**（新编号），在**同一个列表**里（管理界面里不再有独立的「兼容包」区）。
5. 审核页的列表按状态**分成三页**（业主 2026-10-11：「已经通过的也要另开一页」）：
   主列表 `/<ADMIN_PATH>` 放 `pending` + `superseded`、`?view=approved` 放已通过、`?view=rejected` 放已打回。
   三个视图是**三条真实地址**（视图名走白名单，不在名单里直接 404，不悄悄回落），
   计数行给出「三页相加 + 已隐藏 = 全部」。记录一条都不少，只是各归各页。

### 同一条 mod 出现两份：审核页的「不再显示」勾选框

业主 2026-10-11：「**因为有可能 mod 名字和兼容后的名字不一样，导致依旧存在两个 mod
（一个在兼容，一个在上传待定），所以给我一个勾选框，选后就不显示这个 mod 了**」。

自动配对走 `compatOf` + `markReplacedBy`；**名字不一致时人可能根本不会去配对**，
于是同一份 mod 会在审核页上出现两次。这个勾选框完全不依赖名字：**每条记录一个**
（列表行上一个、详情里一个），文案是「**不再显示（已由兼容包取代）**」。

- 勾上 ⇒ 这条从**审核页的三个视图**里都不再显示；**取消勾选 ⇒ 重新显示**（可逆，不是删除）；
- 落成**记录自己的字段**：`meta.json` 的 `hidden: true|false` + `hiddenBy` + `hiddenAt`
  （外加一笔 `revisions` 留痕）；
- **公开面不动**：`/api/mods` 与 `/mods` 从不读这一栏，`/api/file/*` 也不读它 ——
  「不再显示」是**审核页的显示开关，不是下架**；要下架请用「打回」（`decision=rejected`）。
- 页面上另有**「显示已隐藏」**开关（默认不勾）：勾上就能看见被隐藏的那些，便于取消勾选。

```bash
# 勾上（不再显示）／取消（重新显示）—— 一次只认一个 id
curl -sX POST http://127.0.0.1:25570/api/<ADMIN_PATH>/hide \
  -H "x-admin-token: <ADMIN_TOKEN>" -H 'content-type: application/json' \
  -d '{"id":"<记录编号>","hidden":true}'
```

⚠️ **这个端点绝不批量**（与 `/compat/decide`、`/compat/link`、`/compat/note` 同一条铁律）：
报文里出现 `ids` / `batch` / `items` / `list`，或者 `id` 给了数组，一律 400；
`hidden` 必须是**布尔值**，不存在的 id 一律 404。**要藏 N 条就发 N 次，每条单独核对。**
幂等：标志位已经是目标值时返回 `changed:false`，**不写盘、不留第二笔**。

### 已经上线、但当时 `compatOf` 还空着的兼容包：补链

早先手工逐个批准上线的兼容包，`compatOf` 可能是空的，它们对应的原投稿就还挂在待审队列里
——与上面那套逻辑不一致。补链走**同一套实现**，一次只认**一个**明确指定的 id：

```bash
curl -sX POST http://127.0.0.1:25570/api/<ADMIN_PATH>/compat/link \
  -H "x-admin-token: <ADMIN_TOKEN>" -H 'content-type: application/json' \
  -d '{"compatId":"<兼容包编号>","originId":"<原投稿编号>"}'
```

它做两件事，都只是**补记**：给兼容包补上 `compatOf`（其余字段一个不动，改动只进 `revisions`）；
调用**同一个** `markReplacedBy` 把原投稿标 `superseded` + `replacedBy`（原投稿两个文件一字不动）。
幂等：同一条重复调返回 `alreadyLinked: true`，不再产生第二笔改动。
⚠️ **绝不要写「把筛出来的一批 id 循环喂进来」的脚本** —— 一次请求只处理一条，这样每次改动都能单独核对。

### 四条硬要求落在哪

| 硬要求 | 怎么保证的 |
|---|---|
| 上传者是**维护者**，不是给组员的公网入口 | 端点 `POST /api/<ADMIN_PATH>/compat-submit`，与 `/api/submit` 分开；整体先过 `adminAllowed()` + `isAdmin()`（`ADMIN_IPS` + 令牌/Basic） |
| **原作者 + 兼容者两个署名，分开显示、互不覆盖** | 站点侧 `meta.json` 里 `author` 与 `compatAuthor` **各占一栏**；审核页与 `/mods` 两处都渲染成两栏；兼容者不写进包的 `pack.json` |
| **保持原注释不变** | 站点**从不改写 zip**。上传时把 `pack.json` 快照存成 `pack-json.orig.json`，通过前再逐键比对一次；不一致就 409，并把**哪一栏被改了**摆出来 |
| **通过的是新的兼容改写版，原件留档不发布** | 公开下载永远走 `mod.zip`（改写版）；被改写的原件拷成 `orig.zip`，`?variant=orig` **只有维护者能下**（无论通没通过） |

### 数据长什么样

兼容包存在 `DATA_DIR/compat/<编号>/`（普通投稿在 `submissions/`、疑似素材在 `flagged/`，三者分开）：

```
compat/<编号>/mod.zip                ← 要发布的**改写版**（通过后公开可下）
compat/<编号>/orig.zip               ← 被改写的**原件**：留档，不发布（只有维护者能下）
compat/<编号>/pack-json.orig.json    ← 改写版里 pack.json 的**原件快照**（原注释一字未变的凭据）
compat/<编号>/meta.json              ← 两个署名 + 来源 + 两个哈希 + 三档检查结果
compat/<编号>/decision.json          ← 审核决定（写清发布了哪个变体、原件哈希）
```

> **数据目录根下不许有散文件。** 上传中途会先落一个 `<编号>.part`（读完 zip 才知道该进哪个区），
> 它在**任何**路径上都会被清掉：成功时 `rename` 成正式的 `mod.zip`，失败时由请求处理器的
> `finally` 兜底删掉（被拒的 400、抛异常都算）。所以 `DATA_DIR` 根下**只该有
> `submissions/`、`flagged/`、`compat/` 三个目录** —— 多出 `.part` 就是有失败路径漏了清理，
> `selftest-compat.mjs` 的 ③b/⑥ 会直接把它测红。

`meta.json` 里与署名/留痕有关的键：

```jsonc
{
  "kind": "compat",
  "author": "社区作者甲",            // 原作者
  "authorSource": "pack.json",       // 预填来的还是维护者填的
  "packAuthor": "社区作者甲",         // 包里那一栏原样（留痕）
  "compatAuthor": "维护者乙",         // 兼容者 —— **只在这里**，不进包。空字符串 = 未填（合法值）
  "compatAuthorSource": "form",      // form = 维护者手填的；empty = 未填。**没有「兜底」这一档**
  "compatOf": "a21e4770010f",        // 由哪个待审原件改写来
  "origin": { "id": "a21e4770010f", "sha256": "…", "verified": true,
              "archived": true, "archivedFile": "orig.zip", "sourceUrl": "…" },
  "sha256": "…",                     // 改写版的哈希（通过时要核这个）
  "revisions": [ { "to": { "compatAuthor": "维护者乙" }, "why": "decide 时补全" } ]
}
```

- 公开列表 `/api/mods` 里，兼容包多出 `kind/author/compatAuthor/compatAuthorSource/compatOf/compatNote`
  与 `archiveDownload` 几个字段（普通投稿没有，前端按缺省处理）。
  公网 `/mods` 页把两栏都显示出来、**各自带标签**（「原作者」与「兼容改写者」），并附一句
  「原作说明与署名原样保留自包内的 pack.json；兼容改写是另一个人做的」—— 免得只看到一个名字被误当成作者。
- 「兼容者」**不会**出现在包的 `pack.json` 里 —— 那会抬包契约（包只认引擎 `shared/workshop.js` 的 `PACK_FIELDS`）。
- 想清掉一条兼容包：删掉 `compat/<编号>/` 即可。

### 自测

```bash
node site/selftest.mjs             # ① 公网投稿链（上传 → 下载 → 审核 → 上线）
node site/selftest-admin.mjs       # ② 审核台 / 公网列表**页面**跑不跑得起来（见下）
node site/selftest-compat.mjs      # ③ 兼容包整条链 + 反例（临时数据目录，不碰你的数据，不联网）
node site/selftest-publisher.mjs   # ④ 发布者自助（认领 / 改元数据 / 换包体 / 自撤）+ 管理员确认 + 分类筛选 + 审计日志
```

`selftest-admin.mjs` 专治一类「接口全好、页面却是死的」故障：审核台是一整个内联 `<script>`，
它只要在**顶层抛一次错**，后面所有 `onclick` 与自动载入就全都不执行 —— 页面不报错也不崩，
就是永远停在 HTML 里那句「还没载入。」。所以它把**服务器实际发出来的 HTML**里的脚本，
配上真实的 list 响应，塞进最小 DOM 桩里跑一遍，断言：脚本跑到底、列表按磁盘条数画出来、
兼容者空值显示「未填」、全站没有 `Mo233` 兜底。
（2026-10-11 真踩过一次：`const` 写在它被使用之后 → TDZ。）

它同时盯着**三个列表分区**（业主 2026-10-11：「已经通过的也要另开一页」）：
`#list` = 待审页（`pending` + `superseded`）、`#alist` = 已通过页、`#rlist` = 已打回页。
三页的条数之和**加上「已隐藏」那一栏**等于磁盘上的全部记录（分区不筛掉、也不丢记录）；
「状态=已打回」筛出来时只有 `#rlist` 有可见条数，而 `superseded` 的照旧留在待审页、计数里单独算一档。

**「不再显示」勾选框也在这一份自测里**：断言列表每一行都有那个勾选框、文案是
「不再显示（已由兼容包取代）」；勾上之后拿**新的 `/list`** 重开一个桩，断言这条在三个视图里
都不显示、计数仍是「三页相加 + 已隐藏 = 全部」；勾上「显示已隐藏」它就又看得见；取消勾选之后
全部恢复（可逆）。详情里那个勾选框也在同一次自测里断言。
`selftest.mjs` 补的是**端点那一层**：一次一个 id（`ids` / `batch` / `items` / `list` / 数组 id 一律 400）、
不存在 404、幂等、`mod.zip` 与 `decision.json` 的 sha256 前后一致、`/api/mods` 与 `/mods` 字节不变。

---

## 视觉基线（界面取自哪里）

界面样式**来自业主给的样例站** `https://arknights.jiangjiangze.icu/` —— 从它的
`css/theme.css` 与 `css/components.css` 里**逐条抄下实际值**，不是凭印象配的：

| 取到的值 | 从哪拿的 |
|---|---|
| `--bg-0:#0c0f0e` `--bg-1:#141816` `--bg-2:#1e2421` `--bg-3:#252c29` `--bg-4:#2d3632` | `theme.css` 的 `:root`（surfaces 一组） |
| `--line:#2f3a35` `--line-2:#3e4b45` `--line-3:#58675f` | 同上 |
| `--mint-500:#4ed8af` `--mint-400:#59f4ca` `--mint-700:#2a9e7f` `--mint-800:#145443` `--mint-glow:#17f9b7`，以及 `--mint-a10/a20/a35` | 同上（accent 一组，注释写着「official hex values where research marks [DATA]」） |
| `--gold:#ffc600` `--amber:#f6a329` `--red-premium:#ff5454` `--red:#e73118` `--ice:#9fd4ff` | 同上 |
| `--text-hi:#f2f2f2` `--text-md:#c3cbc7` `--text-lo:#8a948f` `--text-dim:#5d6863` `--text-on-mint:#06110d` | 同上 |
| `.panel`：细横条纹理 + `linear-gradient(180deg,rgba(30,36,33,.94),rgba(18,22,20,.94))` + 1px `--line` + `box-shadow 0 .12rem .3rem rgba(0,0,0,.35)` | `components.css` 的 `.panel` |
| `.panel__head` 内边距 `.16rem .22rem .12rem`、`.panel__body` 内边距 `.22rem` | 同上 |
| `.brackets::after`：四角 L 形，`--bk-l:.14rem`、`--bk-w:2px` | `components.css` 的 `.brackets::after` |
| `.btn`：高 `.5rem`、`padding 0 .26rem`、`font-size .18rem`、`font-weight 700`、`letter-spacing .06em`、`--btn-bg:#1a201d`、hover `--btn-bd-hover:--mint-700` + `box-shadow 0 0 .18rem rgba(78,216,175,.25)` | `components.css` 的 `.btn` |
| `.btn--primary`：`--btn-bg:--mint-500`、`--btn-fg:--text-on-mint`、右边 `repeating-linear-gradient(-55deg,…)` 斜纹条 | 同上 |
| `.btn--danger`：`--btn-bg:#a3241a`、`--btn-bd:#c83a2c` | 同上 |
| `.field__box`：高 `.56rem`、`background rgba(5,7,6,.78)`、focus 时边框 `--mint-700` + 蓝色… 薄荷色辉光 | 同上 |
| `.badge` 之类的胶囊尺寸（`border-radius:99px`、`font-size:11px`） | 三张表里 `border-radius` 的全部出现次数：`var(--radius-sm,6px)`×5、`50%`×4、`999px`×2、`9px`/`3px`/`2px`/`99px` 各 1 —— 所以圆角整体很小，本实现取 4px |

**字体怎么处理的**：样例站自己托管 `Bender` 与 `Novecento Wide` 两个 woff2（`fonts/fonts.css` 里三个 `@font-face`）。
本站**不外链、不下载、不打包任何字体文件**（离线/内网也要能用），改用系统字体栈还原那个味道：

- 正文中文：`system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", …`
- 标签/按钮/标题（对应样例的窄体大写观感）：`"Bahnschrift", "DIN Alternate", "Arial Narrow", "Segoe UI", "Microsoft YaHei", sans-serif`
  —— 用系统里现成的窄体，配 `letter-spacing` 与（必要时）`text-transform: uppercase` 出那种「战术标签」的样子。
- 等宽（路径/哈希）：`"Cascadia Mono", ui-monospace, Consolas, …`

样式表是 `site/pages/theme.css`，由服务自己 `GET /theme.css` 发出去（`text/css`，带一小时缓存），
页面里的 `__CSS__` 占位符在 `renderPage()` 里换成同源链接。**没有引入任何前端构建、CDN、npm 依赖**，
自测里有一条断言专门盯着「样式表里不许出现 `http(s)://`」。

---

## 跑起来

```bash
# 本地试试
ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") node site/server.mjs
```

打开 `http://127.0.0.1:8787/`（本机临时实例的默认口）。**先把上面那串令牌抄下来** —— 审核页要它。

> ⚠️ **线上生产实例不是 8787**：`/etc/sp-modsite.env` 里 `PORT=25570`、`HOST=0.0.0.0`，
> 公开入口就是 `http://47.103.14.217:25570/`（`BASE_URL` 同值）。下面这张表的 `PORT` 只是
> **本机试跑的代码默认值**；照它去访问线上会打不开 —— 全网没有反向代理，**必须带 `:25570`**。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | **必填**（≥16 位） | 审核动作的凭据。没设就拒绝启动 |
| `PORT` | `8787`（**线上是 `25570`**） | 监听端口。这里写的是**本机试跑的默认值**；生产实例以 `/etc/sp-modsite.env` 为准 |
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
  --port 25570 \
  --base-url http://47.103.14.217:25570 \
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
ssh -L 25570:127.0.0.1:25570 <user>@<服务器>
# 然后浏览器开 http://127.0.0.1:25570/<ADMIN_PATH>
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

不做也完全能用（直接访问 `http://47.103.14.217:25570`）。真要做，**必须**按这个顺序，
并且**只新增一个文件**、绝不改已有的 server 块：

```bash
# 1) 只新增一个 conf（用独立端口，与现有站点不冲突）
sudo tee /etc/nginx/conf.d/sp-modsite.conf >/dev/null <<'EOF'
server {
  listen 8080;
  server_name _;
  client_max_body_size 120m;                 # 要 ≥ MAX_MB
  location / {
    proxy_pass http://127.0.0.1:25570;
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

> 审核台 2026-10-13 又添三件事：**发布者自撤待确认**（`withdraw-decide`）、
> **批准候选包体**（`promote-blob`，旧包改名留档）、**手工发认领码**（`issue-claim`）；
> 外加「改了什么」那一栏。三件都在下面〈发布者自助管理〉一节里。

## 通过之后怎么进 GitHub 仓库

上传站只是入口，**仓库里的 [`packs/`](../packs/README.md) 才是正式收录**：

```bash
# 从审核页下载 zip（或 curl http://127.0.0.1:25570/api/file/<编号> -H "x-admin-token: ..."）
mkdir -p /tmp/pkg && cd /tmp/pkg && tar -xf ~/Downloads/<编号>-xxx.zip
# 包内文件放在 zip 根，所以直接就是一个包目录的内容 → 放进仓库的 packs/<包 id>/
cp -r /tmp/pkg /path/to/Stronghold-Protocol-Forge-Mods/packs/<包 id>
node tools/check-packs.mjs --engine <引擎目录> --root packs     # 闸门必须过
git add packs/<包 id> && git commit -m "收录 <包 id>（来源：<URL>）" && git push
```

---

## 发布者自助管理：认领码 → 发布者令牌 → `/mine`（2026-10-13 上线）

投稿人交完包**不用再找维护者**：他拿一枚**一次性认领码**换一枚**发布者令牌**，之后自己在
`/mine`（「我的投稿」）里管自己那一条。**自助写一律「改记录 → 强制回待审 → 公开面不动」。**

### 发布者能做什么

| 他能做的 | 端点 | 结果 |
|---|---|---|
| 换令牌 | `POST /api/publisher/claim` | 认领码**只生效一次**：换完就从 `pendingClaim` 里划掉，往 `publisherTokens` 落一枚**哈希** |
| 看自己那条 | `GET /api/publisher/mine` | 凭令牌（`x-publisher-token` 头或 `Authorization: Bearer`）列出；**只读、不限流** |
| 改元数据 | `POST /api/publisher/update` | `name` / `note` / `homepage` / `packKind` 四栏 ⇒ **强制回待审** |
| 换包体 | `POST /api/publisher/blob` | 新包写成**候选**（`candidate`）；公开面**照旧展示旧包**，等管理员批准 |
| 自撤 | `POST /api/publisher/withdraw` | `withdrawRequested: true` ⇒ 公开列表与下载口**立刻**不再列它；等管理员确认 |

共同边界：**自助写不得直改公开面**。「改元数据 ⇒ 回待审」走的是 `clearDecision()` ——
把那一份 `decision.json` **逐字搬进 `meta.revisions`**（含 `decisionSnapshot`），文件不再存在 ⇒
`state` 读出来就是 `pending`。公开面立刻少一条，而**记录、包体、决定一个字都没丢**。

### 管理员负责审核：三件

1. **自撤要管理员确认** —— `POST /api/<ADMIN_PATH>/withdraw-decide`，
   报文 `{ "id": "<编号>", "action": "confirm" | "reject", "note": "…" }`。
   - `confirm` ⇒ `decision = superseded` 且 **`replacedBy: null`**（这是全站**唯一**允许
     `superseded` 不带 `replacedBy` 的例外，标志是 `reason: 'publisher-withdraw'`）；理由取发布者填的 `withdrawReason`。
   - `reject` ⇒ 清掉 `withdrawRequested`，这条**恢复公开** —— 它本来就没被改动过（自撤申请只影响「列不列出来」）。申请照样进 `withdrawHistory` 留痕。
   - 审核台首页的响应里就带一个 **`withdrawQueue`**（自撤待确认队列；只数数、不改盘）。
2. **换包体要管理员批准才切换** —— `POST /api/<ADMIN_PATH>/promote-blob`，
   报文 `{ "id": "…", "expectedSha256": "…" }`（后者可选，带上就**当场核哈希**）。
   核过才切；**旧的 `mod.zip` 改名留档**（`mod.superseded-<时间戳>.zip`），**不删**；切完这条**回到待审**
   —— 上线与否仍由管理员明确给一次。
3. **「改了什么」在审核台看得见** —— 审核详情把 `revisions` 逐笔摆出来（改了哪一栏、从什么改成什么、谁改的、为什么）；
   被发布者动过的记录带 `publisherChanged: true` 标记。

**老记录怎么办**：站上早先批的条目**一个都没有** `pendingClaim`，也就**认领不了**（系统不猜）。
要让原作者自助管理，或者发布者把令牌弄丢了（盘上只有哈希，**找不回明文**），都由管理员
`POST /api/<ADMIN_PATH>/issue-claim` 手工发一枚认领码，**带外**（群里/微信）交给本人。

### 分类筛选：`/mods?kind=…`（URL 可分享）

复用既有的 `packKind` 闭集，**不新增字段、不回填老记录**：

| 值 | 意思 |
|---|---|
| `functional` | 装上即生效 |
| `documentation` | 说明包 / 参考 / 补丁 —— 装上不启用任何功能 |
| `unknown` | 判不了（**缺省就是它**，绝不可能是 `functional`） |

- 单个：`/mods?kind=functional`；多选：`/mods?kind=functional,documentation`（逗号分隔，服务端去重）。
- **不传 = 现状**（三个分区、两份数据、一条判据全不变）。`?kind=`、`?kind=,` 这种空值也按不传算。
- 值不在闭集里 ⇒ **400**，**不悄悄忽略** —— 否则「我筛了但列表没变」会变成查不出来的误会。
- 筛选在**服务端**做（不是前端把数据藏起来）：页面把当前档位交给 `GET /api/mods?kind=…`。
- 每枚按钮都是**真链接**（`<a href>`）：**没有 JS 也能用**，**URL 复制给别人照样显示同一批**；
  别人发来一个多选地址，页面会如实写明「当前只显示：真功能包 + 说明包」。
- **计数口径 = 只数主分区**：「含疑似官方素材的 mod」在 `/mods` 上另起一块，与三个分类区**正交** ——
  既不并进分类区、也不进计数。这样按钮上的数与点进去看到的条数**对得上**：
  线上的 `e3a5d09eb6d3` 正是 approved + documentation + suspected，它落在疑似那一组
  （计数 22、点进去 21）。
- **筛过之后服务端不给 `counts`**：筛完再报「functional 有 3 条」会让人误以为站上只有 3 条功能包；
  此时页面按当前这批**自己数**（那才是屏幕上真实的条数）。
- 管理员侧的改写走 `POST /api/<ADMIN_PATH>/packkind`（**只动 `meta.packKind` 一栏**、进 `revisions`、
  幂等、一次只认一个 id）；发布者那一栏走 `POST /api/publisher/update`。两处都只收闭集。

### 安全口径

- **只存哈希**：`pendingClaim[].h` 与 `publisherTokens[].h` 都是 sha256（带域分隔前缀
  `sp-modsite/claim/v1:` 与 `sp-modsite/publisher-token/v1:`），**盘上没有明文**；
  比对走 `timingSafeEqual` 定长比较。
- **失败同码同句**：认领码不对、编号不存在，返回**同一个**响应 —— 不泄露「这条记录存不存在」。
- **写端点限流**（`publisherRateLimited`，按来源 IP）；只读的 `/api/publisher/mine` **不限流**
  （否则刷新几下就被锁）。
- **审计日志** `<DATA_DIR>/audit.jsonl`：一行一条 JSON，**只追加**，从不改写、从不删除。
  形状 `{ at, action, id, ip, actor, admin, detail }`，`actor` ∈ `admin` / `publisher` / `public`。
  ⚠️ **一个凭据字节都不写** —— 认领码、发布者令牌、`ADMIN_TOKEN`、Basic 头一律不进日志；
  记的是**事件**（`submit` / `tokenClaimed` / `claimIssued` / `publisherUpdate` / `publisherBlob` /
  `withdrawRequested` / `withdrawConfirmed` / `withdrawRejected` / `promoteBlob` / `packKind` /
  `approved` / `superseded` / `hide` / `note` / `compatLink` / `compatNote`），不是凭据。
  写不进去也不影响请求（留痕不是业务）。
- 令牌存在发布者**自己的浏览器**里（`localStorage` 键 `sp-modsite-publisher-token`）；
  站点只存哈希 —— 丢了让管理员重发一枚即可，**旧令牌不回收**。

### 零删除：自助「删除」= 自撤 + 管理员确认 → `superseded`

发布者在 `/mine` 上点的是**申请撤下**，不是删除。整条链上**没有任何一处删数据**：

| 环节 | 盘上发生什么 |
|---|---|
| 发布者申请自撤 | 加 `withdrawRequested: true` + `withdrawReason` + `withdrawRequestedAt` + 一笔 `withdrawHistory`；`meta.json` / `mod.zip` / `decision.json` **全在** |
| 管理员确认 | `decision.json` 写成 `decision = superseded` 且 `replacedBy: null`；**记录与文件全留** |
| 管理员拒绝 | 清 `withdrawRequested`、恢复公开；申请照样进 `withdrawHistory` |
| 换包体 | 旧 `mod.zip` **改名留档** `mod.superseded-<时间戳>.zip`，**不删** |
| 改元数据 ⇒ 回待审 | 原 `decision.json` 逐字进 `revisions.decisionSnapshot` 再移除该文件 —— 这是**唯一**会移除它的地方，且内容一字未丢 |
| 令牌轮换 | `publisherTokens` 只保留最近 8 枚（`TOKEN_MAX = 8`），换发**不删记录** |

公开面的可见性判据只有一条：`isPubliclyVisible = state === 'approved' && withdrawRequested !== true`。

## 数据与备份

- 全在 `DATA_DIR`：
  - `submissions/<编号>/{mod.zip, meta.json, decision.json}` —— 普通投稿
  - `flagged/<编号>/{mod.zip, meta.json, decision.json}` —— **疑似素材**的投稿
  - `compat/<编号>/{mod.zip, orig.zip, pack-json.orig.json, meta.json, decision.json}` —— 维护者侧的**兼容包**（`mod.zip` 是要发布的改写版，`orig.zip` 是留档不发布的原件）
- **备份就备份这一个目录**；没有数据库
- 想清掉一条投稿：删掉对应目录即可（公开列表会立刻少一条）
- 想**一次清掉所有疑似素材**：`rm -rf <DATA_DIR>/flagged`（它们本来就是为了便于整体处理才分开存的）

## 更新服务器上这一个服务

运行时代码只有 `server.mjs` / `review.mjs` / `zip.mjs` 三个 `.mjs`，加一个 `pages/`（4 个 `.html` + `theme.css`）；目录里另有四个 `selftest*.mjs`，同一次一起传。更新时**先备份、再换文件、再重启**，全程只碰 `/opt/sp-modsite` 与 `sp-modsite.service`：

```bash
# ① 备份 + 记下旧版哈希（可回滚的硬条件）
TS=$(date +%Y%m%d-%H%M%S)
cp -a /opt/sp-modsite /opt/sp-modsite.bak-$TS
sha256sum /opt/sp-modsite/{server.mjs,review.mjs,zip.mjs} | tee /opt/sp-modsite.bak-$TS.sha256
```

```powershell
# ② 本机（Windows）传上去。--exclude runtime 免得动服务器上自装的 Node
scp site\server.mjs site\review.mjs site\zip.mjs sp:/opt/sp-modsite/
scp site\pages\*.html site\pages\theme.css sp:/opt/sp-modsite/pages/
scp site\selftest.mjs site\selftest-admin.mjs site\selftest-compat.mjs site\selftest-publisher.mjs sp:/opt/sp-modsite/
```

```bash
# ③ 重启并实测
systemctl restart sp-modsite
systemctl is-active sp-modsite
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25570/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25570/
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25570/mods
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25570/theme.css
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:25570/review-2228      # 401 = 登录框在，正常

# ④ 回滚（一条）
cp -a /opt/sp-modsite.bak-<时间戳>/. /opt/sp-modsite/ && systemctl restart sp-modsite
```

### 改完必跑的**四个**自测（2026-10-13 起）

```bash
cd /opt/sp-modsite
/opt/sp-modsite/runtime/node/bin/node selftest.mjs             # ① 公网投稿链
/opt/sp-modsite/runtime/node/bin/node selftest-admin.mjs       # ② 审核台 / 公网列表**页面**跑不跑得起来
/opt/sp-modsite/runtime/node/bin/node selftest-compat.mjs      # ③ 兼容包整条链 + 反例
/opt/sp-modsite/runtime/node/bin/node selftest-publisher.mjs   # ④ 发布者自助 + 管理员确认 + 分类筛选 + 审计日志
```

**四个全绿才算改完**（`selftest-publisher.mjs` 是 2026-10-13 新增的那一个，专测本次这条链）。
四个都跑在**临时数据目录**（`/tmp/...`）上，**不碰** `/var/lib/sp-modsite`，不联网。
服务器上 `node` 不在 `PATH` 里，用单元文件里那个绝对路径（`/opt/sp-modsite/runtime/node/bin/node`）。

> `/var/lib/sp-modsite`（数据）**不在**这套步骤里 —— 更新代码不碰数据；回滚也不会回退数据。
> 服务器上的 `sync.service`、gunicorn、nginx 等都不属于本服务，别动。

## 边界（它**不**做什么）

- **不解压、不执行**上传的东西；读 zip 只读中央目录
- **不做病毒扫描** —— 它不替你判断一个 zip 里有没有恶意内容，那是人看内容那一步的事
- **不自动拒收疑似素材** —— 它只把特征挑出来、单独存放、标注；收不收、上不上线都归人
- **不自动改仓库** —— 通过之后要不要进 `packs/`、要不要发 release，都由人跑
- **不是 Git 的替代品**：它是让不会 git 的人也能投稿的入口，正式收录仍在仓库里


## 取件：`?variant=orig`（留档原件）到底怎么取 —— 实测矩阵（2026-10-12）

**这一节的由来**：有人拿**公网入口** + 有效 `x-admin-token` 去取 `?variant=orig`，拿到 **403**，
于是怀疑"留档原件存了却取不到 / 是不是回归"。实测结论：**设计如此，不是回归**，只是取用规则没写下来过。

**根因（一行）**：`isAdmin = adminAllowed(req) && (tokenOk(x-admin-token) || basicOk(req))` ——
**先看来源 IP，再看凭据**。`ADMIN_IPS` 非空时，只有**回环**（或白名单里的 IP）才可能通过；
公网入口进来的请求**连凭据那一步都走不到**。

**实测矩阵**（同一请求，只换来源 / 凭据）：

| 取法 | 结果 | 说明 |
|---|---|---|
| 回环 `http://127.0.0.1:<PORT>` + `x-admin-token` | **200** | ✅ **这是可用取法** |
| 回环 + Basic（`admin:<ADMIN_TOKEN>`） | **200** | ✅ 同样可用 |
| 回环 + 无凭据 | 403 | 凭据没过（`adminAllowed` 已过） |
| 公网入口 + `x-admin-token` | 403 | **来源 IP 不过白名单 —— 先于凭据** |
| 公网入口 + 无凭据 | 403 | 同上 |
| 伪造 `X-Forwarded-For: 127.0.0.1` | 403 | `TRUST_PROXY=0` ⇒ **不认这个头**（这正是不被绕过的证据） |
| `?variant=mod`（正常发布物）无凭据 | 200 | 发布物本来公开 |

**两种 403 的正文不一样，可以据此定位**：

- `原件只是留档，不对外发布；管理口只允许回环地址（ADMIN_IPS），走 SSH 隧道再看。` ⇒ **来源 IP 没过白名单**（先那一半）
- `原件只是留档，不对外发布：请从审核页进入（浏览器会弹登录框），或用 x-admin-token 头带上令牌。` ⇒ 来源过了、**凭据没过**（后那一半）

**所以正确的取法**：

```bash
# 把服务器的回环 25570 接到本机某端口（8787 随便挑）
ssh -N -L 8787:127.0.0.1:<PORT> root@<服务器>
# 然后走**回环那一路**取；token 用 /etc/sp-modsite.env 里的 ADMIN_TOKEN
curl -o orig.zip -H "x-admin-token: $ADMIN_TOKEN" "http://127.0.0.1:8787/api/file/<编号>?variant=orig"
```

**为什么保留这个次序**（业主 2026-10-12 裁定「不改」）：**IP 白名单先于凭据**更安全 ——
公网上**拿到令牌也没用**；而且两种 403 的正文本身就把"只允许回环"与"缺令牌"分开了，排查不吃力。

**实测覆盖**：22 条有 `orig.zip` 的兼容包，在回环 + `x-admin-token` 下 **22/22 = HTTP 200 且与磁盘逐字节一致**
（另 4 条本来就没有 `orig.zip` —— 是**没留档**，不是取不到）。


## 纪律：站侧更正「投稿人自述」时怎么改（`compatNote` / `note` / `description`）

**适用范围**：`meta.compatNote`、`meta.note`、以及记录里任何**由投稿人/改写者自己写的话**。
（`decision.json.reason` 那一栏是**站侧**写的，不受本节约束。）

**为什么要有这一节**：站侧确实需要更正投稿人自述里**事实上错的东西**（例如 `979a39c35fd0` 的
「19 个文件里只有 5 个 CSS」—— 实测 `+++` 文件头 19 个 = **4 个 CSS + 15 个 JS**）。
但**不能因此把作者的原话抹掉**：那是"他当时说了什么"的证据。

**四条纪律**：

1. **一律加前缀**：`站侧更正 YYYY-MM-DD：` —— 谁改的、什么时候改的，一眼看得出来。
2. **保留原文数字 / 原句**：**不许覆盖掉作者的原始说法**（例如写成
   `19 个文件里只有 4 个 CSS（站侧更正 2026-10-12：… 实测 19 个 = 4 个 CSS + 15 个 JS，原文写 5）`），
   而不是直接把 `5` 改成 `4` 了事。
3. **`revisions` 留痕**：`changed` = **声称值**、`to` = **实测值**、`why` = 理由。
4. **只改事实上错的**；**作者的判断 / 估计不动** —— 例如「约 17 处 hunk 能用样式表表达」是作者对
   "可转换成样式表的量"的**判断**（实测全量 81 处 hunk、其中 CSS 文件里 21 处），站侧**只补记实测、不改他的判断**。

**配套**：`decision.json.reason` 里写"站侧核实（日期）：…"那一段，与本节的更正**成对出现** ——
一处是"哪句错了、真值是什么"，一处是"我们据此判了什么"。
