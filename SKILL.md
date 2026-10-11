# SKILL — 把一份 mod 做成这个仓库能收录的工坊包

**这份文件是「包作者怎么做」。** 维护者 / agent 怎么审、怎么把包发到站上，看 [AGENTS.md](AGENTS.md)。
两份文件不重叠：这里讲格式与流程，那里讲审核、发布与纪律。

给 AI 助手与人类贡献者的同一份说明书。本文与**引擎文档**冲突时**以引擎文档为准**
（见文末「引擎侧的权威文档」）；本文引用的每一处代码位置都核过（见 §12 的依据表）。

---

## 1. 什么时候用

- 你要把一份**社区 mod**（就地改引擎源码的那种）改写成工坊包，收进本仓库
- 你要新写一个 mod，并希望它在**引擎升级后仍然能装**
- 你要判断「这份 mod 到底能不能做成包」（有些改动没有接口，见 §7）

## 2. 这个仓库是什么

三个目录，三种含义：

| 目录 | 放什么 | 判定 |
|---|---|---|
| `packs/<包 id>/` | **兼容已完成、验过**的包 —— 能直接装 | 闸门：必须全部装上 |
| `demo/<包 id>/` | **已过时的样板**：三份旧包，**不再对外提供、不要照抄** | 退役：见 [`demo/README.md`](demo/README.md) |
| `incoming/<mod 名字>/` | **组员上传、尚未完成兼容**的 mod 原件 | 只报告，不拦 |

一份包一份目录，`pack.json` 是它的唯一入口。**目标是把 `incoming/` 里的东西变成 `packs/` 里的东西。**

**不是**：不是游戏本体、不是引擎源码、**不含任何游戏素材**（§6）。
包由玩家（或整合包）拷进引擎的工坊目录后才生效。本仓库只负责**存放、署名与兼容性校验**。

## 3. 包形状的三条硬规则（踩过坑，先看这三条）

| # | 规则 | 错了会怎样 | 依据 |
|---|---|---|---|
| ① | 装载器**只认** `<工坊根>/<包 id>/pack.json` | 外层再套一层目录 ⇒ 读不到 `pack.json` | `server/workshop.js:94-110` |
| ② | **目录名必须等于 `pack.json.id`** | `PACK_ID_MISMATCH`，整包跳过 | `shared/workshop.js:1443-1447` |
| ③ | **zip 的顶层目录 = 包 id**（包内文件就在这一层） | 解压后多一层 ⇒ 落到规则 ① 的坑里 | 同上 + `README.md` §「怎么装一个包」 |

规则 ③ 是本轮真踩过的：把 `packs/<包 id>/` **整个目录**压进 zip，解压出来就是
`<工坊根>/<包 id>/<包 id>/pack.json`。**正确的 zip 里，`pack.json` 的路径是 `<包 id>/pack.json`，
深度为 2**（顶层目录名 + 文件名），不是 3。

> 一个包一个 zip，条目名一律正斜杠（`/`）。同一份目录压两次得到两个哈希，别混。

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
（`shared/workshop.js:1914-1929`）。

**② `pack.json`** —— 字段全集（引擎 `shared/workshop.js:111-128` 的 `PACK_FIELDS`，一个不多一个不少）：

```
id, name, version, author, license, description, gameVersion, game, api, layer, combat,
content, overrides, voices, voiceLangs, bondIcons, itemIcons, art, skins, support, operators, i18n,
forms, fx, notices, playtest, assets, client, server, routes
```

**③ `api` 与 `game` 是两回事** ——

- **`api`：模组 API 版本区间，引擎会强制比对。** 当前 `MOD_API_VERSION = 1`，所以写 `">=1 <2"` 或 `"1.x"`。
  引擎抬到 2 时，写 `1.x` 的包会被**明确拒掉**并说明理由（`MOD_API_INCOMPATIBLE`，
  `shared/workshop.js:1903-1905`）—— 这正是你要的保护：宁可拒绝，不要带着错的行为跑起来。
- **`game`：上游游戏版本区间**。引擎目前**只校验它是不是合法区间，不比对**
  （`shared/workshop.js:1908-1909`）。它是给人和工具看的信息，不是闸门。
  `gameVersion` 是它的旧名（读的时候 `game` 优先），新包写 `game`。

