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

本仓库**不含游戏本体、不含引擎源码**。含游戏素材的包**如实收录、但必须标注清楚**（见 §3「素材口径」）。

## 2. 先读

| 文件 | 给谁 | 讲什么 |
|---|---|---|
| [SKILL.md](SKILL.md) | **包作者** | 格式、层、`api`/`game`、沉默的坑（未知键 / `api` 类型 / `content` 没声明 `chess` / 未声明的通道）、`notices`、「有更好的逻辑就用我们的」、面板 `ctx`、署名纪律（哪份文件归谁）、工作流、「做不成包」与「没有功能别投成包」、术语约定 |
| [UPLOAD.md](UPLOAD.md) | 投稿人 | 往 `incoming/` 传什么、三种方式、上传前清单 |
| [`incoming/SOURCE.template.md`](incoming/SOURCE.template.md) | 投稿人 | `SOURCE.md` 的填空模板（五件事） |
| [site/README.md](site/README.md) | **维护者** | 上传站 / 审核台的整套用法（部署、环境变量、三视图、兼容包发布、备份与更新） |
| [NOTICE.md](NOTICE.md) | 所有人 | 每个包的来源、署名与许可；非商业声明 |
| 引擎文档（本仓库只索引） | **所有人** | `docs/WORKSHOP.md`（包格式规则）、`docs/MOD-SURFACE.md`（全部表面）、`docs/design/mod-layer.md`（边界；**§28.23** 是 `server.modules[].channels` 通道声明面，**§28.43–§28.57** 是这几版新加的面 —— 其中 **§28.49 `trait.grantsBonds` 今天能用**（[SKILL.md](SKILL.md) §19.7）、**§28.50 `pack.json.enabled`**（§19.9）、**§28.52 `pack.json.callBudget`**（§19.10）、**§28.53 房间同意 + 服主 pin**（§19.11），加上 0.3.0 合入新落的四条：**§28.54 `pack.json.matchKinds`**（§19.16）、**§28.55 `client.screens`**（§19.17）、**§28.56 `server.modules[].lane`**（§19.18）、**§28.57 `server.room.hold`**（§19.19）；上游 0.3.1 已合入引擎 `main`（发行 tag `v0.19.1-0.3.1`），这几节按当前树核过；`PLUGIN_API` 抬到 `2` 只影响 `plugins/`，工坊包的 `api` 仍对 `MOD_API_VERSION = 1` 比对） |

## 3. 硬规则

- **素材口径（业主 2026-10-12 改，取代原「素材红线」）**：**含《明日方舟》游戏素材
  （解包出的美术、音频、字体、数据导出物）的 mod 不因此被打回 —— 如实收录**，但**必须标注清楚**：
  ① 包内 `PROVENANCE.md` 写明「**含官方素材**」并附**实测清点**（个数 / 字节 / 分类；
  `tools/build-index.mjs` 机械生成，含 `.spresources` 容器**内部**的清点）
  ② **站上那条记录的备注里也写明**（能承载自由文本的只有「兼容说明」一栏，见 §5.1）
  ③ 写明**版权归鹰角网络 / Yostar**、**仅供非商业的学习与个人娱乐使用，请勿用于任何商业场景**，
  并声明本仓库与发布者**不主张**这些素材的任何权利。
  包自带的自制素材同样要逐条写明来源与授权。
  **未标注 = 问题**（那才是要消灭的方向）；**标注了就算尽到告知义务**，不另设闸门。
- **不抄规则**：包的格式与层级由**引擎的装载器**决定。校验一律调用引擎那一份
  （`tools/check-packs.mjs --engine <引擎目录>`），**不要在本仓库里重写一份校验规则**。
- **只写 `pack.json` 认识的字段**：字段全集是引擎 `shared/workshop.js` 的 `PACK_FIELDS`。
  多写一个键，**整包被拒**（`PACK_UNKNOWN_FIELD`）。
- **`id` 必须与目录名一致**（装载器按 `<根>/<包 id>/pack.json` 找包）。
- **只 import 白名单别名**（`@kit/*`、`@sim/*`、`@battle/index.js`，以及**按文件开的** 8 个官方 ops kit
  `@ops/op-{shwaz,ray,aglna2,thumpy,aphris,heyak,jesca2,nasti}.js`，另加 `@sim/body.js` 与 `@sim/professions.js`，
  共 **22** 条），不用相对路径碰引擎。
  `@ops/` 是命名空间不是放行 —— 这 8 个之外同前缀的仍然被拒。清单见 [SKILL.md](SKILL.md) §7 与 §19.13。
