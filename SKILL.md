# SKILL — 把一份 mod 做成这个仓库能收录的工坊包

**这份文件是「包作者怎么做」。** 维护者 / agent 怎么审、怎么把包发到站上，看 [AGENTS.md](AGENTS.md)。
两份文件不重叠：这里讲格式与流程，那里讲审核、发布与纪律。

给 AI 助手与人类贡献者的同一份说明书。本文与**引擎文档**冲突时**以引擎文档为准**
（见文末「引擎侧的权威文档」）；本文引用的每一处代码位置都核过（见 §17 的依据表）。

> **完全不会用？先看 [BEGINNER.md](BEGINNER.md)。**
> 那一份是给第一次做包的人的四步流程（复制模板 → 改三处 → 导出 → 上传），
> 带一个**已经跑通过**的模板包。**这份 SKILL.md 是参考手册，不是入门教程。**

---

## 1. 什么时候用

- 你要把一份**社区 mod**（就地改引擎源码的那种）改写成工坊包，收进本仓库
- 你要新写一个 mod，并希望它在**引擎升级后仍然能装**
- 你要判断「这份 mod 到底能不能做成包」（有些改动没有接口，见 §15）

## 2. 这个仓库是什么

三个目录，三种含义：

| 目录 | 放什么 | 判定 |
|---|---|---|
| `packs/<包 id>/` | **兼容已完成、验过**的包 —— 能直接装 | 闸门：必须全部装上 |
| `demo/<包 id>/` | **已过时的样板**：三份旧包，**不再对外提供、不要照抄** | 退役：见 [`demo/README.md`](demo/README.md) |
| `incoming/<mod 名字>/` | **组员上传、尚未完成兼容**的 mod 原件 | 只报告，不拦 |

一份包一份目录，`pack.json` 是它的唯一入口。**目标是把 `incoming/` 里的东西变成 `packs/` 里的东西。**

**不是**：不是游戏本体、不是引擎源码；**含官方素材的包如实收录，但必须标注清楚**（§14 素材口径）。
包由玩家（或整合包）拷进引擎的工坊目录后才生效。本仓库只负责**存放、署名与兼容性校验**。

## 3. 包形状的三条硬规则（踩过坑，先看这三条）

| # | 规则 | 错了会怎样 | 依据 |
|---|---|---|---|
| ① | 装载器**只认** `<工坊根>/<包 id>/pack.json` | 外层再套一层目录 ⇒ 读不到 `pack.json` | `server/workshop.js:94-110` |
| ② | **目录名必须等于 `pack.json.id`** | `PACK_ID_MISMATCH`，整包跳过 | `shared/workshop.js:1443-1447` |
| ③ | **zip 的顶层目录 = 包 id**（包内文件全在这一层里，不再多套一层） | 解压后多一层 ⇒ 落到规则 ① 的坑里 | 同上 + `README.md` §「怎么装一个包」 |

规则 ③ 是本轮真踩过的：把 `packs/<包 id>/` **整个目录**压进 zip，解压出来就是
`<工坊根>/<包 id>/<包 id>/pack.json`。**判据只有一条：zip 里 `pack.json` 的路径必须是
`<包 id>/pack.json`** —— 顶层目录名 = 包 id，文件名跟在它后面，也就是「深度为 2」。
这三句话说的是同一件事，任取一句检查都一样。

> 一个包一个 zip，条目名一律正斜杠（`/`）。同一份目录压两次得到两个哈希，别混。

**同一份包，两个落点两套形状 —— 别二选一**：

| 落点 | 判据 | 形状 |
|---|---|---|
| **仓库 / 引擎装载器** | 装载器只认 `<工坊根>/<包 id>/pack.json`（规则 ①） | zip **两种都收**：规则 ③ 的 `<包 id>/pack.json`，或 `pack.json` 就在 zip 根。引擎 `tools/workshop-pack.mjs:191-200` 按「根 → 否则唯一的顶层目录」解析（多个顶层目录都带 `pack.json` 才拒） |
| **站点上传**（`compat-submit` / 普通投稿） | 站点**只认 zip 根**：`site/server.mjs:180-185 packJsonFor` 精确匹配条目名 `pack.json`（`site/zip.mjs:110`），读不到就 400 拒收 | **必须扁平**：`pack.json` 直接在 zip 根 |

⇒ **投站**时不要套顶层目录（规则 ③ 那个形状会被拒）；本地装载与仓库存档用规则 ③ 的形状。

## 4. 先懂四个概念

**① 层（`layer`）** —— 包能碰到什么，由它声明的字段推导；写不写都会被算出来：

| 层 | 能改 | 典型 |
|---|---|---|
| `A` | 只有数据与素材（棋子/盟约/装备/特质/召唤物/图标） | 内容包 |
| `B` | 服务端行为（钩子、注册表、元数据） | 改规则 |
| `C` | 客户端界面（面板、包裹组件、样式、文案） | 改界面 |

`combat: true` 表示这个包**能改变战斗结果** —— 装了它的对局不能与官方对局逐帧比较，玩家必须知情。
挂 `server.meta` / `server.battle` / 带 `matchClass` 的 `server.modules` 而没写 `combat: true`，
会被 `META_NEEDS_COMBAT` / `BATTLE_NEEDS_COMBAT` / `MODULES_NEED_COMBAT` 直接拒
（`shared/workshop.js:2385-2397`）。

**`combat: true` 的告知义务（判据）**：mod 是**房主建房间时自己选**装不装的
（业主 2026-10-11 口径：「标注好会影响游戏结果就行了，做到了告知义务」）⇒ **不另设闸门**，
只要**标注清楚**就算尽到义务。所以：

| 看到什么 | 判定 |
|---|---|
| `pack.json` 写了 `combat: true`，包的说明（`PROVENANCE.md` / 包内 `notice`）也讲明「会影响对局结果」 | ✅ 已尽告知义务 |
| 能改结果却**不写** `combat: true` | ❌ 装载器直接拒（上面三个拒绝码）；**不标 = 静默改结果**，这才是问题 |
| 写了 `combat: true`，但包里包外都不提这件事 | ❌ 属于漏告知，补上说明再交 |

**站上目前不显示这一栏**（站点代码里没有 `combat` 字样；能贴自由文本的只有「兼容说明」那一栏）——
那一格由维护者填，见 [AGENTS.md](AGENTS.md) §5.1。

**② `pack.json`** —— 字段全集就是引擎的 `PACK_FIELDS`（`shared/workshop.js`，一个不多一个不少）：

```
id, name, version, author, license, description, gameVersion, game, api, layer, combat,
content, overrides, voices, voiceLangs, bondIcons, itemIcons, art, skins, support, operators, i18n,
forms, fx, notices, playtest, enabled, callBudget, variants, behaviour, assets, client, server, routes,
matchKinds, target, dependencies, conflicts
```

> **共 38 键**。最近新加的几格：**`enabled`**（§19.9）、**`callBudget`**（§19.10）、**`matchKinds`**（§19.16），
> 加上更早的 `target` / `dependencies` / `conflicts`（§19.2 / §19.3）。
> 不认识的顶层键**点名整包拒**（`PACK_UNKNOWN_FIELD`），**绝不读过去**。

**②-a `content` / `overrides` / `modules.uses` 是三件不同的事，别混**：

| 写法 | 是什么 | 形状与判据 |
|---|---|---|
| `content: ["chess", …]` | **新增**：声明本包要读哪几个内容文件，加载器把它们**叠加**到官方数据上 | 名单是引擎固定的 **15** 个文件（§20.2；`variants` 是 §28.51 加的第 15 个）；声明了却缺文件会被点名 |
| `overrides: ["chess:chess_char_1_01_a", …]` | **覆盖官方记录**：`"<文件>:<官方 id>"`。它先是一条**所有权声明**（「这条官方记录由本包重新定义」，装载器**不按名字前缀猜归属**），而覆盖本身是**字段级补丁** —— 只写你要改的字段，其余字段从官方记录**递归逐字段**合并过来；**数组类字段整块替换**，另有 11 个键（`skill` / `skills` / `trait` / `traitBase` / `traitOverride` / `modules` / `rangeGrid` / `attackRangeGrid` / `assets` / `diy` / `bonds`）也整块取；`talents` 这类**按身份键逐条**合并 | 形状 `shared/workshop.js:194`、归一化 `:1853-1856`；**字段级合并** `shared/workshop.js:2990-3000`（`mergeRecord`）；**数组整块替换 + 11 键例外** `docs/design/mod-layer.md:238-258`（§A2）；读取点 `server/workshop.js:1172-1178`、`:1243`；拒绝码 `KIT_OFFICIAL_OVERRIDE_UNDECLARED`（`:1292-1299`） |
| `server.modules[].uses: ["matchClass", …]` | **挂载点**：这个服务端模块拿到哪几种能力。`matchClass` 是**唯一能改对局结果**的那一种 ⇒ 声明它**必须 `combat: true`** | 闭枚举 `shared/workshop.js:529`；`combat` 硬闸门 `:977` |

**③ `api` 与 `game` 是两回事** ——

- **`api`：模组 API 版本区间，引擎会强制比对。** 当前 `MOD_API_VERSION = 1`。
  合法写法（**列举，不是唯一写法**）：`">=1 <2"`、`"1.x"`、`"1"`、`"^1"`、`"~1"`、`"*"`、`"1 || 2"`。
  引擎抬到 2 时，写 `1.x` 的包会被**明确拒掉**并说明理由（`MOD_API_INCOMPATIBLE`，
  `shared/workshop.js:2365-2371`）—— 这正是你要的保护：宁可拒绝，不要带着错的行为跑起来。
- **`game`：上游游戏版本区间**。引擎目前**只校验它是不是合法区间，不比对**
  （`shared/workshop.js:2375-2376`）。它是给人和工具看的信息，不是闸门。
  `gameVersion` 是它的旧名（读的时候 `game` 优先），新包写 `game`。

**④ 身份哈希** —— 每个包按内容算一个哈希。改了包里的**任何字节**，哈希就变。它的用途是让玩家一眼看出
「这个包还是不是我上次装的那个」。**不要为了改哈希而改哈希**，也不要手写哈希进文件。

## 5. 四个沉默的坑（本轮真踩到，全部要点名）

### 5.1 未知顶层键 ⇒ **整包拒绝**（不是忽略）

`pack.json` 的顶层键是**闭集**（`shared/workshop.js:1435-1442`）。写一个这份格式不认识的键，
加载器**点名拒绝整个包**：`PACK_UNKNOWN_FIELD`，理由里列出全部合法字段。
「写了等于没写」是本格式最想消灭的失败方向 —— 所以它是拒绝，不是静默丢弃。

**本轮实测踩到的真错键名**（都是「编辑器里有、装载器不认」）：

| 写错的键 | 引擎实际用的键 | 说明 |
|---|---|---|
| `type` | （没有这个键） | 包类型由声明推导出 `layer`，没有一个叫 `type` 的字段 |
| `app` | `client` / `server` / `routes` / `assets` | 「这个包给谁的」没有独立字段 |
| `englishName` | `name`（包名只有一个） | 没有第二语言的名字字段 |
| `target` | `api` + `game` | 「它针对哪个版本」拆成两个区间字段 |
| `capabilities` | `client` / `server` 里的具体声明 | 「能力」不是一个笼统数组 |
| `authors` | **`author`** | 复数形式不存在；署名是单数字符串 |

### 5.2 `api` 必须是**字符串区间**

```jsonc
{ "api": ">=1 <2" }   // ✅ 对
{ "api": 1 }          // ❌ 类型闸门拒绝：BAD_API_TYPE
```

类型闸门先于区间校验（`shared/workshop.js:2348-2364`）。注释写得很直白：非字符串的声明
**会被读成「没声明」** —— 那正是「写了等于没写」。所以这一层宁可当场拒。

**两个要注意的次序 / 语义细节**（实测过，容易误判）：

- **次序：类型闸门排在 `EMPTY_PACK` 之后**。判据：一个 `content: []`、也没有别的贡献项的包，
  报的是 `EMPTY_PACK`，**看不到** `BAD_API_TYPE`。
  所以看到 `EMPTY_PACK` 时，先按 §5.3 补上贡献项再跑一次，才知道 `api` 的类型对不对。
- **合法写法是一批，不是一个**：`isVersionRange` 接受 `">=1 <2"` / `"1.x"` / `"1"`（精确版本）/
  `"^1"` / `"~1"` / `"*"` / `"1 || 2"` 等；上面代码块里的 `">=1 <2"` 只是**其中一个例子**，不是唯一写法。
  错的是**类型**（数字 / 布尔 ⇒ `BAD_API_TYPE`），不是「没写两个点」。

（历史教训：一份包把 `api` 写成数字，编辑器里它存在、磁盘上它也在，却始终进不了游戏。
现在的代码会给一条带 `BAD_API_TYPE` 的明文拒绝，不再需要人猜 —— 前提是那份包没有先被
`EMPTY_PACK` 挡住。）

### 5.3 `content` 必须声明 `chess`，否则加载器**完全不读**这个包的 `chess.json`

装载器只读**声明过的**内容文件（`shared/workshop.js:1799-1809` 归一化，
`server/workshop.js:120-137` 按归一化后的清单逐个读盘）：

- `content` 里没写 `chess` ⇒ `chess.json` **一个字节都不会被读**；
- 症状**全是静默的**：商店摇不到它、试玩里没有它、日志里也没有错误；
- 只有 `pack.json` 里写上 `"content": ["chess"]`，那份文件才会被并进 `data/chess.json`。

```jsonc
{ "content": ["chess"] }   // ✅ 干员/棋子记录会被读
{ "content": [] }          // ❌ chess.json 在磁盘上，但没有任何人读它
```

`content` 只接受固定名单（`shared/workshop.js` 的 `WORKSHOP_CONTENT_FILES`，**15** 个）：
`chess, units, items, enemies, stages, waves, tokens, bosses, factions, garrisons, bands, bonds, effects, choices, variants`。
**名单以外的值不是「被过滤掉」，是点名整包拒**（`UNKNOWN_CONTENT_FILE`）—— 写一个引擎不认识的内容文件名，
得到的是拒绝，不是静默丢弃。

**「`content` 不能为空」是错的读法。** 判据是这条：

