# NOTICE-来源说明

## 原件是什么、从哪来

- **文本原件**：`jingjiangze/stronghold-server`（fork of sganggs/Stronghold-Protocol）的
  `data/announcements.json`（2026-10-11 快照，3 条公告：10 月 11 日更新与维护致歉 / 0.2.2／0.2.3
  累计更新 / 欢迎游玩），以及该 fork 的公告展示位（大厅与标题屏）。仓库：
  <https://github.com/jingjiangze/stronghold-server>
- 展示机制原件：管理器（Forge）自己的 `notices` 表面（`pack.json.notices` → `/data/notices.json` 合并体
  → 标题屏公告弹窗）。本包是**原作者自己**把 fork 的公告文本搬进这个机制的一版，不是第三方改写。

## 它改了什么

**没有改引擎，也没有改文本内容。** 只做搬运与适配：

| 件 | 说明 |
|---|---|
| `notice/announcement.json` | fork 三条公告的转写：段落按**句读**切成 ≤200 字的条目（引擎上限），标题保留为节名；版本写 `1`、日期取快照日 `2026-10-11` |
| `notice/credits.json` | 一条鸣谢（文本来源：fork 的 announcements.json），带 https 链接 |
| `README.md` | 机制与边界说明 |

末尾多了 1 节「关于本公告包」（2 条），交代这 22 条文本由本包提供、删包即改回去 —— 这一段是本包自己写的。

## 做不了的部分

- **大厅滚动公告位**：fork 的公告有大屏展示位；管理器的公告载体是**标题屏公告弹窗**与
  `/data/notices.json`（面板可读）。要一个「大厅公告板」得先有那一格界面宿主，不是内容包能开的。
- **服务端推送 / 已读状态 / 红点**：属产品功能，与管理器自己的公告机制一致（纯静态合并体）。

## 素材从哪来

**没有任何素材。** 没有图标、音频、字体、解包数据；`content: []`、`combat: false`、
服务端零代码（`notices` 是纯文本声明，不执行）。

## 许可

- 公告文本：作者同为本包作者（fork 运营者），本包以 **CC0-1.0** 发布（随改随发；与上一份
  「服务器公告（Stardust）」包的许可口径一致）。
- fork 仓库整体以 GPL-3.0-or-later 分发；本包不再分发其代码，只带转写文本。
- 《明日方舟》及其素材版权归鹰角网络 / Yostar 所有；本包不含、也不主张任何此类素材。
