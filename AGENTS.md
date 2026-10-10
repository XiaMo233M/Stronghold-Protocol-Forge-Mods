# AGENTS.md

AI 助手（Codex、Claude Code、Cursor、Copilot…）在本仓库的入口。
**这份文件只是索引**：它与 [SKILL.md](SKILL.md) 或引擎文档不一致时，**以后者为准**。

## 这是什么

[Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge) 的工坊包仓库：
一份包一个目录，`pack.json` 是它的唯一入口。三个目录含义不同：

| 目录 | 放什么 | 判定 |
|---|---|---|
| `packs/` | 兼容已完成、验过的包 | **闸门**：必须全部装上 |
| `demo/` | 格式示例（三份真实包） | **闸门**：必须全部装上 |
| `incoming/` | 组员上传、**尚未完成兼容**的 mod 原件 | 只报告，**不拦** |

本仓库**不含游戏本体、不含引擎源码、不含任何游戏素材**。

## 先读

1. **[SKILL.md](SKILL.md)** —— 完整说明书：包格式、层、`api` 与 `game`、素材红线、
   把社区 mod 改写成包的步骤、署名与许可、做不成包的情形。**动手前必须读完。**
2. **[UPLOAD.md](UPLOAD.md)** —— 上传说明：往 `incoming/` 传一个 mod 要带什么、三种上传方式、
   `SOURCE.md` 模板（[`incoming/SOURCE.template.md`](incoming/SOURCE.template.md)）、上传前清单。
3. [NOTICE.md](NOTICE.md) —— 每个包的来源、署名与许可；非商业声明。
4. 引擎侧的权威文档（本仓库只做索引，不复制规则）：
   `docs/WORKSHOP.md`（包格式规则）、`docs/MOD-SURFACE.md`（模组能碰到的全部表面）、
   `docs/design/mod-layer.md`（为什么是这个边界）。

## 硬规则

- **素材红线**：不提交任何《明日方舟》游戏素材（解包出的美术、音频、字体、数据导出物）。
  包可以自带自制素材，但必须逐条写明来源与授权。
- **不抄规则**：包的格式与层级由**引擎的装载器**决定。校验一律调用引擎那一份
  （`tools/check-packs.mjs --engine <引擎目录>`），**不要在本仓库里重写一份校验规则**。
- **只写 `pack.json` 认识的字段**：字段全集是引擎 `shared/workshop.js` 的 `PACK_FIELDS`。
  多写一个键，包就装不上。
- **`id` 必须与目录名一致**（装载器按 `<根>/<包 id>/pack.json` 找包）。
- **只 import 白名单别名**（`@kit/*`、`@sim/*`、`@battle/index.js`，共 11 条），不用相对路径碰引擎。
- **署名与许可不可省**：保留原作者署名、原件许可原样保留（改名为 `NOTICE-原件-*`）、
  写清你改了什么、哪些部分没有接口做不了。
- **非商业**：本仓库及其收录的任何包都不得用于商业用途。
- **不为过闸门而放宽闸门**：校验不过就改包，不改校验。
- **`incoming/` 被拒是正常的**：那里是「还没做兼容」的存放处，**不要**为了让它装上而改引擎或改校验；
  也不要为了让它通过而把 `incoming/` 里没验过的东西搬进 `packs/`。
- **提交**：一个包一个主题；提交信息一行说清做了什么（中文或英文），
  **不加** `Co-Authored-By:` / `Generated with …` 这类署名尾巴。

## 验证

```bash
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge            # 三个目录一起看
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs
```

`packs/` 与 `demo/` 里的包必须全部 `✓`、没有任何 `✗`（退出码 0）；
`incoming/` 只报告、不参与退出码。改了包之后**一定要重跑**。