| 看到什么 | 判定 |
|---|---|
| `content: ["chess"]` | ✅ 包有贡献项 |
| `content: []`，但另有贡献项（`voices` / `operators` / `bondIcons` / `itemIcons` / `art` / `skins` / `i18n` / `notices` / `forms` / `fx` / `assets` / `client` / `server` / `routes`） | ✅ 合法（`content` 空着不算错） |
| `content: []`，且没有别的贡献项（只写 `support` / `playtest` 也算没有） | ❌ `EMPTY_PACK` |

**`support` 与 `playtest` 不是贡献项**：只写 `support` 而 `content: []` 的包会被
`EMPTY_PACK` 拒，理由里点名这一句（`shared/workshop.js:2652-2666`；引擎
`docs/WORKSHOP.md:665-666`、`:1897-1898` 也这么说）。

### 5.4 未声明的通道会被点名

`client.panels[].messages` 里声明过通道才能收发（§9.1）。一个**永远不响的订阅**是这一层最不愿留下的东西，
所以未声明的通道是**点名**而不是静默。

## 6. 公告 / 鸣谢走 `notices`（只认两个字段）

`notices` 只认 `announcement` / `credits`，**各指向一个包内相对 `.json` 路径**（不是内联文本）
（`shared/workshop.js:1051-1073`）。两条都遵守同一条纪律：**清单里没写这个键，哈希逐字节不变**。

**「追加」的判据**：`notices` 是**追加**语义 —— 两个包的公告不会互相覆盖，引擎自带的公告也不会被包顶掉
（`shared/workshop.js:1047-1048`）。所以它不是「合并顺序由包决定」，而是「**谁都不顶掉谁**」。

```jsonc
// pack.json 里
"notices": {
  "announcement": "notice/announcement.json",
  "credits": "notice/credits.json"
}
```

两份文件的形状：

```jsonc
// notice/announcement.json
{ "version": "1.0.0", "date": "2026-10-11", "summary": "一句话说明这次更新",
  "sections": [ { "name": "改动", "items": ["第一条", "第二条"] } ] }
```

```jsonc
// notice/credits.json —— 顶层是数组；url 只能是 https://
[ { "name": "某位作者", "note": "他做了什么" },
  { "name": "另一个来源", "note": "数据参照", "url": "https://example.org/" } ]
```

形状被 `parseNoticesDecl` 判（`shared/workshop.js:1044-1045` 记录了两个形状）；
写错的字段名得到 `NOTICES_UNKNOWN_FIELD`，空对象得到 `NOTICES_EMPTY`，路径不是包内 `.json` 得到
`NOTICES_BAD_PATH`（`:1054-1071`）—— 三条都点名，都不静默。

**可抄的最小完整例子**：[`docs-copy-examples/notices/pack.notices.json`](docs-copy-examples/notices/pack.notices.json)、
[`notice/announcement.json`](docs-copy-examples/notices/notice/announcement.json)、
[`notice/credits.json`](docs-copy-examples/notices/notice/credits.json)（三份照抄即可）。
**形状看哪里只有一个答案：`docs-copy-examples/notices/`。**
本轮之前的先例是 `demo/plugin-pack/notice/credits.json` —— 它的**形状与上面三份相同**，
但 `demo/` 已退役、里面是**真人姓名与真 URL**：**结构可以照抄，内容不要照抄**。

## 7. 落成包格式（最常用的一屏）

```
packs/<包 id>/
├── pack.json            必需
├── PROVENANCE.md        必需：署名与来源（§10）
├── <content>.json       数据层：bonds / chess / garrisons / items / tokens …（名字由 pack.json 的 content 列出）
├── kits/*.js            行为层：自定义干员 kit（只能 import 白名单里的别名，见下）
├── ui/*.js              界面层：面板模块（浏览器原生 ESM）
├── css/*.css            界面层：样式
├── i18n/<lang>.json     文案（键与引擎一致：zh-CN / zh-TW / en / ja / ko）
├── notice/*.json        公告与鸣谢（由 pack.json 的 notices 指向，§6）
├── assets/**            包自带的素材（图标、徽记、音效…）
└── server/*.mjs         服务端成员：preDispatch / meta / modules / battle / room
```

**能被 import 的东西是白名单**（引擎的 kit import map，共 **22** 条，写别名、**不写相对路径**）：

```
@kit/tier1.js … @kit/tier6.js   @kit/summoner.js
@sim/constants.js  @sim/dir.js  @sim/targeting.js  @sim/detmath.js  @sim/body.js  @sim/professions.js  @battle/index.js
@ops/op-shwaz.js  @ops/op-ray.js  @ops/op-aglna2.js  @ops/op-thumpy.js
@ops/op-aphris.js  @ops/op-heyak.js  @ops/op-jesca2.js  @ops/op-nasti.js
```

⭐ **`@sim/detmath.js`**（2026-10-15 加）是**上游单有、本引擎此前缺**的那一条：包里要算几何（射程 / 方向 /
距离）时，**唯一**的正当写法就是 import 它 —— 引擎的确定性硬规矩不许 `server/sim/` 直接用
`Math.sin` / `Math.cos` / `Math.atan2` / `Math.hypot` / `Math.pow` 这类「两端可能不一致」的函数，不开放它
作者只能自己抄一份 `Math.*`（`shared/kitImports.js:83-95`）。

`@ops/` 那 8 条是**按文件开的官方 ops kit**（2026-10-14 起 4 个，2026-10-15 加到 8 个）：包里的棋子就是
某名官方干员换皮时，直接 `import opShwaz from '@ops/op-shwaz.js'` 再调 `opShwaz.char_340_shwaz(bb, chess)`，
**不必**把引擎子系统复制进包（那条路的依赖闭包实测 18 个文件 / 513 KB）。⚠️ `@ops/` 是**命名空间不是放行**：
这 8 个之外，同前缀的文件（如 `@ops/op-siege.js`）**仍然被拒** —— 要用别的官方 kit 就按上面那条「做不成包」
处理（`shared/kitImports.js:105-106`、`:43-44`；`test/kitImports.test.js` §⑥ 把这条界线钉住，含按前缀计数断言）。
后加的 4 个（`op-aphris` / `op-heyak` / `op-jesca2` / `op-nasti`）来自投稿 `rimbilliton`：
`shared/kitImports.js:108-125`。

想用白名单以外的东西 = **这个 mod 做不成包**（§15），不要试图用相对路径绕过去：装载器会拒。

**界面槽位**（`client.panels` 的 `slot`，共 10 个；`screen.game.shopCard` 是**可重复**的，
会往每一张商店卡上挂一个，模块靠 `ctx.hostKey` 分辨自己在哪一个）：

```
root.overlays  root.guide  screen.game.aside  screen.result.footer
screen.game.shopCard  screen.game.bondStrip  screen.game.hud  screen.game.overlay
screen.loadout.detail  screen.room.aside
```

**前四个是浮层，后六个在引擎已经渲染的组件里**（业主 2026-10-10 裁决）：`screen.room.aside` 是房间屏
（等待开局那一屏）的**旁栏**，由**组件自己**渲染 `[data-mod-slot]` 容器、面板往里填 —— 它**不是**引擎按需
创建的浮层（`public/js/ui/extensions.js:82-84` 的「first four … overlays / last six live inside components」、
`:93-94` 的 10 条、`shared/workshop.js:394-396` 的另一份 10 条、`docs/WORKSHOP.md:960` 的「十个挂载点」与
`:973` 那一行）。

**能被包裹的组件**（`client.wrap`）：`game.bondStrip`、`game.hud.topBar`、`game.shopCard`、`loadout.detail`。

**包里的 URL 前缀**：素材 `/workshop-assets/<包 id>/…`，面板模块 `/workshop-panels/…`
（`shared/workshop.js:228-240`）。

## 8. 「有更好的逻辑就用我们的」（业主原则）

**写包之前先查引擎有没有现成通道。** 自己重造一份的代价是「两套真相会漂」，而且漂的方向通常是静默。
下表左列是社区 mod 里反复出现的做法，右列是本仓库要求改用的通道 —— **逐条都可抄**。

| 原件常见做法 | 改用引擎的通道 | 依据 |
|---|---|---|
| 自己塞一整套变量覆盖样式表 | `client.theme.vars`：**加法**语义，只写 `--` 开头的自定义属性，只认 `vars` 这一格 | `public/js/ui/extensions.js:1106-1120`（`applyTheme`）；`:9` |
| 自己全局 `!important` 把动画归零 | 引擎**已有**的 `@media (prefers-reduced-motion: reduce)` 通道（全站 `*, *::before, *::after` 收到 `1ms !important`）+ `reducedMotion()` | `public/css/theme.css:387-393`；`public/js/ui/device.js:106-107` |
| 面板里自己重算引擎数据 | `ctx.data.get('<表>')`（冻结深拷贝）+ `ctx.net.on('m.result')` 这类**只读引擎数据**；不要自己重新算一遍 | `public/js/ui/extensions.js:776-797`（`dataFacade`） |
| 自己造资源分发 / 导入 / 准入 | 引擎**内建**的 `public/js/resources/*`（`bundle.js` / `verify.js` / `host.js` / `worker.js` / `service.js` / `common.js`） | 目录实测存在；退役理由见 [`demo/README.md`](demo/README.md) |

**关于「一律归零」**：引擎的通道要用户 / 系统**声明了 `reduce`** 才生效。
如果原件的行为是「装上就一律归零」，**不要**写一份无条件的全局 `!important`；
正确做法是把它做成**用户开关**（默认走引擎通道），开关状态存在 §9.3 的偏好口里。
拆开说：**默认尊重平台偏好，用户主动打开才一律归零。**

## 9. 面板 ctx：一个面板能拿到什么

面板模块的 `mount(ctx)` 拿到的 `ctx` 是**冻结对象**。键以 `public/js/ui/extensions.js` 里 `panelContext` 的
`return Object.freeze({…})`（`:1351`）**实际列出的**为准 —— 不要拿文件头那份旧注释当依据，它跟不上后加的格子。

**面板与整屏拿到的不是同一套**（§19.17）：普通面板是下面这 **12 键 ＋ `battle`**；`client.screens` 的整屏模块是
**12 键 ＋ `screen` / `actions` / `ui`**，而**没有** `battle`。

| 键 | 是什么 |
|---|---|
| `id` | 这个面板的 id（`client.panels[].id`） |
| `pack` | 包 id |
| `slot` | 挂载槽位 |
| `order` | 排序 |
| `gate` | 入场条件（`session.setPreload` 那一对标志的名字） |
| `host` | 注册点拥有的那个容器元素 —— 包可以往里填，别的都不行 |
| `hostKey` | **可重复宿主**里分辨「我是哪一份」（商店卡那个键就是棋子 id），不可重复宿主为 `null` |
| `log` | `info` / `warn` / `error`，自动带 `[mod <包 id>]` 前缀 |
| `session` | 见 §9.3 |
| `net` | 见 §9.1 / §9.2 |
| `data` | 只读数据口（§8 那一条） |
| `me` | 只读会话态：`playerId` / `name` / `room`（房间**展示面**快照：`code` / `mode` / `difficulty` / `inMatch` / `mySeat` / `spectating` / `mods`），另有 `snapshot()` 一次取全 |
| `battle` | **只有普通面板有**：只读战斗读数（`damage()`，以及冻结的 `players` / `units`）。⚠️ 它是**读数**，不是战场句柄 —— 面板能看，不能改结果。整屏模块**没有**这一格（§19.17） |

**边界就是「没传什么」**：**没有** store 句柄、没有 `Match` 对象、没有 `battleRunner`、没有 audio。
面板**有** `ctx.battle`，但那是**只读读数**（`damage()` 与冻结的 `players` / `units`），不是战场句柄 ——
所以一个 C 层模块可以「画错」，但改不了对局结果。

### 9.1 `ctx.net` 的全部成员（6 个）

| 成员 | 做什么 |
|---|---|
| `on(type, fn)` | 订阅。**引擎类型**原样透传；其余名字必须先在 `client.panels[].messages` 里声明，否则点名 `CLIENT_CHANNEL_UNDECLARED` 并返回一个空退订函数 |
| `send(channel, data)` | 发**自己的**通道消息（`pack.msg`），通道必须声明过 |
| `sendResourceMessage(msg)` | 发资源挑战那一类**早于 `hello`** 的消息（走 `_sendRaw`，`send()` 会丢） |
| **`status()`** | **本轮新增**：连接读数，见 §9.2 |
| **`welcome()`** | **本轮新增**：服务器身份读数，见 §9.2 |
| （无其它） | 面板**拿不到** `WebSocket`、心跳往返、重连计数器 —— 所以那两格只能由引擎给 |

### 9.2 两格新读数的返回形状与只读语义

```jsonc
// ctx.net.status() —— 每次调用都是一份新的、冻结的副本
{ "status": "idle|connecting|connected|handshaking|online|reconnecting|closed",
  "attempt": 0, "retryAt": 0, "ping": null,
  "lastError": { "code": "REPLACED", "text": "…" } | null }
```

来源是引擎自己那份连接状态（`Net.snapshot()`，`'status'` 事件携带的就是它），**同一条事实，不是第二份推断**。
只带这五个键，引擎内部字段（如 `playerId`）不外传（`public/js/ui/extensions.js:948-966`）。

```jsonc
// ctx.net.welcome() —— 已收到的那一帧 welcome 的冻结深拷贝
{ "playerId": "…", "name": "…", "token": "…", "serverNow": 0, "version": "…",
  "mods": { "digest": "…", "packs": [] }, "modPanels": [], "maxSeats": 0 /* … */ }
```

帧里的字段**原样保留**：不裁、不改名、不补默认值（`public/js/ui/extensions.js:995-1003`）。
**为什么需要它**：面板是由**同一条 `welcome` 帧**装载的（面板清单走 `welcome.modPanels`），
所以面板在 `mount()` 里自己去订阅这一帧，首帧大概率赶不上、要等一次重连才知道对面是谁 ——
这正是社区投稿报过的卡点（引擎 `docs/design/mod-layer.md:2225-2237`）。

两格共同的语义（三条，都要照做）：

1. **冻结、拿不到即 `null`** —— 不抛、不编造、不补默认值。没有读数就画空态。
2. **不新增协议消息**：不发任何帧、不发请求、不改引擎行为（引擎侧有机械断言盯这一点，
   `docs/design/mod-layer.md:2252-2253`）。
