# Stronghold-Protocol-Forge-Mods

[Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge) 的**工坊包仓库**：
存放可以直接装进游戏的 mod（工坊包），并给出写包、改包、验包的说明书。

- 游戏本体与引擎源码**不在这里** —— 那是 [Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge)
- **本仓库不含任何游戏素材**（见 [NOTICE.md](NOTICE.md) 与 [SKILL.md](SKILL.md) §5）
- 上游原作：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)

> 非官方同人作品，**禁止商业使用**。《明日方舟》及其素材版权归**鹰角网络**所有。

## 收录的包

| 包 | 版本 | 层 | 许可 | 说明 |
|---|---|---|---|---|
| [`fanpack-kazdel-rhodes`](packs/fanpack-kazdel-rhodes) | 1.0.0 | B（**会改战斗结果**） | 非商业同人作品 | 卡兹戴尔 / 罗德岛两条盟约、包内棋子 20 名、装备 5 件、特质 34 条、召唤物 4 条 |
| [`plugin-pack`](packs/plugin-pack) | 0.3.1 | C | **CC0-1.0**（原作者 Ausevay） | 界面插件：头像选择器、卡面标记、聊天、局域网面板 |
| [`sp-resource-pack`](packs/sp-resource-pack) | 0.2.0 | C | **GPL-3.0-only** | 完整资源包的导入与准入（浏览器缓存分发） |

每个包**以自己的 `pack.json` 里的 `license` 为准**；本仓库整体的许可见 [LICENSE](LICENSE)。

## 怎么装

1. 取到这个包的 **zip**（本仓库的 Releases，或自己把 `packs/<包 id>/` 里的**内容**压成 zip ——
   注意是包内文件放在 **zip 根**，不要再套一层文件夹）
2. 把 zip **拖到**便携包根目录的 `安装工坊包.bat` 上（或 `安装工坊包.bat <包.zip>`）
3. 装好后在游戏的工坊界面能看到它；包落在 `app/workshop/<包 id>/`

卸载就是删掉 `app/workshop/<包 id>/`。

> 装了 `combat` 为真的包，对局结果可能与官方不同 —— 请知情后使用。

## 怎么写 / 怎么改包

**读 [SKILL.md](SKILL.md)** —— 它是这个仓库的完整说明书：包格式、层、`api` 与 `game` 的区别、
素材红线、把一份社区 mod 改写成包的步骤、署名与许可要求、做不成包的情形。

给 AI 助手的入口是 [AGENTS.md](AGENTS.md)（只有索引，规则以 [SKILL.md](SKILL.md) 与引擎文档为准）。

## 验包（引擎升级后也这么做）

```bash
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge
```

用**引擎自己那一份装载器**过一遍本仓库所有包，逐个报出「装上了 / 被拒的理由」。
每个包都要是 `✓`、且没有任何 `✗`（退出码 0）。加 `--json` 给机器读。

## 兼容性

包的闸门是 `api`（模组 API 版本区间），引擎**会强制比对**：引擎当前的 `MOD_API_VERSION` 是 `1`，
所以本仓库的包都声明 `">=1 <2"`。引擎抬到 2 时它们会被**明确拒掉**并说明理由 ——
宁可拒绝，也不要带着过时的行为跑起来。届时本仓库会跟着升级，并在 Releases 里标明对应的引擎版本。
