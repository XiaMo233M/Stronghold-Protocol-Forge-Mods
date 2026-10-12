# PROVENANCE — 装备拆卸mod（`unequip`）

本文件由**兼容改写者**写，六项照 `Stronghold-Protocol-Forge-Mods/SKILL.md` §10。**核不到的事实写「未声明」，不编造。**

| # | 项 | 值 |
|---|---|---|
| ① | 原作者 | **B站@伊佐那邪_**（来源：站侧记录 `meta.json` 的 `note` 栏）。原件 zip 内的 `manifest.json` / `pack.json` **均未声明 `author`** —— 站侧 `meta.json` 另有一个 `author` 键，值为空串 |
| ② | 许可 | **原件未声明许可**（原件 `manifest.json` / `pack.json` 都没有 `license` 键；站侧记录也没有）。本包 `pack.json` 因此写 `NOASSERTION` |
| ③ | 兼容改写者 | **Mo233** |
| ④ | 来源 | 站上投稿编号 **`79de9ff03518`** · 原投稿名「装备拆卸mod」 · 原件 `mod.zip` 248,225 B · sha256 `d6437d1139a919726964c9dcc501b55b2429763da46a7bedf54d7e60e3614b86` · 上传于 2026-10-11T17:44:32.545Z · 原件自述版本 `1.1.0`（`pack.json` 的 `version`）· 站侧 `homepage`：https://github.com/yznx09/Stronghold-Protocol-Rhodes-Kazdel-Mod |
| ⑤ | 改了什么 | 见下「改写对照」 |
| ⑥ | 自带素材来源 | **无** —— 原件与本体都不含图片 / 音频 / 字体 / Spine 素材（原件的 `asset-additions.json` 与载荷清单里没有素材条目） |

## ⑤ 改写对照（原做法 → 我们的做法 → 为什么）

| # | 原做法 | 我们的做法 | 为什么 |
|---|---|---|---|
| 1 | **安装器型**：`install.mjs`（45,829 B）+ `payload/**`，按 `pack.json` 的 `copy` 清单**整份覆盖** `shared/protocol.js`、`server/match/match/intents.js`、`server/match/player/items.js`、`shared/morph.js`、`shared/dataVariants.js` 与六个客户端文件，外加四份 i18n 表 | **本包不含任何覆盖**，只有 `pack.json` + `PROVENANCE.md` + 两份公告文本。要表达的那件事写成 `pack.json` 的 `behaviour` 一栏：`{ "switch": "unequip", "option": "allow" }` | 包**不许整份覆盖引擎文件**（`docs/WORKSHOP.md` §1.1 六格「刻意没有通道」+ `docs/design/mod-layer.md` §28.43）。引擎已为这条投稿实现好这一格开关，包只需**声明**它 |
| 2 | 自己新增 `g.unequip {itemUid}` 意图（改协议表 + 意图路由 + `PlayerState.unequip()`） | **不新增协议消息**：`g.unequip` 由引擎实现（`docs/design/mod-layer.md` §28.43.2 点名了五处落点，`PROTOCOL_VERSION` 不动） | 引擎能力必须在引擎，包只能消费它（`docs/STANDARD-PACK.md` §五）。包给不出模块、文件、路径或数字 |
| 3 | 客户端「卸下」按钮 + i18n 文案 | 引擎侧 `unequipAllowed()` 决定画不画按钮；本包不携带 UI 与 i18n 覆盖 | 同上；界面文案由引擎的 i18n 表管 |

**原件文本一字未改**：本包**不收录**原件任何文件，所以没有「哪份文件归谁」的歧义；原件里的
`README` / `来源说明.md` 未被引用，也就没有被改动。

## 与引擎缺省档的关系

`unequip` 的缺省档是 `official`（= 引擎今天的行为：装备装上后只能靠精英化 / 合成 / 卖出离开）。
**本包选的是非缺省档 `allow`**，所以它**必须** `combat: true`（`BEHAVIOUR_NEEDS_COMBAT`），
且会进房间摘要闸门与 golden 语料。不声明 `behaviour` 的包一个字节都不受影响。

## 未核到 / 未测

- **未取回**原件 zip 内的 `来源说明.md`（3,772 B）—— 它可能另有署名或许可声明。本地只取回了
  `meta.json` 与 `pack.json` 两份。**未据此推断**，也未用它补 ① ② 两项。
- **未测**：没有在真实对局里跑过「卸下」操作（本包只做装载验证；行为由引擎侧测试覆盖）。