3. **加能力不抬 `MOD_API_VERSION`**：两格是往**已存在的对象**上加成员，
   `MOD_API_VERSION` **不动**、已发布的包不会被拒（`docs/design/mod-layer.md:1990-1991`）。
   所以包侧的正确写法是「有就用、没有就优雅降级」，不是「判版本、缺了就报错」。

> 引擎侧的规范：`docs/design/mod-layer.md` **§28.24**（`status()`，`:1998`）与 **§28.25**（`welcome()`，`:2028`）。

### 9.3 `ctx.session.setPref` / `getPref` —— 唯一一格能写的东西

面板**没有** `localStorage`、也没有 store 的写权限。要记住「每干员选了哪套」这类东西，用这一格：
键自动按 `<包 id>/` 分区（两个包用同一个键名不会互相覆盖），值只收 `string` / `number` / `boolean` / `null`，
键 1..64 字符、字符串值 ≤512 字符，**越界一律 `false` 并点名**（`CLIENT_PREF_BAD_KEY` /
`CLIENT_PREF_BAD_VALUE`），不静默（`public/js/ui/extensions.js:715-736`）。

```js
const on = ctx.session.getPref('hardOff', false);   // 默认关
ctx.session.setPref('hardOff', true);              // 返回 true / false
```

`session` 的另一半是 `setPreload({ required, ready })` —— 入场闸门，**唯一**一格 store 写。

## 10. 署名与许可纪律（不可省）

**每个包必带 `PROVENANCE.md`**（放在包根，与 `pack.json` 同级），写清**六项**：

| # | 项 | 要求 |
|---|---|---|
| 1 | 原作者 | 名字；**原件未署名就写「原件未署名」，绝不代填** |
| 2 | 许可 | **照实抄**包内 `pack.json` 的 `license` 原文，含 `NOASSERTION` 这类**非 SPDX 值**也照抄 |
| 3 | 兼容改写者 | 做兼容改写的那个人（与原作者**分开列，不抹掉任何一方**） |
| 4 | 来源 | 从哪来的、可追溯的编号 / URL / 版本（能记 sha256 就记） |
| 5 | 改了什么 | 逐条：原做法 → 我们的做法 → 为什么 |
| 6 | 自带素材来源 | 逐条；没有就写「无」 |

**包内文本一字不改** —— 但「哪份文件归谁」只有一种读法：

| 文件 | 归谁写 | 规矩 |
|---|---|---|
| 原作者自带的 `README` / `NOTICE` / `CREDITS` / `LICENSE`，以及包自带元数据（`pack.json` 的 `name` / `version` / `author` / `license` / `api` …） | 原作者 | **一个字节都不改**。要同时保留原件许可时，把那份原件许可**改名**为 `NOTICE-原件-*` 随包 —— 改名不算改内容 |
| `PROVENANCE.md`（包根，与 `pack.json` 同级） | 兼容改写者（我们） | **必带**，写上面那六项。**它与「原件未署名就写『原件未署名』」那条是配合关系，不是二选一** |
| 「我们的新实现与原件文本不符」这件事 | 兼容改写者（我们） | **只写进 `PROVENANCE.md`**，不动上面那一栏任何文件。判据：`PROVENANCE.md` 里能看到「哪一处不符 + 保持原样未改」，而原件文本里找不到任何被我们改过的痕迹 |

格式照这个来：

> `pack.json.name` 已与实现不符（**保持原样未改**）：它写的是「无条件关动画」，
> 本版改成用户开关、默认走引擎通道。

其余许可规矩：

- 本仓库**整体**以 **GPL-3.0-or-later** 分发（`LICENSE`），**但每个包仍以自己 `pack.json` 的 `license` 为准**
- **非商业**：本仓库及其收录的包**不得用于任何商业用途**（见 `NOTICE.md`）
- 游戏本体的名称、素材与商标归**鹰角网络**所有

## 11. 工作流（本轮实际怎么做的）

```
⓪ 先判有没有功能        装上会改变某项游戏内行为吗？不能 ⇒ 别投成包（§15.1）
① 重打成 zip 根形状      包内文件放进**一个顶层目录**里、目录名 = 包 id（§3 规则 ③）
② 修包契约              pack.json 只留 PACK_FIELDS 的键；id = 目录名；content 声明到位（§5）
③ 该用我们的实现就换    逐条过 §8 的替代表，别自己重造引擎已有的通道
④ 干净 workshop 根装载   一包一根、单独装载、要 errors=0（把原始输出贴进交付说明）
⑤ 一包一 zip             顶层目录 = 包 id（zip 里 pack.json 的路径 = `<包 id>/pack.json`）；条目名正斜杠
⑥ 补 PROVENANCE.md       六项（§10）
⑦ 记字节与 sha256        zip 的字节数与哈希记在交付清单里，不写进包内文本
```

> ①⑤ 这两个形状是**仓库收录 / 本地装载**用的（§3 规则 ①–③）；**投站上传要扁平** —— 站点只读 zip 根的
> `pack.json`，套了顶层目录即 400 拒收，见 §3 那张「两个落点两套形状」表与 [AGENTS.md](AGENTS.md) §6 ⑧。

**第 ④ 步不能省**：拿**干净的空工坊根**（只有这一个包）跑一遍引擎自己的装载器，
**要 `errors=0`**，并把**原始输出**留着。理由：混装时一个包被拒是分不清「谁的问题」的。

**多 mod 时：一个 mod 一个子 agent 并行。** 这是业主明确口径 —— 包之间不共享状态，
唯一要共享的是「引擎通道怎么用」这条知识（本文 §8）。

## 12. 验证（做完必跑）

```bash
# 拿引擎自己那一份装载器过一遍三个目录（引擎升级后也这么验）
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge

# 只看某一个目录
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs

# 机器可读（给 CI / 其他工具用）
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --json
```

**判定标准**：
- `packs/` 与 `demo/` 是**闸门** —— 里面的包必须全部 `✓`，且**一个 `✗` 都没有**（退出码 0）
  （`demo/` 已**不再对外提供**，见 [`demo/README.md`](demo/README.md)；闸门管的是「文件还装得上」，未因退役改动）
- `incoming/` **只报告不拦** —— 那里的包被拒是正常的（还没做兼容），退出码不受它影响

刷不出来的常见原因：`id` 与目录名不一致、`pack.json` 里有 `PACK_FIELDS` 之外的键、
`api` 不是字符串区间 / 区间与 `MOD_API_VERSION` 对不上、`content` 没声明要读的文件、
引用了白名单外的模块、声明了不存在的槽位、`content` 为空且没有别的贡献项（`EMPTY_PACK`）。

> **`EMPTY_PACK` 会掩住后面的判罚**：`content` 为空且没有其它贡献项时，它先报出来，
> 于是 `api` 的类型错误（`BAD_API_TYPE`）看不到。**补上 `content` 再跑一次**（§5.2）。

### 12.1 作者侧自测：拿**真引擎的校验器**过一遍（不自测不算做完）

`check-packs.mjs` 是**本仓库**对 `packs/` / `demo/` / `incoming/` 的闸门；**你自己那个包**在交上来之前，
先用引擎自己的校验器跑一遍 —— 它比装载器更早、更细，且**规则只有一份**（判据本体住在
`shared/workshopValidate.mjs`，CLI 与编辑器界面调的是同一个函数）：

```bash
# ① 起一个临时工坊根，把包按装载器认识的形状放进去（目录名 = 包 id）
#    Windows: mkdir %TEMP%\myshop && xcopy /E /I my-pack %TEMP%\myshop\my-pack
SP_WORKSHOP=/tmp/myshop node <引擎>/tools/workshop-validate.mjs --workshop /tmp/myshop --json

# ② 判据：JSON 里的 errors 必须是 0（warnings 可以留，但要逐条看懂）
```

- **`errors` 必须 0**。非 0 时引擎会**整包拒**或**静默少读一个文件**（§5.3 就是后者），别指望「装上试试看」。
- `--json` 给的是机器可读结构（给 CI / 你自己的脚本用）；不带 `--json` 是人读的分层报告
  （格式 → 语义 → 真实引擎 → 每种内容一层）。
- ⚠️ **`packs/` 是引擎的「语言包」目录，不是工坊包目录**（引擎 `docs/PACKS.md`）：往 `packs/` 里放模组
  **不会生效**，也不会给你预期的错误。模组放 `<工坊根>/<包 id>/`，或者在整合包里把 `.zip` 拖到
  `安装工坊包.bat` 上 —— 那条路装到的也是工坊目录。
- 引擎侧还有一条同源入口：编辑器包管理页的 **「校验这个包」** 按钮，调的是同一个判据。

## 13. 命令速查

```bash
node tools/check-packs.mjs --engine <引擎目录>          # 全部包过一遍
node tools/check-packs.mjs --engine <引擎目录> --json   # 机器可读
SP_ENGINE=<引擎目录> node tools/check-packs.mjs          # 用环境变量给引擎路径
```

Windows PowerShell 里用 `;` 不用 `&&`；写文件用 **UTF-8 无 BOM**（否则 Git 会把整文件当改动）。

## 14. 禁止事项

- ❌ 在 `pack.json` 里写 `PACK_FIELDS` 之外的字段（装载器会**整包拒**，且玩家装不上）
- ❌ 把 `api` 写成数字（类型闸门会拒；老版本引擎会**静默读成没声明**）
- ❌ `content` 不声明 `chess` 却指望 `chess.json` 生效（静默失败，§5.3）
- ❌ 用相对路径 import 引擎模块（只用白名单别名）
- ❌ 在 `server.modules` 的模块里用 `globalThis` —— **它已回到服务端模块源码扫描的禁止名单**（与 `process` / `require` / `eval` / `new Function` 同列；要读进程信息用 `host.metrics`、要落文件用 `host.io`，详见 **§19.15**）
- ❌ 自己重造引擎已有的通道（§8：主题变量、关动画、只读数据、资源分发）
- ❌ 删掉原作者的署名或原件许可、改包内原作者文本
- ❌ 声称本仓库或任何包可以商业使用
- ❌ 为了让校验通过而放宽校验（应当改包，不是改闸门）

### 14.1 四条红线（不是「建议」）

| # | 红线 | 为什么 / 判据 |
|---|---|---|
| 1 | **不许整份覆盖引擎文件**。`install.mjs` + `payload/**`（整份覆盖 `data/**` 与 `server/**`）那种**安装器型**形态，**判为「非标准」且违反发行纪律**：包能碰的只有 mod 层那几张闭集（`PACK_FIELDS` 与 `content` 名单），**没有**「指定任意文件」这一格 | 定级与处置 `docs/STANDARD-PACK.md:20`、`:95`（引擎侧 `docs/WORKSHOP.md` §1.1 的六格「刻意没有通道」）；包想改引擎行为，正确做法是**先在引擎里加一格**（§19.1 末尾那条纪律）。这类原件**照收进 `incoming/`、不打回**，由我们逐条看它改了什么、能靠既有通道表达的改写成包 |
| 2 | **不许夹带可执行物**：`.bat` / `.cmd` / `.exe` / `.dll` / `.ps1` 这类**不是包内容**。包里的代码只有两种 —— `server.modules[].entry` 指向的 `.mjs`（必须落在包内）与行为层 `kits/*.js` | ⚠️ **引擎今天没有「扫到 `.exe` 就拒包」的闸门**，所以这条是**收录侧的硬要求**（闸门判不了它，靠人审）：`shared/workshop.js:695`（`entry` 必须是包内相对 `.mjs`）；`kits/` 那一层**只读文本、静态校验、不执行你的文件** |
| 3 | **不许静默改对局外行为** —— 会改对局结果就写 `combat: true`，并在包自述里讲明「会影响对局结果」；**不写 = 静默改结果**，那正是要消灭的方向 | 引擎硬闸门 `META_NEEDS_COMBAT` / `BATTLE_NEEDS_COMBAT` / `MODULES_NEED_COMBAT`（`shared/workshop.js:2385-2397`）；告知义务见 §4 那张表 |
| 4 | **素材版权**：官方素材**仅本地、不随源码分发**。包里带官方素材**不因此被拒，但必须标注清楚**（包内 `PROVENANCE.md` 的机械清点 + 站上那条记录的备注），并写明**版权归鹰角网络 / Yostar**、仅供非商业的学习与个人娱乐使用，本仓库与发布者**不主张**这些素材的任何权利 | 就是下面那一段「素材口径」（与 [AGENTS.md](AGENTS.md) §3 同一份，以那里为准）。**未标注才是问题**，标注了就算尽到告知义务 |

**素材口径（业主 2026-10-12 改，取代原「素材红线」）**：**含《明日方舟》游戏素材
（解包出的美术、音频、字体、数据导出物）的包不因此被拒 —— 如实收录**，但**必须标注清楚**：

1. 包内 `PROVENANCE.md` 写明「**含官方素材**」并附**实测清点**（个数 / 字节 / 分类；
   含 `.spresources` 容器**内部**的清点）—— 见 §10 第 6 项
2. **站上那条记录的备注里也写明**（能承载自由文本的只有「兼容说明」一栏）
3. 写明**版权归鹰角网络 / Yostar**、**仅供非商业的学习与个人娱乐使用，请勿用于任何商业场景**，
   并声明本仓库与发布者**不主张**这些素材的任何权利

包自带的自制素材同样要**逐条写明来源与授权**。**未标注 = 问题**（那才是要消灭的方向）；
**标注了就算尽到告知义务**，不另设闸门。这条与 [`AGENTS.md`](AGENTS.md) §3「素材口径」是同一份，以那里为准。

- 包**可以自带**素材（同人绘制的图标、徽记、自制音效），放进 `assets/` 并**逐条写明来源与授权**
- 包**可以引用**引擎里已有的官方素材
- 包**可以随包带**官方素材（解包出的美术 / 音频 / 字体 / 数据导出物）—— 但必须照上面的口径**标注清楚**
- 包**不可以**声明把自己挂成官方素材的替代品（引擎有准入规则，会拒）

## 15. 做不成包的情形（先判断，别白做）

