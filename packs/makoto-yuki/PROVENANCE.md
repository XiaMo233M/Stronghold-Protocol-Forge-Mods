# PROVENANCE — 结城理（Persona 3 Reload）（`makoto-yuki`）

本文件由**兼容改写者**写，六项照 `Stronghold-Protocol-Forge-Mods/SKILL.md` §10。**核不到的事实写「未声明」，不编造。**

| # | 项 | 值 |
|---|---|---|
| ① | 原作者 | **原件未署名**（uncredited original）—— 站侧记录 `49e807b1b5b0` 的 `author` 栏原文即「原件未署名（uncredited original）；本版修改者：Stronghold-Protocol（工坊包通道改写 + api 类型修正）」。原件两份文件（`install.mjs` / `README.md`）全文搜 `licen|MIT|GPL|Copyright|版权|作者|署名` **零命中**，所以**不许自填** |
| ② | 许可 | **`NOASSERTION`**（原件未声明许可；站侧记录也没有 `license`）。本包 `pack.json` 因此写 `NOASSERTION` |
| ③ | 兼容改写者 | 站侧记录那一栏**未填**（`compatAuthor: null`）。**本对齐版由 `Mo233` / Stronghold-Protocol 对齐**（改 `combat` / 补 `forms` / 记 kit 边界） |
| ④ | 来源 | ① **原件投稿编号 `b65c7f9320ca`**「结城理mod」· `mod.zip` **4,710,723 B** · 存在站侧 `flagged/`（疑似素材，2026-10-11 起 `hidden`）。② **站上已通过的兼容改写版**：记录 **`49e807b1b5b0`**「makoto-yuki 1.0.1」· `mod.zip` sha256 `3873c55cf62f8ea4f573be5a7d4d2ebc809a6b3e1ba0e0e1e76224d6f565fbe1` · 30 个条目 · 2026-10-11T10:28:47Z 由 admin 批准。⚠️ 那条记录的 **`compatOf` 是 `null`**（站侧**没有**记回原件 `b65c7f9320ca` 的链，待站侧补 `POST /compat/link`）。**本包 = 拿 `49e807b1b5b0` 对齐第 8 段裁定**（原件 `mod.zip` 未随本包收录） |
| ⑤ | 改了什么 | 见下「改写对照」 |
| ⑥ | 自带素材来源 | ⚠️ **含官方素材**：**25** 个文件 / **8584477** B，分类 `{"image":17,"spine":8}`（`.png` 17 · `.atlas` 4 · `.skel` 4）。它们是《明日方舟》客户端**解包**出来的官方美术（结城理 / Persona 3 Reload 联动）。**版权归鹰角网络 / Yostar**，**仅供非商业的学习与个人娱乐使用，请勿用于任何商业场景**；本仓库与发布者**不主张**这些素材的任何权利 |

## ⑤ 改写对照（原做法 → 我们的做法 → 为什么）

本包**不收录原件任何文件**；内容取自站上已通过的兼容改写版 `49e807b1b5b0`，逐条比过 sha256。

| # | 站上成品 `49e807b1b5b0` 的做法 | 本包的做法 | 为什么 |
|---|---|---|---|
| 1 | `pack.json` 写 **`combat: false`** | **`combat: true`** | 它装上一名**可玩**干员（进自选池、带外观与时装）⇒ **会改对局结果** ⇒ 按业主口径必须标 `true`（`AGENTS.md` §5.1）。不标 = 静默改结果，那正是要消灭的方向 |
| 2 | **不声明 `forms`** ⇒ `assets.modForms` 为空 | **声明 4 个形态**（`doll1` / `doll2` / `doll3p1` / `doll3p2`），逐字取自原件 `data/forms-entry.js` | 不写 ⇒ **人偶形态渲染不出来**（`doll3p1` 的 `end`/`next` 链是 S3 两段形态的切换）。形状逐字对 `FORM_ROLE_KEYS` 与 `FORM_LOOP_KEYS`：`roles.skill` 只写 `{begin,loop,end,via}`（包通道**不许** `index` / `idle`，那两个是引擎内部 `clipSet` 的字段） |
| 3 | 其余**一字未改**（`units.json` / `tokens.json` / `assets/**` 共 **27** 个文件 sha256 **全部相同**） | 同 | 逐条比过：**DIFF = 0**（只 `pack.json` 差，差的就是上表两处） |
| 4 | **战斗 kit 没随包发出**（那份 README 说「kit 挂不上去」） | **补上** `kits/char_4217_makoto.js`（原件 `op-makoto.js` 的函数体 499 行 + helper 77 行**逐行相同**，只换了 import 与默认导出的外壳） | 「挂不上去」是**过期说法**（引擎后来把 `pack.json.operators` 的 charId 收成了合法 kit 目标）；真卡点是**导入白名单**，由引擎侧补再导出解开。逐条见下 |