- **署名与许可不可省**：每包必带 `PROVENANCE.md`（六项，见 [SKILL.md](SKILL.md) §10）；
  保留原作者署名、原件许可原样保留（改名 `NOTICE-原件-*`）、写清改了什么、哪些部分没有接口做不了。
  **包内原作者文本与包自带元数据一字不改** —— 与新实现不符时，写在我们自己的 `PROVENANCE.md` 里。
- **非商业**：本仓库及其收录的任何包都不得用于商业用途。
- **不为过闸门而放宽闸门**：校验不过就改包，不改校验、不改工具。
- **`incoming/` 被拒是正常的**：那里是「还没做兼容」的存放处，**不要**为了让它装上而改引擎或改校验；
  也不要为了让它通过而把 `incoming/` 里没验过的东西搬进 `packs/`。
- **本仓库不许改的东西**：`site/*.mjs`、`site/pages/*.html` 这层功能代码按各自的流程改；
  `packs/`、`demo/`、`incoming/` 下的**包内容**（只读、审核用，不要顺手「优化」）——
  这里说的是包内文件；`packs/README.md`、`demo/README.md`、`incoming/README.md` 是文档，可以改。
- **提交**：一个主题一个 commit；提交信息一行说清做了什么（中文或英文），
  **不加** `Co-Authored-By:` / `Generated with …` 这类署名尾巴。
- **不许碰服务器**：本仓库的 agent **不要 `ssh`**、不要直连服务器做操作。站点上的动作走
  [site/README.md](site/README.md) 里的管理 API 与隧道，交给人或专门那一路去做。
- **四条红线**（与 [SKILL.md](SKILL.md) §14.1 是同一份，审核时逐条看）：
  ① **不许整份覆盖引擎文件** —— `install.mjs` + `payload/**`（整份覆盖 `data/**`、`server/**`）那种**安装器形态判「非标准」**，
  引擎侧定级见 `docs/STANDARD-PACK.md:20`、`:95`；
  ② **不许夹带可执行物** —— `.bat` / `.cmd` / `.exe` / `.dll` / `.ps1` **不是包内容**；
  ⚠️ 引擎**没有**「扫到可执行就拒包」的闸门，所以**这条只能靠审核兜住**（闸门判不了它）；
  ③ **不许静默改对局外行为** —— 会改对局结果就写 `combat: true` 并在包自述里讲明（§5.1）；
  ④ **素材版权** —— 官方素材**仅本地、不随源码分发**，包里带了就必须标注（§3「素材口径」）。

## 4. 收录闸门（一个包能不能进 `packs/`）

五条全中才行（细则见 [`packs/README.md`](packs/README.md)）：

1. **装得上**：引擎自己的装载器验过，`✓` 且 `errors=0`
2. **只做有接口的事**：原件里没有接口的部分，**如实写进包的来源说明**
3. **署名与许可齐全**：`PROVENANCE.md` 六项齐（原作者 / 许可 / 兼容改写者 / 来源 / 改了什么 / 自带素材来源）
4. **素材已标注**：含游戏素材的包**可以收录**，但 `PROVENANCE.md`（机械清点 + 来源授权）
   与站上备注必须写明「**含官方素材**」（见 §3「素材口径」）—— **未标注才是问题**
5. **带上真实功能**（业主 2026-10-11 口径：「documentation-only 不放，有功能我们再放」）

> ⚠️ **数字别混**：这里是**五条**闸门，其中第 3 条的 `PROVENANCE.md` 是**六项**；
> 而 `mods/` 那一侧是**四道**入库闸门（见 [`mods/README.md`](mods/README.md)）—— 三组数字说的是三件不同的事。

**第 5 条的判据**：装上之后**会改变某项游戏内行为**（数据 / 界面 / 服务端任一层）才算「有功能」。
一眼判的反例 —— 命中所列任一条即**不上架**（**处理方式是「留在待审」，不是「打回」**）：

