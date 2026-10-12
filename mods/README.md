# `mods/` —— mod 仓库（站上已通过的成品）

这个目录是**本站 mod 的分发本体**：站上**已通过**、**非说明文档**的包，逐字节原样收在这里
（**含官方素材的也收** —— 素材不拦、如实标注，见下），外加一份机器可读的目录 [`index.json`](index.json)。

它和 `packs/` 的分工：

| 目录 | 是什么 | 判定 |
|---|---|---|
| `packs/` | 我们**自己改写并验过**的兼容包（一份包一个目录，解开的文件） | **闸门**：必须全部装上 |
| **`mods/`** | **站上已通过的成品镜像**（一份包一个 `mod.zip`，逐字节原样）+ 索引 | 由 `tools/build-index.mjs` 生成，四道硬闸门 |

## 布局

```
mods/
  index.json                        ← 唯一真相（机器可读目录）
  <包 id>/<版本>/mod.zip            ← 站上那份 mod.zip，**逐字节原样**（索引里的 sha256 才对得上）
  <包 id>/<版本>/meta.json          ← 站侧记录快照
  <包 id>/<版本>/decision.json      ← 站侧裁定快照（含 reason / compatOf 等）
  <包 id>/<版本>/PROVENANCE.md      ← 六项署名（工具从站侧事实机械生成，缺的写「未声明」，不编）
```

**为什么不把 zip 解开**：解包会**丢掉 zip 字节的 sha256**，而索引里那个哈希正是「下载到的就是站上那份」的唯一凭据。
所以载荷只留一份 zip，闸门要看内容时**解到干净临时根**再交给引擎装载器 —— 一个游离文件不可能悄悄混进包而改变身份。

## 生成（**不要手改** `index.json` 与各 `PROVENANCE.md` 的机械部分）

```bash
node tools/build-index.mjs --stage <站侧导出目录> --engine /path/to/Stronghold-Protocol-Forge
node tools/build-index.mjs --stage <…> --engine <…> --write     # 加 --write 才真写盘
```

`<stage>` 由站侧导出：`manifest.json` + `mods/<站点编号>/{mod.zip,meta.json,decision.json}`。

## 四道硬闸门（不满足就不入库，**报出来等人判**，工具绝不自己挑）

| # | 闸门 | 判据 |
|---|---|---|
| 1 | **装得上** | 引擎自己的装载器（`loadWorkshop`）：`packsLoaded` 恰好 `[包 id]` 且 `errors=0` |
| 2 | **字节没走样** | `mod.zip` 重算的 sha256 == manifest 里的值 |
| 3 | **不是说明包** | `category !== documentation`（业主口径：只收**非**说明文档） |
| 4 | **元数据齐** | `pack.json` 能读、`id` 与包内目录名一致 |

> **素材不拦，改为如实标注**（业主 2026-10-12：「以后不用打回所有有敏感素材的 mod，
> 如实上传并做到标注好含官方素材就行」）。工具按扩展名清点 zip 内**与 `.spresources`
> 容器内部**的图片 / 音频 / 字体 / Spine，把结果写进 `index.json`（`assets` 字段）与
> 各包的 `PROVENANCE.md`（「素材与授权」一节），由下载者与审核者自己看见。
> **未标注才是问题**；标注了就算尽到告知义务。

**第 4 条（清点）为什么连容器一起看**：`.spresources` 是不透明容器，从 zip 层只看得到一个条目，
里面可能装着几百个素材文件 —— 只看 zip 条目名会**整批漏过**。所以工具会解析容器头
（`SPRES001` + uint32 小端 `headerLen` + 压缩 JSON 头，头里有 `manifest.files[]`）再清点一次。

## `category` 判据（按序判，写**实测值**，不抄别处）