| 原件做了什么 | 能不能成包 |
|---|---|
| 改 `data/*.json` 的数据、加棋子/盟约/装备/特质 | ✅ 数据层 |
| 改界面（加面板、包裹组件、改样式、加文案） | ✅ 界面层 |
| 用白名单别名写干员 kit、注册服务端钩子 | ✅ 行为层 |
| 改 `server/sim/` 的内部实现、`server/match/` 的流程 | ❌ 没有接口 |
| 改引擎的结算顺序、加新的伤害类型、动 golden 结果 | ❌ 没有接口 |
| import 白名单以外的引擎模块 | ❌ 装载器拒绝（`KIT_NO_TARGET` / 白名单校验） |

**做不了的部分要如实写进包的说明**（`fanpack-kazdel-rhodes` 的
`README-改写说明.md` / `NOTICE-来源说明.md` 是这个体例：原件哪些部分没有接口、为什么、影响了什么）。

### 15.1 没有功能的，**不要投成包**

**判据**：一个包要能被收录，装上之后必须**改变某项游戏内行为**（数据 / 界面 / 服务端任一层）。
**只放 JSON 资料 + 说明面板、自述 `documentation-only` / 只读参考的包不上架**
（业主 2026-10-11 口径：「documentation-only 不放，有功能我们再放」）。
但**「不上架」≠「打回」**：**处理方式是「留在待审」，不是「打回」** —— 它的**记录与简介要保留**，
那是我们**做兼容包改写的依据**；打回会写下 `decision.json`（`decision: rejected`），
该条**离开待审队列**、掉到 `?view=rejected` —— doc-only 件**不走这一步**。等它有真实功能再上架。

| 看到什么 | 判定 |
|---|---|
| 包里有真实数据 / 界面 / 服务端行为 | ✅ 投 |
| 只有 `README` / 说明面板 / 参考表，装了没有任何行为改变 | ❌ **不上架**，但**留在待审、不要打回**：记录与简介保留（是兼容包改写的依据），等它带上真实功能再上架 |

**做不成功能的东西去哪儿**（不要硬塞成「参考包」）：

- 属于**引擎能力**的（新接口、结算顺序、`server/sim/` 内部）⇒ 去引擎仓库提（本仓库只索引，改不了它）；
- 属于**发行说明 / 资料**的 ⇒ 随发行工件或 `PROVENANCE.md` 走，别做成包；
- 拿不准的 ⇒ 写进「待裁决」，别先投上去。

**为什么这条重要**：下载者按下「安装」时的预期是「装了会有效果」。一个装上不启用任何功能的包，
消耗的是这份预期 —— 用户会先去查「我是不是装错了」。

## 16. 引擎侧的权威文档（本仓库只做索引）

- `docs/WORKSHOP.md` —— 工坊包格式的完整规则（`pack.json` 每个字段、层、覆盖、语音、准入）
- `docs/MOD-SURFACE.md` —— 模组能碰到的**全部表面**（钩子、槽位、包裹组件、服务端成员）；**「加一格表面的清单」在它末尾**
- `docs/design/mod-layer.md` —— 为什么是现在这个边界（§28），含 **§28.24 / §28.25**（§9.2 引的就是这两节）；本文 **§19 / §20** 引的是
  **§28.43**（行为开关）· **§28.44 / §28.45**（宿主 lane）· **§28.46**（`target`）· **§28.47**（登记册）· **§28.48**（依赖与互斥裁决）·
  **§28.49**（`trait.grantsBonds`，§19.7）· **§28.23**（`server.modules[].channels` 通道声明面，§19.8）·
  **§28.50**（启用声明 `pack.json.enabled`，§19.9）
- `AGENTS.md`（引擎仓库自己的）—— 引擎仓库的贡献规则

**核新面孔时常翻的源码**（§19 每条都从这里核出）：`shared/behaviour.js`（五格开关表）· `shared/callBudget.js`（调用预算，§19.10）· `shared/variants.js`（三轴口径）·
`shared/kitImports.js`（kit / battle / room 三份 import 白名单，§19.13）·
`shared/workshop.js`（形状校验与拒绝码）· `shared/modSurface.js`（表面账本）· `server/modRegistry.js` 与
`tools/workshop-pack.mjs`（管理器 CLI）· `server/http/{wsLanes,httpLanes}.js`（宿主 lane）· `server/match/effectsMeta.js`（META 的 `ctx` 与 `HOOKS`）。

## 17. 本文引用位置的依据表

| 本文说的 | 依据（引擎仓库，只读核过；**以符号名为准，行号随手给**） |
|---|---|
| 只认 `<根>/<包 id>/pack.json`；只读声明过的 content 文件 | `server/workshop.js` 的 `loadWorkshop`（`:95`） |
| zip 形状：包内文件在同名顶层目录下；装载目录名由 `pack.json.id` 推导 | `tools/workshop-pack.mjs` 的归档布局注释（`:13`）与顶层前缀解析（`:195`） |
| `PACK_FIELDS` 闭集（**38 键**） | `shared/workshop.js` 的 `PACK_FIELDS`（`:139`） |
| 未知顶层键整包拒 | `shared/workshop.js` 的 `PACK_UNKNOWN_FIELD_CODE`（`:212`）与归一化里的那道判据（`:2072`） |
| `id` 必须等于目录名 | `shared/workshop.js` 的 `PACK_ID_MISMATCH`（`:2078`） |
| `content` 名单 | `shared/workshop.js` 的 `WORKSHOP_CONTENT_FILES`（`:56`，**15** 个文件；`variants` 是 §28.51 加的第 15 个） |
| `api` / `game` 类型闸门与比对 | `shared/workshop.js` 的 `BAD_API_TYPE`（`:295`）与 `MOD_API_INCOMPATIBLE`（`:2708`） |
| `support` / `playtest` / `variants` / `behaviour` / `dependencies` / `conflicts` / `callBudget` / `matchKinds` 不是贡献项；`EMPTY_PACK` | `shared/workshop.js` 的 `notContributions`（`:2659`，**八样**）与 `EMPTY_PACK`（`:2666`） |
| `notices` 形状与拒绝码 | `shared/workshop.js` 的 `parseNoticesDecl`（`:1661`） |
| `behaviour` **五格**表与引擎读取点 | `shared/behaviour.js` 的表（`:91`，第 5 格 `diyPoolOverlap` 在 `:203`）；硬闸门 `shared/workshop.js` 的 `BEHAVIOUR_NEEDS_COMBAT`（`:2788`）；表面锚点 `shared/modSurface.js` 的 `behaviour` 那一格（`:60`） |
| `target` 闭枚举 / 跨宿主 `foreign` | `shared/workshop.js` 的 `PACK_TARGETS`（`:189`）与 `PACK_TARGET_UNKNOWN`（`:2594`）；三面 `tools/workshop-validate.mjs` 的 `PACK_FOREIGN`、`tools/workshop-pack.mjs` 的 `list`、`editor/ui/pack.js` |
| 依赖与互斥的装载期裁决 | `shared/workshop.js` 的 `adjudicatePackGraph`（`:4917`）；装载点 `server/index.js` |
| `trait.grantsBonds`（§19.7） | `shared/morph.js` 的 `TRAIT_GRANT_KEY` 与 `grantedBondsByTrait`；作者侧 `shared/chessAuthoring.js`；契约测试 `test/traitGrants.test.js`；表面账本 `shared/modSurface.js` 的 `traits.grantsBonds` 那一格；设计稿 §28.49 |
| 宿主注册 lane | `server/http/wsLanes.js`、`server/http/httpLanes.js`；入口 `server/index.js` 的 `opts.wsLanes` |
| 登记册与"两道闸" | `server/modRegistry.js`；`tools/workshop-pack.mjs` 的 `cliUninstall` 与 `cliRollback` |
| `server.meta` 的叠层写法（§20.1） | `server/match/effectsMeta.js` 的 `HOOKS`（`:56`）、`chessRecord`、`addLayers`；`server/match/builtinMeta.js` 的 `ctx.pieceBonds` |
| `assets.mirrors` / `client.panels[].messages` / `server.modules[]` 字段闭集 | `shared/workshop.js` 的 `ASSETS_MIRROR_FIELDS`、面板字段闭集、`SERVER_MODULE_FIELDS`（`:578`） |
| `server.modules[].channels` 声明面（§19.8） | `shared/workshop.js` 的 `SERVER_MODULE_FIELDS`（`:578`）、`MODULES_CHANNELS_NEED_MATCH`、`MODULES_UNKNOWN_CHANNEL`；设计稿 §28.23 |
| `pack.json.enabled`（§19.9） | `shared/enabled.js` 的 `ENABLED_BAD_SHAPE`、`ENABLED_FALSE`（`:22`）与两个判据函数；设计稿 §28.50 |
| `pack.json.callBudget`（§19.10） | `shared/callBudget.js` 的 `PACK_CALL_BUDGET_DEFAULT`（`:63`，缺省 8000）、`CALL_BUDGET_FIELDS`、`CALL_BUDGET_TOO_HIGH`（`:93`）、`packCallAllowed`；形状层 `shared/workshop.js`；装载层 `server/battlePack.js` 与 `server/workshop.js` 的 `effectivePackCallBudget`；运行层 `server/sim/battle/hooks.js`；设计稿 §28.52、表面账 `docs/MOD-SURFACE.md` |
| 房间级 mod 集合与同意（§19.11） | `shared/constants.js` 的 `MOD_SET_LOCKED` 与 `MOD_CONSENT_REQUIRED`；`shared/protocol.js` 的 `room.join` 的 `consent`；`server/lobby.js` 的 `checkModSet` 与 `room.mods` 分支；设计稿 §28.53 |
| 第 10 个挂载点与 `PANEL_SEND_TYPES`（§19.12） | `public/js/ui/extensions.js` 的 `MOD_PANEL_SLOTS`（`:94`，10 条）与 `PANEL_SEND_TYPES`（`:140`，两条）；另一份 10 条 `shared/workshop.js` 的 `CLIENT_PANEL_SLOTS`；作者面 `docs/WORKSHOP.md` |
| kit / battle / room 三份 import 白名单（§19.13） | `shared/kitImports.js` 的 `KIT_IMPORT_FILES`（`:70`，**22** 条）与从它筛出的 `BATTLE_IMPORT_FILES` / `ROOM_IMPORT_FILES`；测试 `test/kitImports.test.js` §⑥ |
| `stripDiyOverlaps` 投稿的改写口径（§19.14） | `test/diyPoolOverlap.test.js`（引擎逐字给出的对应关系）、`shared/behaviour.js` 的第 5 格（`:203`）与按包读取（`:197-201`）；读取点 `shared/workshop.js` 的 `stripPackOperators`（`:3132`） |
| `globalThis` 回到服务端模块源码扫描的禁止名单（§19.15） | `shared/kitAuthoring.js` 的 `SERVER_CODE_FORBIDDEN_GLOBALS`（`:91`，`globalThis` 是其中一格）；执行点 `server/modModules.js`；描述 `shared/modSurface.js` |
| `pack.json.matchKinds`（§19.16） | `shared/workshop.js` 的 `PACK_FIELDS`（`:139`，新格）、`MATCHKINDS_NEED_MATCH_CLASS`（`:2568`）；`test/modMatchKinds.test.mjs`；设计稿 §28.54 |
| `client.screens`（§19.17） | `shared/workshop.js` 的 `CLIENT_SCREEN_ROUTES` 与 `client.screens` 形状；`public/js/ui/extensions.js` 的 `panelContext` 里 `rec.kind === 'screen'` 那三个门面；`test/modClientScreens.test.mjs`；设计稿 §28.55 |
| `server.modules[].lane`（§19.18） | `shared/workshop.js` 的 `SERVER_MODULE_USES`（`:576`，末尾 `lane`）、`SERVER_MODULE_FIELDS`（`:578`）、`MODULES_LANE_BAD_NAMESPACE`（`:2764`）；`server/modLanes.js`、`server/modServer.js`；`test/modPackLane.test.mjs`；设计稿 §28.56 |
| `server.room.hold`（§19.19） | `shared/workshop.js` 的 `ROOM_HOLD_NEEDS_COMBAT`（`:551`）；`server/lobby.js` 的 `reapEmptyRoom` 与 `releaseRoomHolds`；`test/modRoomHold.test.mjs`；设计稿 §28.57 |
| `overrides`（所有权声明 ＋ **字段级补丁**） | `shared/workshop.js` 的 `OVERRIDE_ENTRY_RE`、`mergeRecord`、`OVERRIDE_REPLACE_KEYS`；读取点 `server/workshop.js` 的 `KIT_OFFICIAL_OVERRIDE_UNDECLARED`；数组整块替换与 11 键例外见 `docs/design/mod-layer.md`（§A2） |
| `variants` 三轴 | `shared/variants.js` 的 `VARIANT_AXES`（`:56`） |
| 面板 ctx 的键 | `public/js/ui/extensions.js` 的 `panelContext` 的返回处（`:1351`；面板 12 键 + `battle`，整屏 12 键 + `screen`/`actions`/`ui`） |
| `net` 成员与两格新读数 | `public/js/ui/extensions.js` 的 `netFacade`；设计稿 §28.24 / §28.25 |
| 偏好口 | `public/js/ui/extensions.js` 的 `setPref` / `getPref` |
| 主题变量（加法） | `public/js/ui/extensions.js` 的 `applyTheme` |
| 关动画的引擎通道 | `public/css/theme.css` 的 `prefers-reduced-motion` 那一段、`public/js/ui/device.js` 的 `reducedMotion` |
| 资源分发内建 | `public/js/resources/{bundle,verify,host,worker,service,common}.js` |
| URL 前缀 | `shared/workshop.js` 的 workshop URL 前缀常量 |

