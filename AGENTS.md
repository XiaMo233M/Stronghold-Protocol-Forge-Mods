# AGENTS.md

AI 助手（Codex、Claude Code、Cursor、Copilot…）与维护者在本仓库的入口。

**这份文件是「维护者 / agent 怎么审、怎么验、怎么发」**：审核闸门、站点的分发流程、操作纪律。
**「包作者怎么写一个包」在 [SKILL.md](SKILL.md)** —— 包格式、层、`api` 与 `game`、那几条沉默的坑、
面板 `ctx`、署名纪律、工作流。**两份不重叠，别互相抄**；本文与 SKILL.md 或引擎文档不一致时，
**以后者为准**，并以引擎的代码与文档为最终依据。

---

## 1. 这是什么

[Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge) 的工坊包仓库：
一份包一个目录，`pack.json` 是它的唯一入口。

| 目录 | 放什么 | 判定 |
|---|---|---|
| `packs/` | 兼容已完成、验过的包 | **闸门**：必须全部装上 |
| `demo/` | **已过时的样板**（三份旧包，**不再对外提供、不要照抄**） | 退役：见 [`demo/README.md`](demo/README.md) |
| `incoming/` | 组员上传、**尚未完成兼容**的 mod 原件 | 只报告，**不拦** |
| `docs-copy-examples/` | 只在文档里被引用的**可抄片段**（不是包，不参与闸门） | 见 [`docs-copy-examples/README.md`](docs-copy-examples/README.md) |

本仓库**不含游戏本体、不含引擎源码、不含任何游戏素材**。

## 2. 先读

| 文件 | 给谁 | 讲什么 |
|---|---|---|
| [SKILL.md](SKILL.md) | **包作者** | 格式、层、`api`/`game`、沉默的坑（未知键 / `api` 类型 / `content` 没声明 `chess`）、`notices`、「有更好的逻辑就用我们的」、面板 `ctx`、署名纪律、工作流、「做不成包」 |
| [UPLOAD.md](UPLOAD.md) | 投稿人 | 往 `incoming/` 传什么、三种方式、上传前清单 |
| [`incoming/SOURCE.template.md`](incoming/SOURCE.template.md) | 投稿人 | `SOURCE.md` 的填空模板（五件事） |
| [site/README.md](site/README.md) | **维护者** | 上传站 / 审核台的整套用法（部署、环境变量、三视图、兼容包发布、备份与更新） |
| [NOTICE.md](NOTICE.md) | 所有人 | 每个包的来源、署名与许可；非商业声明 |
| 引擎文档（本仓库只索引） | **所有人** | `docs/WORKSHOP.md`（包格式规则）、`docs/MOD-SURFACE.md`（全部表面）、`docs/design/mod-layer.md`（边界与 §28.24 / §28.25） |

## 3. 硬规则

- **素材红线**：不提交任何《明日方舟》游戏素材（解包出的美术、音频、字体、数据导出物）。
  包可以自带自制素材，但必须逐条写明来源与授权。
- **不抄规则**：包的格式与层级由**引擎的装载器**决定。校验一律调用引擎那一份
  （`tools/check-packs.mjs --engine <引擎目录>`），**不要在本仓库里重写一份校验规则**。
- **只写 `pack.json` 认识的字段**：字段全集是引擎 `shared/workshop.js` 的 `PACK_FIELDS`。
  多写一个键，**整包被拒**（`PACK_UNKNOWN_FIELD`）。
- **`id` 必须与目录名一致**（装载器按 `<根>/<包 id>/pack.json` 找包）。
- **只 import 白名单别名**（`@kit/*`、`@sim/*`、`@battle/index.js`，共 11 条），不用相对路径碰引擎。
- **署名与许可不可省**：每包必带 `PROVENANCE.md`（六项，见 [SKILL.md](SKILL.md) §9）；
  保留原作者署名、原件许可原样保留（改名 `NOTICE-原件-*`）、写清改了什么、哪些部分没有接口做不了。
  **包内原作者文本与包自带元数据一字不改** —— 与新实现不符时，写在我们自己的 `PROVENANCE.md` 里。
- **非商业**：本仓库及其收录的任何包都不得用于商业用途。
- **不为过闸门而放宽闸门**：校验不过就改包，不改校验、不改工具。
- **`incoming/` 被拒是正常的**：那里是「还没做兼容」的存放处，**不要**为了让它装上而改引擎或改校验；
  也不要为了让它通过而把 `incoming/` 里没验过的东西搬进 `packs/`。
- **本仓库不许改的东西**：`site/*.mjs`、`site/pages/*.html` 这层功能代码按各自的流程改；
  `packs/`、`demo/`、`incoming/` 下的**包内容**（只读、审核用，不要顺手「优化」）。
- **提交**：一个主题一个 commit；提交信息一行说清做了什么（中文或英文），
  **不加** `Co-Authored-By:` / `Generated with …` 这类署名尾巴。
