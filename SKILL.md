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

**② `pack.json`** —— 字段全集（引擎 `shared/workshop.js:128-163` 的 `PACK_FIELDS`，一个不多一个不少）：

```
id, name, version, author, license, description, gameVersion, game, api, layer, combat,
content, overrides, voices, voiceLangs, bondIcons, itemIcons, art, skins, support, operators, i18n,
forms, fx, notices, playtest, enabled, variants, behaviour, assets, client, server, routes,
target, dependencies, conflicts
```

> **共 36 键**（`target` / `dependencies` / `conflicts` 是上一版新加的三格，见 §19.2 与 §19.3；
> **`enabled`** 是这一版新加的第 36 格，见 §19.9）。
> 不认识的顶层键**点名整包拒**（`PACK_UNKNOWN_FIELD`），**绝不读过去**。

**②-a `content` / `overrides` / `modules.uses` 是三件不同的事，别混**：

| 写法 | 是什么 | 形状与判据 |
|---|---|---|
| `content: ["chess", …]` | **新增**：声明本包要读哪几个内容文件，加载器把它们**叠加**到官方数据上 | 名单是引擎固定的 **14** 个文件（§20.2）；声明了却缺文件会被点名 |
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

`content` 只接受固定名单（`shared/workshop.js:28-30`）：
`chess, units, items, enemies, stages, waves, tokens, bosses, factions, garrisons, bands, bonds, effects, choices`。
名单以外的值被过滤掉。

**「`content` 不能为空」是错的读法。** 判据是这条：

| 看到什么 | 判定 |
|---|---|
| `content: ["chess"]` | ✅ 包有贡献项 |
| `content: []`，但另有贡献项（`voices` / `operators` / `bondIcons` / `itemIcons` / `art` / `skins` / `i18n` / `notices` / `forms` / `fx` / `assets` / `client` / `server` / `routes`） | ✅ 合法（`content` 空着不算错） |
| `content: []`，且没有别的贡献项（只写 `support` / `playtest` 也算没有） | ❌ `EMPTY_PACK` |

**`support` 与 `playtest` 不是贡献项**：只写 `support` 而 `content: []` 的包会被
`EMPTY_PACK` 拒，理由里点名这一句（`shared/workshop.js:1847-1862`；引擎
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

**能被 import 的东西是白名单**（引擎的 kit import map，共 15 条，写别名、**不写相对路径**）：

```
@kit/tier1.js … @kit/tier6.js   @kit/summoner.js
@sim/constants.js  @sim/dir.js  @sim/targeting.js  @battle/index.js
@ops/op-shwaz.js  @ops/op-ray.js  @ops/op-aglna2.js  @ops/op-thumpy.js
```

`@ops/` 那 4 条是**按文件开的官方 ops kit**（2026-10-14 起）：包里的棋子就是某名官方干员换皮时，
直接 `import opShwaz from '@ops/op-shwaz.js'` 再调 `opShwaz.char_340_shwaz(bb, chess)`，
**不必**把引擎子系统复制进包（那条路的依赖闭包实测 18 个文件 / 513 KB）。⚠️ `@ops/` 是**命名空间不是放行**：
这 4 个之外，同前缀的文件（如 `@ops/op-siege.js`）**仍然被拒** —— 要用别的官方 kit 就按上面那条「做不成包」处理。

想用白名单以外的东西 = **这个 mod 做不成包**（§15），不要试图用相对路径绕过去：装载器会拒。

**界面槽位**（`client.panels` 的 `slot`，共 9 个；`screen.game.shopCard` 是**可重复**的，
会往每一张商店卡上挂一个，模块靠 `ctx.hostKey` 分辨自己在哪一个）：

```
root.overlays  root.guide  screen.game.aside  screen.result.footer
screen.game.shopCard  screen.game.bondStrip  screen.game.hud  screen.game.overlay
screen.loadout.detail
```

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

面板模块的 `mount(ctx)` 拿到的 `ctx` 是**冻结对象**，键就是下面这些（`public/js/ui/extensions.js:798-805`）。
**判据是「数键」**：以 `:798-805` 那个 `return Object.freeze({…})` 里实际列出的键为准（当前 12 个），
不要拿文件头 `:32-33` 的旧注释当依据 —— 那份注释只列了 9 个、还没跟上后加的三格。

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

**边界就是「没传什么」**：**没有** store 句柄、没有 match / battle 对象、没有 `battleRunner`、没有 audio。
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
这正是社区投稿报过的卡点（引擎 `docs/design/mod-layer.md:1957-1964`）。