| 看到什么 | 判定 |
|---|---|
| 包自述是 `documentation-only` / 只读参考 / 资料包 | ❌ 不上架；**记录与简介留在待审，不要打回** |
| `content: []` 且没有别的贡献项（只放 JSON 资料与说明面板） | ❌ 不上架（通常连 `EMPTY_PACK` 都过不去） |
| 装了之后**没有任何一项游戏内行为改变**，只有说明文字 | ❌ 不上架；**记录与简介留在待审，不要打回** |

**一句话判据**：`documentation-only` 包**不上架**，但**记录与简介要保留**（**留在待审即可，不要打回**）
—— 它的**简介是我们做兼容包改写的依据**；等它有真实功能再上架。

**我们怎么用它**：拿它的**简介 + 原件内容**，由**我们自己重构成有实际功能的兼容包**，
再走**兼容包通道**发布（一步到位见 §7.1，兼容包是独立记录见 §7.2）。
**兼容人与原投稿的关系照既有规矩**：`compatOf` 记「由哪条待审原件改写来」，
发布后原投稿置 `superseded`、`replacedBy` 指向刚发布的兼容包，
原投稿的 `meta.json` 与 `mod.zip` **一个字节都不动**。

**「不上架」≠「打回」**：打回会写下 `decision.json`（`decision: rejected`），
该条**离开待审队列**、落到 `?view=rejected`（§7）—— doc-only 件**不走这一步**，**留在待审**即可。

**为什么**：下载者按下「安装」时的预期是「装了会有效果」。一个装上不启用任何功能的包，
消耗的是这份预期 —— 用户会先去查「我是不是装错了」。做不成功能的东西**不要投成包**，
正确去处见 [SKILL.md](SKILL.md) §15。

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

**审核一个包时，除了闸门还要看这三条**（闸门判不了它们）：**含素材的包有没有标注清楚**
（`PROVENANCE.md` 的机械清点 + 站上备注）、`PROVENANCE.md` 六项是不是真的、
包内原作者文本与自带元数据有没有被改过。

**闸门分工**（五条里，只有第 1 条工具能判，其余四条靠人）：
「装得上」由 `check-packs.mjs` 判；「只做有接口的事 / 署名齐全 / **素材已标注**」由人审；
「带上真实功能」按 §4 第 5 条判。

### 5.1 `combat: true` 的告知义务：标注清楚就算尽到，不另设闸门

**判据**：mod 是**房主建房间时自己选**装不装的（业主 2026-10-11 口径：「标注好会影响游戏结果
就行了，做到了告知义务」）⇒ 对 `combat: true` 的包**不另设闸门**，**只要把这个事实标注清楚**，
告知义务即已履行。**反面才是问题**：不标 = 静默改结果，那正是要消灭的方向。

| 看到什么 | 判定 |
|---|---|
| 包在 `pack.json` 写了 `combat: true`，且包的说明里讲明「会影响对局结果」 | ✅ 已尽告知义务，照旧收录 |
| 包会改结果（挂 `server.meta` / `server.battle` / 带 `matchClass` 的 `server.modules`）却**没写** `combat: true` | ❌ 装载器直接拒（`META_NEEDS_COMBAT` / `BATTLE_NEEDS_COMBAT` / `MODULES_NEED_COMBAT`）—— 这一条是**引擎的硬闸门**，不是本文的要求 |
| 能改结果、也写了 `combat: true`，但**任何地方都没告诉下载者** | ❌ 审核时点出来，补上说明再过 |

**标注应该出现在哪（按代码事实）**：

- **包自述 —— 已验证、必须做**：`pack.json` 的 `combat: true` 是**唯一**机械可判的标注，
  也是引擎的判罚依据；包的说明文本（`PROVENANCE.md` 的「改了什么」那一项、包内公告）是人读的那一份。
- **站上 —— 未验证 / 当前做不到**：站点代码里**没有任何 `combat` 字样**
  （`site/*.mjs`、`site/pages/*.html` 全无），所以站上**目前不显示**这一栏；
  `/mods` 公开面能承载自由文本的只有「**兼容说明**」一栏（`meta.json` 的 `compatNote`，
  由 `POST /api/<ADMIN_PATH>/compat/note` 改写，`site/server.mjs:1291`、`:1258-1289`）。
  也就是说：**要贴在站上，当前只能写进「兼容说明」**；想让它成为独立的一栏，需要改站点代码 ——
  那件事**不在本文档的改动范围里**，列为待裁决。

### 5.2 AI agent 的可执行工作流：读什么 → 怎么验 → 怎么自检 → 什么时候停下