**④ 身份哈希** —— 每个包按内容算一个哈希。改了包里的**任何字节**，哈希就变。它的用途是让玩家一眼看出
「这个包还是不是我上次装的那个」。**不要为了改哈希而改哈希**，也不要手写哈希进文件。

## 5. 三个沉默的坑（本轮真踩到，全部要点名）

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

类型闸门先于区间校验（`shared/workshop.js:1864-1895`）。注释写得很直白：非字符串的声明
**会被读成「没声明」** —— 那正是「写了等于没写」。所以这一层宁可当场拒。

**两个要注意的次序 / 语义细节**（实测过，容易误判）：

- **类型闸门排在 `EMPTY_PACK` 之后**。一个 `content: []`、也没有别的贡献项的包，
  先报的是 `EMPTY_PACK` —— 也就是那条 `api` 类型错误**会被掩住**。
  所以看到 `EMPTY_PACK` 时，把 `content` 补上再跑一次，才知道 `api` 的类型对不对。
- **这不是错的**：`isVersionRange` 接受 `">=1 <2"` / `"1.x"` / `"1"`（精确版本）等形式。
  错的是**类型**（数字 / 布尔 → `BAD_API_TYPE`），不是「没写两个点」。

（历史教训：一份包把 `api` 写成数字，编辑器里它存在、磁盘上它也在，却始终进不了游戏。
现在的代码会给一条带 `BAD_API_TYPE` 的明文拒绝，不再需要人猜 —— 前提是那份包没有先被
`EMPTY_PACK` 挡住。）

### 5.3 `content` 必须声明 `chess`，否则加载器**完全不读**这个包的 `chess.json`

装载器只读**声明过的**内容文件（`shared/workshop.js:1448-1450` 归一化，
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
名单以外的值被过滤掉。**`support` 与 `playtest` 不是贡献项**：只写 `support` 而 `content: []` 的包会被
`EMPTY_PACK` 拒，理由里点名这一句（`shared/workshop.js:1847-1862`；引擎
`docs/WORKSHOP.md:665-666`、`:1897-1898` 也这么说）。

### 5.4 公告 / 鸣谢走 `notices`（只认两个字段）

`notices` 只认 `announcement` / `credits`，**各指向一个包内相对 `.json` 路径**（不是内联文本）
（`shared/workshop.js:1051-1073`）。两条都遵守同一条纪律：**清单里没写这个键，哈希逐字节不变**。

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
本轮之前的先例是 `demo/plugin-pack/notice/credits.json`，但 `demo/` 已退役、**不要照抄那一份**。

## 6. 落成包格式（最常用的一屏）

```
packs/<包 id>/
├── pack.json            必需
├── PROVENANCE.md        必需：署名与来源（§9）
├── <content>.json       数据层：bonds / chess / garrisons / items / tokens …（名字由 pack.json 的 content 列出）
├── kits/*.js            行为层：自定义干员 kit（只能 import 白名单里的别名，见下）
├── ui/*.js              界面层：面板模块（浏览器原生 ESM）
├── css/*.css            界面层：样式
├── i18n/<lang>.json     文案（键与引擎一致：zh-CN / zh-TW / en / ja / ko）
├── notice/*.json        公告与鸣谢（由 pack.json 的 notices 指向，§5.4）
├── assets/**            包自带的素材（图标、徽记、音效…）
└── server/*.mjs         服务端成员：preDispatch / meta / modules / battle / room
```

**能被 import 的东西是白名单**（引擎的 kit import map，共 11 条，写别名、**不写相对路径**）：

```
@kit/tier1.js … @kit/tier6.js   @kit/summoner.js
@sim/constants.js  @sim/dir.js  @sim/targeting.js  @battle/index.js
```

想用白名单以外的东西 = **这个 mod 做不成包**（§7），不要试图用相对路径绕过去：装载器会拒。

**界面槽位**（`client.panels` 的 `slot`，共 9 个；`screen.game.shopCard` 是**可重复**的，
会往每一张商店卡上挂一个，模块靠 `ctx.hostKey` 分辨自己在哪一个）：

```
root.overlays  root.guide  screen.game.aside  screen.result.footer
screen.game.shopCard  screen.game.bondStrip  screen.game.hud  screen.game.overlay
screen.loadout.detail
```

**能被包裹的组件**（`client.wrap`）：`game.bondStrip`、`game.hud.topBar`、`game.shopCard`、`loadout.detail`。

