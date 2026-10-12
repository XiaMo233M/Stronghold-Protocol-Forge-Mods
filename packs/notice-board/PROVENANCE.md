# 署名与来源 · PROVENANCE

> 原作者与兼容改写者**分开列出，不抹掉任何一方**。原件未署名的一律写**「原件未署名」**，不代填；
> 许可照实抄自包内 `pack.json` 的 `license` 字段，未改动。

## 包

| 项 | 值 |
|---|---|
| 包 id | `notice-board` |
| 版本 | `1.0.0` |
| 名称 | 服务器公告板（notices） |
| 目录名 = 包 id | 是 |
| 顶层目录 | **无** —— 本成品是**上传形状**：`pack.json` 直接落在 zip 根层。装载器按 `<workshop 根>/<包 id>/pack.json` 找包，那一层目录名取 `pack.json.id` = `notice-board`，由装载器自己定，不写进 zip。 |

## 原作者

`jingjiangze` —— 见包内 `pack.json` 的 `author` 字段。包内 `NOTICE-来源说明.md`
「原件是什么、从哪来」一节自述：「本包是**原作者自己**把 fork 的公告文本搬进这个机制的一版，
不是第三方改写」。站点投稿备注（`submissions/7e037cc96cb5`）同写「原作者：jingjiangze
（本包与来源为同一方）」。**署名完整，不需要代填。**

## 许可

包内 `pack.json.license` 原文（**一字未改**）：

> `CC0-1.0（公告文本与包本体；文本来源与两栏结构见 NOTICE-来源说明.md）`

包内 `NOTICE-来源说明.md`「许可」一节另自述：上游 fork 仓库整体以 `GPL-3.0-or-later` 分发，
本包不再分发其代码、只带转写文本；《明日方舟》及其素材版权归鹰角网络 / Yostar，本包不含也不主张。

## 兼容改写者

`Mo233`

## 来源

- 站点投稿 **`7e037cc96cb5`**（区 `submissions`）。原件 zip **7645 字节**，sha256（zip）
  `c4727d492d1d8e9ee47e28b731d29d08009df3f24698866039b820597da5704c`
  —— 与站点 `meta.json` 记录的 `sha256` 逐字相同（源件只读，未改动一个字节）。
- 包内声明的文本来源：`https://github.com/jingjiangze/stronghold-server`
  （fork of `sganggs/Stronghold-Protocol`）的 `data/announcements.json`，2026-10-11 快照
  （HEAD 9a8127d 一带）。该 URL 写在包内 `NOTICE-来源说明.md` 与 `notice/credits.json` 的 `url` 字段。
- 包内 `pack.json` **没有** `homepage` 字段；站点记录里的 `homepage` 是投稿面的字段，不是包内声明。

## 改了什么

**原件一个字节都没改**（逐文件 sha256 见下）。本次适配只做两件事：

1. **包根形状**：站点上传面只认 `pack.json` 在 zip 根，站点上**已发布**的包也全是这一形状
   （`/var/lib/sp-modsite/compat/*/mod.zip` 逐个查看：`pack.json` 都在根层）。所以成品按
   **上传形状**打包 —— zip 根层直接是 `pack.json` / `README.md` / `NOTICE-来源说明.md` / `notice/`，
   **不套一层目录**。
2. **补 `PROVENANCE.md`**：本文件。
3. **契约核对**：`api: ">=1 <2"` 与引擎 `MOD_API_VERSION = 1` 相符；`game: "0.2.x"` 是合法区间。
   两处**都不需要改**。

原作者自己做过的改动（本次适配**照抄不改**）：把 fork 的三条公告转写进 `pack.json.notices`
这条引擎正规通道，段落按句读切成 ≤200 字的条目，版本写 `1`、日期取快照日 `2026-10-11`，
末尾自加 1 节「关于本公告包」（2 条）。

## 包内文本与实现的核对

- ✅ **`notices` 形状相符**：`shared/workshop.js:1044-1045`（恰好两个成员）、`:1053`
  （只认 `announcement` / `credits`）、`:1067`（必须是包内相对 `.json` 路径）。本包声明的
  `notice/announcement.json` / `notice/credits.json` 逐条对上。