**① 动手前读什么（只读，别猜）**

| 要判的事 | 读哪里 |
|---|---|
| 这个包能声明哪些字段 | 引擎 `shared/workshop.js` 的 `PACK_FIELDS`（**闭集，38 键**）；`content` 名单另有一份（**15** 个文件） |
| 「这一版能不能用」的通道面 | 本仓 [SKILL.md](SKILL.md) §19 / §20（每条带 `文件:行号`）—— **核不到就回引擎复一遍**，那张「在途」表会过期 |
| 站上某条记录现在是什么状态 | 审核台三个视图（§7）；**不要**拿 `mods/index.json` 反推站上状态（镜像只是采集时刻的快照） |
| 站侧到底怎么判的 | `site/server.mjs` —— 拒绝码是**机器可读**的，按 `code` 直接搜 |

**② 怎么验（三条命令，缺一条都不算验过）**

```bash
# 1) 本仓闸门：packs/ 与 demo/ 里的包必须全部 ✓（退出码 0）
node tools/check-packs.mjs --engine <引擎检出> --json

# 2) 作者侧分层校验：干净临时工坊根，errors 必须是 0
SP_WORKSHOP=/tmp/agent-shop node <引擎检出>/tools/workshop-validate.mjs --workshop /tmp/agent-shop --json

# 3) 动过镜像 / 索引之后：先重新导出 staging，再让工具重算（默认只报不写盘）
node tools/build-index.mjs --stage <staging> --engine <引擎检出>
```

**③ 怎么自检（每条都要能回答「凭什么是这样」）**

- 写进文档的每一个数字与结论，**要么有命令输出，要么有 `文件:行号`**；核不到的写「**待核**」，不写印象；
- 改完**重跑**②里的前两条；动过镜像再跑 `--assert-only` 核「应 live 的一条没掉」；
- 提交前 `git status --porcelain` **只应看到你自己改的那几个文件**（`site/**` 功能代码与包内容不在同一次改动里碰）。

**④ 什么情况必须停下问人（不要自己决定）**

- 要动**服务器**（`ssh` / 直连 / 改站上盘上的文件）—— 本仓 agent 一律不做（§3）；
- 要对**一批**记录做批准 / 决定 —— 先把命中的 id 列出来给人看（§8.1）；
- 要**硬删**一条有引用的记录（409）—— 报人；
- **素材标注够不够**、某个原件能不能收、样板要不要退 —— 写进「待裁决」（§9）；
- 文档与代码冲突 —— **以代码为准改文档**，并把这条冲突写进交付说明。

## 6. 发布工作流（本轮实际做的）

```
站点收到原件          → 审核台下载、跑测试
① 重打成 zip 根形状      包内文件放进**一个顶层目录**里、目录名 = 包 id（zip 里 pack.json 的路径是 `<包 id>/pack.json`）
② 修包契约            pack.json 只留 PACK_FIELDS 的键；id = 目录名；content 声明到位
③ 该用我们的实现就换   逐条过 SKILL.md §8 的替代表
④ 干净 workshop 根装载  一包一根、单独装载、要 errors=0（原始输出留档）
⑤ 一包一 zip            顶层目录 = 包 id，条目名正斜杠
⑥ 补 PROVENANCE.md      六项，含「包内哪一节已与实现不符（保持原样未改）」
⑦ 记字节与 sha256       zip 的字节数与哈希记在交付清单里，不写进包内文本
⑧ 投站改扁平            上传（compat-submit / 普通投稿）要的**不是**①⑤ 那个形状：站点只读 zip 根的 `pack.json`
                        （`site/server.mjs:180-185` 精确匹配条目名，`site/zip.mjs:110`），套了顶层目录即 400 拒收
                        ⇒ 另做一份 `pack.json` 在 zip 根的扁平件去投，原交付件保留（判据与两个落点的对照见 SKILL.md §3）
```

> ①⑤ 与 ⑧ 是**两个落点的两套形状**，不是矛盾：装载器只认 `<工坊根>/<包 id>/pack.json`（包装成 zip 时
> `pack.json` 在根或在唯一顶层目录里**都收**，引擎 `tools/workshop-pack.mjs:191-200`），而**站点上传只认 zip 根**。

