# `docs-copy-examples/` — 只在文档里被引用的**可抄片段**

这里**不是包**，也不参与任何闸门，**刻意不放在 `packs/` 底下**
（`packs/` 的装载闸门只认 `<包 id>/pack.json`，放进去会被当成一个装不上的包）。
它只放几份**照抄用的最小片段**，省得作者为了看一眼正确形状去翻已退役的 `demo/` 或别人的包。

| 片段 | 抄去哪里 | 说明 |
|---|---|---|
| `notices/pack.notices.json` | 粘进你自己的 `pack.json`（顶层那个 `notices` 键） | `notices` 的形状（见 [`../SKILL.md`](../SKILL.md) §5.4） |
| `notices/notice/announcement.json` | 你包里的 `notice/announcement.json` | 公告文件的形状 |
| `notices/notice/credits.json` | 你包里的 `notice/credits.json` | 鸣谢文件的形状（`url` 只能是 `https://`） |

**为什么不放在 `demo/` 里**：`demo/` 是**已退役的样板**，明确写了「不要照抄」。
这里的三份是**当前格式**的片段，跟着本文档一起维护。

**为什么不是完整包**：完整的正确例子请读引擎侧 `docs/WORKSHOP.md` 的示例，
或照着 [`../SKILL.md`](../SKILL.md) §6 的目录表自己搭。这里刻意只放「一个键 / 一份文件」的形状，
免得再多一份会过时的完整包。
