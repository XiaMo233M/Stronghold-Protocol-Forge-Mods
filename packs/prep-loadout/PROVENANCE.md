# PROVENANCE — 休整期可更换技能和模组mod（`prep-loadout`）

本文件由**兼容改写者**写，六项照 `Stronghold-Protocol-Forge-Mods/SKILL.md` §10。**核不到的事实写「未声明」，不编造。**

| # | 项 | 值 |
|---|---|---|
| ① | 原作者 | **B站@伊佐那邪_**（来源：站侧记录 `meta.json` 的 `note` 栏，原文即「作者B站@伊佐那邪_」）。原件 zip 内的 `manifest.json` **未声明 `author`** |
| ② | 许可 | **原件未声明许可**（原件 `manifest.json` / `files.json` 都没有 `license` 键；站侧记录也没有）。本包 `pack.json` 因此写 `NOASSERTION` |
| ③ | 兼容改写者 | **Mo233** |
| ④ | 来源 | 站上投稿编号 **`8b4e5da55c58`** · 原投稿名「休整期可更换技能和模组mod」 · 原件 `mod.zip` 115,004 B · sha256 `3bfd2b47830db9d3f7774b93595396688d55206c0c83391b07e549d739544d40` · 上传于 2026-10-11T17:02:46.191Z · 原件自述版本 `1.0.0`（`manifest.json` 的 `version`） |
| ⑤ | 改了什么 | 见下「改写对照」 |
| ⑥ | 自带素材来源 | **无** —— 原件自述「不需要 `--assets`：这个包不带任何美术资源」，其 `asset-additions.json` 只有 133 B |

## ⑤ 改写对照（原做法 → 我们的做法 → 为什么）

| # | 原做法 | 我们的做法 | 为什么 |
|---|---|---|---|
| 1 | **安装器型**：`install.mjs`（50,484 B）+ `payload/**`，**整份覆盖** `shared/protocol.js`、`server/match/match/intents.js`、`server/match/match/platform.js` 与四个客户端文件（`game.js` / `detailPanel.js` / `gameActions.js` / `game-panels.css`） | **本包不含任何覆盖**，只有 `pack.json` + `PROVENANCE.md` + 两份公告文本。要表达的那件事写成 `pack.json` 的 `behaviour` 一栏：`{ "switch": "prepLoadout", "option": "prep" }` | 包**不许整份覆盖引擎文件**。引擎已为这条投稿实现好这一格开关，包只需**声明**它 |
| 2 | 自己新增一条 `g.loadout {entries}` 意图，并加 `MatchPlatform.setPrepLoadout()` | **不新增协议消息**：引擎这一格走的是**既有**那条 `room.loadout { entries, ops? }`，相位闸门由引擎管（`docs/design/mod-layer.md` §28.43.1 那行写的是 `LOADOUT_PHASES` / `loadoutPhasesFor` + `MatchPlatform.setLoadout`） | 引擎能力必须在引擎，包只能消费它。**投稿原件本身也是复用既有意图**，所以这里没有语义损失 |
| 3 | 客户端技能 / 模组切换按钮 + `.dloadout-pick` 样式 | 引擎侧决定按钮的可见性；本包不携带 UI 覆盖 | 同上 |

**原件文本一字未改**：本包**不收录**原件任何文件。

## 与引擎缺省档的关系

`prepLoadout` 的缺省档是 **`locked`**（= 引擎今天的行为：`room.loadout` 只在 `INFO_CHECK` 收一次，之后冻结）。
**注意选项名不是 `official`** —— 这一格的两个选项名是 `locked` / `prep`（`shared/behaviour.js` 的
`BEHAVIOUR_SWITCHES.prepLoadout`）。写 `official` 会被 `BEHAVIOUR_UNKNOWN_OPTION` 整包拒。
**本包选的是非缺省档 `prep`**，所以它**必须** `combat: true`（`BEHAVIOUR_NEEDS_COMBAT`）。

## 未核到 / 未测

- **未测**：没有在真实对局的休整期里点过技能 / 模组切换按钮（本包只做装载验证；行为由引擎侧测试覆盖）。
- 原件的 `app` 字段写 `0.2.4`（上游版本标签）；本包**不声明** `game` / `gameVersion` —— 那两个键是标签、
  引擎不与运行版本比对，写一个我们没有核实过的值不如不写。