> ⭐ **新版要上线时，多做一步**：**站点不按 `pack.id` 去重**（公开面按记录列，见 §7.8 与 §8.6 第 5 条）
> —— 所以「新的上线、旧的下架」要**显式**做：`POST /api/<ADMIN_PATH>/supersede`（一对、强制同 `pack.id`），
> 或走投稿详情页的「上传并发布兼容包…」（§7.1，原投稿按 B 口径自动置 `superseded`）。

**多 mod 时：一个 mod 一个子 agent 并行。** 包之间不共享状态；要共享的只有「引擎通道怎么用」这条知识。

## 7. 站点侧：审核站与兼容包发布

**审核站地址与三条视图**、环境变量、部署与回滚：全部在 [site/README.md](site/README.md)，
本文只列**维护者最容易踩错的操作**。站点上有三类记录，公开面与审核面分开：

| 面 | 是什么 |
|---|---|
| `/` 公网上传页 | 给投稿人用；收下的包进待审队列（**疑似素材**的照收、单独存进 `flagged/`，上线要勾一次确认 —— 见 §7.4） |
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
（`site/server.mjs:748` 的 `existsSync`）—— 没留档就**不派发这个入口**，
不要用一个 404 去假装它存在。

### 7.7 用途分类（`funcKind`）：六类，与 `packKind` 是**两个维度、两个键**

- **六类闭枚举**（`FUNC_KINDS`，`site/server.mjs:172`）：**游戏玩法** `gameplay` · **拓展包** `expansion` ·
  **实用工具** `utility` · **素材替换** `assets` · **说明文档** `documentation` · **未分类** `uncategorized`。
  这是**业主真正要的那个分类**（「这包是干什么的」）。
- **`packKind` 是另一个维度**（`:160`）：`functional` / `documentation` / `unknown` ——「**装上到底会不会生效**」。
  两个键**故意不复用**（`:1441`）；`uncategorized` **不是** `unknown`：老记录**没有** `funcKind` 这一栏 ⇒ 落未分类（`:646`）。
- ⭐ **一致性判据 `packKindFor(funcKind)`**（`:650`、`:656`）：功能类目一旦落库，**技术维度照着它派生** ——
  `documentation` ⇒ `documentation`；`FUNC_KINDS_FUNCTIONAL`（`gameplay` / `expansion` / `utility` / `assets`，`:178`）
  ⇒ `functional`。所以两栏**不可能各说各话**，除非同一次报文里又**显式**给了 `packKind`（那就以显式值为准，`:1864`）。
- **归类端点**：`POST /api/<ADMIN_PATH>/funkind`，**一次一个明确写出的 id**（与 `/note`、`/hide`、`/packkind` 同一条铁律，`:1817`）。
- **筛选**：`GET /mods?func=…` 与 `GET /api/mods?func=…`（可多值；写了不在闭枚举里的类目会被拒，`:658-663`）；
  技术维度仍是 `?kind=…`（`:69-70`）。
- **老记录的迁移**：`site/migrate-funkind.mjs`，**默认干跑**。它只写一条明确无误的判据
  （`packKind=documentation ⇒ funcKind=documentation`），其余一律标「**留未分类，待人工过**」且**不写盘**；
  真写盘时才一次一条 id 打 `/funkind`，凭据只从环境变量读。
- ⚠️ **`funcKind` 不进镜像索引**：本仓 `mods/index.json` 只有技术维度的 `category`；31 份 `meta.json` 快照里
  **一份都没有** `funcKind`（那是站侧 2026-10-13 之后才加的维度）。要它进镜像，得**重新导出 staging** 再重跑
  `tools/build-index.mjs` —— 工具不会从别处补这一栏。

### 7.8 ⭐ 「以新为准」：新版上线 = 一次 `/supersede`（业主 2026-10-13 总政策）

原话是「**以后所有 mod 以新为准**：新的上线、旧的下架但**不删除**」。

- **端点**：`POST /api/<ADMIN_PATH>/supersede`，**一次一对**（`newId` + `oldId`）；**强制同 `pack.id`**，
  并要求**新的那条已在公开面**（`site/server.mjs:1112`）。