两格共同的语义（三条，都要照做）：

1. **冻结、拿不到即 `null`** —— 不抛、不编造、不补默认值。没有读数就画空态。
2. **不新增协议消息**：不发任何帧、不发请求、不改引擎行为（引擎侧有机械断言盯这一点，
   `docs/design/mod-layer.md:2024-2026`）。
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

**核新面孔时常翻的源码**（§19 每条都从这里核出）：`shared/behaviour.js`（四格开关表）· `shared/variants.js`（三轴口径）·
`shared/workshop.js`（形状校验与拒绝码）· `shared/modSurface.js`（表面账本）· `server/modRegistry.js` 与
`tools/workshop-pack.mjs`（管理器 CLI）· `server/http/{wsLanes,httpLanes}.js`（宿主 lane）· `server/match/effectsMeta.js`（META 的 `ctx` 与 `HOOKS`）。

## 17. 本文引用位置的依据表

| 本文说的 | 依据（引擎仓库，只读核过） |
|---|---|
| 只认 `<根>/<包 id>/pack.json`；只读声明过的 content 文件 | `server/workshop.js:94-110`、`:120-137` |
| zip 形状：包内文件在同名顶层目录下；装载目录名由 `pack.json.id` 推导 | `tools/workshop-pack.mjs:13`（归档布局）、`:191-199`（顶层前缀）、`:252-255`（装到 `<root>/<pack.json.id>/`） |
| `PACK_FIELDS` 闭集 | `shared/workshop.js:128-163`（核于 `c0988645`；这一格加过 `target` / `dependencies` / `conflicts`，这一版又加了 `enabled`，所以行号与本文早先记的不同） |
| 未知顶层键整包拒 | `shared/workshop.js:131`（拒绝码）、`:1770-1783`（判据） |
| `id` 必须等于目录名 | `shared/workshop.js:1788`（`PACK_ID_MISMATCH`） |
| `content` 名单 | `shared/workshop.js:40-41`（14 个文件） |
| `api` / `game` 类型闸门与比对 | `shared/workshop.js:1883-1895`（类型）、`:1897`（区间）、`:1903-1905`（与 `MOD_API_VERSION` 比对）、`:1909`（`game`） |
| `support` / `playtest` / `variants` / `behaviour` / `dependencies` / `conflicts` 不是贡献项；`EMPTY_PACK` | `shared/workshop.js:2248-2262`（六样的语义逐条在 `:2248-2260`，`EMPTY_PACK` 的豁免在 `:2258-2260`） |
| `notices` 形状与拒绝码 | `shared/workshop.js:1374-1391` |
| `behaviour` 四格表与引擎读取点 | `shared/behaviour.js:91-183`；硬闸门 `shared/workshop.js:2418`；表面锚点 `shared/modSurface.js:329` |
| `target` 闭枚举 / 跨宿主 `foreign` | `shared/workshop.js:162`（`PACK_TARGETS`）、`:2263`（`PACK_TARGET_UNKNOWN`）；`server/workshop.js:127`、`:254`；三面 `tools/workshop-validate.mjs:212`、`tools/workshop-pack.mjs:912`、`editor/ui/pack.js:153` |
| 依赖与互斥的装载期裁决 | `shared/workshop.js:4320-4406`（`adjudicatePackGraph`）；装载点 `server/index.js:120-123` |
| `trait.grantsBonds`（§19.7） | `shared/morph.js:117-118`（键名）、`:149`（唯一判据）、`:154-166`（点名的那几类）；作者侧 `shared/chessAuthoring.js`；契约测试 `test/traitGrants.test.js`；表面账本 `shared/modSurface.js` 的 `traits.grantsBonds` 那一格；设计稿 §28.49（`docs/design/mod-layer.md:3489`） |
| 宿主注册 lane | `server/http/wsLanes.js`、`server/http/httpLanes.js`；入口 `server/index.js:83-84`、`:352`、`:355` |
| 登记册与"两道闸" | `server/modRegistry.js:33`、`:99`、`:135-147`；`tools/workshop-pack.mjs:1027-1050`（卸载 `cliUninstall`）、`:1061-1077`（回滚 `cliRollback`） |
| `server.meta` 的叠层写法（§20.1） | `server/match/effectsMeta.js:52`（`HOOKS`）、`:526`（`chessRecord`）、`:561`（`addLayers`）、`server/match/builtinMeta.js:82`（`ctx.pieceBonds`）；`shared/workshop.js:470`、`:2383` |
| `assets.mirrors` / `client.panels[].messages` / `server.modules[]` 字段闭集 | `shared/workshop.js:310`、`:787-799`、`:531-539`（模块的字段闭集与控制码在 `:958-978`）、`:2257-2270`（模块通道必须被本包面板声明过） |
| `server.modules[].channels` 声明面（§19.8） | `shared/workshop.js:531`（字段闭集）、`:539`（每题上限 8）、`:960-978`（四条形状判据 + `MODULES_CHANNELS_NEED_MATCH`）、`:2257-2270`（`MODULES_UNKNOWN_CHANNEL`）；设计稿 §28.23（`docs/design/mod-layer.md:1998`） |
| `pack.json.enabled`（§19.9） | `shared/enabled.js:33`（`ENABLED_BAD_SHAPE`）、`:36`（`ENABLED_FALSE`）、`:39`（键名）、`:48`/`:64`（两个判据函数）；设计稿 §28.50 |
| `overrides`（所有权声明 ＋ **字段级补丁**） | `shared/workshop.js:194`（形状）、`:1853-1856`（归一化）、**`:2990-3000`（`mergeRecord`：号码 / 字符串 / 布尔与承载它们的普通对象**递归逐字段**合并）**；**数组整块替换 ＋ `OVERRIDE_REPLACE_KEYS` 11 键整块取 ＋ `talents` 按身份键** `docs/design/mod-layer.md:238-258`（§A2）；读取点 `server/workshop.js:1172-1178`、`:1243`、`:1292-1299`（`KIT_OFFICIAL_OVERRIDE_UNDECLARED`） |
| `variants` 三轴 | `shared/variants.js:57`（`training`）、`:72`（`form`）、`:87`（`deploy`） |
| 面板 ctx 的键 | `public/js/ui/extensions.js:798-805` |
| `net` 成员与两格新读数 | `public/js/ui/extensions.js:667-768`；`docs/design/mod-layer.md:1928-2013` |
| 偏好口 | `public/js/ui/extensions.js:536-586` |
| 主题变量（加法） | `public/js/ui/extensions.js:1106-1120` |
| 关动画的引擎通道 | `public/css/theme.css:387-393`、`public/js/ui/device.js:106-107` |
| 资源分发内建 | `public/js/resources/{bundle,verify,host,worker,service,common}.js` |
| URL 前缀 | `shared/workshop.js:147`、`:156` |