> 上表的依据**以符号名为准**，行号是核的时候顺手记的，核于引擎 `main` 的
> **`300556c9`**（上游 0.3.1 已合入；发行 tag `v0.19.1-0.3.1` → `0df1ed21`）。
> ⚠️ **不要按行号硬找**：引擎每动一次，行号就漂。上一版把行号记在 `7aa58a24` 上，本轮逐条重核时发现其中一批
> **在那一版就已经对不上** —— 例：`PACK_ID_MISMATCH` 当时在 `:1846`，文档记的是 `:1788`；
> `PACK_UNKNOWN_FIELD_CODE` 当时在 `:204`，文档记的是 `:131`；`tools/workshop-validate.mjs` 当时只有 134 行，
> 而文档引的是 `:212`。**按符号名搜**（`PACK_FIELDS`、`BEHAVIOUR_SWITCHES`、`callBudget`、
> `adjudicatePackGraph`、`SERVER_MODULE_USES`…），搜到就是对的。
> 底座（源码口径）：`APP_VERSION = 0.19.1`、`UPSTREAM_VERSION = 0.3.1`（`shared/constants.js` 的实值）。
> §19 / §20 的路由细节以引擎文件为准，**本文只记「在哪、怎么写、边界是什么」**。

## 18. 术语约定（同一个概念全文只用一个词）

读这两份文档时，看到下表左列的写法，一律按右列理解 —— **不做同义词联想**：

| 只用这一个词 | 指什么 | 不要再读成 |
|---|---|---|
| **包 id**（永远带「包」字） | `pack.json` 的 `id`，也就是包目录的名字 | 「包名」`name`（那是给人看的显示名） |
| **`name`** | `pack.json.name`，包的显示名 | 包 id |
| **工坊包** | 本仓库存放、玩家拷进引擎工坊目录的那种包 | mod 原件（就地改引擎源码的那种，在 `incoming/`） |
| **原件** | `incoming/` 里那份还没做兼容的 mod | 包 |
| **`content` 空 / `content: []`** | 明确指 `pack.json.content` 这个数组是空的 | 「这个包什么都没带」（那是 `EMPTY_PACK`，判据见 §5.3） |
| **`packs/` 是空的** | 本仓库的 `packs/` 目录里只有 README，没有任何包目录 | 「站上没有兼容包」（站上已发布的是**另一份清单**） |
| **隐藏**（文案「不再显示」） | 审核页的显示开关，可逆 | 下架（那叫**打回**） |

同一份文档里，**包 id 与 `name` 是两件事**：前者只能用 `[A-Za-z0-9_-]`、命名目录与 URL；
后者是任意字符串、只上屏。

## 19. 引擎这一版新加的接口面（核于引擎 `main` `300556c9`；上游 0.3.1 **已合入**）

**口径先摆出来**：下面每条都**去引擎代码里核过**，不是照抄任何清单。判「今天能用」的判据是三样齐 ——
**实现点 + 一个钉行为的测试 + 一节设计文档**；核不到的写「在途」，没有的写「没有」。
**核时的引擎 HEAD**：`300556c9`（上游 0.3.1 已合入；发行 tag `v0.19.1-0.3.1` → `0df1ed21`）。
⚠️ **0.3.1 对工坊包作者没有新增表面**：`PLUGIN_API` 抬到 `2` 只影响 `plugins/`（插件），工坊包的 `api` 仍对
`MOD_API_VERSION = 1` 比对，所以 `>=1 <2` 照旧；`PROTOCOL_VERSION` 也是 `2` 未动。
这里说的是**源码当前状态**，不是某个已发布的整合包。本节的 `文件:行号` 按当前树重核过一遍，
但 ⚠️ **行号会漂，按符号名搜才可靠**（`PACK_FIELDS`、`SERVER_MODULE_USES`、`callBudget`、`stripPackOperators`…）。
底座：`APP_VERSION = 0.19.1`、`UPSTREAM_VERSION = 0.3.1`（`shared/constants.js` 的实值）。
**引擎是最终依据**：这一节只讲「在哪、怎么写、边界是什么」，规则细节回引擎读（§16 的清单）。

### 19.1 `behaviour` 行为开关 —— **五格**，**今天能用**

| 开关 | 选项（**前一个是缺省档**） | 一句话效果 | 引擎读取点 |
|---|---|---|---|
| `shopBias` | `official` · `bondBias` | 商店装备槽只在本玩家**已激活**盟约的装备里抽；**只偏置、不授予**；某阶级无命中 ⇒ 回落官方那一份，库存闸门一步不跳过 | `shared/behaviour.js:91-104` |
| `prepLoadout` | `locked` · `prep` | 休整期（`PREP`）、且这个座位**还没准备**时，也收一次既有的 `room.loadout`；**合并语义**（没写的干员保留当前配发）；**不新增协议消息** | `shared/behaviour.js:114-127` |
| `morphPairing` | `official` · `plus` | 一件装备就够配对、只取装备行**最左边**那一件、变形同构体**不占装备位**（每名干员最多一件） | `shared/behaviour.js:145-158` |
| `unequip` | `official` · `allow` | 休整期用 `g.unequip { itemUid }` 把装备退回**手牌**（右→左优先），手牌满进**临时整备区**；两处都满 ⇒ 原子拒绝 `HAND_FULL`，装备留在原处 | `shared/behaviour.js:170-183` |
| ⭐ `diyPoolOverlap` | `report` · `strip` | **本包**做成棋子的干员、又本来在自选池（`diy.ownedPool`）里的那几名：`report`（缺省）＝逐条点名、池子一个字节不动；`strip`＝把**这几名**从自选池**摘出名单**（`diy.operators` 那条记录留着 —— 界面按 id 读它）。见 §19.14 | `shared/behaviour.js:203-216` |

**五格的缺省档都等于引擎今天的行为**（逐字节不变，不需要 `golden:update`）。

⚠️ **第 5 格是全表第一格「按包读取」的开关 —— 它刻意不走 `mergeBehaviourDecls`**（其余四格读的是
`Match` / `roomMods` 里那一份**合并后**的 decl，包 id 小者赢）。理由是一条硬语义：这一格说的是
「**本包**做成的棋子」，不是一条全局口径；若照其余四格先合并成一个值，那么「A 包声明 `strip`」会连
**B 包**的重叠一起摘掉 —— 而 B 从没声明过这件事。所以读取点（`shared/workshop.js:2900` 的
`stripPackOperators`）逐个包读**它自己**的 `pack.behaviour`，判据仍是同一份 `behaviourValue`、闭枚举仍是
这一张表（`shared/behaviour.js:197-201` 逐字写「后人若在这里「顺手补上 merge」，那是**改错**」）。
这条对应关系的**投稿侧**口径见 §19.14。

声明写法（库里那四份包就是这么写的，可直接抄 `packs/unequip/pack.json`）：

```json
{
  "combat": true,
  "behaviour": [{ "switch": "unequip", "option": "allow" }]
}
```

**五条边界，逐条都会咬人**：

| # | 边界 | 判据 |
|---|---|---|
| 1 | **闭枚举，整包拒（不是忽略）**：开关名不认识 ⇒ `BEHAVIOUR_UNKNOWN_SWITCH`；选项名不认识 ⇒ `BEHAVIOUR_UNKNOWN_OPTION` | `docs/MOD-SURFACE.md:76`、`shared/modSurface.js:370` |
| 2 | ⚠️ **`combat: true` 是硬闸门**：**五格每一格都会改对局结果**（商店出货 / 配发 / 盟约成员与层数 / 装备位 / 自选池名单），不写 ⇒ `BEHAVIOUR_NEEDS_COMBAT` **整包拒** | `shared/workshop.js` 的 `BEHAVIOUR_NEEDS_COMBAT`（`:2788`） |
| 3 | ⚠️ **`behaviour` 不是贡献项**：只带它的包照旧 **`EMPTY_PACK` 整包拒**，**必须另带真贡献**（`content` / `client` / `notices` / `routes` / 素材…）。与它同一条的还有 `support` / `playtest` / `variants` / `dependencies` / `conflicts` / `callBudget` / **`matchKinds`**（**八样**） | `shared/workshop.js` 的 `notContributions`（`:2659`）与 `EMPTY_PACK`（`:2666`）、[README](README.md) 与 §5.3 |
| 4 | **包里给不出数值、也给不出路径**：`module` / `entry` / `file` / `path` / `value` / `key` 这类键在形状层**点名拒**；动作 `{ kind, value }` **由引擎构造** | `docs/MOD-SURFACE.md:76` |
| 5 | 不声明 ⇒ 归一化清单里**不长这个键**；声明了**必须进包身份哈希**（不进 `modDigest`） | `docs/MOD-SURFACE.md:76` |

**五格各自的「还没做」也照实写**（边界不是装饰）：

- `shopBias` 的原件还提过两条（已激活**核心**盟约优先、骑士戒律接入）以及它的 `giveBondBiasOnly` / `canGiveBond` ——
  **未实现、也未被读取**（源件不在手上，业主口径「缺源件就不做假实现」）：`shared/behaviour.js:84-89`；
- `prepLoadout` 的**客户端入口还没做**（`PREP` 期换技能/模组的那个按钮），记账在 §28.43.4：`docs/design/mod-layer.md:3373`。

**想加第六格？包作者加不了。** 加一格的前置是「**引擎先有实现点**」——清单在 `docs/MOD-SURFACE.md:110-116`
（形状校验 + 锚点 + 实现文件 + 一个测试文件 + 一节设计文档）；包这一侧只能声明**表里已有的**。
设计稿：§28.43（`docs/design/mod-layer.md:3121` 起）。

### 19.2 `pack.json.target` —— 今天能用，但要认清「三面点名」

| 你写什么 | 结局 |
|---|---|
| **什么都不写** | 缺省 `forge` ＝ 本引擎装载；**不进归一化清单** ⇒ 老包的身份哈希逐字节不变 |
| `"target": "forge"` | 显式声明（等价于缺省），但**进**包身份哈希 |
| `"target": "stardust"` | 给 Stardust 宿主的**声明型包**：本引擎**认识、但不装载**（`foreign`）；不进数据叠加层、不进 `/mods/catalog.json`、也**不受 `EMPTY_PACK` 约束**；启动日志一行具名 |
| **别的值**（不在闭枚举里） | **整包拒** `PACK_TARGET_UNKNOWN`（不猜、不忽略） |

判据：闭枚举 `shared/workshop.js:162`、拒绝 `:2263`；不装载 `server/workshop.js:127`、日志 `:254`。

**三面都会点名它**（业主 2026-10-12 裁定：`foreign` 必须**响亮** —— 「接受了却一声不吭」正是要消灭的形状）：

| 面 | 你看到什么 |
|---|---|
| 校验器 | `PACK_FOREIGN` **warning**（清单合法，所以是 warning 不是 error）＋ 收尾一句 `N pack(s) target another host`：`tools/workshop-validate.mjs:141` |
| 管理器 CLI | `list` 里是具名的 `FOREIGN（本引擎不装载：…）`，不是 `REFUSED（null）`：`tools/workshop-pack.mjs:912` |
| 编辑器 | 包管理页拿到 `foreign` ＋同一句原因，并**渲染出来**：`editor/ui/pack.js:153` |

契约测试（四问 + 三面接线）：`test/modTarget.test.mjs`。设计稿：§28.46。

### 19.3 `dependencies` / `conflicts` —— 装载期裁决

形状：`dependencies = [{ id, range? }]`、`conflicts = [{ id, range? }]`。`id` 是**另一个工坊包**的 id，
`range` 是那个包 `version` 的区间（缺省＝任意版本）。**形状层就整包拒**的：
`DEPENDENCIES_BAD_ID` / `DEPENDENCIES_BAD_RANGE` / `DEPENDENCIES_CONFLICTING_RANGES`（同一个 id 配两个 range —— 不许猜作者的意思）；
`conflicts` 用同一套解析器，错误码换 `CONFLICTS_` 前缀。

**语义在装载期裁决**（`adjudicatePackGraph`，纯函数、确定性、全部具名，`shared/workshop.js:4320-4406`）：

| # | 规则 | 落点 |
|---|---|---|
| 1 | **缺失依赖** ⇒ 依赖方被拒 | `:4344` |
| 2 | **版本不合** ⇒ 依赖方被拒；⚠️ **对方没写 `version` 视为满足**（归一化出的 `0.0.0` 也按「未声明」处理 —— 是「未声明」，不是「不匹配」） | `:4332-4338`、`:4345-4347` |
| 3 | **互斥命中** ⇒ **包 id 大者败**；带 `range` 时只有区间匹配才算互斥；双方都声明时同一条边只裁决一次 | `:4349-4356` |
| 4 | **级联** ⇒ 依赖链上有人被拒，依赖方跟着拒，**迭代到不动点** | `:4358-4373` |
| 5 | **循环** ⇒ **环上全体被拒**（与级联不同：每个包自己的依赖都"在"，是声明本身死锁） | `:4374-4399` |

拒绝全部**具名成一行启动日志**：`[mod-registry] "<id>" refused: <原因>`（`server/index.js:120-123`）。
⚠️ **不是贡献项**：只声明依赖的包照旧 `EMPTY_PACK`；不声明的包清单里不长这个键（老包哈希不变）。设计稿：§28.48。

### 19.4 宿主注册 lane（`wsLanes` / `httpLanes`）—— **`pack.json` 里没有这个键**

引擎有两条「把一段路径交给**宿主自己的代码**」的表：`startServer({ wsLanes: [...] })`（WebSocket 升级路径，§28.44）
与 `startServer({ httpLanes: [...] })`（请求路径子树，**含 POST**，§28.45）。实现点 `server/http/wsLanes.js`、
`server/http/httpLanes.js`，入口 `server/index.js` 的 `opts.wsLanes`。

| 谁 | 能不能声明 lane |
|---|---|
| **宿主**（调 `startServer` 的那段代码，例如一个整合发行版） | **能** —— `wsLanes` / `httpLanes` 是**函数入参**，不在 `pack.json` 里 |
| **工坊包**（写进 `pack.json` 顶层） | **不能**：`PACK_FIELDS` 是闭集，里面**没有** `wsLanes` / `httpLanes` ⇒ 写进 `pack.json` 就是 `PACK_UNKNOWN_FIELD` **整包拒** |
| **工坊包**（`server.modules[].lane`，§28.56） | ⭐ **能，但只有一条、且只在自己的命名空间里**：`uses` 里声明 `"lane"` 再配 `lane = { path, summary? }`，路径必须落在 `/mod-ws/<本包 id>` 之下。宿主替它开、也替它记账 —— 包**仍然**拿不到监听套接字 / 新端口 / 定时器 / 子进程。见 §19.18 |