**原件文本一字未改**：本包不收录原件任何文件。原件 `README.md` 里写死了原作者的本机路径与用户名，**未抄进本包**。

## 战斗 kit：从「做不成包」到**已收录**（含引擎侧那一刀）

原件带一个战斗 kit：`files/server/sim/content/kits/ops/op-makoto.js`（**48,347 B**，603 行）+ 它的
helper `files/server/sim/content/kits/shared/mod-tier3.js`（**5,993 B**，97 行）。**本包已收录**，做法逐条说清。

**（一）「挂不上去」这条已经不成立（站上成品那份 `README.md` 的说法过期了）。**
那份 README 写「结城理走自选池，没有任何 chess 记录以 `char_4217_makoto` 为 id ⇒ kit 挂不上去（`KIT_NO_TARGET`）」。
**引擎现在不是这样**：`server/workshop.js:1204-1208` 明写 **`pack.json.operators` 的 charId
就是模拟层 `kitOf` 对自选 def 唯一查的键（`def.charId`），所以它是一个合法的 kit 目标**。
实测（最小 stub，隔离目标这一问）：

| 放什么 | 装载器的判罚 |
|---|---|
| `kits/char_4217_makoto.js` = `export default { char_4217_makoto: () => ({}) }` | `KIT_NO_DEFAULT_EXPORT`（**形状**错，**不是**目标错） |
| 对照：`kits/char_9999_nobody.js`（谁都不认识的 id） | `KIT_NO_TARGET` |

⇒ **目标合法**。所以卡住的**不是**目标。

**（二）真卡点是导入白名单 —— 已由引擎侧补再导出解开（业主裁定 (A)）。**
工坊 kit 只许 import **11 条白名单别名**（`@kit/tier1..6.js`、`@kit/summoner.js`、`@sim/constants.js`、
`@sim/dir.js`、`@sim/targeting.js`、`@battle/index.js`）或包内 `./…`（**不得含 `..`**）。
原件那个 kit 用的是引擎内部相对路径，逐条对账：

| 原件 import | 符号 | 调用处 | 走哪条 |
|---|---|---|---|
| `../../../constants.js` | `COLS` `PUSH_DIRECTIONAL_MIN_DIST` | — | ✅ `@sim/constants.js` |
| `../../../targeting.js` | `canTargetEnemy` / `absoluteRangeKeys` `sortEnemyTargets` | — | ✅ `@sim/targeting.js` |
| `../../../body.js` | `bodyDist` `bodyInKeys` `bodyOnTile` | 6 | ✅ `@battle/index.js`（**本来就有**） |
| `../../../simdata.js` | `normalizeChess` `normalizeSkill` | 7 | ✅ **引擎侧补再导出**（`@battle/index.js`） |
| `../../tokens.js` | `releaseSkillSummon` `TOKEN_IDS` `tacticalPoint` | 4 | ✅ 同上 |
| `../../items/battle.js` | `weaknessRetype` | 4 | ✅ 同上 |