- **不许碰服务器**：本仓库的 agent **不要 `ssh`**、不要直连服务器做操作。站点上的动作走
  [site/README.md](site/README.md) 里的管理 API 与隧道，交给人或专门那一路去做。

## 4. 收录闸门（一个包能不能进 `packs/`）

四条全中才行（细则见 [`packs/README.md`](packs/README.md)）：

1. **装得上**：引擎自己的装载器验过，`✓` 且 `errors=0`
2. **只做有接口的事**：原件里没有接口的部分，**如实写进包的来源说明**
3. **署名与许可齐全**：`PROVENANCE.md` 六项齐（原作者 / 许可 / 兼容改写者 / 来源 / 改了什么 / 自带素材来源）
4. **不含任何游戏素材**

## 5. 验证

```bash
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge            # 三个目录一起看
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --json     # 机器可读
```

- `packs/` 与 `demo/` 里的包必须全部 `✓`、没有任何 `✗`（**退出码 0**）；
- `incoming/` 只报告、**不参与退出码**；
- 改了包之后**一定要重跑**。
- （`demo/` 已**不再对外提供**，见 [`demo/README.md`](demo/README.md)；工具判定未因此改动。）

**审核一个包时，除了闸门还要看这三条**（闸门判不了它们）：包内有没有游戏素材、
`PROVENANCE.md` 六项是不是真的、包内原作者文本与自带元数据有没有被改过。

## 6. 发布工作流（本轮实际做的）

```
站点收到原件          → 审核台下载、跑测试
① 重打成 zip 根形状      包内文件直接在 zip 顶层；顶层目录名 = 包 id
② 修包契约            pack.json 只留 PACK_FIELDS 的键；id = 目录名；content 声明到位
③ 该用我们的实现就换   逐条过 SKILL.md §7 的替代表
④ 干净 workshop 根装载  一包一根、单独装载、要 errors=0（原始输出留档）
⑤ 一包一 zip            顶层目录 = 包 id，条目名正斜杠
⑥ 补 PROVENANCE.md      六项，含「包内哪一节已与实现不符（保持原样未改）」
⑦ 记字节与 sha256       zip 的字节数与哈希记在交付清单里，不写进包内文本
```

**多 mod 时：一个 mod 一个子 agent 并行。** 包之间不共享状态；要共享的只有「引擎通道怎么用」这条知识。

## 7. 站点侧：审核站与兼容包发布

**审核站地址与三条视图**、环境变量、部署与回滚：全部在 [site/README.md](site/README.md)，
本文只列**维护者最容易踩错的操作**。站点上有三类记录，公开面与审核面分开：

| 面 | 是什么 |
|---|---|
| `/` 公网上传页 | 给投稿人用；收下的包进待审队列（疑似素材单独一处，见 §8） |
| `/<ADMIN_PATH>` 审核台 | 维护者用；**三个视图**：主列表（`pending` + `superseded`）、`?view=approved`、`?view=rejected` |
| `/mods` 公开列表 | 只显示已通过的；兼容包多显示一栏「兼容改写者」 |

### 7.1 一步到位：投稿详情页的「上传并发布兼容包…」

**那个按钮 = 上传 + 通过 + 发布，一次做完。** 表单内联展开在那条投稿的详情下方
（不跳页），「由哪个待审原件改写来」预填成当前这条编号。填完点「上传并发布」打的是
`POST /api/<ADMIN_PATH>/compat-submit`，带 `publish=1`；它和普通投稿走**同一套三档检查**
（`blocker` / `warn` / `info`）。完整栏位表见 [site/README.md](site/README.md) §维护者侧。

### 7.2 兼容包是**独立记录**

- 兼容包**另起一个编号**，在**同一个列表**里（管理界面没有单独的「兼容包」区）；
- `compatOf` 记「由哪条待审原件改写来」（可追溯，含原件 sha256 与留档）；
- 发布成功后**原投稿**按 B 口径处置：状态置 `superseded`、`replacedBy` 指向刚发布的兼容包、
  **移出待审队列** —— 它的 `meta.json` 与 `mod.zip` **一个字节都不动**；
- 早先手工上线、`compatOf` 还空着的兼容包，用 `POST /api/<ADMIN_PATH>/compat/link` **补链**：
  一次只认**一个**明确指定的 id，只补记（`compatOf` + `markReplacedBy`），幂等。

### 7.3 兼容者字段：**必须手填，没有任何兜底**

- 表单里「兼容者」是**必填字段**（**值可以为空**）：报文里**缺这一栏**才拒收（400，点名「缺少兼容者字段」）；
  填了空串是**合法值**，如实存空并显示「未填」；
- `compatAuthorSource` 只有两档：`form`（手填）/ `empty`（未填）—— **没有「兜底」这一档**；
- 兼容者**永远不进** `pack.json`（那会抬包契约），只存在站点侧。