**为什么窄**：lane 的语义是「路径 → **宿主进程里的一个回调**」（`onUpgrade` / `onRequest`）＝ **任意代码 + 任意路径**。
包这一侧能给的三条通道都**刻意更窄**：`routes`（路径与缓存策略都在允许集合内，**只有 GET/HEAD**，
`docs/MOD-SURFACE.md:73`）、`server.modules[].uses: "route"`（路径必须落在 `/mod/<包 id>/…`，**只有 GET/HEAD**，
回调必须**同步**返回、体积 ≤ 64 KB、**没有认证**，`:69`），以及 §19.18 那一条（路径必须在 `/mod-ws/<本包 id>` 之下）。
**包永远不能注册任意路径、也不能挂 POST** —— 那两条是宿主自己的事。

**今天的现实**：不给 `wsLanes` / `httpLanes` 就是「没有这个键」，命运与从前**逐字节相同**
（`test/laneDefaults.test.js:8-22`）；不声明 `lane` 的包同样逐字节不变（`test/modPackLane.test.mjs`）。

### 19.5 mod 登记册 —— 能用，但**只有 CLI 与启动日志看得见**

| 面 | 今天的状态 | 判据 |
|---|---|---|
| 登记册文件 | `<stateRoot>/mod-registry.json`：记录「本管理器装过什么、操作者启停过什么、升级时留底在哪」 | `server/modRegistry.js:33`、`:99`、`:102-147` |
| **启停** | CLI `enable` / `disable`。禁用后**连它的服务端载荷都不装载**（没有 hook、没有订阅、没有字节），**文件留在磁盘**，一条 `enable` 就回来；重启服务器后生效 | `tools/workshop-pack.mjs:1020-1025`（`cliEnable`）、`server/index.js:114-119` |
| **卸载** | **两道闸，都不可绕过**：① **ownership** —— 只卸载**本管理器登记过**的包（登记册里没有记录 ⇒ 拒绝，让你手动处理）② **留底** —— `fs.renameSync` 把**整个包目录**挪进 `<root>/.mod-backups/<id>/uninstall-<时间戳>/`，**不是删除**（点开头 ⇒ 装载器不扫描，所以它立刻"不在"，但一个字节没丢；CLI 会把留底路径打出来） | `tools/workshop-pack.mjs:1027-1050`（`cliUninstall`） |
| **升级 / 回滚** | `import --force` 时旧版进 `.mod-backups/<id>/…`；`rollback` 换回来，被换掉的那份**也留底** | `:266-267`、`:1001-1006`、`:1061-1077` |
| ⚠️ **编辑器** | **还没接登记册**：`editor/` 下**没有任何** registry 引用（`git grep registry -- editor/*` 只命中一条无关文案）⇒ **不要指望在界面上切换启停**。今天看得见启停的只有 **CLI**、管理器 `list`，以及启动那一行 `[mod-registry] "<id>" disabled (…) — not loaded` | `server/index.js:119` |

设计稿：§28.47。登记册是**管理器**的账本，不是包格式的一格 —— 包作者不用管它，但要知道
**「禁用 ≠ 卸载、卸载 ≠ 删除」**。

### 19.6 核不到 / 在途（照实写，别当成「有」）

| 面 | 实测 | 证据 |
|---|---|---|
| `shopBias` 的两条子规则与 `giveBondBiasOnly` | **未实现、也未读取**（源件不在手上，不做假实现） | `shared/behaviour.js:84-89` |
| `prepLoadout` 的 `PREP` 客户端入口 | **还没做** | `docs/design/mod-layer.md:3373`（§28.43.4） |
| 编辑器接登记册 | **还没接**：`editor/` 下点不到登记册，启停只有 CLI 看得见 | 见 §19.5 那张表 |
| ⚠️ **引擎侧文档缺口**（只报，本仓库改不了引擎；**引擎侧补齐后这一行要删掉**） | `docs/MOD-SURFACE.md` 的 `behaviour` 表**仍只列到第 4 格**（没有 `diyPoolOverlap` 那一行）；`public/js/ui/extensions.js` 里 `send()` 的注释仍写「今天只有 `room.appearance`」（实际 `PANEL_SEND_TYPES` 已是两条，`:140`）；`docs/WORKSHOP.md:703` 仍写「挂上**四个**宿主」，而同文件 `:960` 写的是「**十个**挂载点」 | 第 5 格的**实际**作者面文档在 `docs/WORKSHOP.md:2249` 与 `:2323`（§1.23），不在 MOD-SURFACE。⚠️ 这三处是**引擎侧**的过期点（本轮核于 `2f335656`），引擎改完后**本行即失效** |
| ✅ 已合入、可以用的 | `behaviour` **五格**（§19.1，第 5 格 `diyPoolOverlap`）· `target` · `dependencies` / `conflicts` · 宿主 lane · 登记册（CLI）· **`trait.grantsBonds`**（§19.7）· **`server.modules[].channels`**（§19.8）· **`pack.json.enabled`**（§19.9）· **`pack.json.callBudget`**（§19.10）· **房间级 mod 集合与同意**（§19.11）· **第 10 个挂载点 `screen.room.aside`**（§19.12）· **kit 白名单 22 条**（§19.13）· **`pack.json.matchKinds`**（§19.16）· **`client.screens`**（§19.17）· **`server.modules[].lane`**（§19.18）· **`server.room.hold`**（§19.19） | 见 §19.1–§19.5、§19.7–§19.13、§19.16–§19.19 |

> **上一版写在这里的两条都已经落地**，本版按当前树核实并改写：
> ① `trait.grantsBonds`（当时写「在途 / 未合入」）⇒ 现在是 §19.7；② `server.modules[].channels` ⇒ 现在是 §19.8。
> ⭐ **本版（上游 0.3.0 合入之后）又补了 §19.16–§19.19**：`pack.json.matchKinds`、`client.screens`、
> `server.modules[].lane`、`server.room.hold` —— 这四条是 0.3.0 合入新落的作者可见面。
> **「核不到」的结论会过期** —— 引用之前回引擎复一遍，别照抄这一张表。

### 19.7 `trait.grantsBonds` —— **已合入 `0.17.0`，今天能用**（§28.49）

**一句话**：一条 `chess` 记录写 `trait.grantsBonds = ["<盟约 id>", …]` ⇔「带这条特质的棋子**视为那些盟约的成员**」
⇒ 进 `bondsMeta` 的去重成员集合 ⇒ count +1 ⇒ 盟约层数自然上去。**不需要模块、不需要 `server.meta`、不需要一行脚本。**

```json
// units.json / chess.json（引擎侧记录）里的一条 chess 记录，`trait` 是**对象**：
"trait": { "desc": "…", "bb": {}, "rangeGrid": null, "grantsBonds": ["bond_abyss", "bond_victoria"] }
```

| 项 | 实况 | 依据 |
|---|---|---|
| 键名 | `grantsBonds`，写在 **`trait` 这个对象**里（**不是** `def.trait` 那个投影出来的文本字符串） | `shared/morph.js:117-118`（`TRAIT_GRANT_KEY`） |
| 唯一判据 | `grantedBondsByTrait(trait, { hasBond })`；成员资格的**合并**也只有一份 `memberBonds` | `shared/morph.js:149`、`:105-115` |
| 三处读取点 | prep 的 `bondsMeta.pieceBonds` · 战斗的 `support/index.js unitBonds` · 客户端的 `gameLogic/bonds.js`（`pieceBondIds` 与 `bondMembers` 两处读者）—— **都调同一份判据** | `shared/modSurface.js` 的 `traits.grantsBonds` 那一格 |
| 不写这一格 | **逐字节不变**（官方 266 条记录一条都没有它）⇒ **不需要 `golden:update`** | `shared/modSurface.js:70-71` |
| ⚠️ 改对局结果 | 成员资格决定 count / tier / 层数 ⇒ **会改结果**，所以它像 `behaviour` 一样有具名读取点、锚点、测试与一节文档 | `shared/modSurface.js:56-61` |
| 写歪了 | **点名，但不拒包、不改数据**：不是数组 / 数组里有非空字符串以外的东西 ⇒ `TRAIT_GRANT_BAD_SHAPE`；空数组 ⇒ `TRAIT_GRANT_EMPTY`（声明了个寂寞）；数据里不存在的盟约 id ⇒ `TRAIT_GRANT_UNKNOWN_BOND`（读取点的 `hasBond` 会把它挡在计数之外） | `shared/morph.js:165-166`、`:173-204` |
| 作者侧什么时候会看到 | 启动日志（`report.traitGrants`）+ `npm run workshop:validate`（`shared/chessAuthoring.js` 的 `validateChessRecord`）：**装之前**就点名 | `shared/morph.js:154-157` |
| 契约测试 | `test/traitGrants.test.js`；设计稿 §28.49 | `docs/design/mod-layer.md:3489` |

**为什么它比 `server.meta` 好**（同一件事的两条路，按需要选）：

| 你想要的 | 用哪条 | 为什么 |
|---|---|---|
| 「这条特质视为某几个盟约的成员」——**纯数据、固定映射** | **`trait.grantsBonds`**（本格） | 一格数据声明，**不用写代码**、不用 `combat: true`（它不新增通道，它是一条记录字段）；缺省不写就逐字节不变 |
| 「按对局状态**算**层数 / 有条件地叠 / 读别的记录再决定」 | `server.meta`（§20.1） | 那是**代码**：能读 `ctx.chessRecord`、能按 `requireActive` 之类条件决定叠不叠 —— `grantsBonds` 表达不了这种条件 |

⇒ 两条**不是替代关系**：**固定映射走本格，条件叠层走 `server.meta`**（§20.1 保留，作为「更复杂效果」的做法）。

### 19.8 `server.modules[].channels` —— 包通道的**服务端那一半**（§28.23）

`client.panels[].messages` 是通道的**客户端那一半**；**服务端那一半**是 `server.modules[].channels`：
声明「这个模块在对局里**接收**哪几条包通道」。两半必须**指同一批名字**。

| 项 | 实况 | 依据 |
|---|---|---|
| 字段闭集 | `server.modules[]` 的字段是 `id` / `entry` / `uses` / `write` / **`channels`** / **`lane`**（后两个可选） | `shared/workshop.js` 的 `SERVER_MODULE_FIELDS`（`:578`） |
| 条数上限 | 每个模块 **≤ 8 条**（`MODULES_TOO_MANY_CHANNELS`）；**不给空数组**（`MODULES_BAD_CHANNELS` —— 不想声明就把键去掉） | `:539`、`:960-966` |
| 名字形状 | `^[a-z][a-z0-9_-]{0,63}$`，与面板那条**同一个形状**（`MODULES_BAD_CHANNEL`）；不许重复（`MODULES_DUPLICATE_CHANNEL`） | `:967-974` |
| ⚠️ **必须有接收人** | 声明了 `channels` 就**必须同时声明 `matchClass`**（`MODULES_CHANNELS_NEED_MATCH` 整包拒）—— 收到消息的是**对局**，而 `matchClass` 是那个挂载点 | `:976-978` |
| ⚠️ **必须被本包的面板声明过** | `channels` 点名的每一条，必须也出现在本包某个 `client.panels[].messages` 里（`MODULES_UNKNOWN_CHANNEL` 整包拒）。理由不是洁癖：Lobby 的通道白名单是**从面板清单推出来的**，没被声明过的名字**永远到不了** | `:2257-2270` |
| 线上名与递送点 | `<包 id>.<短名>`；服务端唯一由消息驱动的调用点是 `Match.handlePackMsg(playerId, msg)` | 设计稿 §28.23 |
| 不写这一格 | **逐字节不变**（`channels` 只在被声明时进归一化清单与包哈希） | 设计稿 §28.23 第 4 条 |

两半一起长这样（**形状**，不是一整份包 —— 元信息与贡献项见 §4）：

```json
{
  "combat": true,
  "client": { "panels": [
    { "id": "borrow", "slot": "screen.game.hud", "module": "panels/borrow.js", "messages": ["borrow", "answer"] }
  ] },
  "server": { "modules": [
    { "id": "borrower", "entry": "server/borrow.mjs", "uses": ["matchClass"], "channels": ["borrow", "answer"] }
  ] }
}
```

> ⚠️ `uses` 里有 `matchClass` ⇒ **必须 `combat: true`**（`MODULES_NEED_COMBAT`，`shared/workshop.js:977`）。
> 面板的字段闭集是 `id` / `slot` / `module` / `order` / `gate` / `styles` / `data` / `messages` / `wraps`
> （`shared/workshop.js:424`），**10** 个槽位在 `:394-396`（清单与「哪个是组件渲染的」见 §7 与 §19.12）。

### 19.9 `pack.json.enabled` —— **装好 ≠ 生效**（§28.50）

| 项 | 实况 | 依据 |
|---|---|---|
| 形状 | **只有布尔**：`"false"` / `0` / `null` / `"true"` 这类**假布尔整包拒**（`ENABLED_BAD_SHAPE`）。理由与 `BEHAVIOUR_BAD_OPTION` 逐字相同：一个被 JS 真值表放行的假布尔就是**静默失效** —— 作者写下 `"false"`、引擎读到「启用了」，中间没有任何人收到错误 | `shared/enabled.js:33`、`:48` |
| 缺省 | 不写 = 引擎今天的行为；写 `true` 与**不写逐字节相同**（只有 `false` 进归一化清单的 `declared`，所以老包的身份哈希不变） | §28.50 第 2 条 |
| 效果 | `false` 的包**不进 `packs`**，而是进装载结论的 `errors`（**`ENABLED_FALSE`**）并**逐条点名**；跳过发生在**归一化之后、读任何内容文件之前** —— 所以被关掉的包**不会**因为「缺文件」再报一次噪声 | `shared/enabled.js:36`、`:64`；§28.50 第 3 条 |
| 它**不是**什么 | **不是**能力通道（打不开引擎里没有的东西）；**不是**安装器的退让（不整份覆盖引擎文件，红线 1）；**也不是**热重载（改了 `enabled` 一样要重启服务器） | §28.50 |
| 什么时候用它 | 你想让一个包**留在原处、字节完好、只是不参与** —— 而不是把 `pack.json` 改坏、或把目录搬出工坊根（那两条都是响亮的失败，作者自己看不到发生了什么） | §28.50 |

### 19.10 `pack.json.callBudget` —— 新顶层键，**沙箱档的运行时保护**（§28.52）

