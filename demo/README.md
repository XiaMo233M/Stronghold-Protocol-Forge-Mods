# `demo/` — 已过时的样板包（**不再作为下载或参考样板**）

> **一句话**：这里的三个包是**过时的样板**。它们要展示的能力**引擎已内建**，或已被上游后续实现覆盖。
> **不再对外提供下载，也不再作为照抄的样板。** 请以 [`../packs/`](../packs/README.md) 与引擎文档为准。

## 为什么退役

业主口径（原话）：

> 「在 mod 仓库里的 demo 全部打回，不要放到 mod 站给人下载，这些功能或多或少已经部分实现，已经过时」

也就是说这是**退役**，不是「待修」：不是包坏了，也不是缺署名 —— 是它要展示的能力已经进了引擎。

## 每个包的现状

| 包 | 版本 | 层 | 现状 | 退役理由 |
|---|---|---|---|---|
| [`sp-resource-pack`](sp-resource-pack) | 0.2.0 | C | **已过时** | 样板容器整套（导入 / 校验 / Service Worker 应答 / 服务端准入）**引擎已内建**：`public/js/resources/bundle.js`、`verify.js`、`host.js`、`worker.js`、`service.js`、`common.js`；`public/js/net.js` 已带 `resource-admission` 消息。 |
| [`plugin-pack`](plugin-pack) | 0.3.1 | C | **已过时** | 它展示的挂载面（客户端面板槽位、`i18n`、`notices`）**已由引擎的包接口正式提供**，照抄这份样板已无意义 → 直接读引擎的包格式文档。 |
| [`fanpack-kazdel-rhodes`](fanpack-kazdel-rhodes) | 1.0.0 | B（**会改战斗结果**） | **已过时** | 内容层（`bonds` / `chess` / `garrisons` / `items` / `tokens`）的能力已被上游后续实现覆盖；这份是当时的回移样板。 |

**包本身的内容一字未改**（保留是为了让本仓库的历史与来源说明（[`../NOTICE.md`](../NOTICE.md)）仍能追溯）。
退役只改「对外提供」这一层，不改包。

## 这意味着什么

- **不要**把这些目录压成 zip 装进游戏，也**不要**当模板照抄。
- **要写新包**：读引擎侧的包格式规则（`docs/WORKSHOP.md`、`docs/MOD-SURFACE.md`），
  再读 [`../SKILL.md`](../SKILL.md) 的流程。要看**当前格式**的可抄片段，用
  [`../docs-copy-examples/`](../docs-copy-examples/README.md)，**不要**回头抄这里的旧包。
- **要进 `packs/`**：走 [`../packs/README.md`](../packs/README.md) 的四条收录条件。
- **站上也不提供**：审核站（[`../site/`](../site/README.md)）上对应这三份的记录已**逐个打回**，
  公开列表里看不到、下载口返回 403；记录本身保留，便于追溯。

## 关于这里的「闸门」

验包工具 [`../tools/check-packs.mjs`](../tools/check-packs.mjs) 里 `demo/` 仍是 `gate: true`
（因为文件还在，工具照旧把它们过一遍装载器）。**这个闸门管的是「文件本身还装得上」，
与「对外提供下载」是两件事** —— 前者照旧，后者已停：

```bash
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge            # 三个目录一起看
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs  # 只看收录闸门
```

工具与包都**没有为了这次退役改动判定**（包一字未动；工具只改了注释与显示标签，`gate` 与退出码逻辑没动）。
退役只发生在「对外提供」这一层：审核站记录打回、仓库文档写明不再作为样板。