> 上面这些行号是**核的时候**记的，核于引擎 `main` 的 **`c0988645`**（= 引擎 `main` 与 `origin/main` 的那一笔源码提交；
> 上一版核的是 `f15bad80`，底座从上游 0.2.5 抬到 **0.2.6** 之后有若干行号漂移，
> 本版把 §4 / §12 / §19 / §20 引到的那些逐条重核过）。
> 引擎在动，**行号会漂** —— 核不准时**按符号名搜**（`PACK_FIELDS`、`BEHAVIOUR_SWITCHES`、`adjudicatePackGraph`…），
> 不要按行号硬找。
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

## 19. 引擎这一版新加的接口面（核于引擎 `main` `c0988645`）

**口径先摆出来**：下面每条都**去引擎代码里核过**，不是照抄任何清单。判「今天能用」的判据是三样齐 ——
**实现点 + 一个钉行为的测试 + 一节设计文档**；核不到的写「在途」，没有的写「没有」。
**核时的引擎 HEAD**：`c098864545aabbb47d0f93a81af852207903ea532`（= 引擎 `main` 与 `origin/main` 的那一笔源码提交
—— 这里说的是**源码当前状态**，不是某个已发布的整合包；本节的 `文件:行号` 全部按这一版重核过一遍，
上一版记的是 `f15bad80`，底座从上游 0.2.5 抬到 **0.2.6** 之后有若干行号漂移 —— 见 §17 末尾那条说明）。
**引擎是最终依据**：这一节只讲「在哪、怎么写、边界是什么」，规则细节回引擎读（§16 的清单）。

### 19.1 `behaviour` 行为开关 —— 四格，**今天能用**