**一句话**：`combat: true` 回答的是「这个包**能不能**改对局结果」（一句**意图声明**），`callBudget` 回答的是
「它**能跑多少次**」（一个**执行上限**）。两者**同一级**、都进包身份哈希；但 `callBudget` **不要求**
`combat: true` —— 它**只收紧、不授权**。

```json
"callBudget": { "max": 400 }
```

| 项 | 实况 | 依据 |
|---|---|---|
| 形状 | `{ max? }` —— 闭集**只有 `max` 这一个键**（别的键 ⇒ `CALL_BUDGET_UNKNOWN_FIELD`，点名拒、绝不读过去）；不是对象 ⇒ `CALL_BUDGET_BAD_SHAPE`；`max` 不是 ≥ 1 的整数 ⇒ `CALL_BUDGET_BAD_MAX` | `shared/callBudget.js:66`、`:86`、`:88`、`:90` |
| 缺省 | 不写 `max` ⇒ **8000**（`PACK_CALL_BUDGET_DEFAULT`；上游实测口径，**只有这一份符号** —— 两端、装载器与形状层读的是同一个） | `shared/callBudget.js:63` |
| ⭐ **只许收紧、不许放宽** | `max > 8000` ⇒ `CALL_BUDGET_TOO_HIGH` **整包拒**，文案逐字「**a budget that can be raised is not a budget**」。作者想要更多 = **不写这一格**（那让他留在 module 档，逐字节与今天相同） | `shared/callBudget.js:93`、`:127-131` |
| `max` 的语义 | **可用次数**：第 `max` 次仍放行，第 `max + 1` 次不放行 —— 差一位就是给每个诚实包少一次调用 | `shared/callBudget.js:144` |
| 耗尽做什么 | **回滚这个包**：撤掉它**全部** hook 与计时器、撤掉它**标的** buff，并记一笔 **`plugin:<包 id>`** 的错；对局**继续**，只是没有这个包 | `server/sim/battle/hooks.js:211-214`、`:229-243`；错名 `shared/callBudget.js:155` |
| 覆盖到哪 | ① 包 `server.battle` 在 `install(battle)` 里注册的东西；② ⭐ **`kits/*.js` 的逐单位回调**（注册点在 `server/sim/battle/players.js:250`、`:252` 的 `_safe(…, pack)`，归属按**对象身份**记）；⚠️ **只带 `kits/`、没有 `server.battle` 的包也建账** | `server/workshop.js:1242-1243`、`:1352`；`docs/MOD-SURFACE.md:106` |
| 判决在哪 | **装载期一次**（`server/battlePack.js:130-131` 与 `server/workshop.js:1242` 读**同一个** `effectivePackCallBudget`）；⚠️ **不进建房路径** —— `server/lobby.js` 里出现 `callBudget` 就是错的 | `docs/design/mod-layer.md:3868`（§28.52） |
| 进不进摘要 | **声明过才进**归一化清单（`shared/workshop.js:2571`）⇒ 进 `identifyPack` 的内容哈希 ⇒ **两份只差预算的包是两个身份**。反过来「不声明 ⇒ 不长键」是硬性的：给每个包补一个 `callBudget: { max: 8000 }` 会让**所有已发布包的内容哈希全变**，而哈希是房间身份与对齐的依据 | `shared/workshop.js:2567-2571` |
| 不是贡献项 | 只带它的包照旧 `EMPTY_PACK` 整包拒（它在那份**八样**清单里） | `shared/workshop.js` 的 `notContributions`（`:2659`）、`:2666`（`EMPTY_PACK`） |

设计稿 §28.52（`docs/design/mod-layer.md:3868`）；表面账 `docs/MOD-SURFACE.md:106`；契约测试 `test/callBudget.test.js`。

### 19.11 房间级 mod 集合与**同意**（W7）（§28.53）

**这一层不用包作者声明什么**，但要知道**玩家什么时候会被拒**、以及「同意」到底同意了什么。

| 项 | 实况 | 依据 |
|---|---|---|
| `room.mods` | **房主在房间里改本房间的模组集合**（`{ modIds }`）—— 与 `room.create` 报出的集合同一份口径 | `server/lobby.js:744`、`:1234` |
| 改不了的两条 | ① **对局已开** ⇒ `MOD_SET_LOCKED`（跑着的那一局拿的是**开局那一刻**的集合）② **任一真人座位 `ready === true`** ⇒ `MOD_SET_LOCKED`（那个人是按**旧集合**对齐完才点的准备就绪） | `server/lobby.js:1322-1325`；`shared/constants.js:366` |
| ⭐ **同意** | 真人进一个**声明了模组**的房间，必须在 `room.join` 里带 **`consent: true`**（可选字段）；不带 ⇒ **`MOD_CONSENT_REQUIRED`**。判在**占玩家座位之前** ⇒ 没同意的人**进不去**，不是「进来了只能看着」 | `shared/protocol.js:577-578`；`server/lobby.js:1071-1073`；`shared/constants.js:372` |
| 同意的是**一份字节** | 同意落在**座位**上：`seat.modConsent === room.modSet.digest` 才算同意过 ⇒ **集合一变、摘要就不同，同意自动作废**；已经在座的人可以**再发一次 `room.join` 补同意**（不必退出重进） | `server/lobby.js:1058` |
| 谁不受约束 | **房主**（`room.create` 报出的 `modIds` 就是他在钉这一份字节）、**AI 座位**、**观战者**（不占玩家座位、不参与开局门槛） | `docs/design/mod-layer.md:3962`（§28.53） |
| 摘要闸门 | `checkModSet(msg)` —— 客户端回一份「进程集合」的摘要，回了才放行。⚠️ 那是**握手**（证明它读到了服务器装着哪些包），**不是表态**；表态是上面那条 `consent` | `server/lobby.js:714` |
| 字节漂移 | 房间钉的是**字节**：同一 id、另一个 hash ⇒ `MOD_SET_LOCKED` ＋一句说真话的 detail（要**重开房间**让每端重新对齐） | `server/lobby.js:1356` |

设计稿 §28.53（`docs/design/mod-layer.md:3962`）；契约测试 `test/roomModSet.test.js`、`test/roomConsent.test.js`。

### 19.12 第 10 个挂载点 `screen.room.aside` 与 `PANEL_SEND_TYPES` 的**两条**

**挂载点现在是 10 个**（`client.panels[].slot` 的闭枚举，清单见 §7）。新加的那个是 `screen.room.aside` ——
房间屏（等待开局那一屏）的**旁栏**。

| 项 | 实况 | 依据 |
|---|---|---|
| 它是**组件渲染**的，不是浮层 | 前 4 个（`root.overlays` / `root.guide` / `screen.game.aside` / `screen.result.footer`）是 0.11.0 的**浮层**：引擎按需创建容器、`position: fixed`。后 6 个在**引擎已经渲染的组件里**：容器由**组件自己**渲染 `[data-mod-slot="…"]`，面板往里填 | `public/js/ui/extensions.js:82-84`、`:93-94` |
| 两份 10 条必须一致 | `public/js/ui/extensions.js` 的 `MOD_PANEL_SLOTS` 与 `shared/workshop.js` 的 `CLIENT_PANEL_SLOTS` 是同一张表的两份（测试钉住它们） | `shared/workshop.js:394-396` |
| ⭐ `PANEL_SEND_TYPES` 现在**两条** | `['room.appearance', 'room.mods']` —— 面板能**主动发**的引擎消息是**闭枚举**，只有这两条。`room.appearance` 只改别人看到的外观、不碰战果；`room.mods` 是**房间级、只有房主、开局前且没人就绪才收** | `public/js/ui/extensions.js:128`；`docs/WORKSHOP.md:1007`、`:1015` |
| ⚠️ **`room.create` 永远不在里面** | 面板**不能**建房。白名单是闭枚举、不是「想发什么发什么」：面板能改的是**展示** | `public/js/ui/extensions.js:787-789`、`:797` |

设计稿 §28.8（挂载点）；作者面 `docs/WORKSHOP.md:960`（「十个挂载点」）与 `:973`（`screen.room.aside` 那一行）。

### 19.13 kit import 白名单现在 **22 条**（7 `@kit/` ＋ 6 `@sim/` ＋ 1 `@battle/` ＋ 8 `@ops/`）

清单见 §7（本节只记「加了几条、边界是什么」）。几个里程碑：4 个官方 ops kit
（`@ops/op-aphris.js` / `op-heyak.js` / `op-jesca2.js` / `op-nasti.js`，来自投稿 `rimbilliton`）；
⭐ **`@sim/detmath.js`**（**上游单有、本引擎此前缺**的那一条）；以及 0.3.0 合入带进来的
**`@sim/body.js`** 与 **`@sim/professions.js`**。

| 项 | 实况 | 依据 |
|---|---|---|
| 总数 | `KIT_IMPORT_FILES` **22 条**：7 `@kit/` ＋ 6 `@sim/` ＋ 1 `@battle/` ＋ 8 `@ops/` | `shared/kitImports.js` 的 `KIT_IMPORT_FILES`（`:70`） |
| ⭐ 为什么开 `@sim/detmath.js` | 包里的 kit 要算几何（射程 / 方向 / 距离）时，**唯一**的正当写法就是 import 它 —— 引擎的确定性硬规矩不许 `server/sim/` 直接用 `Math.sin` / `Math.cos` / `Math.atan2` / `Math.hypot` / `Math.pow` 这类「两端可能不一致」的函数，不开放它作者只能自己抄一份 `Math.*` | `shared/kitImports.js:83-95` |
| ⚠️ **前缀没有整体放开** | `@ops/` 进的是**前缀表**（浏览器 import map 按前缀生成、错误文案要能说「模块没开」而不是「未知前缀」），但**具体哪个文件能 import 由这张表决定**：表里没列名的同前缀文件（如 `@ops/op-siege.js`）**仍然被拒** | `shared/kitImports.js:43-44`、`:105-106` |
| 三份名单同源 | kit 用 `KIT_IMPORT_FILES`；`server.battle` 用 `BATTLE_IMPORT_FILES`（`@battle/` ＋ `@sim/`）；`server.room` 只有 `ROOM_IMPORT_FILES`（`@sim/`）—— 后两份都是从同一张表**筛**出来的，不抄第二份 | `shared/kitImports.js:129`、`:155` |
| 契约测试 | `test/kitImports.test.js` §⑥ 钉住「按前缀计数」这条界线 | — |

### 19.14 投稿带 `stripDiyOverlaps` 的改写件：**一律「删键 ＋ 加声明」**

⭐ **对应关系是引擎自己给的，不是我们推的** —— 引擎自带 `test/diyPoolOverlap.test.js:1` 逐字写着：

> 行为开关 `diyPoolOverlap`（DESIGN §28.43 第 5 格，**投稿 `stripDiyOverlaps`**）—— 「自选池重叠」。

所以口径只有一条（**不猜、不映射别的键**）：

> **凡投稿带 `stripDiyOverlaps` 的改写件，一律「删键 ＋ 加
> `behaviour: [{ "switch": "diyPoolOverlap", "option": "strip" }]`」。**

**为什么两步都要做**：

1. **原键必须删**：`stripDiyOverlaps` **不在** `PACK_FIELDS` 闭集内，装载器**不读**它 ⇒ 原样装载就是
   `PACK_UNKNOWN_FIELD` **整包被点名拒收**（引擎自己的话：「a declaration that is ignored is worse than a refusal」）。
2. **声明必须加**：`diyPoolOverlap` 是**按包读取**的开关（读取点 `shared/workshop.js:2900` 的 `stripPackOperators`，
   判据 `behaviourValue(pack.behaviour, 'diyPoolOverlap') === 'strip'`，**刻意不走** `mergeBehaviourDecls` —— 见 §19.1）。
   不加声明 ⇒ 作者的**原意被静默丢掉**，那正是「声明被忽略」。

⚠️ **边界**：**只**处理这一个键。别的闭集外键**不套用**这条口径 —— 一律回到「**不凭空给语义**」：能删就删、
删了要留档、不映射。若作者原意不是「把本包做成棋子的干员从自选池摘掉」，加了声明的那版**行为可能不同于来件**，
这一点必须写进包内 `PROVENANCE.md` 与提交备注。

依据：`test/diyPoolOverlap.test.js:1`（引擎逐字给出的对应关系）、`shared/behaviour.js` 的三件投稿
（`columbia` / `rimbilliton` / `rainbow-squad`，`:185`）、第 5 格（`:203-216`）与按包读取（`:197-201`）。
**这条口径在本仓没有单独的收录文件** —— 它就在本节上面那两段里（「一律删键 ＋ 加声明」）。
它成立的两条事实：`stripDiyOverlaps` **不在** `PACK_FIELDS` 闭集内；`diyPoolOverlap` 是**按包读取**的开关。

### 19.15 `globalThis` 已回到服务端模块源码扫描的**禁止名单**（W11）

⚠️ **这条与 §14 的红线、§19.8 的 `server.modules` 直接相关**：`server.modules[].entry` 指向的模块在
`import()` **之前**要过一遍**静态确定性扫描**（`stripComments` ＋ `mentionsIdentifier`），名单是
`SERVER_CODE_FORBIDDEN_GLOBALS` —— 现在是 **`process` / `globalThis` / `require` / `eval` / `new Function`** 五个。

| 项 | 实况 | 依据 |
|---|---|---|
| `globalThis` 那一格 | **2026-10-13 回归**：它曾被拿掉，为保住那个拿 `globalThis` 与同进程测试通信的合法模块；那个用例现在走引擎**显式注入**的 `host.io`（包声明 `write: true`，目录限定在 `<状态目录>/mod/<包 id>/`）⇒ 这一格没有留下的理由：**开着它时 `globalThis.process` 绕得过 `process` 那一格** | `shared/modSurface.js:194-196` |
| 名单本体 | `shared/kitAuthoring.js:91-97`（`:93` 就是 `globalThis` 那一格） | 同上 |
| 执行点 | `server/modModules.js:292`。⚠️ 名单**不齐**是刻意的：`server.modules` 这一处**只取** `SERVER_CODE_FORBIDDEN_GLOBALS`；`server.meta` / `battle` / `room` 三处取 `KIT_FORBIDDEN_GLOBALS + SERVER_CODE_FORBIDDEN_GLOBALS`，因为它们跑在**对局循环**里 | `server/modModules.js:255-260`、`:273`、`:292` |
| 免责（与那三处逐字同一句） | 这是**启发式，不是沙箱**（把名字拼成两段绕得过），兜底的是内容哈希与「只给 `uses` 里声明过的那几样」 | `shared/modSurface.js:197-198` |