**包里的 URL 前缀**：素材 `/workshop-assets/<包 id>/…`，面板模块 `/workshop-panels/…`
（`shared/workshop.js:147`、`:156`）。

## 7. 「有更好的逻辑就用我们的」（业主原则）

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
正确做法是把它做成**用户开关**（默认走引擎通道），开关状态存在 §8.4 的偏好口里。
拆开说：**默认尊重平台偏好，用户主动打开才一律归零。**

## 8. 面板 ctx：一个面板能拿到什么

面板模块的 `mount(ctx)` 拿到的 `ctx` 是**冻结对象**，键就是下面这些（`public/js/ui/extensions.js:798-805`）：

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
| `session` | 见 §8.4 |
| `net` | 见 §8.1 / §8.2 |
| `data` | 只读数据口（§7 那一条） |
| `me` | 只读会话态：`playerId` / `name` / `room`（房间**展示面**快照：`code` / `mode` / `difficulty` / `inMatch` / `mySeat` / `spectating` / `mods`），另有 `snapshot()` 一次取全 |

**边界就是「没传什么」**：**没有** store 句柄、没有 match / battle 对象、没有 `battleRunner`、没有 audio。
所以一个 C 层模块可以「画错」，但改不了对局结果。

### 8.1 `ctx.net` 的全部成员（6 个）

| 成员 | 做什么 |
|---|---|
| `on(type, fn)` | 订阅。**引擎类型**原样透传；其余名字必须先在 `client.panels[].messages` 里声明，否则点名 `CLIENT_CHANNEL_UNDECLARED` 并返回一个空退订函数 |
| `send(channel, data)` | 发**自己的**通道消息（`pack.msg`），通道必须声明过 |
| `sendResourceMessage(msg)` | 发资源挑战那一类**早于 `hello`** 的消息（走 `_sendRaw`，`send()` 会丢） |
| **`status()`** | **本轮新增**：连接读数，见 §8.2 |
| **`welcome()`** | **本轮新增**：服务器身份读数，见 §8.2 |
| （无其它） | 面板**拿不到** `WebSocket`、心跳往返、重连计数器 —— 所以那两格只能由引擎给 |

### 8.2 两格新读数的返回形状与只读语义

```jsonc
// ctx.net.status() —— 每次调用都是一份新的、冻结的副本
{ "status": "idle|connecting|connected|handshaking|online|reconnecting|closed",
  "attempt": 0, "retryAt": 0, "ping": null,
  "lastError": { "code": "REPLACED", "text": "…" } | null }
```

来源是引擎自己那份连接状态（`Net.snapshot()`，`'status'` 事件携带的就是它），**同一条事实，不是第二份推断**。
只带这五个键，引擎内部字段（如 `playerId`）不外传（`public/js/ui/extensions.js:730-748`）。

```jsonc
// ctx.net.welcome() —— 已收到的那一帧 welcome 的冻结深拷贝
{ "playerId": "…", "name": "…", "token": "…", "serverNow": 0, "version": "…",
  "mods": { "digest": "…", "packs": [] }, "modPanels": [], "maxSeats": 0 /* … */ }
```

帧里的字段**原样保留**：不裁、不改名、不补默认值（`public/js/ui/extensions.js:765-767`）。
**为什么需要它**：面板是由**同一条 `welcome` 帧**装载的（面板清单走 `welcome.modPanels`），
所以面板在 `mount()` 里自己去订阅这一帧，首帧大概率赶不上、要等一次重连才知道对面是谁 ——
这正是社区投稿报过的卡点（引擎 `docs/design/mod-layer.md:1982-1987`）。

两格共同的语义（三条，都要照做）：

1. **冻结、拿不到即 `null`** —— 不抛、不编造、不补默认值。没有读数就画空态。
2. **不新增协议消息**：不发任何帧、不发请求、不改引擎行为（引擎侧有机械断言盯这一点，
   `docs/design/mod-layer.md:1969-1971`）。
3. **加能力不抬 `MOD_API_VERSION`**：两格是往**已存在的对象**上加成员，
   `MOD_API_VERSION` **不动**、已发布的包不会被拒（`docs/design/mod-layer.md:2004-2006`）。
   所以包侧的正确写法是「有就用、没有就优雅降级」，不是「判版本、缺了就报错」。