**引擎侧那一刀**（`server/sim/content/support/index.js`，即白名单里的 `@battle/index.js`）：**只增 3 行再导出**
（`normalizeChess`/`normalizeSkill`、`TOKEN_IDS`/`releaseSkillSummon`/`tacticalPoint`、`weaknessRetype`），
**不改既有行为、不开新前缀、不动 import map、不动 `test/kitImports.test.js`** —— 把引擎已有的原语交给包的最小改动。
⚠️ 那一刀让 `@battle/index.js` 与 `items/battle.js` **成环**（后者本来就 import 前者）；安全，因为 `weaknessRetype`
是**函数声明**、而 `items/battle.js` 只在**函数体**里用前者的导出（顶层零调用），两条边都不会在模块初始化期读到未初始化的绑定。

**（三）包侧两处机械改写（函数体一字未改）。**

| 改了什么 | 为什么 | 证明 |
|---|---|---|
| **helper 并进 kit 文件**（不再有 `kits/lib/mod-tier3.js`） | 装载器只对 **kit 文件本身**跑 `rewriteKitImports`；包内相对 import 的辅助文件是用**普通文件 URL** 去 import 的、**不会再被改写**，所以它自己的 `@sim/…` 在服务端解不开（浏览器靠 import map 反而能解）。实测报过 `KIT_IMPORT_FAILED: Cannot find package '@sim/constants.js' imported from …/kits/lib/mod-tier3.js`。并成一个文件后全部 import 走同一趟改写 | helper 定义段 **77 行**，并入前后 sha256 **逐行相同**（`284f375b9120797c`） |
| **默认导出换成裸函数**（`export default { char_4217_makoto: (bb, chess, def) => … }` → `export default (bb, chess, def) => …`） | 工坊 kit 要**裸函数**（`server/workshop.js:1295` 只认 `typeof mod.default === 'function'`），原件那份是引擎内部的 ops 约定（`content/index.js` 按 charId 键读）。实测报过 `KIT_NO_DEFAULT_EXPORT`。对象里只有这一个键，所以只是去掉外壳 | **函数体 499 行**，改写前后 sha256 **逐行相同**（`fd1d1e824dc5ccd7`） |

⇒ **原件的战斗逻辑一字未改**，只换了「怎么接上引擎」的那几行。
⚠️ 顺带纠正一条我先前的说法：helper 放 `kits/lib/` 子目录**确实**能避开「被当 kit 读」（装载器只把 `kits/*.js`
的**直接子文件**当 kit），但**解决不了别名问题** —— 子目录里的文件同样不会被导入改写覆盖，所以最终走的是**并入**。

**（四）曾考虑但没采用的路线（留档）。**
**(B)** 在 `shared/kitImports.js` 开 3 条新白名单（`simdata.js` / `content/tokens.js` / `content/items/battle.js`）
—— 否：后两个是**内容层**模块，`shared/kitImports.js:89-92` 明写那两个前缀通向的是**战斗里**的东西，与既有纪律冲突。
**(C)** 改写 kit 绕开那 5 个符号 —— 否：它们是引擎内部的**规范化 / 召唤 / 破甲**原语，包内**没有**等价物，
逐条重写等于重实现引擎内部。

**不声称的**：没有在真实对局里逐条核对过这名干员的战斗数值。本包做的是**装载验证**：
`loadWorkshop` `errors: 0` · `loadWorkshopKits` `errors: 0`、`loaded: char_4217_makoto`、模块 URL 已登记
（`/workshop-kits/makoto-yuki/char_4217_makoto.js`）。

## 未核到 / 未测

- **未核到**：原件 `b65c7f9320ca` 的 `mod.zip` **sha256**（本地只有解开的分析副本，没有那个 zip）。
- **未核到**：原件是否声明过 `game` / `gameVersion`（原件是覆盖式安装脚本，`install.mjs` 里写的是上游 `0.2.2`；
  本包**不声明** `game`）。
- **未测**：没有在真实对局里打过这名干员（本包只做**装载验证**：一包一根单独装载 `loadWorkshop` `errors=0` +
  `loadWorkshopKits` `errors=0`、`loaded: char_4217_makoto` + `diy.ownedPool` / `diy.operators` /
  `units.forms` / `assets.modForms` / `assets.chars.spine` / `assets.skins` 六处落点都实测过）。