### 7.4 许可素材类 blocker 才可用维护者确认开关

`blocker` 是**提醒不是判决**（`site/review.mjs` 分三档，`hasBlocker()` 决定能否直接上线）。
命中「疑似官方素材」的记录要上线，**必须显式勾一次确认**（服务端要 `acknowledge:true`，
少了给 409）—— 可以放行，但不允许默默放过。这条开关**只对许可素材类 blocker 用**，
要**填理由、留痕**（进 `decision.json`），并且**一次一条**。

### 7.5 「已隐藏」勾选框与「三页相加 + 已隐藏 = 全部」

- 文案是「**不再显示（已由兼容包取代）**」，**每条记录一个**（列表行上一个、详情里一个）；
- 勾上 ⇒ 从**审核页的三个视图**里都不显示；**取消 ⇒ 重新显示**（可逆，不是删除）；
- 落成记录自己的字段：`meta.json` 的 `hidden` + `hiddenBy` + `hiddenAt`（外加一笔 `revisions` 留痕）；
- **公开面不动**：`/api/mods`、`/mods`、`/api/file/*` 都不读这一栏 —— 「隐藏」是审核页的**显示开关，不是下架**
  （要下架用「打回」）；
- 计数行给出「**三页相加 + 已隐藏 = 全部**」：分区**不筛掉、也不丢记录**。

### 7.6 没留档原件时**不下发** `archiveDownload`

兼容包详情里的 `archiveDownload`（`?variant=orig`）只在磁盘上真的有 `orig.zip` 时才给
（`site/server.mjs:680` 的 `existsSync`）—— 没留档就**不派发这个入口**，
不要用一个 404 去假装它存在。

## 8. 纪律与坑（每条都有依据）

### 8.1 ⚠️ **批准 / 决定类端点绝不批量调**

> **只对「明确指定的单个 id」调 `decide` / `compat/decide` / `compat/link` / `compat/note` / `hide`。
> 绝不对「按条件筛出来的一批」批量调用。**

这条是 2026-10-11 线上回归的教训，写在 `site/server.mjs:19-27`（文件头）与 `:684-686`：
有人想「把该上线的都上线」，对一批筛出来的兼容包连着调 `/compat/decide`，
把**刚刚打回的两条 demo 样板件又批准了回去** —— 过时样板重新出现在公网 `/api/mods` 上，
记录里只剩一个「approved」，看不出是哪一次批量操作顺带翻回来的。

批准是有后果的动作（上线、放开下载、取代原投稿）。要「按条件处理」，
**先把命中的 id 列出来给人看一眼，再逐条调**。`/hide` 的报文里出现
`ids` / `batch` / `items` / `list`（或 `id` 给了数组）一律 400（`site/server.mjs:1297-1334`）。

### 8.2 绝不打印凭据

- 凭据**不进命令行**：不要 `set -x` 那一类会把参数打进日志的调试开关（真踩过：token 落进日志）；
- 输出里出现令牌 / 环境变量值时，先挡住再贴；
- 站点侧靠 `ADMIN_IPS` 白名单 + 令牌两道防线，`ADMIN_PATH` 换名字**只减少扫描噪音、不是安全屏障**。

### 8.3 Windows 这边的两个坑

- **PowerShell 管道喂 bash 会把换行改写成 CRLF** ⇒ 远端脚本一律
  `cmd /c "ssh … bash -s < 文件"`，不要用管道；
- **写文件用 UTF-8 无 BOM**：带 BOM 会让整个文件在 Git 里显示成改动，也会让脚本第一行失效。

### 8.4 引擎的 `data/` 不许从更新包整目录拷贝

我们这边的 `data/i18n/*.json` 是**美化版**，上游是**压缩版** —— 整目录拷会把这些差异一并带回去。
只拷真正变了的文件。

### 8.5 只改该改的地方

- 本文档层要改的是 markdown；**功能代码（`site/*.mjs`、`site/pages/*.html`）与包内容不在同一次改动里碰**；
- 临时产物放仓库**外**（`_up/` 之类），不要留在工作树里；
- 提交用**明确路径** `git add <路径>`，不要 `-A`（免得把 `_scratch*`、`*.env`、凭据类顺进版本库）。

## 9. 拿不准时怎么办

1. **去引擎仓库读代码**（只读）：`shared/workshop.js`、`server/workshop.js`、
   `public/js/ui/extensions.js`、`docs/WORKSHOP.md`、`docs/design/mod-layer.md`。
2. **核不到的不要写**：文档里宁可标「未验证」，也不要写一句凭印象的规则 ——
   这份仓库存在的意义就是让「兼容」有依据。
3. **不确定的不替业主决定**：素材能不能收、样板要不要退、某个原件能不能收 —— 写进「待裁决」。