- **判据只有一份**：`checkSupersede()`（`:1109-1124`），**先算不写** —— 任何一道不过就返回错误对象，
  **磁盘上什么都不改**。错误码是机器可读的：`SUPERSEDE_OLD_ID_SHAPE` / `SUPERSEDE_NEW_ID_SHAPE` /
  `SUPERSEDE_SELF`（自己取代自己）/ `SUPERSEDE_OLD_NOT_FOUND` / `SUPERSEDE_NEW_NOT_FOUND` /
  `SUPERSEDE_PACK_ID_UNREADABLE`（**读不出 `pack.id` 就不猜、不动它**）/
  `SUPERSEDE_PACK_ID_MISMATCH`（只有这个入口核这一道）/ `SUPERSEDE_CYCLE`（会构成取代环，`chain` 给出整条链）。
- **旧的那条怎么处置**：`markReplacedBy`（`:1050-1068`）写 `decision = superseded` +
  `replacedBy { id, name, area, at }` —— 理由原文就是「**不再单独上线，避免公网出现两份**」。
  **旧的 `meta.json` 与 `mod.zip` 一个字节都不动**；`decision.json` 是整份覆盖，所以新版补了一笔
  `decisionSnapshot` 留档（`:2644-2661`），上一份决定**逐字保留**。
- **旧的可以是兼容包**：那道 `area === 'compat'` 的硬拦**已删除**（`:1037-1041`）。
- **另一条入口**：`POST /api/<ADMIN_PATH>/decide` 的 `superseded` 分支 —— 管理员的**明确指令**，
  历史用法允许跨 id（人工纠正 / 合并），所以**不核 `pack.id`**（`:1113`）。
- ⚠️ **公开面按「记录」列，不按 `pack.id` 去重**（可见性只读 `state === 'approved'` 与 `withdrawRequested`，`:289`）
  ⇒ 同一个 `pack.id` 的两条会**同时公开**。这就是为什么「新版上线」必须**显式做一次** `supersede`，
  不能指望站点自己发现重名。

### 7.9 发布者自助删除：三档，**只有一档会真删**

| 档 | 端点 | 落成什么 | 门槛 |
|---|---|---|---|
| **档 1 软删** | `POST /api/publisher/delete`（`:59`） | 转 `superseded` 终态（`replacedBy: null` / `reason: publisher-delete`），**一按即生效、不经管理员**；留 `revisions` + `audit` | 发布者**自己的发布者令牌** |
| **自撤** | `POST /api/publisher/withdraw`（`:58`）＋ 管理员 `POST /api/<ADMIN_PATH>/withdraw-decide`（`:62`） | **公开面立刻不再列出**（`withdrawRequested`）；**落终态要管理员确认** | 令牌 ＋ 管理员 |
| **档 3 硬删（物理）** | `POST /api/publisher/delete-hard`（`:61`） | ⚠️ 必须**两次调用二次确认**，且**先落墓碑**（`tombstones/`，`:111`）**再**物理删 | 令牌 ＋ 二次确认 |

- 站上「**零删除**」是默认，**唯一例外就是档 3**（授权注释在 `:44-46`）。
- **恢复口只有一条**：只有**发布者自助删除**造成的那种 `superseded` 能自助恢复（标志 `decision.publisherDelete`）；
  被**别的版本取代**的**不在这条通道里**，要找维护者（`:451`、`:467-472`）。
- 删除撞上**引用**（比如它已被某条取代链指着）⇒ **409 先报人**，不自行处理。

### 7.10 管理口口径：**两道防线 + 绝不写凭据**

- `ADMIN_IPS`（**只认回环**）＋ 令牌两道（`site/server.mjs:122`、`:133`）；审核动作全部要 `x-admin-token`，
  比对用 `timingSafeEqual`（`:16`）。
- `ADMIN_TOKEN` **至少 16 位**，没设就直接不启动（`:195-197`）。
- `ADMIN_PATH` 换名字**只减少扫描噪音，不是安全屏障**（`:135-140`）。
- ⚠️ **绝不把凭据写进任何文件 / 命令行 / 输出**：认领码、发布者令牌、`ADMIN_TOKEN`、Basic 头
  **一个字节都不落盘**（`:337`）。写文档时一律**不写凭据**，也不要贴带 token 的命令行。
- 批准 / 决定类端点**绝不批量调**（§8.1）。

## 8. 纪律与坑（每条都有依据）

### 8.1 ⚠️ **批准 / 决定类端点绝不批量调**

> **只对「明确指定的单个 id」调 `decide` / `compat/decide` / `compat/link` / `compat/note` / `hide`。
> 绝不对「按条件筛出来的一批」批量调用。**

