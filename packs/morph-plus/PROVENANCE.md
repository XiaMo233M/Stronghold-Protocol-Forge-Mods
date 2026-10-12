# PROVENANCE — 变形同构体加强mod（`morph-plus`）

本文件由**兼容改写者**写，六项照 `Stronghold-Protocol-Forge-Mods/SKILL.md` §10。**核不到的事实写「未声明」，不编造。**

| # | 项 | 值 |
|---|---|---|
| ① | 原作者 | **B站@伊佐那邪_**（来源：站侧记录 `meta.json` 的 `note` 栏，原文即「作者B站@伊佐那邪_」）。原件 zip 内的 `manifest.json` **未声明 `author`** |
| ② | 许可 | **原件未声明许可**（原件 `manifest.json` / `files.json` 都没有 `license` 键；站侧记录也没有）。本包 `pack.json` 因此写 `NOASSERTION` |
| ③ | 兼容改写者 | **Mo233** |
| ④ | 来源 | 站上投稿编号 **`19ea65909cf6`** · 原投稿名「变形同构体加强mod」 · 原件 `mod.zip` 266,572 B · sha256 `9cd376754e43ea42d6c6781a66d26de9fec5910e410b2f55f801727939adc33f` · 上传于 2026-10-11T17:01:17.087Z · 原件自述版本 `1.1.0`（`manifest.json` 的 `version`；其 `README.md` 标题写的是 `1.0.0` —— **两处不一致，照 `manifest.json` 取**） |
| ⑤ | 改了什么 | 见下「改写对照」 |
| ⑥ | 自带素材来源 | **无** —— 原件自述「不需要 `--assets`：这个包不带任何美术资源」，其 `asset-additions.json` 只有 406 B |

## ⑤ 改写对照（原做法 → 我们的做法 → 为什么）

| # | 原做法 | 我们的做法 | 为什么 |
|---|---|---|---|
| 1 | **安装器型**：`install.mjs`（45,829 B）+ `payload/**`，**整份覆盖** `shared/morph.js`（新增）、`server/match/bondsMeta.js`、`server/match/bot.js`、`server/match/invariants.js`、`server/match/player/acquire.js`、`server/match/player/items.js`、`server/sim/content/support/index.js`、`server/sim/content/support/meta.js` 与六个客户端 / i18n 文件 | **本包不含任何覆盖**，只有 `pack.json` + `PROVENANCE.md` + 两份公告文本。要表达的那件事写成 `pack.json` 的 `behaviour` 一栏：`{ "switch": "morphPairing", "option": "plus" }` | 包**不许整份覆盖引擎文件**。引擎已为这条投稿实现好这一格开关（判据本体 `grantedBondsByMorph`，三处读取点同判），包只需**声明**它 |
| 2 | 自己新建 `shared/morph.js` 作为规则唯一来源，并让四处盟约计数改读它 | 引擎侧已有同一条判据本体，且**三处读取点调的是同一个函数**（prep 的 `pieceBonds`、战斗的 `support/index.unitBonds`、客户端的 `gameLogic/bonds.grantedBonds`） | 引擎能力必须在引擎，包只能消费它（`docs/STANDARD-PACK.md` §五） |
| 3 | 界面加「不占装备格」标签、`EQUIP 1/2` 计数、配对列表说明行 | 本包不携带 UI 与 i18n 覆盖 | 同上 |

**原件文本一字未改**：本包**不收录**原件任何文件。

## 与引擎缺省档的关系

`morphPairing` 的缺省档是 `official`（= 引擎今天的行为：变形同构体**占一个装备位**，少于两件装备就不配对，
并与**每一件** `giveBondId` 装备配对、全部授予）。**本包选的是非缺省档 `plus`**，所以它**必须** `combat: true`
（`BEHAVIOUR_NEEDS_COMBAT`），且会进房间摘要闸门与 golden 语料。

## ⚠ 如实标注：原件四条要求里这一格只实现了**一条**

原件要求四件事，引擎这一版**只实现「配对授予哪些盟约」**：

| 原件要求 | 本包 `plus` 是否实现 |
|---|---|
| **一件**装备就能配对（不再要求两件） | ✅ 已实现 |
| 只取装备行里**最左边**那件能授予盟约的装备 | ✅ 已实现 |
| **不占装备位**（干员装备格满了也能装它） | ❌ **未实现** —— 槽位语义在 `server/match/player/items.js` 与 `gamedata.equipPerChess` 上，是引擎的下一刀 |
| 每名干员**只能装一件**变形同构体（装第二件回 `BAD_TARGET`） | ❌ **未实现** —— 同上 |
| 第三件装备顶掉时**新装备落在它的位置上** | ❌ **未实现** —— 同上 |

引擎那一格的 `effect.plus` 与 `test/morphPairing.test.js` 都写明了这条边界
（`docs/design/mod-layer.md` §28.43.1 的「`morphPairing` 的一条如实边界」）。本包不声称做了未做的那三条。

## 未核到 / 未测

- **未测**：没有在真实对局里验证过盟约人数（本包只做装载验证；行为由引擎侧测试覆盖）。
- 原件自述适用于上游 `0.2.2`；本包**不声明** `game` / `gameVersion`。
