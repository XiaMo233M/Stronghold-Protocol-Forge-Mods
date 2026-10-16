# Stronghold-Protocol-Forge-Mods

[Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge) 的**工坊包仓库**。它做两件事：

- **当 mod 仓库**：站上**已通过**的成品逐字节镜像在 [`mods/`](mods)，机器可读的目录是 [`mods/index.json`](mods/index.json) —— **那个索引是唯一的真相**，每条都带 sha256、大小、分类与许可。条数**以 `index.json` 为准**，本文不写死。
- **当说明书**：写包、改包、投稿、验包、审包的规矩都在这里 —— [SKILL.md](SKILL.md) 给**包作者**，[AGENTS.md](AGENTS.md) 给**维护者 / AI agent**，[UPLOAD.md](UPLOAD.md) 给**投稿人**。

- 游戏本体与引擎源码**不在这里** —— 那是 [Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge)
- 上游原作：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)
- **含官方素材的包如实收录，但必须标注清楚**（见 [NOTICE.md](NOTICE.md) 与 [SKILL.md](SKILL.md) §14 素材口径）

> 非官方同人作品，**禁止商业使用**。《明日方舟》及其素材版权归**鹰角网络**所有。

> **完全不会用？先看 [BEGINNER.md](BEGINNER.md)。**
> 那一份从「复制一个文件夹」讲到「上传」，每步都写了敲什么、成功时看到什么、失败最常见是什么原因，
> 并且带一个**已经跑通过**的模板包：[`examples/my-first-pack/`](examples/my-first-pack)。

## 目录地图

| 目录 | 放什么 | 判定 |
|---|---|---|
| [`mods/`](mods) | **站上已通过成品的镜像**（一份包一个 `mod.zip`，**逐字节原样**）+ [`index.json`](mods/index.json) | 由 `tools/build-index.mjs` 生成；入库闸门见 [`mods/README.md`](mods/README.md) |
| [`packs/`](packs) | **兼容已完成、验过的包** —— 能直接装 | **闸门**：里面必须全部装上 |
| [`incoming/`](incoming) | **组员上传、尚未完成兼容**的 mod 原件 | 只报告，**不拦**（被拒是正常的） |
| [`demo/`](demo) | **已过时的样板**（三份旧包，**不再对外提供、不要照抄**） | 退役：说明见 [`demo/README.md`](demo/README.md) |

另有一个**不是包**的目录：[`docs-copy-examples/`](docs-copy-examples/README.md) 只放文档里引用的
**可抄片段**（`notices` 的形状等），不参与任何闸门 —— 想照抄当前格式看它，别回头抄 `demo/`。

流程是一条直线：

```
incoming/<mod>  ──►  读来源说明、判断哪些部分有接口  ──►  改写成工坊包  ──►  packs/<包 id>
```

完整的链还多两步（站上发布、以及入库成 `mods/`），画出来是这样：

![投稿 → 兼容 → 收录](docs/img/repo-map.svg)

- **想上传一个 mod** → 先读 **[UPLOAD.md](UPLOAD.md)**（上传说明：要传什么、三种上传方式、
  照抄的 `SOURCE.md` 模板、上传前清单）
- **不想碰 git？** 本仓库自带一个**上传站**（[`site/`](site)）：网页上填「mod 名 + 备注」传 zip →
  维护者下载跑测试 → 名称与内容审过 → 自动上线到公开列表。部署见 [`site/README.md`](site/README.md)