**为什么不能批量（不是洁癖，是会把结果翻回去）**：这一族端点会**覆盖记录当前的状态**。
对一批筛出来的 id 连着调，就是把每一条的**旧结论**重新写一遍 —— 早先已经被「打回」的记录，
会被这次批量调用**又批准回去**（批准 = 上线 + 放开下载 + 取代原投稿），而记录里只剩下一个
`approved`，**看不出它是被哪一次批量操作顺带翻回来的**。

这条是 2026-10-11 线上回归的实测，写在 `site/server.mjs:19-27`（文件头）与 `:23`、`:753`、`:1113`、`:1200`：
有人想「把该上线的都上线」，对一批筛出来的兼容包连着调 `/compat/decide`，
把**刚刚打回的两条 demo 样板件又批准了回去** —— 过时样板重新出现在公网 `/api/mods` 上。

**正确做法（判据）**：一次请求 = **一个**明确写出的 id。

| 看到什么 | 判定 |
|---|---|
| `{"id":"a1b2c3","decision":"approved"}`，然后**另发一次**给下一个 id | ✅ 对 |
| 一次请求的报文里出现 `ids` / `batch` / `items` / `list`，或 `id` 是数组 | ❌ 一律 400（`/hide` 的实现见 `site/server.mjs:1329-1334`） |
| 写一个脚本「把筛出来的那批循环喂进来」 | ❌ 同样禁止 —— 那就是把上面那件事自动化 |

要「按条件处理」，**先把命中的 id 列出来给人看一眼，再逐条调**。

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

### 8.6 本轮实测撞到的坑（照抄进来，别再撞一次）

| # | 坑 | 症状 | 判据 / 怎么绕 |
|---|---|---|---|
| 1 | **zip 成员名带反斜杠** | 站点读条目名失败：它按 **`/` 精确匹配** `pack.json` | 压包时**条目名一律正斜杠 `/`**（`site/server.mjs:180-185`、`site/zip.mjs:110`）；Windows 上别用会把成员名写成 `\` 的工具 |
| 2 | **PowerShell 写文件吃掉行尾** | Git 里整文件显示成改动 / 脚本第一行失效 | 写文件用 **UTF-8 无 BOM + LF**；`Out-File` / `Set-Content` 的默认行为是 **CRLF + 尾随换行**（§8.3） |
| 3 | **`packKind` 不由「通过」写** | 发布成功却**不进镜像**：记录的 `packKind` 停在 `unknown` | 提交时缺省落 `unknown`（`site/server.mjs:1439`），`/decide` **只读不写**（`:1784`）；要 `functional` 得走 `/packkind`（`:1856-1861`）或写 `funcKind` 让它派生（`:1864`、§7.7） |
| 4 | **`unknown` 不进镜像** | 站上「已通过」却不在 `mods/` 里 | 站侧采集的选择口径是 `state === 'approved'` **且** `meta.packKind === 'functional'`（`tools/collect-station.mjs:119`、`:197`）⇒ 先把它归成 functional 再重跑采集 |
| 5 | **同 `pack.id` 两条会同时公开** | 公网出现两份 | 公开面按**记录**列、不按 `pack.id` 去重（`site/server.mjs:289`）⇒ 新版上线要**显式** `POST /supersede`（§7.8） |
| 6 | **`hidden` 对公开面无效** | 勾了「不再显示」，公网还在 | `hidden` 只是**审核页的显示开关**（§7.5）：`/api/mods`、`/mods`、`/api/file/*` 都不读它 ⇒ 下架要用**打回**或 `/supersede` |

## 9. 拿不准时怎么办

1. **去引擎仓库读代码**（只读）：`shared/workshop.js`、`server/workshop.js`、
   `public/js/ui/extensions.js`、`docs/WORKSHOP.md`、`docs/design/mod-layer.md`。
2. **核不到的不要写**：文档里宁可标「未验证」，也不要写一句凭印象的规则 ——
   这份仓库存在的意义就是让「兼容」有依据。
3. **不确定的不替业主决定**：样板要不要退、某个原件能不能收、**某条素材标注够不够** —— 写进「待裁决」。
   （**素材本身已由业主 2026-10-12 裁定：不拦、如实收录、标注清楚** —— 见 §3「素材口径」，
   所以它不再是「待裁决」项。）
