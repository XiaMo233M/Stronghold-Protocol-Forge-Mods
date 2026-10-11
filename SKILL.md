# SKILL — 把一份 mod 做成这个仓库能收录的工坊包

给 AI 助手与人类贡献者的同一份说明书。**本仓库里已有的三份真实包就是范例**，写作时以它们为准，
本文与引擎文档冲突时**以引擎文档为准**（见文末「引擎侧的权威文档」）。

---

## 1. 什么时候用

- 你要把一份**社区 mod**（就地改引擎源码的那种）改写成工坊包，收进本仓库
- 你要新写一个 mod，并希望它在**引擎升级后仍然能装**
- 你要判断「这份 mod 到底能不能做成包」（有些改动没有接口，见 §6）

## 2. 这个仓库是什么

三个目录，三种含义：

| 目录 | 放什么 | 判定 |
|---|---|---|
| `packs/<包 id>/` | **兼容已完成、验过**的包 —— 能直接装 | 闸门：必须全部装上 |
| `demo/<包 id>/` | **已过时的样板**：三份旧包，**不再对外提供、不要照抄** | 退役：见 [`demo/README.md`](demo/README.md) |
| `incoming/<mod 名字>/` | **组员上传、尚未完成兼容**的 mod 原件 | 只报告，不拦 |

一份包一份目录，`pack.json` 是它的唯一入口。**目标是把 `incoming/` 里的东西变成 `packs/` 里的东西。**

**不是**：不是游戏本体、不是引擎源码、**不含任何游戏素材**（§5）。
包由玩家（或整合包）拷进引擎的工坊目录后才生效。本仓库只负责**存放、署名与兼容性校验**。

## 3. 先懂四个概念

**① 层（`layer`）** —— 包能碰到什么，由它声明的字段推导；写不写都会被算出来：

| 层 | 能改 | 典型 |
|---|---|---|
| `A` | 只有数据与素材（棋子/盟约/装备/特质/召唤物/图标） | 内容包 |
| `B` | 服务端行为（钩子、注册表、元数据） | 改规则 |
| `C` | 客户端界面（面板、包裹组件、样式、文案） | 改界面 |

`combat: true` 表示这个包**能改变战斗结果** —— 装了它的对局不能与官方对局逐帧比较，玩家必须知情。

**② `pack.json`** —— 字段全集（引擎 `shared/workshop.js` 的 `PACK_FIELDS`，一个不多一个不少）：

```
id, name, version, author, license, description, gameVersion, game, api, layer, combat,
content, overrides, voices, voiceLangs, bondIcons, itemIcons, art, skins, support,
operators, i18n, notices, playtest, assets, client, server, routes
```

`id` 必须与目录名一致（装载器按 `<根>/<包 id>/pack.json` 找包）。

**③ `api` 与 `game` 是两回事** ——

- **`api`：模组 API 版本区间，引擎会强制比对。** 当前 `MOD_API_VERSION = 1`，所以写 `">=1 <2"` 或 `"1.x"`。
  引擎抬到 2 时，写 `1.x` 的包会被**明确拒掉**并说明理由 —— 这正是你要的保护：宁可拒绝，不要带着错的行为跑起来。
- **`game`：上游游戏版本区间（当前上游 0.2.3，写 `"0.2.x"`）。** 引擎目前**只校验它是不是合法区间，不比对**。
  它是给人和工具看的信息，不是闸门。`gameVersion` 是它的旧名（读的时候 `game` 优先），新包写 `game`。

**④ 身份哈希** —— 每个包按内容算一个哈希。改了包里的**任何字节**，哈希就变。它的用途是让玩家一眼看出
「这个包还是不是我上次装的那个」。**不要为了改哈希而改哈希**，也不要手写哈希进文件。

## 4. 落成包格式（最常用的一屏）

```
packs/<包 id>/
├── pack.json            必需
├── <content>.json       数据层：bonds / chess / garrisons / items / tokens …（名字由 pack.json 的 content 列出）
├── kits/*.js            行为层：自定义干员 kit（只能 import 白名单里的别名，见下）
├── ui/*.js              界面层：面板模块（浏览器原生 ESM）
├── css/*.css            界面层：样式
├── i18n/<lang>.json     文案（键与引擎一致：zh-CN / zh-TW / en / ja / ko）
├── assets/**            包自带的素材（图标、徽记、音效…）
└── server/*.mjs         服务端成员：preDispatch / meta / modules / battle / room
```

**能被 import 的东西是白名单**（引擎的 kit import map，共 11 条，写别名、**不写相对路径**）：

```
@kit/tier1.js … @kit/tier6.js   @kit/summoner.js
@sim/constants.js  @sim/dir.js  @sim/targeting.js  @battle/index.js
```

想用白名单以外的东西 = **这个 mod 做不成包**（§6），不要试图用相对路径绕过去：装载器会拒。

**界面槽位**（`client.panels` 的 `slot`，共 9 个；`screen.game.shopCard` 是**可重复**的，
会往每一张商店卡上挂一个，模块靠 `ctx.hostKey` 分辨自己在哪一个）：

```
root.overlays  root.guide  screen.game.aside  screen.result.footer
screen.game.shopCard  screen.game.bondStrip  screen.game.hud  screen.game.overlay
screen.loadout.detail
```

**能被包裹的组件**（`client.wrap`）：`game.bondStrip`、`game.hud.topBar`、`game.shopCard`、`loadout.detail`。