**作者侧要做什么**：`server.modules` 的模块里**不要**出现 `globalThis`（也不要 `process` / `require` / `eval` /
`new Function`）。要读进程信息用 `host.metrics`（`uses` 里声明 `"metrics"`）；要落文件用 `host.io`
（模块声明 `write: true` 才拿到，目录限定在包自己的状态目录下）—— 两者都是**引擎显式注入**的那几样，
不是全局对象（`shared/modSurface.js:199`、`:233`、`server/modModules.js:15`、`:271`、`:282`、`:296`）。

### 19.16 `pack.json.matchKinds` —— 第二种对局的**声明面**（§28.54，0.3.0 新落）

**一句话**：`matchClass` 是唯一能碰到对局的挂载点。这一格让包把「我提供的是哪一种玩法」**写成数据**，
而不是靠「这个包被装进了房间」这句隐式信号。

**它是声明与协商面，不是分派表** —— 管理器**不认玩法名**，判定住在包自己的模块里。

```json
"matchKinds": [{ "id": "football-3v3", "seats": { "min": 6, "max": 6 }, "label": "3v3 足球" }]
```

| 项 | 实况 |
|---|---|
| 形状 | 数组，每项 `{ id, seats?: { min, max }, label? }` |
| 有界 | 每包 **≤ 4 种**；座位 **1..12**；`label` ≤ 60 字符，是**给作者看的**名字，**不占 i18n 词条**（它不走 `t()`） |
| id 形状 | 与包通道**共用同一套**（`^[a-z][a-z0-9_-]{0,63}$`） |
| ⚠️ **必须有接收人** | 本包至少要有一个 `server.modules` 条目挂 `matchClass`，否则 `MATCHKINDS_NEED_MATCH_CLASS` **整包拒**（与 §19.8 的 `MODULES_CHANNELS_NEED_MATCH` 同一条形状） |
| `combat: true` | 不在这里重复判 —— 有 `matchClass` 就必须认 `combat`，那是已有的一条线 |
| 进不进摘要 | **声明了才进**（给每个包补一个 `matchKinds: []` 会改掉所有已发布包的摘要）；id 按**排序**进，不按书写顺序 |
| 它不给什么 | 不新增 `C2S` 意图、不动 `PROTOCOL_VERSION` / `MOD_API_VERSION`、不开新的消息类型。玩法自己的输入走既有的 `pack.msg` |
| 包装器怎么写 | `MatchClass` 是**进程级一次**包装的 ⇒ **不能**按房间换类。只能在子类构造里判「这一局是不是我的」，命中就返回自己的实现、否则**原样把 Base 交回**。判得着的数据只有两样：`opts.mods.packs[].id`，以及开局之后的包通道 |

证据：`test/modMatchKinds.test.mjs`；设计稿 §28.54。

### 19.17 `client.screens` —— 整屏替换（§28.55，0.3.0 新落）

**一句话**：§7 的十个槽是**插进**引擎已经渲染的组件里的；`client.screens` 换掉**那一屏本身**。

| 项 | 实况 |
|---|---|
| 形状 | `client.screens[] = { id, route, module, order?, styles?, data?, messages? }` |
| 路由是**闭枚举**，只有引擎真有的四条 | `title` / `lobby` / `room` / `game`。写 `result` 或 `loadout` 是**永远不会命中的死声明** —— 结算与干员调配是路由**内部**的视图，不是路由 |
| id | 与面板**共用**一个包内命名空间（`CLIENT_SCREEN_DUPLICATE_ID`）；一条路由在一个包里只能有一份（`CLIENT_SCREEN_DUPLICATE_ROUTE`） |
| 模块要导出 | `mountScreen` 或 `default` |
| 失败方向 | 宿主原生界面**在任何一步失败时都保持可见**（样式装不上 / `import` 失败 / 没导出 / `mountScreen` 抛错，四种都拉黑该 key 并点名），不做「白屏但看起来成功了」 |
| 进不进摘要 | 模块与 `styles[]` 的源码字节**进**摘要；没声明 `screens` 的包摘要**逐字节不变** |
| ctx | 整屏模块拿到的是 `screen` / `actions` / `ui` 三面，**没有** `battle`（见 §9） |
| ⭐ **移动端** | 路由是**语义名**，本身不含尺寸；全屏用 `position: fixed` + `inset: 0`（四边贴合视口，不是固定宽高）与 `overflow: auto`，背景取 `var(--screen-background, …)`。**没有像素与桌面视口假设**，移植时不必改 |

证据：`test/modClientScreens.test.mjs`；设计稿 §28.55。**不进模拟** ⇒ 不需要 `golden:update`。

### 19.18 `server.modules[].lane` —— 包自带一条 WebSocket 通道（§28.56，0.3.0 新落）

**一句话**：包**声明一条路径**，宿主替它开。与 §19.4 的宿主 lane 是两件事 —— 那一格是函数入参，这一格是包能声明的。

| 项 | 实况 |
|---|---|
| 写法 | `uses` 里加 `"lane"`，再配 `lane = { path, summary? }` |
| 路径命名空间 | **必须**落在 `/mod-ws/<本包 id>` 或其子路径（`MODULES_LANE_BAD_NAMESPACE`） |
| 四条互拒 | `MODULES_LANE_UNDECLARED`（有 `lane` 但没有 `uses: ["lane"]`）、`MODULES_LANE_NEEDS_PATH`、`MODULES_LANE_BAD_PATH`、`MODULES_LANE_BAD_SUMMARY` / `MODULES_BAD_LANE` |
| 闭枚举扩张 | `SERVER_MODULE_USES` **6 → 7**（末尾 `lane`）、`SERVER_MODULE_FIELDS` **5 → 6**（+`lane`）。路径语法与限额**不在形状层抄第二遍**（归宿主） |
| ⚠️ **结构性保证没变** | 包**仍然**拿不到监听套接字、新端口、定时器或子进程。准入、背压、心跳透传、按名字记日志全部沿用宿主那一侧 |
| `MOD_API_VERSION` | **不动**（加一格不抬世代；抬了只会把写 `api: "1.x"` 的老包判成不相容） |
| 进不进摘要 | **只在声明时**才进归一化清单 ⇒ 没用它的包摘要逐字节不变 |
| 附带 | 同一个入口还带进了**热装载**（`server/modHotReload.js`）：缺省只**报告**、不动服务；要生效得用 `restart` 交给外部 supervisor |

证据：`test/modPackLane.test.mjs`、`test/mod-hot-reload.test.mjs`、`test/wsLanes.test.js`；设计稿 §28.56。

### 19.19 `server.room.hold` —— 空席房间的回收裁决（§28.57，0.3.0 新落）

**一句话**：真人全部退出、而对局还在跑时，宿主默认**直接销毁房间**。这一格让包参与**这一个**决定 —— 别的什么都没开。

| 项 | 实况 |
|---|---|
| 写法 | `pack.json.server.room.hold = true`；然后模块里调 `room.canHold(fn)` |
| 没声明就调 | `ROOM_HOLD_UNDECLARED` **点名**（不是静默收下） |
| ⚠️ **要 `combat: true`** | `ROOM_HOLD_NEEDS_COMBAT` —— 它能决定一局会不会被回收，那是对局结果的一部分（§28.20 的房间层里唯一破例的一格） |
| 谁决定「留多久」 | **包决定留不留，宿主决定留多久**：硬时限 `ROOM_HOLD_MAX_MS = 15 分钟`（具名常量，不是魔法数），谓词返回的 `until` 越界一律夹回来 |
| 多包 | **OR**（谁申请留就留），时限取**最早**那一票 |
| 失败方向 | 谓词抛异常 ⇒ 这一票作废并 `ROOM_HOOK_THREW` 点名（别的包照算）；返回 `{hold:true}` 以外的一切 ⇒ 视为不留 |
| 缺省 | 没有任何包登记 ⇒ `{ hold: false, until: 0 }` ⇒ 落回原来那一行 `disposeRoom(room, 'empty')`，**逐字相同** |

证据：`test/modRoomHold.test.mjs`、`test/roomModSet.test.js`、`test/roomKeep.test.js`；设计稿 §28.57。
**不进模拟** ⇒ 不需要 `golden:update`。

## 20. 今天就能用、以前没写清的老面

### 20.1 `server.meta`：**条件叠层**、更复杂效果的那条路（不用改引擎）

⚠️ **先看清与 §19.7 的分工**：只想要「这条特质视为某几个盟约的成员」这个**固定映射**，用
**`trait.grantsBonds`**（§19.7）—— 一格数据，不用写代码。这一节是**另一条路**：需要在**运行时按条件算**
（读某条记录再决定、按对局状态决定叠不叠、算出来的层数不是常量）时，用 `server.meta`。

这是**已有面**，不是新加的 —— 写在这里，是因为它今天就能做，而本文之前没写做法。

1. `pack.json` 写 `server.meta = { module, registers }`（`META_FIELDS` 只有这两格），
   并且**必须** `combat: true`（它会改结果；不写 ⇒ `META_NEEDS_COMBAT` **整包拒**）；
2. 模块里注册 `HOOKS` 里的钩子 —— 共 **20 个**（`onPrepEnd` 是其中一个）：`server/match/effectsMeta.js` 的
   `HOOKS`（`:56`）；
3. 钩子里**读**：`ctx.chessRecord(uid)` → `data/chess.json` 那条记录，**它带 `trait`**
   （形状例如 `"trait": { "desc": …, "bb": {}, "rangeGrid": null }`）：`server/match/effectsMeta.js`；
4. 钩子里**写**：`ctx.addLayers(bondId, n, { requireActive?, reason? })` —— 叠加盟约层数：
   `server/match/effectsMeta.js`。

```js
// 钩子体里（注册外层怎么写，以引擎 docs/WORKSHOP.md 的 META 那一节为准）：
const rec = ctx.chessRecord(uid);            // 只读：data/chess.json 那条记录，带 trait
if (rec?.trait) for (const b of ctx.pieceBonds(uid)) ctx.addLayers(b, 1, { reason: 'trait' });
```

**边界**：`chessRecord` 是**读**口（改不了东西）；`addLayers` 是**写**口（会改对局 ⇒ 包必须 `combat: true`）。
`ctx.pieceBonds` 的用法见引擎自带的 `server/match/builtinMeta.js:82`。

### 20.2 其余老面速查（逐条核过）

| 面 | 今天有吗 | 边界（要点） | 依据 |
|---|---|---|---|
| `content` | **有** | 名单是引擎固定的 **15** 个文件：`chess` / `units` / `items` / `enemies` / `stages` / `waves` / `tokens` / `bosses` / `factions` / `garrisons` / `bands` / `bonds` / `effects` / `choices` / `variants`（最后一个见 §19 开头那条说明）。名单外的值是**点名拒包**，不是过滤 | `shared/workshop.js` 的 `WORKSHOP_CONTENT_FILES`（`:56`） |
| `operators` | **有** | `operators[<charId>]` **只有两个字段**：`bonds` 与 `powers`（每项非空字符串、去重排序）。它把干员放进**自选池** —— 与 `content: ["chess"]` 是两条不同的入口（同一个干员两条路都走会被点名） | `shared/workshop.js` 的 `UNIT_REQUIRED_FIELDS` |
| `client.panels[].messages` | **有** | 通道名由包自己起（线上名是 `<包 id>.<短名>`），有**额度与限流**；通道名形状写歪点名 `CLIENT_PANEL_CHANNEL` | `shared/workshop.js` 的面板字段闭集、`docs/MOD-SURFACE.md` |
| `server.modules[].channels` | **有** | 可选字段（`id` / `entry` / `uses` / `write` / `channels` / `lane`）：每个模块 ≤ 8 条、名字形状同面板、**必须同时声明 `matchClass`**、且每一条都要被本包某个 `client.panels[].messages` 声明过 —— 详见 §19.8 | `shared/workshop.js` 的 `SERVER_MODULE_FIELDS`（`:578`）与那几条 `MODULES_*` 判据 |
| `assets.mirrors` | **有** | `mirrors[] = { id, base, sha256 }`：**只镜像本包自己的容器**；`base` 必须绝对 `https://`（有主机、无凭据、无查询、尾斜杠）、id 唯一且 **≤ 4 条**、`sha256` 必须等于装载期从包内文件算出的容器摘要（对不上的那条**停用并点名**，不拒包）；声明它**必须写 `license`**；**服务端不为这一格发一次网络请求**（取字节的是客户端） | `docs/MOD-SURFACE.md:74`、`:97` |
| `variants` | **有** | **三条轴**：`training`（`official` · `full`，缺省 `full`）、`form`（`official` · `elite`，缺省 `official`）、`deploy`（`official` · `max`，缺省 `official`）。缺省＝引擎今天的行为；**不是贡献项** | `shared/variants.js` 的 `VARIANT_AXES`（`:56`） |
| `routes` | **有** | `routes = [{ path, cache }]`：路径与缓存策略都必须在引擎的允许集合内；**只有 GET/HEAD** —— 整个 HTTP 面「除 GET/HEAD 之外的方法一律 405，除非某条**宿主 lane** 为那个路径认领了该方法」。要 POST 得走 §19.4 那两条**宿主**通道，包没有 | `docs/MOD-SURFACE.md:73`、`server/http/routes.js:5`、`:12-15` |
| `notices` | **有** | `notices = { 栏目: 文本 }`（只认 `announcement` / `credits`），纯文本、结构化但**不执行**；**是贡献项** | `docs/MOD-SURFACE.md`、`shared/workshop.js` 的 `parseNoticesDecl`（`:1661`）、本文 §6 |
| `enabled` | **有** | **只有布尔**；`true` = 不写（逐字节相同），`false` = 包留在原处但不参与、进 `errors` 并点名。**不是贡献项**、不是能力通道、不是热重载 —— 详见 §19.9 | `shared/enabled.js` 的 `ENABLED_BAD_SHAPE` / `ENABLED_FALSE`、设计稿 §28.50 |