> 引擎侧的规范：`docs/design/mod-layer.md` **§28.24**（`status()`，`:1943`）与 **§28.25**（`welcome()`，`:1973`）。

### 8.3 `ctx.session.setPref` / `getPref` —— 唯一一格能写的东西

面板**没有** `localStorage`、也没有 store 的写权限。要记住「每干员选了哪套」这类东西，用这一格：
键自动按 `<包 id>/` 分区（两个包用同一个键名不会互相覆盖），值只收 `string` / `number` / `boolean` / `null`，
键 1..64 字符、字符串值 ≤512 字符，**越界一律 `false` 并点名**（`CLIENT_PREF_BAD_KEY` /
`CLIENT_PREF_BAD_VALUE`），不静默（`public/js/ui/extensions.js:536-586`）。

```js
const on = ctx.session.getPref('hardOff', false);   // 默认关
ctx.session.setPref('hardOff', true);              // 返回 true / false
```

`session` 的另一半是 `setPreload({ required, ready })` —— 入场闸门，**唯一**一格 store 写。

### 8.4 `ctx` 之外的兜底写法

`client.panels[].messages` 里声明过通道才能收发（§8.1）。一个**永远不响的订阅**是这一层最不愿留下的东西，
所以未声明的通道是**点名**而不是静默。

## 9. 署名与许可纪律（不可省）

**每个包必带 `PROVENANCE.md`**（放在包根，与 `pack.json` 同级），写清**六项**：

| # | 项 | 要求 |
|---|---|---|
| 1 | 原作者 | 名字；**原件未署名就写「原件未署名」，绝不代填** |
| 2 | 许可 | **照实抄**包内 `pack.json` 的 `license` 原文，含 `NOASSERTION` 这类**非 SPDX 值**也照抄 |
| 3 | 兼容改写者 | 做兼容改写的那个人（与原作者**分开列，不抹掉任何一方**） |
| 4 | 来源 | 从哪来的、可追溯的编号 / URL / 版本（能记 sha256 就记） |
| 5 | 改了什么 | 逐条：原做法 → 我们的做法 → 为什么 |
| 6 | 自带素材来源 | 逐条；没有就写「无」 |

**包内文本一字不改**：原作者自带的 `README` / `NOTICE` / `CREDITS` / `LICENSE`，
以及包自带的元数据（`pack.json` 的 `name` / `version` / `author` / `license` / `api` …）
**一律保持原样**（要保留原件许可时改名为 `NOTICE-原件-*` 一起随包）。
**与我们的新实现不符时，写在我们自己的 `PROVENANCE.md` 里**，格式照这个来：

> `pack.json.name` 已与实现不符（**保持原样未改**）：它写的是「无条件关动画」，
> 本版改成用户开关、默认走引擎通道。

其余许可规矩：

- 本仓库**整体**以 **GPL-3.0-or-later** 分发（`LICENSE`），**但每个包仍以自己 `pack.json` 的 `license` 为准**
- **非商业**：本仓库及其收录的包**不得用于任何商业用途**（见 `NOTICE.md`）
- 游戏本体的名称、素材与商标归**鹰角网络**所有

## 10. 工作流（本轮实际怎么做的）

```
① 重打成 zip 根形状      包内文件直接放在 zip 顶层；顶层目录名 = 包 id（§3 规则 ③）
② 修包契约              pack.json 只留 PACK_FIELDS 的键；id = 目录名；content 声明到位（§5）
③ 该用我们的实现就换    逐条过 §7 的替代表，别自己重造引擎已有的通道
④ 干净 workshop 根装载   一包一根、单独装载、要 errors=0（把原始输出贴进交付说明）
⑤ 一包一 zip             顶层目录 = 包 id；条目名正斜杠
⑥ 补 PROVENANCE.md       六项（§9）
⑦ 记字节与 sha256        zip 的字节数与哈希记在交付清单里，不写进包内文本
```

**第 ④ 步不能省**：拿**干净的空工坊根**（只有这一个包）跑一遍引擎自己的装载器，
**要 `errors=0`**，并把**原始输出**留着。理由：混装时一个包被拒是分不清「谁的问题」的。

**多 mod 时：一个 mod 一个子 agent 并行。** 这是业主明确口径 —— 包之间不共享状态，
唯一要共享的是「引擎通道怎么用」这条知识（本文 §7）。

