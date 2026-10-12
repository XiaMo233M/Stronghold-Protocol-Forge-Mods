# `mods/` —— mod 仓库（站上已通过的成品）

这个目录是**本站 mod 的分发本体**：站上**已通过**、**非说明文档**、**且不含游戏素材**的包，逐字节原样收在这里，
外加一份机器可读的目录 [`index.json`](index.json)。

它和 `packs/` 的分工：

| 目录 | 是什么 | 判定 |
|---|---|---|
| `packs/` | 我们**自己改写并验过**的兼容包（一份包一个目录，解开的文件） | **闸门**：必须全部装上 |
| **`mods/`** | **站上已通过的成品镜像**（一份包一个 `mod.zip`，逐字节原样）+ 索引 | 由 `tools/build-index.mjs` 生成，五道硬闸门 |

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

## 五道硬闸门（不满足就不入库，**报出来等人判**，工具绝不自己挑）

| # | 闸门 | 判据 |
|---|---|---|
| 1 | **装得上** | 引擎自己的装载器（`loadWorkshop`）：`packsLoaded` 恰好 `[包 id]` 且 `errors=0` |
| 2 | **字节没走样** | `mod.zip` 重算的 sha256 == manifest 里的值 |
| 3 | **不是说明包** | `category !== documentation`（业主口径：只收**非**说明文档） |
| 4 | **不含游戏素材** | 本仓库的**素材红线**（[AGENTS.md](../AGENTS.md) §3 / §4 第 4 条）：按扩展名清点 zip 内**与 `.spresources` 容器内部**的图片 / 音频 / 字体 / Spine ⇒ 命中即不入库 |
| 5 | **元数据齐** | `pack.json` 能读、`id` 与包内目录名一致 |

**第 4 条为什么连容器一起看**：`.spresources` 是不透明容器，从 zip 层只看得到一个条目，里面可能装着几百个素材文件 ——
只看 zip 条目名会**整批漏过**。所以工具会解析容器头（`SPRES001` + uint32 小端 `headerLen` + 压缩 JSON 头，
头里有 `manifest.files[]`）再清点一次。

## `category` 判据（按序判，写**实测值**，不抄别处）

见引擎仓库 [docs/STANDARD-PACK.md](https://github.com/XiaMo233M/Stronghold-Protocol-Forge/blob/main/docs/STANDARD-PACK.md) §三：
① 声明了 `content / overrides / kits / variants / behaviour / client / server / assets / notices / routes` 任一 ⇒ `functional`；
② 否则若包**自述**是参考/说明包 ⇒ `documentation`；③ 都不满足 ⇒ `unknown`（不入库，报人判）。

## 关于被退件的包

工具会**逐条列出**退件与原因（写进 `index.json` 的 `rejected[]`）。被退**不是打回**：
站上那条记录照旧（不打回、不删）。退件常见两类 ——

- **含游戏素材** ⇒ 触到本仓库的素材红线。**本仓库不含任何游戏素材**，这条不因任何理由放宽；
  要不要为某一条破例，是**业主的裁决**，不是工具或维护者能定的。
- **单文件超过引擎 zip 读取器的上限**（`shared/zip.js` 的 `ZIP_MAX_FILE_BYTES = 32 MB`）⇒
  引擎自带的包导入路径（编辑器「包管理」/ `tools/workshop-pack.mjs import`）会拒收它；
  站点侧的读取器没有这个上限，所以「站上装得上」与「引擎导入装得上」**两条路结论不同**。

## 纪律

- `mods/` 下的**包内容只读**（审核与分发用），不要顺手「优化」；要改包请回到站上的兼容包流程。
- **本仓库的 agent 不要 `ssh`**（[AGENTS.md](../AGENTS.md) §3）。
- 站上新增已通过的包 ⇒ **重跑 `build-index.mjs`**，不要手工往 `index.json` 里补条目。
