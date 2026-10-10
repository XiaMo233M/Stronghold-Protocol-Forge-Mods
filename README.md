# Stronghold-Protocol-Forge-Mods

[Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge) 的**工坊包仓库**：
存放可以装进游戏的 mod（工坊包），并给出写包、改包、验包的说明书。

- 游戏本体与引擎源码**不在这里** —— 那是 [Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge)
- 上游原作：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)
- **本仓库不含任何游戏素材**（见 [NOTICE.md](NOTICE.md) 与 [SKILL.md](SKILL.md) §5）

> 非官方同人作品，**禁止商业使用**。《明日方舟》及其素材版权归**鹰角网络**所有。

## 三个目录，三种含义

| 目录 | 放什么 | 判定 |
|---|---|---|
| [`packs/`](packs) | **兼容已完成、验过的包** —— 能直接装 | **闸门**：里面必须全部装上 |
| [`demo/`](demo) | **格式示例**：三份真实包，给人照抄的样板 | **闸门**：同样必须全部装上 |
| [`incoming/`](incoming) | **组员上传、尚未完成兼容**的 mod 原件 | 只报告，**不拦**（被拒是正常的） |

流程是一条直线：

```
incoming/<mod>  ──►  读来源说明、判断哪些部分有接口  ──►  改写成工坊包  ──►  packs/<包 id>
```

- **想上传一个 mod** → 先读 **[UPLOAD.md](UPLOAD.md)**（上传说明：要传什么、三种上传方式、
  照抄的 `SOURCE.md` 模板、上传前清单）
- **不想碰 git？** 本仓库自带一个**上传站**（[`site/`](site)）：网页上填「mod 名 + 备注」传 zip →
  维护者下载跑测试 → 名称与内容审过 → 自动上线到公开列表。部署见 [`site/README.md`](site/README.md)
- 收录的条件 → [`packs/README.md`](packs/README.md)
- 上传区的规则 → [`incoming/README.md`](incoming/README.md)

> `packs/` 目前是**空的** —— 还没有包走完兼容流程。

## `demo/` 里的三份示例

| 包 | 版本 | 层 | 许可 |
|---|---|---|---|
| [`demo/fanpack-kazdel-rhodes`](demo/fanpack-kazdel-rhodes) | 1.0.0 | B（**会改战斗结果**） | 非商业同人作品 |
| [`demo/plugin-pack`](demo/plugin-pack) | 0.3.1 | C | **CC0-1.0**（原作者 Ausevay） |
| [`demo/sp-resource-pack`](demo/sp-resource-pack) | 0.2.0 | C | **GPL-3.0-only** |

每个包**以自己的 `pack.json` 里的 `license` 为准**；原件自带的许可与来源说明原样随包。
本仓库整体的许可见 [LICENSE](LICENSE)。

## 怎么装一个包

1. 把 `packs/<包 id>/` 里的**内容**压成 zip（包内文件放在 **zip 根**，不要再套一层文件夹）
2. 把 zip **拖到**便携包根目录的 `安装工坊包.bat` 上（或 `安装工坊包.bat <包.zip>`）
3. 装好后包落在 `app/workshop/<包 id>/`，在游戏的工坊界面能看到它

卸载就是删掉 `app/workshop/<包 id>/`。

> 装了 `combat` 为真的包，对局结果可能与官方不同 —— 请知情后使用。

## 怎么写 / 怎么改包

**读 [SKILL.md](SKILL.md)** —— 这个仓库的完整说明书：包格式、层、`api` 与 `game` 的区别、
素材红线、把一份社区 mod 改写成包的步骤、署名与许可要求、做不成包的情形。

给 AI 助手的入口是 [AGENTS.md](AGENTS.md)（只有索引，规则以 [SKILL.md](SKILL.md) 与引擎文档为准）。

## 验包

```bash
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge
```

用**引擎自己那一份装载器**过一遍三个目录，逐个报出「装上了 / 被拒的理由」。
`--root packs` 可以只看某一个目录；`--json` 给机器读。退出码非 0 表示 **`packs/` 或 `demo/` 里有包装不上**。

## 兼容性

包的闸门是 `api`（模组 API 版本区间），引擎**会强制比对**：引擎当前的 `MOD_API_VERSION` 是 `1`，
所以这里的包都声明 `">=1 <2"`。引擎抬到 2 时它们会被**明确拒掉**并说明理由 ——
宁可拒绝，也不要带着过时的行为跑起来。届时本仓库会跟着升级。