## 11. 验证（做完必跑）

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

## 12. 命令速查

```bash
node tools/check-packs.mjs --engine <引擎目录>          # 全部包过一遍
node tools/check-packs.mjs --engine <引擎目录> --json   # 机器可读
SP_ENGINE=<引擎目录> node tools/check-packs.mjs          # 用环境变量给引擎路径
```

Windows PowerShell 里用 `;` 不用 `&&`；写文件用 **UTF-8 无 BOM**（否则 Git 会把整文件当改动）。

## 13. 禁止事项

- ❌ 提交任何官方游戏素材（§6 的红线见下）
- ❌ 在 `pack.json` 里写 `PACK_FIELDS` 之外的字段（装载器会**整包拒**，且玩家装不上）
- ❌ 把 `api` 写成数字（类型闸门会拒；老版本引擎会**静默读成没声明**）
- ❌ `content` 不声明 `chess` 却指望 `chess.json` 生效（静默失败，§5.3）
- ❌ 用相对路径 import 引擎模块（只用白名单别名）
- ❌ 自己重造引擎已有的通道（§7：主题变量、关动画、只读数据、资源分发）
- ❌ 删掉原作者的署名或原件许可、改包内原作者文本
- ❌ 声称本仓库或任何包可以商业使用
- ❌ 为了让校验通过而放宽校验（应当改包，不是改闸门）

**素材红线（最重要的一条）**：本仓库不含、也永远不提交任何《明日方舟》的游戏素材
（解包出的美术、音频、字体、数据表导出物）。这条是硬线：`public/assets/` 在引擎侧就是 gitignore 的，这里同样。

- 包**可以自带**素材（同人绘制的图标、徽记、自制音效），放进 `assets/` 并**逐条写明来源与授权**
- 包**可以引用**引擎里已有的官方素材
- **不可以**把官方素材拷进仓库
- 包**不可以**声明把自己挂成官方素材的替代品（引擎有准入规则，会拒）

## 14. 做不成包的情形（先判断，别白做）

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

## 15. 引擎侧的权威文档（本仓库只做索引）

- `docs/WORKSHOP.md` —— 工坊包格式的完整规则（`pack.json` 每个字段、层、覆盖、语音、准入）
- `docs/MOD-SURFACE.md` —— 模组能碰到的**全部表面**（钩子、槽位、包裹组件、服务端成员）
- `docs/design/mod-layer.md` —— 为什么是现在这个边界（§28），含 **§28.24 / §28.25**（§8.2）
- `AGENTS.md`（引擎仓库自己的）—— 引擎仓库的贡献规则

## 16. 本文引用位置的依据表

| 本文说的 | 依据（引擎仓库，只读核过） |
|---|---|
| 只认 `<根>/<包 id>/pack.json`；只读声明过的 content 文件 | `server/workshop.js:94-110`、`:120-137` |
| `PACK_FIELDS` 闭集 | `shared/workshop.js:111-128` |
| 未知顶层键整包拒 | `shared/workshop.js:131`（拒绝码）、`:1435-1442`（判据） |
| `id` 必须等于目录名 | `shared/workshop.js:1443-1447` |
| `content` 名单 | `shared/workshop.js:28-30`、`:1448-1450` |
| `api` / `game` 类型闸门与比对 | `shared/workshop.js:1883-1895`（类型）、`:1897`（区间）、`:1903-1905`（与 `MOD_API_VERSION` 比对）、`:1909`（`game`） |
| `support` / `playtest` 不是贡献项；`EMPTY_PACK` | `shared/workshop.js:1847-1862` |
| `notices` 形状与拒绝码 | `shared/workshop.js:1037-1073` |
| 面板 ctx 的键 | `public/js/ui/extensions.js:798-805` |
| `net` 成员与两格新读数 | `public/js/ui/extensions.js:667-768`；`docs/design/mod-layer.md:1943-2014` |
| 偏好口 | `public/js/ui/extensions.js:536-586` |
| 主题变量（加法） | `public/js/ui/extensions.js:1106-1120` |
| 关动画的引擎通道 | `public/css/theme.css:387-393`、`public/js/ui/device.js:106-107` |
| 资源分发内建 | `public/js/resources/{bundle,verify,host,worker,service,common}.js` |
| URL 前缀 | `shared/workshop.js:147`、`:156` |