| 开关 | 选项（**前一个是缺省档**） | 一句话效果 | 引擎读取点 |
|---|---|---|---|
| `shopBias` | `official` · `bondBias` | 商店装备槽只在本玩家**已激活**盟约的装备里抽；**只偏置、不授予**；某阶级无命中 ⇒ 回落官方那一份，库存闸门一步不跳过 | `shared/behaviour.js:91-104` |
| `prepLoadout` | `locked` · `prep` | 休整期（`PREP`）、且这个座位**还没准备**时，也收一次既有的 `room.loadout`；**合并语义**（没写的干员保留当前配发）；**不新增协议消息** | `shared/behaviour.js:114-127` |
| `morphPairing` | `official` · `plus` | 一件装备就够配对、只取装备行**最左边**那一件、变形同构体**不占装备位**（每名干员最多一件） | `shared/behaviour.js:145-158` |
| `unequip` | `official` · `allow` | 休整期用 `g.unequip { itemUid }` 把装备退回**手牌**（右→左优先），手牌满进**临时整备区**；两处都满 ⇒ 原子拒绝 `HAND_FULL`，装备留在原处 | `shared/behaviour.js:170-183` |

**四格的缺省档都等于引擎今天的行为**（逐字节不变，不需要 `golden:update`）。

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
| 1 | **闭枚举，整包拒（不是忽略）**：开关名不认识 ⇒ `BEHAVIOUR_UNKNOWN_SWITCH`；选项名不认识 ⇒ `BEHAVIOUR_UNKNOWN_OPTION` | `docs/MOD-SURFACE.md:75`、`shared/modSurface.js:329` |
| 2 | ⚠️ **`combat: true` 是硬闸门**：四格**每一格都会改对局结果**（商店出货 / 配发 / 盟约成员与层数 / 装备位），不写 ⇒ `BEHAVIOUR_NEEDS_COMBAT` **整包拒** | `shared/workshop.js:2418` |
| 3 | ⚠️ **`behaviour` 不是贡献项**：只带它的包照旧 **`EMPTY_PACK` 整包拒**，**必须另带真贡献**（`content` / `client` / `notices` / `routes` / 素材…）。与它同一条的还有 `support` / `playtest` / `variants` / `dependencies` / `conflicts` | `shared/workshop.js:2308-2326`（六样清单在 `:2319`）、[README](README.md) 与 §5.3 |
| 4 | **包里给不出数值、也给不出路径**：`module` / `entry` / `file` / `path` / `value` / `key` 这类键在形状层**点名拒**；动作 `{ kind, value }` **由引擎构造** | `docs/MOD-SURFACE.md:75` |
| 5 | 不声明 ⇒ 归一化清单里**不长这个键**；声明了**必须进包身份哈希**（不进 `modDigest`） | `docs/MOD-SURFACE.md:75` |

**四格各自的「还没做」也照实写**（边界不是装饰）：

- `shopBias` 的原件还提过两条（已激活**核心**盟约优先、骑士戒律接入）以及它的 `giveBondBiasOnly` / `canGiveBond` ——
  **未实现、也未被读取**（源件不在手上，业主口径「缺源件就不做假实现」）：`shared/behaviour.js:84-89`；
- `prepLoadout` 的**客户端入口还没做**（`PREP` 期换技能/模组的那个按钮），记账在 §28.43.4：`docs/design/mod-layer.md:3189`。

**想加第五格？包作者加不了。** 加一格的前置是「**引擎先有实现点**」——清单在 `docs/MOD-SURFACE.md:108-115`
（形状校验 + 锚点 + 实现文件 + 一个测试文件 + 一节设计文档）；包这一侧只能声明**表里已有的**。
设计稿：§28.43（`docs/design/mod-layer.md:2937` 起）。

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
| 校验器 | `PACK_FOREIGN` **warning**（清单合法，所以是 warning 不是 error）＋ 收尾一句 `N pack(s) target another host`：`tools/workshop-validate.mjs:212` |
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

### 19.4 宿主注册 lane（`wsLanes` / `httpLanes`）—— **包不能声明，只给宿主**

引擎有两条「把一段路径交给**宿主自己的代码**」的表：`startServer({ wsLanes: [...] })`（WebSocket 升级路径，§28.44）
与 `startServer({ httpLanes: [...] })`（请求路径子树，**含 POST**，§28.45）。实现点 `server/http/wsLanes.js`、
`server/http/httpLanes.js`，入口 `server/index.js:83-84`、`:352`、`:355`。

| 谁 | 能不能声明 lane |
|---|---|
| **宿主**（调 `startServer` 的那段代码，例如一个整合发行版） | **能** —— `lanes` / `httpLanes` 是**函数入参**，不在 `pack.json` 里 |
| **工坊包** | **不能**。`PACK_FIELDS` 是闭集，里面**没有** `wsLanes` / `httpLanes`（`shared/workshop.js:123-156`）⇒ 写进 `pack.json` 就是 `PACK_UNKNOWN_FIELD` **整包拒** |

