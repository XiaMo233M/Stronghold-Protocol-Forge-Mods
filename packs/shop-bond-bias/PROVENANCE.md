# PROVENANCE — 商店刷新盟约装备几率提升mod（`shop-bond-bias`）

本文件由**兼容改写者**写，六项照 `Stronghold-Protocol-Forge-Mods/SKILL.md` §10。**核不到的事实写「未声明」，不编造。**

| # | 项 | 值 |
|---|---|---|
| ① | 原作者 | **B站@伊佐那邪_**（来源：站侧记录 `meta.json` 的 `note` 栏，原文即「作者B站@伊佐那邪_」）。原件 zip 内的 `manifest.json` **未声明 `author`** |
| ② | 许可 | **原件未声明许可**（原件 `manifest.json` / `files.json` 都没有 `license` 键；站侧记录也没有）。本包 `pack.json` 因此写 `NOASSERTION` |
| ③ | 兼容改写者 | **Mo233** |
| ④ | 来源 | 站上投稿编号 **`b293e061b38f`** · 原投稿名「商店刷新盟约装备几率提升mod」 · 原件 `mod.zip` 54,364 B · sha256 `656497c045826de73f839bcef31da68b8b4c772fcc48db2388b178a3f08b90b5` · 上传于 2026-10-11T17:02:35.207Z · 原件自述版本 `1.0.0`（`manifest.json` 的 `version`） |
| ⑤ | 改了什么 | 见下「改写对照」 |
| ⑥ | 自带素材来源 | **无** —— 原件自述「不需要 `--assets`：本包不带任何美术资源」，其 `asset-additions.json` 只有 2 B（空对象） |

## ⑤ 改写对照（原做法 → 我们的做法 → 为什么）

| # | 原做法 | 我们的做法 | 为什么 |
|---|---|---|---|
| 1 | **安装器型**：`install.mjs`（50,484 B）+ `payload/**`，**整份覆盖** `data/items.json`（173,841 B）与 `server/match/bondsMeta.js`、`server/match/pool.js`、`server/match/player/economy.js` | **本包不含任何覆盖**，只有 `pack.json` + `PROVENANCE.md` + 两份公告文本。要表达的那件事写成 `pack.json` 的 `behaviour` 一栏：`{ "switch": "shopBias", "option": "bondBias" }` | 包**不许整份覆盖引擎文件**，也**不许**自带 `data/items.json` 去改数值（`official` / `config` 那几格「刻意没有通道」）。引擎已为这条投稿实现好这一格开关 |
| 2 | 自带一份 `data/items.json`，里面多了 `giveBondBiasOnly`（115 处）等字段来驱动偏向 | **不读那两个字段**：引擎这一格**只读 `giveBondId`** | 我们的 `data/items.json` 里 `giveBondBiasOnly` / `canGiveBond` 都是 **0 处** —— 读一个数据里不存在的字段就是一条永远为假的判据，也就是**假实现**（业主口径「缺源件就不做假实现」，`docs/design/mod-layer.md` §28.43.1） |

**原件文本一字未改**：本包**不收录**原件任何文件，包括那份 `payload/data/items.json`。

## 与引擎缺省档的关系

`shopBias` 的缺省档是 `official`（= 引擎今天的行为：装备槽按棋子阶级份额抽一个阶级，同阶级等概率）。
**本包选的是非缺省档 `bondBias`**，所以它**必须** `combat: true`（`BEHAVIOUR_NEEDS_COMBAT`），
且会进房间摘要闸门与 golden 语料。

## ⚠ 如实标注：原件有三条要求这一格**没有**实现

原件的 `files.json._doc` 与 `payload/data/items.json` 还要求：

1. 「已激活**核心**盟约优先于已激活附加盟约」；
2. 「**骑士戒律**也接入这套偏向」；
3. 靠 `giveBondBiasOnly`（115 处）/ `canGiveBond`（115 处）两个字段驱动偏向。

**三条都没有做**，理由逐字同上（源件不在我们手上 / 数据里没有那两个字段）。
引擎那一格的 `effect.bondBias` 与 `test/shopBias.test.js` 都写明了这一点，本包不声称做了它们。
**本包表达的只是主干**：装备槽偏向这个玩家**已激活**盟约对应的装备，**只偏置、不授予**。

## 未核到 / 未测

- **未测**：没有在真实对局里数过装备槽的出货分布（本包只做装载验证；行为由引擎侧测试覆盖）。
- 原件自述适用于上游 `0.2.4`；本包**不声明** `game` / `gameVersion`。