**包里的 URL 前缀**：素材 `/workshop-assets/<包 id>/…`，面板模块 `/workshop-panels/…`。

## 5. 素材红线（**最重要的一条**）

**本仓库不含、也永远不提交任何《明日方舟》的游戏素材**（解包出的美术、音频、字体、数据表导出物）。
这条是硬线：`public/assets/` 在引擎侧就是 gitignore 的，这里同样。

- 包**可以自带**素材（同人绘制的图标、徽记、自制音效），放进 `assets/` 并**逐条写明来源与授权**
- 包**可以引用**引擎里已有的官方素材
- **不可以**把官方素材拷进仓库
- 包**不可以**声明把自己挂成官方素材的替代品（引擎有准入规则，会拒）

## 6. 做不成包的情形（先判断，别白做）

| 原件做了什么 | 能不能成包 |
|---|---|
| 改 `data/*.json` 的数据、加棋子/盟约/装备/特质 | ✅ 数据层 |
| 改界面（加面板、包裹组件、改样式、加文案） | ✅ 界面层 |
| 用白名单别名写干员 kit、注册服务端钩子 | ✅ 行为层 |
| 改 `server/sim/` 的内部实现、`server/match/` 的流程 | ❌ 没有接口 |
| 改引擎的结算顺序、加新的伤害类型、动 golden 结果 | ❌ 没有接口 |
| import 白名单以外的引擎模块 | ❌ 装载器拒绝 |

**做不了的部分要如实写进包的说明**（本仓库 `fanpack-kazdel-rhodes` 的
`README-改写说明.md` / `NOTICE-来源说明.md` 就是这个体例：原件哪些部分没有接口、为什么、影响了什么）。

## 7. 工作流：把一份社区 mod 改成包

**第 0 步 · 先测出原件到底改了什么。** 别读它的 README 就当事实。做法：拿**未改动的上游**当基准，
把原件的改动逐文件分类（新增 / 修改 / 删除），每一类都落到「数据 / 服务端 / 界面 / 素材」。

**第 1 步 · 分类成三堆**：能做进包的（§4 的表格）、没有接口的（写进说明）、原件自带的素材
（**只保留自制/授权的**，官方素材一律不进来）。

**第 2 步 · 写 `pack.json`。** 从下面这份最小骨架开始（**照抄，别自创字段名**）：

```json
{
  "id": "your-pack-id",
  "name": "包的显示名",
  "version": "1.0.0",
  "author": "原作者名（你若是改编者，这里写清「由谁改写」）",
  "license": "本包的许可（见 §8）",
  "description": "一句话说清它做什么、来源于哪份原件",
  "game": "0.2.x",
  "api": ">=1 <2",
  "combat": false,
  "content": []
}
```

**第 3 步 · 搬内容。** 数据按引擎的数据表字段写（`dev` 里能看到的那些字段就是全部字段）；
界面/行为按 §4 的入口写。**每搬一部分就跑一次校验**（§9），别攒到最后。

**第 4 步 · 带写清说明。** 每份包至少要有：

- `NOTICE-来源说明.md` —— 原件是谁、哪里来的、你改了什么、哪些部分没有接口做不了、素材从哪来
- 原件自带的许可与 README 若与本包不同，**原样保留**（改名为 `NOTICE-原件-*`）

**第 5 步 · 校验 + 提交。** 见 §8、§9。

## 8. 署名与许可（不可省）

- **保留原作者署名**，并写清「本包由谁改写、改了什么」
- 原件的许可**逐条遵守**：本仓库三份包分别是
  `fanpack-kazdel-rhodes`（**非商业同人作品**）、`plugin-pack`（**CC0-1.0**，原作者 Ausevay）、
  `sp-resource-pack`（**GPL-3.0-only**）
- 本仓库**整体**以 **GPL-3.0-or-later** 分发（`LICENSE`），**但每个包仍以自己 `pack.json` 的 `license` 为准**
- **非商业**：本仓库及其收录的包**不得用于任何商业用途**（见 `NOTICE.md`）
- 游戏本体的名称、素材与商标归**鹰角网络**所有

## 9. 验证（做完必跑）

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
`api` 区间与引擎的 `MOD_API_VERSION` 对不上、引用了白名单外的模块、声明了不存在的槽位。

## 10. 命令速查

```bash
node tools/check-packs.mjs --engine <引擎目录>          # 全部包过一遍
node tools/check-packs.mjs --engine <引擎目录> --json   # 机器可读
SP_ENGINE=<引擎目录> node tools/check-packs.mjs          # 用环境变量给引擎路径
```

## 11. 禁止事项

- ❌ 提交任何官方游戏素材（§5）
- ❌ 用相对路径 import 引擎模块（只用白名单别名）
- ❌ 在 `pack.json` 里写 `PACK_FIELDS` 之外的字段（装载器会拒，且玩家装不上）
- ❌ 删掉原作者的署名或原件许可
- ❌ 声称本仓库或任何包可以商业使用
- ❌ 为了让校验通过而放宽校验（应当改包，不是改闸门）

## 12. 引擎侧的权威文档（本仓库只做索引）

- `docs/WORKSHOP.md` —— 工坊包格式的完整规则（`pack.json` 每个字段、层、覆盖、语音、准入）
- `docs/MOD-SURFACE.md` —— 模组能碰到的**全部表面**（钩子、槽位、包裹组件、服务端成员）
- `docs/design/mod-layer.md` —— 为什么是现在这个边界（DESIGN §28）
- `AGENTS.md` —— 引擎仓库自己的贡献规则