**为什么**：lane 的语义是「路径 → **宿主进程里的一个回调**」（`onUpgrade` / `onRequest`）＝ **任意代码 + 任意路径**。
而包这一侧能给的两条等价通道都**刻意更窄**：`routes`（路径与缓存策略都在允许集合内，**只有 GET/HEAD**，
`docs/MOD-SURFACE.md:73`）与 `server.modules[].uses: "route"`（路径必须落在 `/mod/<包 id>/…`，**只有 GET/HEAD**，
回调必须**同步**返回、体积 ≤ 64 KB、**没有认证**，`:69`）。
**包的路径面永远不能注册任意路径、也不能挂 POST** —— 那两条是宿主自己的事。

**今天的现实**：不给 `lanes` / `httpLanes` 就是「没有这个键」，三条命运与从前**逐字节相同**
（`test/laneDefaults.test.js:8-22`）。

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
| `prepLoadout` 的 `PREP` 客户端入口 | **还没做** | `docs/design/mod-layer.md:3189`（§28.43.4） |
| 编辑器接登记册 | **还没接**：`editor/` 下点不到登记册，启停只有 CLI 看得见 | 见 §19.5 那张表 |
| ✅ 已合入、可以用的 | `behaviour` 四格 · `target` · `dependencies` / `conflicts` · 宿主 lane · 登记册（CLI）· **`trait.grantsBonds`**（§19.7）· **`server.modules[].channels`**（§19.8）· **`pack.json.enabled`**（§19.9） | 见 §19.1–§19.5、§19.7–§19.9 |

> **上一版写在这里的两条都已经落地**，本版按当前树核实并改写：
> ① `trait.grantsBonds`（当时写「在途 / 未合入：所有 ref 零命中、`mod-layer.md` 里没有 §28.49」）
> ⇒ 现在是 §19.7；② `server.modules[].channels`（当时写「还没有这一格」）⇒ 现在是 §19.8。
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
| 字段闭集 | `server.modules[]` 的字段是 `id` / `entry` / `uses` / `write` / **`channels`**（可选） | `shared/workshop.js:531` |
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
> （`shared/workshop.js:409`），9 个槽位在 `:377-381`。

### 19.9 `pack.json.enabled` —— **装好 ≠ 生效**（§28.50）

| 项 | 实况 | 依据 |
|---|---|---|
| 形状 | **只有布尔**：`"false"` / `0` / `null` / `"true"` 这类**假布尔整包拒**（`ENABLED_BAD_SHAPE`）。理由与 `BEHAVIOUR_BAD_OPTION` 逐字相同：一个被 JS 真值表放行的假布尔就是**静默失效** —— 作者写下 `"false"`、引擎读到「启用了」，中间没有任何人收到错误 | `shared/enabled.js:33`、`:48` |
| 缺省 | 不写 = 引擎今天的行为；写 `true` 与**不写逐字节相同**（只有 `false` 进归一化清单的 `declared`，所以老包的身份哈希不变） | §28.50 第 2 条 |
| 效果 | `false` 的包**不进 `packs`**，而是进装载结论的 `errors`（**`ENABLED_FALSE`**）并**逐条点名**；跳过发生在**归一化之后、读任何内容文件之前** —— 所以被关掉的包**不会**因为「缺文件」再报一次噪声 | `shared/enabled.js:36`、`:64`；§28.50 第 3 条 |
| 它**不是**什么 | **不是**能力通道（打不开引擎里没有的东西）；**不是**安装器的退让（不整份覆盖引擎文件，红线 1）；**也不是**热重载（改了 `enabled` 一样要重启服务器） | §28.50 |
| 什么时候用它 | 你想让一个包**留在原处、字节完好、只是不参与** —— 而不是把 `pack.json` 改坏、或把目录搬出工坊根（那两条都是响亮的失败，作者自己看不到发生了什么） | §28.50 |


## 20. 今天就能用、以前没写清的老面

### 20.1 `server.meta`：**条件叠层**、更复杂效果的那条路（不用改引擎）

⚠️ **先看清与 §19.7 的分工**：只想要「这条特质视为某几个盟约的成员」这个**固定映射**，用
**`trait.grantsBonds`**（§19.7）—— 一格数据，不用写代码。这一节是**另一条路**：需要在**运行时按条件算**
（读某条记录再决定、按对局状态决定叠不叠、算出来的层数不是常量）时，用 `server.meta`。