见引擎仓库 [docs/STANDARD-PACK.md](https://github.com/XiaMo233M/Stronghold-Protocol-Forge/blob/main/docs/STANDARD-PACK.md) §三：
① 声明了 `content / overrides / kits / variants / behaviour / client / server / assets / notices / routes` 任一 ⇒ `functional`；
② 否则若包**自述**是参考/说明包 ⇒ `documentation`；③ 都不满足 ⇒ `unknown`（不入库，报人判）。

## 什么时候重新生成（⚠️ 每次发版前都跑一次）

`mods/` 是**站上某个时刻的快照**，不是自动跟随的。**站上一旦新批了包，镜像不会自己变** ——
所以在**每次发版前**都要重新导出一次 staging、重跑 `build-index.mjs --write`，再逐条核对
「已经 live 的包一条没掉」。不做这一步，`mods/` 与站上就会悄悄分叉。

**实测过的分叉（2026-10-12）**：索引生成于 `07:43Z`，而站上 `84ab02864356`（chat-bubble）与
`b6a3f39ae9ad`（duel-mode v0.2.1）分别在 `08:26Z` / `08:40Z` 才通过 ⇒ 两条都**漏收**，
`mods/duel-mode/` 还停在已被取代的 v0.1.0 上。

⚠️ **最容易踩的那个坑：同一个包 id 有「旧版先 approved → 新版后 approved」的更替时，
只重跑工具、不重新导出 staging，镜像会停在旧件。** 因为闸门里没有「同 id 取新版」这一条 ——
工具只按 staging 给的清单收件，**新旧哪一条进 staging 由导出那一步决定**。
所以「重新导出」和「重新生成」**必须成对做**，缺一个就会留下一个看不见的旧版本。

## 同一个包 id 出现两份公开件：只镜像一条（以及为什么）

引擎**不允许同 id 并存**（同一 workshop 根里放两份 id 相同的包 ⇒ 只装载 1 条，后者静默覆盖前者），
所以导出时按**包内 `pack.json.id`** 去重，一个 id 只放一条进 staging。判定顺序（确定性）：
**① 上传时间晚者优先 ② 批准时间晚者优先 ③ 站点编号大者优先**
（把上传时间排第一，是因为两条常常是**同一批一起批准**的，批准时间分不出新旧）。

**当前这一条**（`index.json` 的 `source.excludedSamePackId` 里也原样带着）：

| 站点编号 | 包 id | 版本 | 处置 |
|---|---|---|---|
| `05c6dd5c5844` | `duel-assets` | 0.1.0 | **收录**（`mods/duel-assets/0.1.0/`） |
| `d19511bd5485` | `duel-assets` | 0.1.0 | **不镜像**（同包 id 只能一条） |

两条的**载荷完全相同**（`pack.json` 之外三个成员逐字节相同），只差 `pack.json` 里的 `name`：
前者「客户端导出 · 非商业」、后者「官方解包件」。站上两条都仍是公开记录 ——
**不镜像 ≠ 下架**，这里只是「仓库里同一个包 id 放不下一份」。

## `_selection.json` 是采集清单，`manifest.json` 才是入选清单

每次导出会在 staging 里留两个文件，**它们不是一回事**：

| 文件 | 里面是什么 |
|---|---|
| `_selection.json` | **采集时刻的全部记录**（含当时 `pending` / `superseded` / `rejected` 的）—— 它的用途是留档「这一刻站上都有什么」 |
| `manifest.json` 的 `mods[]` | **入选清单**：`state=approved 且 packKind=functional` 再按上面的规则去重之后的那些 |

判「缺了哪个包」请**按 `manifest.json` / `index.json` 判**，不要拿 `_selection.json` 比 ——
那里面本来就有一堆不该入库的记录。

## 关于被退件的包

工具会**逐条列出**退件与原因（写进 `index.json` 的 `rejected[]`）。被退**不是打回**：
站上那条记录照旧（不打回、不删）。今天只可能因为两类原因被退 ——

- **装不上 / 字节对不上 / 元数据不齐** ⇒ 这是硬闸门，改包或改导出，不放宽。
- **`category` 量成 `documentation`** ⇒ 业主口径是只收**非**说明文档；说明包留在站上待审即可。

⚠️ **单文件超过引擎默认 zip 读取上限**（`shared/zip.js` 的 `ZIP_MAX_FILE_BYTES = 32 MB`）
**不再是退件理由** —— 工具会放宽上限把包读进来并收录，但会在 `index.json` 的 `notes` 里
**如实记下**：「引擎自带的包导入路径（编辑器「包管理」/ `tools/workshop-pack.mjs import`）
会拒收它；站点侧读取器没有这个上限 ⇒ 两条路结论不同」。
下载者按哪条路装，自己看得见。

## 纪律

- `mods/` 下的**包内容只读**（审核与分发用），不要顺手「优化」；要改包请回到站上的兼容包流程。
- **本仓库的 agent 不要 `ssh`**（[AGENTS.md](../AGENTS.md) §3）。
- 站上新增已通过的包 ⇒ **重新导出 staging + 重跑 `build-index.mjs --write`**（见上面
  「什么时候重新生成」），不要手工往 `index.json` 里补条目。
- `mods/` 是**生成物**：`<包 id>/<版本>/` 由导出清单决定。旧版本目录**随生成规则替换**，
  这不算「删站上记录」—— 站上那条记录一个字节都不动；`mods/` 的历史由 git 留着。
  但**删之前要看一眼**：旧目录必须先确认站上那条已被取代（`superseded`）才让它消失。
