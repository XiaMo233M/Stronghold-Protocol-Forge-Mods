# PROVENANCE — srv-notice（服务器公告 · notices 兼容版）

本包的**来源、署名与改动**。六项按仓库规矩逐条列，缺一项就算没写。

## 1. 原作者

**jingjiangze** —— Stardust 版「服务器公告」包（`srv-notice` 2.0.0，包内 `pack.json` 的 `authors` 就写着这一位）。

## 2. 原件的许可

**CC0-1.0**（原件 `pack.json` 的 `license` 原文；本包原样沿用，未抬高也未收紧）。

## 3. 兼容改写者

本仓库（XiaMo233M / Stronghold-Protocol-Forge-Mods）的维护者。改写只做**契约适配**，公告文字一字未改。

## 4. 来源

站上记录 `531e1d90c4f5`（SP MODSITE），原文件保留在采集 staging 里，未改一个字节：

- 原件 `pack.json` 的 `target` 是 `"stardust"`，公告字段叫 `announcements`
  ⇒ 本引擎按设计把它归进 `foreign`、**只认识不装载**（`server/workshop.js` 的 `target === 'stardust'` 那一支，
  DESIGN §28.46），所以原件在本引擎下 `packsLoaded` 恒为 `[]`。

## 5. 改了什么

| 原件的写法 | 本包的写法 | 为什么 |
|---|---|---|
| `"type": "mod"` | 删掉 | 不是本引擎 `PACK_FIELDS`（38 键闭集）里的键；多写一个键整包被拒（`PACK_UNKNOWN_FIELD`） |
| `"target": "stardust"` | 删掉 | 这一格让引擎把包判定为「Stardust 宿主的声明型包」，不进装载集合 |
| `"app": ">=0.2.0"` | 删掉，改 `"game": "0.2.x"` | 本引擎的对应键是 `game`（原件 `app` 是 Stardust 的写法） |
| `"capabilities": ["announcements"]` | 删掉 | 本引擎的能力由「声明了哪些表面」表达，没有这一格 |
| `"englishName"` | 删掉 | 不是 `PACK_FIELDS` 的键；英文名要进 `i18n/`（本包没有，故不编造） |
| `"announcements": [ { title, date, paragraphs } … ]` | `"notices": { "announcement": …, "credits": … }` + 两份 `.json` | 本引擎的公告是 `notices` 表面（DESIGN §28.15）：**正文落文件**（进身份哈希、可被工具检查），且一个包只有**一条**公告 |
| 两条公告（各自 `title` / `paragraphs`） | 同一条公告的两个 `sections`（`name` = 原 `title`，`items` = 原 `paragraphs`） | 引擎的公告体是 `sections[]`；两条合一不丢内容 |
| —（原件没有署名表） | `notice/credits.json` 写原作者 | 本引擎的 `credits` 是署名的落点；原作者与许可如实记上 |

**没有做的**：不给包加任何功能、不改公告文字、不补 `i18n`（原件没有英文正文，就不编一份）。
原件里的两句「本包的文字在 pack.json 里」在本包改为指向 `notice/announcement.json`（位置变了，事实仍准确）。

## 6. 包自带素材的来源

**本包不含任何素材**：没有图片、音频、字体、Spine，也没有 `.spresources` 容器 —— 全部内容就是三份文本文件
（`pack.json` + 两份 `notice/*.json`）加本文件。公告文字来自原件，版权与许可归原作者（见第 1、2 项）；
本仓库与发布者不主张这些文字的任何权利，仅供非商业的学习与个人娱乐使用。