这是**已有面**，不是新加的 —— 写在这里，是因为它今天就能做，而本文之前没写做法。

1. `pack.json` 写 `server.meta = { module, registers }`（`META_FIELDS` 只有这两格：`shared/workshop.js:473`），
   并且**必须** `combat: true`（它会改结果；不写 ⇒ `META_NEEDS_COMBAT` **整包拒**：`shared/workshop.js:2386`）；
2. 模块里注册 `HOOKS` 里的钩子 —— 共 **19 个**（`onPrepEnd` 是其中一个）：`server/match/effectsMeta.js:52`；
3. 钩子里**读**：`ctx.chessRecord(uid)` → `data/chess.json` 那条记录，**它带 `trait`**
   （形状例如 `"trait": { "desc": …, "bb": {}, "rangeGrid": null }`）：`server/match/effectsMeta.js:526`；
4. 钩子里**写**：`ctx.addLayers(bondId, n, { requireActive?, reason? })` —— 叠加盟约层数：`server/match/effectsMeta.js:561`。

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
| `content` | **有** | 名单是引擎固定的 **14** 个文件：`chess` / `units` / `items` / `enemies` / `stages` / `waves` / `tokens` / `bosses` / `factions` / `garrisons` / `bands` / `bonds` / `effects` / `choices` | `shared/workshop.js:40-41` |
| `operators` | **有** | `operators[<charId>]` **只有两个字段**：`bonds` 与 `powers`（每项非空字符串、去重排序）。它把干员放进**自选池** —— 与 `content: ["chess"]` 是两条不同的入口（同一个干员两条路都走会被点名） | `shared/workshop.js:64`（`UNIT_REQUIRED_FIELDS`）、`:2155-2167`、`:2722-2733` |
| `client.panels[].messages` | **有** | 通道名由包自己起（线上名是 `<包 id>.<短名>`），有**额度与限流**；通道名形状写歪点名 `CLIENT_PANEL_CHANNEL` | `shared/workshop.js:787-799`、`docs/MOD-SURFACE.md:95` |
| `server.modules[].channels` | **有** | 可选字段（`id` / `entry` / `uses` / `write` / `channels`）：每个模块 ≤ 8 条、名字形状同面板、**必须同时声明 `matchClass`**、且每一条都要被本包某个 `client.panels[].messages` 声明过 —— 详见 §19.8 | `shared/workshop.js:531`、`:960-978`、`:2257-2270` |
| `assets.mirrors` | **有** | `mirrors[] = { id, base, sha256 }`：**只镜像本包自己的容器**；`base` 必须绝对 `https://`（有主机、无凭据、无查询、尾斜杠）、id 唯一且 **≤ 4 条**、`sha256` 必须等于装载期从包内文件算出的容器摘要（对不上的那条**停用并点名**，不拒包）；声明它**必须写 `license`**；**服务端不为这一格发一次网络请求**（取字节的是客户端） | `docs/MOD-SURFACE.md:74`、`:97` |
| `variants` | **有** | **三条轴**：`training`（`official` · `full`，缺省 `full`）、`form`（`official` · `elite`，缺省 `official`）、`deploy`（`official` · `max`，缺省 `official`）。缺省＝引擎今天的行为；**不是贡献项** | `shared/variants.js:57`、`:72`、`:87` |
| `routes` | **有** | `routes = [{ path, cache }]`：路径与缓存策略都必须在引擎的允许集合内；**只有 GET/HEAD** —— 整个 HTTP 面「除 GET/HEAD 之外的方法一律 405，除非某条**宿主 lane** 为那个路径认领了该方法」。要 POST 得走 §19.4 那两条**宿主**通道，包没有 | `docs/MOD-SURFACE.md:73`、`server/http/routes.js:5`、`:12-15` |
| `notices` | **有** | `notices = { 栏目: 文本 }`（只认 `announcement` / `credits`），纯文本、结构化但**不执行**；**是贡献项** | `docs/MOD-SURFACE.md:58`、`shared/workshop.js:1372-1388`、本文 §6 |
| `enabled` | **有**（这一版新加的第 36 格） | **只有布尔**；`true` = 不写（逐字节相同），`false` = 包留在原处但不参与、进 `errors` 并点名。**不是贡献项**、不是能力通道、不是热重载 —— 详见 §19.9 | `shared/enabled.js:33-64`、设计稿 §28.50 |