- 收录的条件 → [`packs/README.md`](packs/README.md)
- 上传区的规则 → [`incoming/README.md`](incoming/README.md)
- **什么叫「标准工坊包」** → 引擎仓库的 [docs/STANDARD-PACK.md](https://github.com/XiaMo233M/Stronghold-Protocol-Forge/blob/main/docs/STANDARD-PACK.md)：七种投稿形态的定级、标准包的四条硬要求、`functional` / `documentation` / `unknown` 判据

> `packs/` 与 `mods/` 是**两份清单，不互相同步**：`packs/` 只收**提交进这里**的那几个包（解开的文件，进这里才算被本仓库收录）；
> `mods/` 是**站上全部已通过成品**的镜像（不透明 zip，字节级就是站上那份）。
> 两者的条数**以各自的 `README.md` 与 `index.json` 为准**，本 README 不写死。

## `mods/` 是什么

**站上已经通过的成品，逐字节镜像在这里**，外加一份机器可读的目录。它和 `packs/` 的分工：

| 目录 | 是什么 | 判定 |
|---|---|---|
| `packs/` | 我们**自己改写并验过**的兼容包（一份包一个目录，**解开的文件**） | **闸门**：必须全部装上 |
| **`mods/`** | **站上已通过的成品镜像**（一份包一个 `mod.zip`，**逐字节原样**）+ 索引 | 由 `tools/build-index.mjs` 生成 |

```
mods/
  index.json                        ← 唯一真相（机器可读目录）
  <包 id>/<版本>/mod.zip            ← 站上那份 mod.zip，逐字节原样（索引里的 sha256 才对得上）
  <包 id>/<版本>/meta.json          ← 站侧记录快照
  <包 id>/<版本>/decision.json      ← 站侧裁定快照
```

- **怎么用**：想装哪个包，直接下 `mods/<包 id>/<版本>/mod.zip`，再照[怎么装一个包](#怎么装一个包)那三步走。
- **要「字节级就是站上那份」，就用这里的 zip** —— `packs/` 里那份是**解开的文件**，git 的换行归一化会让它与站上差几个字节（这也是**为什么这里把 zip 原样收着、不解开**：解开就对不上 sha256 了，而「字节没走样」正是入库闸门的一条）。
- **`index.json` 是唯一真相**：每条都带 `sha256`、大小、文件数、`category`、许可与素材清点，全部**实测**得来。

**入库闸门**（`tools/build-index.mjs`；不满足就**报出来等人判**，工具绝不自己挑）：

| # | 闸门 | 判据 |
|---|---|---|
| 1 | **装得上** | 引擎自己的装载器（`loadWorkshop`）：`packsLoaded` 恰好 `[包 id]` 且 `errors = 0` |
| 2 | **字节没走样** | `mod.zip` 重算的 sha256 == manifest 里的值 |
| 3 | **不是说明包** | `category !== documentation`（业主口径：只收**非**说明文档） |
| 4 | **元数据齐** | `pack.json` 能读、`id` 与包内目录名一致 |

被退**不是打回**：站上那条记录照旧（不打回、不删），工具只是把原因逐条写进 `index.json` 的 `rejected[]`。

**素材**：含官方素材的包**照收**，但工具会按扩展名清点 zip 内**与 `.spresources` 容器内部**的图片 / 音频 / 字体 / Spine，把结果写进 `index.json` 与各包的 `PROVENANCE.md`（`.spresources` 是不透明容器，只看 zip 条目名会整批漏过，所以要解析容器头再清点一次）。**未标注才是问题**；标注了就算尽到告知义务。

## 站点（`site/`）现在能干什么

`site/` 是本仓库自带的**上传站 + 审核台**（部署与用法见 [`site/README.md`](site/README.md)）。下面每条都以 `site/` 的**当前源码**为准。

### 投稿流程（作者视角）

`/` 公网上传页填「mod 名 + 备注」→ 传 zip → 进待审队列（**疑似素材**的照收、单独存进 `flagged/`，上线要勾一次确认）。上传件必须是**扁平**的（`pack.json` 在 zip 根；套了顶层目录即 400）。要传什么、三种方式、上传前清单见 [`UPLOAD.md`](UPLOAD.md)，第一次做包先看 [`BEGINNER.md`](BEGINNER.md)。

### 用途分类（`funcKind`）：六类，与 `packKind` 是**两个维度**

| 维度 | 键 | 取值 | 它问的问题 |
|---|---|---|---|
| **用途**（业主真正要的那一栏） | `funcKind` | `gameplay` 游戏玩法 · `expansion` 拓展包 · `utility` 实用工具 · `assets` 素材替换 · `documentation` 说明文档 · `uncategorized` 未分类 | 「这包是干什么的」 |
| 技术 | `packKind` | `functional` / `documentation` / `unknown` | 「装上到底会不会生效」 |

- 两个键**故意不复用**（`site/server.mjs:1441`）；`uncategorized` **不是** `unknown` —— 老记录**没有** `funcKind` 这一栏，所以落未分类（`:646`）。
- ⭐ **一致性判据 `packKindFor(funcKind)`**（`:650`、`:656`）：归了用途类目，技术维度就**照着它派生**（`gameplay` / `expansion` / `utility` / `assets` ⇒ `functional`，`:178`），两栏不会各说各话。
- 公开面筛选：`/mods?func=…` 与 `/api/mods?func=…`（技术维度仍是 `?kind=…`）。
- 老记录的迁移脚本 [`site/migrate-funkind.mjs`](site/migrate-funkind.mjs) **默认干跑**：只认一条明确判据（`packKind=documentation ⇒ funcKind=documentation`），其余一律标「**留未分类，待人工过**」且**不写盘**。
- ⚠️ **`funcKind` 现在不在镜像里**：`mods/index.json` 只有技术维度的 `category`，31 份 `meta.json` 快照**一份都没有** `funcKind` ⇒ 要它进镜像，得**重新导出 staging** 再重跑 `tools/build-index.mjs`。

### ⭐ 「以新为准」`POST /api/<ADMIN_PATH>/supersede`

业主 2026-10-13 总政策：「**以后所有 mod 以新为准** —— 新的上线、旧的下架但**不删除**」。

- **一次一对**（`newId` + `oldId`），**强制同 `pack.id`**，且新的那条要**已在公开面**（`site/server.mjs:1112`）。
- 判据只有一份 `checkSupersede()`（`:1109-1124`），**先算不写** —— 任何一道不过，**磁盘上什么都不改**。错误码可机读：`SUPERSEDE_SELF` · `SUPERSEDE_OLD_NOT_FOUND` · `SUPERSEDE_NEW_NOT_FOUND` · `SUPERSEDE_PACK_ID_UNREADABLE`（**读不出 `pack.id` 就不猜、不动它**） · `SUPERSEDE_PACK_ID_MISMATCH` · `SUPERSEDE_CYCLE`（取代环，`chain` 给出整条链）。
- 旧的落 `decision = superseded` + `replacedBy { id, name, area, at }`（`markReplacedBy`，`:1050-1068`）；**旧的 `meta.json` 与 `mod.zip` 一个字节都不动**，而 `decision.json` 是整份覆盖，所以覆盖前会留一笔 `decisionSnapshot`（`:2644-2661`）。旧的**可以是兼容包**（那道 `area === 'compat'` 的硬拦已放开，`:1037-1041`）。
- ⚠️ **公开面按「记录」列，不按 `pack.id` 去重**（可见性只读 `state === 'approved'` 与 `withdrawRequested`，`:289`）⇒ 同一个 `pack.id` 的两条会**同时公开**，所以这一步必须**显式做**，不能指望站点自己发现重名。

### 发布者自助删除：三档，**只有一档会真删**

| 档 | 端点 | 结果 |
|---|---|---|
| **档 1 软删** | `POST /api/publisher/delete`（`:59`） | 转 superseded 终态（`replacedBy: null` / `reason: publisher-delete`），**一按即生效、不经管理员** |
| **自撤** | `POST /api/publisher/withdraw`（`:58`）＋ 管理员 `…/withdraw-decide`（`:62`） | **公开面立刻不再列出**；落终态要管理员确认 |
| **档 3 硬删** | `POST /api/publisher/delete-hard`（`:61`） | **两次调用二次确认** ＋ **先落墓碑**（`tombstones/`，`:111`）再物理删；撞上引用 ⇒ **409 先报人** |

站上「**零删除**」是默认，**唯一例外就是档 3**（授权注释在 `:44-46`）。

### 兼容包流程（我们这一侧）

| 端点 | 干什么 |
|---|---|
| `POST /api/<ADMIN_PATH>/compat-submit`（带 `publish=1` 一步到位） | 上传改写件 → 通过 → 发布（`:919`） |
| `POST /api/<ADMIN_PATH>/compat/decide` | 对**已在记录里**的兼容包补一次通过 / 打回（`:921`） |
| `POST /api/<ADMIN_PATH>/compat/link` | 只给**已在记录里、已通过**的兼容包补 `compatOf`，并让原投稿按 B 口径置 superseded；不改决定、不发布（`:923`） |

⭐ **快照门 `compatPublishGate`**（`:977-987`）＝ 署名 → 快照在 → 快照里的原注释**一字未变** → 磁盘上那份没被换过。它把**提交时留下的 `pack.json` 快照**与**眼下的**那一份**逐字段**比（`packDiff`，`:961-974`），不一致就**把哪几栏被动了直接摆出来**并拒绝（`needsPackUnchanged`）—— 「保持原注释不变」是**硬要求**。兼容者 `compatAuthor` **必填但值可以为空**（`compatAuthorSource` 只有 `form` / `empty`，没有兜底档），且**永不进 `pack.json`**，只存在站点侧。

### 管理口口径

`ADMIN_IPS`（**只认回环**）＋ 令牌两道（`site/server.mjs:122`、`:133`）；审核动作全部要 `x-admin-token`（`:16`，`timingSafeEqual` 比对）。⚠️ **本文与任何提交都不写凭据** —— 认领码 / 发布者令牌 / `ADMIN_TOKEN` / Basic 头在站上**一个字节都不落盘**（`:337`）。

## `demo/` 里的三份样板 —— **已过时，不再对外提供**

这三份旧包**退役**了：它们要展示的能力**引擎已内建**，或已被上游后续实现覆盖。
**不要拿来装、不要拿来照抄**；逐包理由见 [`demo/README.md`](demo/README.md)。

> 审核站上对应这三份的记录已**逐个打回**：公开列表里看不到，下载口返回 403（记录保留，可追溯）。
> 包本身的内容**一字未改**，保留只为让本仓库的来源与署名说明（[NOTICE.md](NOTICE.md)）仍能追溯。

| 包 | 版本 | 层 | 许可 |
|---|---|---|---|
| [`demo/fanpack-kazdel-rhodes`](demo/fanpack-kazdel-rhodes) | 1.0.0 | B（**会改战斗结果**） | 非商业同人作品 |
| [`demo/plugin-pack`](demo/plugin-pack) | 0.3.1 | C | **CC0-1.0**（原作者 Ausevay） |
| [`demo/sp-resource-pack`](demo/sp-resource-pack) | 0.2.0 | C | **GPL-3.0-only** |

每个包**以自己的 `pack.json` 里的 `license` 为准**；原件自带的许可与来源说明原样随包。
本仓库整体的许可见 [LICENSE](LICENSE)。

## 怎么装一个包

1. 把 `packs/<包 id>/` 里的**内容**压成 zip：包内文件放进**一个顶层目录**里，目录名就用**包 id**
   （不要比这一层再多套一层文件夹）。压完检查 `pack.json` 的路径：
   **必须是 `<包 id>/pack.json`** —— 顶层目录 + 文件名，也就是「深度为 2」。
   **一包一 zip**：不要把 `packs/<包 id>/` **整个目录**再压进去（那会变成 `<包 id>/<包 id>/pack.json`，
   装载器读不到 `pack.json`）。
2. 把 zip **拖到**便携包根目录的 `安装工坊包.bat` 上（或 `安装工坊包.bat <包.zip>`）

   > 上面这条是**本地安装 / 仓库收录**的形状。**要投到审核站（上传）时反过来**：站点只读 **zip 根**的
   > `pack.json`，套了顶层目录即 400 —— 见 [`SKILL.md`](SKILL.md) §3 与 [`AGENTS.md`](AGENTS.md) §6 ⑧。
3. 装好后包落在 `app/workshop/<包 id>/`。⚠ **游戏里没有「工坊界面」**（`public/js/screens/` 下没有
   这样一个屏），所以它**不会**出现在任何界面上；要确认装上了，看启动日志那一行
   `[workshop] applied <n> pack(s): …`，以及游戏内容本身变没变（换的立绘、加的内容）。
   **改完包必须重启服务器** —— 引擎没有热重载。
   第一次做包 / 第一次装包，先看 [`BEGINNER.md`](BEGINNER.md)（引擎包内那一份是 `app/docs/START-HERE.md`，
   两份同源、要一起改）。

**目录名必须等于 `pack.json` 的 `id`**，否则装载器整包跳过（引擎会报 `PACK_ID_MISMATCH`）。

卸载就是删掉 `app/workshop/<包 id>/`。

> 装了 `combat` 为真的包，对局结果可能与官方不同 —— 请知情后使用。

## 怎么写 / 怎么改包

**两份说明书的分工，先看清再读**：

| 文件 | 给谁 | 讲什么 |
|---|---|---|
| [SKILL.md](SKILL.md) | **包作者** | 包格式、层、`api` 与 `game`、四个沉默的坑（未知顶层键 / `api` 写成数字 / `content` 没声明 `chess` / 未声明的通道）、`notices` 公告与鸣谢、「有更好的逻辑就用我们的」、面板 `ctx`、署名纪律（含「哪份文件归谁」）、工作流、做不成包的情形、术语约定；**§19 引擎这一版新加的接口面**（`behaviour` **五格** / `target` / `dependencies`·`conflicts` / 宿主 lane / mod 登记册 / **`trait.grantsBonds`（§19.7，已合入）** / **`pack.json.callBudget`（§19.10）** / **房间级 mod 集合与同意（§19.11）** / **第 10 个挂载点 `screen.room.aside`（§19.12）** / **kit 白名单 22 条（§19.13）** / **`stripDiyOverlaps` 投稿口径（§19.14）** / **`globalThis` 回到禁止名单（§19.15）** / **`pack.json.matchKinds`（§19.16）** / **`client.screens` 整屏替换（§19.17）** / **`server.modules[].lane`（§19.18）** / **`server.room.hold`（§19.19）**，**含「还没有」的那几条**）与 **§20 今天就能用的老面**（`server.meta` 条件叠层等） |
| [AGENTS.md](AGENTS.md) | **维护者 / AI agent** | 五条收录闸门（含「带上真实功能」「`combat` 要标注清楚」）、审核站与兼容包发布流程、操作纪律（批准类端点绝不批量调、绝不打印凭据…） |

两份**不重叠**：一份讲怎么写，一份讲怎么审与怎么发。都读的话，先读 SKILL.md。

包格式与层级的**最终依据是引擎**（本仓库只做索引）—— 冲突时以引擎代码与
`docs/WORKSHOP.md` / `docs/MOD-SURFACE.md` / `docs/design/mod-layer.md` 为准。

> 文档里引用的**最小可抄片段**在 [`docs-copy-examples/`](docs-copy-examples/README.md)（不是包，不参与闸门）。

## 验包

```bash
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge            # 三个目录一起看
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --json     # 机器可读

node tools/build-index.mjs --stage <站侧导出目录> --engine <引擎检出>            # 只报，不写盘
node tools/build-index.mjs --stage <站侧导出目录> --engine <引擎检出> --write    # 真写 index.json
node tools/build-index.mjs --stage <…> --engine <…> --write --prune-stale       # 真写 + 清掉站上已不 live 的旧版本目录
node tools/build-index.mjs --stage <…> --engine <…> --assert-only              # 只核「应 live 的一条没掉」

# 站侧导出（只读站点）就是本仓库里那一份 tools/collect-station.mjs：
ssh <站点主机> 'node <仓库>/tools/collect-station.mjs --out /tmp/modrepo-stage' > stage.tar
```

`check-packs.mjs` 用**引擎自己那一份装载器**过一遍三个目录，逐个报出「装上了 / 被拒的理由」。
`--root packs` 可以只看某一个目录；`--json` 给机器读。
退出码非 0 表示 **`packs/` 或 `demo/` 里有包装不上**（工具把两者都当闸门，这次退役没有改动工具）。
`demo/` 已**不再对外提供**（见 [`demo/README.md`](demo/README.md)）—— 闸门管的是「文件还装得上」，不是「可下载」。

`build-index.mjs` 从**站侧导出**生成 `mods/index.json`（布局见 [`mods/README.md`](mods/README.md)）。
它**不在本仓库里重写校验规则** —— 包的格式、能不能装、装成哪一层，全部调用引擎那一份（`loadWorkshop`）；
索引里每个字段都**实测**得来。默认**只报不写盘**，要落盘得显式 `--write`。
`--prune-stale` 才会清「站上对应记录已不在接受集、本次也没入选」的旧版本目录，**且带守卫**
（先打印将要删的清单 → 状态核不到的一律不删 → 删完断言应 live 的一条没掉）；
`--assert-only` 是那条断言的单独复核入口（只读、不装载、不写盘）。细则见 [`mods/README.md`](mods/README.md)。

### 镜像重建的**两道判据**（缺一不进，且必须按这个顺序）

```bash
# ① 站侧采集：只读站点，导出一份 staging
node tools/collect-station.mjs --out /tmp/modrepo-stage
# ② 生成索引：默认只报不写盘，要落盘得显式 --write
node tools/build-index.mjs --stage /tmp/modrepo-stage --engine <引擎检出> --write
```

- **① 的选择口径**：`state === 'approved'` **且** `meta.packKind === 'functional'`（`tools/collect-station.mjs:119`、`:197`）。
  所以「站上已通过」**不等于**「能进镜像」：`documentation` / `unknown` 都不入选。
  `manifest.json.mods[]`（入选清单）与 `_selection.json`（采集时刻**全部**记录，含未入选）**不是一回事**（`:19-20`）。
- **② 的四道硬闸门**：装得上（引擎自己的装载器，`packsLoaded` 恰好 `[包 id]` 且 `errors = 0`）/ 字节没走样（`mod.zip` 重算的 sha256 与 manifest 一致）/ 不是说明包（`category !== 'documentation'`）/ 元数据齐（`pack.json` 可读、`id` 与目录名一致）。不满足就**报出来等人判**，工具绝不自己挑。
- ⚠️ **重建必须走「站侧重新导出 staging → 重跑 `build-index.mjs`」**，不许跳过第 ① 步。
- ⚠️ **本仓库的 agent 禁 `ssh`**（见 [AGENTS.md](AGENTS.md) §3）：第 ① 步交给人或专门那一路去做。
- ⚠️ **不许改脚本，也不许手改 `mods/index.json`**：索引里每个字段都是**实测**得来；「抄一份就是第二个会漂移的真相」（`tools/collect-station.mjs:9-12`）。

## 兼容性

包的闸门是 `api`（模组 API 版本区间），引擎**会强制比对**：引擎当前的 `MOD_API_VERSION` 是 `1`，
所以这里的包都声明 `">=1 <2"`（`"1.x"` / `"1"` / `"^1"` 这类写法同样合法）。
引擎抬到 2 时它们会被**明确拒掉**并说明理由 —— 宁可拒绝，也不要带着过时的行为跑起来。
届时本仓库会跟着升级。

## 什么样的包会被收发

- **要带上真实功能**：装上会改变某项游戏内行为（数据 / 界面 / 服务端任一层）才收；
  自述 `documentation-only` / 只读参考 / 只放 JSON 与说明面板的**不上架** —— 但**处理方式是
  「留在待审」，不是「打回」**：**记录与简介要保留**，那是我们**做兼容包改写的依据**
  （打回会写下 `decision.json` 的 `rejected`、该条离开待审队列掉到 `?view=rejected`）
  —— 等它带上真实功能再上架（见 [AGENTS.md](AGENTS.md) §4）。
- **会改对局结果的包要标注清楚**：`combat: true` 的包**不另设闸门**（mod 由房主建房间时自己选装），
  但**必须在包自述里讲明「会影响对局结果」**；不标才是问题（见 [SKILL.md](SKILL.md) §4）。

## 还不能做什么

和上一节一样重要 —— 写在这里，是为了让「能不能用」有一个当场能查的答案。

| 还不行 | 具体到什么程度 |
|---|---|
| **在站上单独标出「会改对局结果」** | 站点代码里**没有任何 `combat` 字样**（`site/*.mjs`、`site/pages/*.html` 全无）⇒ 站上**目前不显示**这一栏。`/mods` 公开面能承载自由文本的只有「**兼容说明**」一栏；想让它成为独立的一栏，需要改站点代码 —— 那件事不在本文档的改动范围里（见 [AGENTS.md](AGENTS.md) §5.1）。 |
| **`packs/` 与 `mods/` 自动同步** | 两者**不互相同步**。站上新增已通过的包 ⇒ **重跑 `build-index.mjs`**，不要手工往 `index.json` 里补条目。 |
| **`mods/` 里的包直接改** | `mods/` 下的包内容**只读**（审核与分发用）。要改包请回到站上的兼容包流程。 |
| **超大单文件在两条路上都装得上** | 单文件超过引擎默认 zip 读取上限（`shared/zip.js` 的 `ZIP_MAX_FILE_BYTES = 32 MB`）**不再是退件理由** —— 工具会放宽上限收录，并在 `index.json` 的 `notes` 里**如实记下**：引擎自带的包导入路径（编辑器「包管理」/ `workshop-pack.mjs import`）**会拒收它**，而站点侧读取器没有这个上限 ⇒ **两条路结论不同**。 |
| **说明包上架** | 自述 `documentation-only` / 只读参考的包**不上架**，但**留在待审、不打回**（它的简介是我们做兼容包改写的依据）。 |
| **本仓库的 agent 连服务器** | 不 `ssh`、不直连服务器做操作；站点上的动作走 [`site/README.md`](site/README.md) 里的管理 API 与隧道（见 [AGENTS.md](AGENTS.md) §3）。 |
| **在界面上切换一个包的启停** | 引擎**有** mod 登记册（`server/modRegistry.js`）＋ CLI（`tools/workshop-pack.mjs enable` / `disable` / `uninstall` / `rollback`），但**编辑器还没接它** —— 今天看得见启停的只有 CLI、管理器 `list`，以及启动那一行 `[mod-registry] "…" disabled — not loaded`。做法与「两道闸」见 [SKILL.md](SKILL.md) §19.5。 |
| **同一个 `pack.id` 自动去重** | **没有**：公开面按**记录**列、不按 `pack.id` 去重（`site/server.mjs:289`）⇒ 同一个 `pack.id` 的两条会**同时公开**；「新版上线」要**显式**调 `POST /api/<ADMIN_PATH>/supersede`（见上面「以新为准」一段）。 |
| **`funcKind` 进镜像** | **还没有**：`mods/index.json` 只有技术维度的 `category`，31 份 `meta.json` 快照**都不带** `funcKind` ⇒ 要它进镜像，得**重新导出 staging** 再重跑 `tools/build-index.mjs`（工具不会从别处补这一栏）。 |

### 已经**能用了**（本版按引擎当前树更正的几条）

上一版在「还不行」那一栏写过的几条，按引擎**当前树**核过之后应当归入「能用」：

| 现在能做 | 到什么程度 |
|---|---|
| **`trait.grantsBonds`（特质 → 视为某几个盟约的成员 ⇒ 叠层）** | ✅ 引擎 **`0.17.0`** 起已合入（设计稿 §28.49）：一条 `chess` 记录写 `trait.grantsBonds = ["<盟约 id>", …]`，**一格数据、不用写代码**。盟约 id 不存在或形状写歪 **点名但不拒包**（`TRAIT_GRANT_UNKNOWN_BOND` / `TRAIT_GRANT_BAD_SHAPE` / `TRAIT_GRANT_EMPTY`），作者侧在 `npm run workshop:validate` 时就能看到；不写这一格 ⇒ 逐字节不变、不需要 `golden:update`。想**按条件算**层数（不是固定映射）仍走 `server.meta` —— 两条路的分工见 [SKILL.md](SKILL.md) §19.7 与 §20.1。 |
| **`server.modules[].channels`（包通道的服务端那一半）** | ✅ 引擎**有**这一格（设计稿 §28.23）：`server.modules[]` 的字段是 `id` / `entry` / `uses` / `write` / **`channels`**。规则四条 —— 每模块 **≤ 8 条**、名字形状同 `client.panels[].messages`、**必须同时声明 `matchClass`**（`MODULES_CHANNELS_NEED_MATCH`）、且每一条都要**被本包某个面板声明过**（`MODULES_UNKNOWN_CHANNEL` 整包拒）。写法与边界见 [SKILL.md](SKILL.md) §19.8。 |
| **`pack.json.enabled`（装好 ≠ 生效）** | ✅ 引擎**有**这一格（设计稿 §28.50）：**只有布尔**；`true` 与不写**逐字节相同**，`false` 的包**留在原处但不参与**、进装载结论的 `errors`（`ENABLED_FALSE`）并**逐条点名**。见 [SKILL.md](SKILL.md) §19.9。 |
| **`behaviour` 第 5 格 `diyPoolOverlap`（自选池重叠）** | ✅ 引擎**有**这一格（`shared/behaviour.js:203`）：`report`（缺省）＝逐条点名、池子不动；`strip`＝把**本包**做成棋子的那几名干员从自选池摘出名单。⚠️ 它是全表**第一格「按包读取」**的开关（**刻意不走** `mergeBehaviourDecls`）。三件投稿 `columbia` / `rimbilliton` / `rainbow-squad` 带的就是它 —— 投稿里那个 `stripDiyOverlaps` 顶层键**必须删**并改成这条声明（口径见 [SKILL.md](SKILL.md) §19.1 与 §19.14）。 |
| **`pack.json.callBudget`（每局每插件的调用次数上限）** | ✅ 引擎**有**这一格（设计稿 §28.52，沙箱档的运行时保护）：`{ max? }`，缺省 **8000**，⭐ **只许收紧不许放宽**（调高 ⇒ `CALL_BUDGET_TOO_HIGH`）。耗尽 ⇒ 回滚该包的 hook / 计时器 / 标记 buff ＋记一笔 `plugin:<包 id>` 的错。`kits/*.js` 的逐单位回调**也归账**，只带 `kits/` 没有 `server.battle` 的包也建账。见 [SKILL.md](SKILL.md) §19.10。 |
| **房间级 mod 集合与同意（`room.mods` / `MOD_SET_LOCKED` / `MOD_CONSENT_REQUIRED`）** | ✅ 引擎**有**（设计稿 §28.53）：房主可以在房间里改集合（已开局或有人 ready ⇒ `MOD_SET_LOCKED`）；真人进一个声明了模组的房间要在 `room.join` 里带 `consent: true`，否则 `MOD_CONSENT_REQUIRED` —— 同意的是**一份字节指纹**，集合一变就自动作废。见 [SKILL.md](SKILL.md) §19.11。 |
| **第 10 个界面挂载点 `screen.room.aside`** | ✅ 引擎**有**（设计稿 §28.8）：房间屏（等待开局那一屏）的**旁栏**，由**组件渲染**（不是引擎按需造的浮层）。`PANEL_SEND_TYPES` 同时变成**两条**（`room.appearance` ＋ `room.mods`）；⚠️ `room.create` **永远不在**里面。见 [SKILL.md](SKILL.md) §7 与 §19.12。 |
| **`pack.json.matchKinds`（第二种对局的声明面）** | ✅ 引擎**有**这一格（设计稿 §28.54）：`matchKinds = [{ id, seats?: { min, max }, label? }]`，每包 **≤ 4 种**、座位 **1..12**、id 形状与包通道同一条。**必须有接收人** —— 本包要有一个挂了 `matchClass` 的 `server.modules` 条目，否则 `MATCHKINDS_NEED_MATCH_CLASS` **整包拒**。它是**声明与协商面，不是分派表**：管理器**不认玩法名**，判定住在包自己的模块里。不写 ⇒ 不进摘要。见 [SKILL.md](SKILL.md) §19.16。 |
| **`client.screens`（整屏替换）** | ✅ 引擎**有**这一格（设计稿 §28.55）：`client.screens[] = { id, route, module, order?, styles?, data?, messages? }`，路由是**闭枚举**且只有引擎真有的那四条（`title` / `lobby` / `room` / `game`）—— 写 `result` 或 `loadout` 是永远不会命中的死声明。屏 id 与面板**共用**一个包内命名空间。**移动端可用**：路由是语义名、全屏用 `inset: 0`，没有像素或桌面视口假设。见 [SKILL.md](SKILL.md) §19.17。 |
| **`server.modules[].lane`（包自带一条 WebSocket 通道）** | ✅ 引擎**有**这一格（设计稿 §28.56）：`lane = { path, summary? }`，路径必须落在 `/mod-ws/<本包 id>` 之下。`SERVER_MODULE_USES` 6 → **7**、`SERVER_MODULE_FIELDS` 5 → **6**。⚠️ **结构性保证一个字没改**：包仍然拿不到监听套接字 / 新端口 / 定时器 / 子进程 —— 开与不开、怎么记账都归宿主。`MOD_API_VERSION` **不动**。见 [SKILL.md](SKILL.md) §19.18。 |
| **`server.room.hold`（空席房间的回收裁决）** | ✅ 引擎**有**这一格（设计稿 §28.57）：只有 `pack.json.server.room.hold = true` 的包才能调 `room.canHold(fn)`（没声明就调 ⇒ `ROOM_HOLD_UNDECLARED` 点名）。**它要 `combat: true`**（`ROOM_HOLD_NEEDS_COMBAT`）—— 它能决定一局会不会因为「没真人了」而被回收。**包决定「留不留」，宿主决定「留多久」**：硬时限 **15 分钟**；多包是 **OR**，时限取**最早**那一票。见 [SKILL.md](SKILL.md) §19.19。 |

> **底座（源码口径）**：本仓库的包对着引擎**源码当前状态**核过 —— `APP_VERSION = 0.19.0`、`UPSTREAM_VERSION = 0.3.0`（`shared/constants.js` 的实值），对齐的提交是引擎 `main` 的 `37e16197e2c73d19e6e554f8bae7ebb32efd2bb8`（发行 tag `v0.19.0-0.3.0`）。⚠️ 这里说的是**引擎仓库 `main` 上的源码**，**不是**某个已发布的整合包 —— 可下载的发行版以引擎仓库的 Releases 页为准。上一版文档里写「底座 0.2.4 / 0.2.5 / 0.2.6」的地方一律以这一行为准。
> ⚠️ **上游 0.3.0 已合入**（合并提交 `0bfe3727`，落在引擎 `main` 上）⇒ [SKILL.md](SKILL.md) §19 已按合入后的树重核；**§19.16–§19.19 就是这次合入新落的四条面**。
>
> ⭐ **引擎 `v0.19.0-0.3.0` 已经发版**（2026-10-16，tag `v0.19.0-0.3.0` → `37e16197`）。这一版的作者可见变化：
> **§28.54 `matchKinds` / §28.55 `client.screens` / §28.56 `server.modules[].lane` / §28.57 `server.room.hold`** 四格声明面；
> **kit 白名单 20 → 22**（新开 `@sim/body.js`、`@sim/professions.js`）；**`PACK_FIELDS` 37 → 38**；
> **`SERVER_MODULE_USES` 6 → 7**（尾巴是 `lane`）；四语 i18n 各补 540 条至 **100 %**（2096/2096）。
> ⚠️ **`PROTOCOL_VERSION`（2）与 `MOD_API_VERSION`（1）都没动** ⇒ 老包不受影响。
> 完整包还补进了**官方战斗特效素材**（`public/assets/local/fx/`，12534 个文件）—— 那是**引擎侧发行包**的事，
> 与本仓库的包无关，但作者若在自己的包里引用这批特效，请以引擎 `v0.19.0-0.3.0` 的完整包为准。

