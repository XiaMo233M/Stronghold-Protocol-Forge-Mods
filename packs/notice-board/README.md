# 服务器公告板（notices）

**这是一个真功能的包**：装上它，服务器的**公告**与**鸣谢**就出现在管理器的公告面板里。

## 它做什么

- 声明 `notices` 这两个成员（`pack.json.notices`），每份是**包内相对 `.json` 路径**：
  - `notice/announcement.json` —— 一条公告：`{ version, date, summary, sections: [{ name, items[] }] }`
  - `notice/credits.json` —— 一张署名表：`[{ name, note, url }]`
- 装载期：服务器把各包的公告**并进** `/data/notices.json` 的合并体（**追加**语义 —— 不会顶掉引擎自己的
  公告，也不会顶掉别的包的公告；引擎那一份是从 `CHANGELOG.md` 生成的）。
- 展示面：标题屏的「公告」入口（`NoticesModal`）读到合并体；任何声明了 `data: ["notices"]` 的面板也能用
  `ctx.data.get('notices')` 读到同一份内容。
- 上限（引擎侧，写包时按它控制篇幅）：合并体最多 8 条公告 / 40 条鸣谢；单条公告最多 12 节、每节 40 条、
  每条 200 字、摘要 600 字。本包目前 1 条公告、4 节、22 条。

## 它不做

- 不改对局、不带素材、服务端零代码（`notices` 是**纯文本声明**，不执行）。
- 不是「大厅公告板」的替身：管理器里公告的落点就是**标题屏公告弹窗**（与引擎自带公告共用一处），
  没有第二个大厅滚动公告位 —— 这一点在「做不成包/引擎原生」的说明包（native-ui-ref）里也写了。
- 不提供推送/已读/红点这类产品功能。

## 改文本

编辑 `notice/announcement.json`（保持同一个形状与上限）即可；字节变了包身份哈希就变，
按正常流程更新即可。公告文本来源见 `NOTICE-来源说明.md`。

## 安装

拷进管理器的工坊目录（`workshop/notice-board/`）并重启；`/data/notices.json` 里就能看到
本包的两栏（带 `pack: "notice-board"` 标记）。