- ✅ **`notices` 是贡献项**：`shared/workshop.js:1645` 把 `notices` 列进非内容贡献名单，
  所以这个零内容包不会被判 `EMPTY_PACK`。实测：删掉 `notices` 键 → `EMPTY_PACK`；原样 → 装载通过。
  这正是「真功能包」而不是「documentation-only」的机器判据。
- ✅ **追加语义**：`server/notices.js:154-233`。`:157` 从 `[...engine.announcements]` 起手再逐包 `push`，
  `:227-231` 的上限只丢**引擎那一端最旧**的条目。
- ✅ **上限相符**：包内 `README.md` 写的「8 条公告 / 40 条鸣谢；12 节、每节 40 条、每条 200 字、
  摘要 600 字」与 `server/notices.js:19` 的 `NOTICE_LIMITS` 逐项相同。
- ✅ **展示面相符**：`/data/notices.json` 确实由 `server/index.js:154-155` 送出；
  `NoticesModal` 确实存在（`public/js/ui/notices.js:77`）。
- ✅ **面板数据口相符**：`notices` 在 `CLIENT_PANEL_DATA_TABLES` 里（`shared/workshop.js:311`），
  所以 `README.md` 说「声明了 `data: ["notices"]` 的面板也能读到同一份」成立。
- ⚠️ **一处不符（保持原样未改）**：包内 `NOTICE-来源说明.md`「素材从哪来」一节称
  `content: []`，但 `pack.json` 里**没有** `content` 键。两者效果相同（没有 `content` 就等于不带内容
  文件），但该节点名的键在包内并不存在。按要求**只写在这里，包内文件一字未动**。
- 注（引擎侧问题，与本包无关）：`CLIENT_PANEL_DATA_TABLES` 的字面量是 **14 项**，而
  `CLIENT_MAX_PANEL_DATA_TABLES = 13`（`shared/workshop.js:296`，该处注释也写「今天是 13 张」）。
  一个面板因此**读不全**这 14 张表。本包不声明 `client`，不受影响 —— 只作为观察记录。

## 自带素材来源

**无。** zip 内 5 个文件全是文本（`pack.json` / `README.md` / `NOTICE-来源说明.md` /
`notice/announcement.json` / `notice/credits.json`），不含任何图片 / 音频 / 字体 / 解包数据；
`combat: false`，服务端零代码（`notices` 是纯文本声明，不执行）。

## 校验用哈希（改动前 / 改动后）

| 文件 | 字节 | 改动前 sha256（= 原件） | 改动后 sha256 |
|---|---|---|---|
| `pack.json` | 847 | `5eb858d1a6e928202b1d8ce38b14b53ff6cda53c19523e36ef9e4b10de419882` | **同左（未改）** |
| `README.md` | 1967 | `a8d7dfb5327a8232c47e8b5cd4a98d11d8e0e61d0543b8bbfb59740503bc4a7b` | **同左（未改）** |
| `NOTICE-来源说明.md` | 2356 | `fdcfed6bd91003246091cc84a427d4f29d3270f3813718851f753dd7900a9b9a` | **同左（未改）** |
| `notice/announcement.json` | 6442 | `0ea9b84ad442d732163f96e785fef00c9195b8e69825dc78c3b0dfe6df3f3059` | **同左（未改）** |
| `notice/credits.json` | 253 | `cfa54332b28bc7b5b42b71a134a9eb69c5b635e96793ad859b572fea66336671` | **同左（未改）** |

`PROVENANCE.md` 是本次**新增**（本文件），不参与上表 —— 它的摘要写进本文件必然自相矛盾。

## 实测证据（本次适配跑的）

- **干净 workshop 根**（根内只有 `notice-board/` 这一个包）装载：
  `0 error(s), 0 warning(s)` / `VALID: the engine accepts this content.`
- **追加语义实测**：合并体 = 引擎 6 条公告（`pack: null`）+ 本包 1 条（`pack: "notice-board"`）
  + 另一包 1 条；鸣谢 = 引擎 3 条 + 本包 1 条 + 另一包 1 条。**没有任何一条被顶掉。**
- **22 条逐条长度实测**：全部 ≤200 字（最长 157 字），**没有一条被丢弃**。
  注意引擎对超限条目的行为是**整条丢弃**（`server/notices.js:28-33` 的 `cleanText` 返回 `null`），
  **不是截断** —— 所以「每一条都留在上限内」是必须的，本包做到了。
