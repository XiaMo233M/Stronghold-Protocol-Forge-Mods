# Stronghold-Protocol-Forge-Mods

[Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge) 的**工坊包仓库**：
存放可以装进游戏的 mod（工坊包），并给出写包、改包、验包的说明书。

- 游戏本体与引擎源码**不在这里** —— 那是 [Stronghold-Protocol-Forge](https://github.com/XiaMo233M/Stronghold-Protocol-Forge)
- 上游原作：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)
- **本仓库不含任何游戏素材**（见 [NOTICE.md](NOTICE.md) 与 [SKILL.md](SKILL.md) §14）

> 非官方同人作品，**禁止商业使用**。《明日方舟》及其素材版权归**鹰角网络**所有。

## 三个目录，三种含义

| 目录 | 放什么 | 判定 |
|---|---|---|
| [`packs/`](packs) | **兼容已完成、验过的包** —— 能直接装 | **闸门**：里面必须全部装上 |
| [`demo/`](demo) | **已过时的样板**（三份旧包，**不再对外提供、不要照抄**） | 退役：说明见 [`demo/README.md`](demo/README.md) |
| [`incoming/`](incoming) | **组员上传、尚未完成兼容**的 mod 原件 | 只报告，**不拦**（被拒是正常的） |

另有一个**不是包**的目录：[`docs-copy-examples/`](docs-copy-examples/README.md) 只放文档里引用的
**可抄片段**（`notices` 的形状等），不参与任何闸门 —— 想照抄当前格式看它，别回头抄 `demo/`。

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

> `packs/` 目前是**空的** —— 这个仓库里还没有包走完兼容流程。
> 注意这是**两回事**：`packs/` 是**正式收录区**（进这里才算被本仓库收录），
> 而**站上已经发布的兼容包是另一份清单** —— 两者不互相同步。

## `demo/` 里的三份样板 —— **已过时，不再对外提供**

这三份旧包**退役**了：它们要展示的能力**引擎已内建**，或已被上游后续实现覆盖。
**不要拿来装、不要拿来照抄**；逐包理由见 [`demo/README.md`](demo/README.md)。

> 审核站上对应这三份的记录已**逐个打回**：公开列表里看不到，下载口返回 403（记录保留，可追溯）。
> 包本身的内容**一字未改**，保留只为让本仓库的来源与署名说明（[NOTICE.md](NOTICE.md)）仍能追溯。

| 包 | 版本 | 层 | 许可 |
|---|---|---|---|
| [`demo/fanpack-kazdel-rhodes`](demo/fanpack-kazdel-rhodes) | 1.0.0 | B（**会改战斗结果**） | 非商业同人作品 |
| [`demo/plugin-pack`](demo/plugin-pack) | 0.3.1 | C | **CC0-1.0**（原作者 Ausevay） |
| [`demo/sp-resource-pack`](demo/sp-resource-pack) | 0.2.0 | C | **GPL-3.0-only** |

每个包**以自己的 `pack.json` 里的 `license` 为准**；原件自带的许可与来源说明原样随包。
本仓库整体的许可见 [LICENSE](LICENSE)。

## 怎么装一个包

1. 把 `packs/<包 id>/` 里的**内容**压成 zip：包内文件放进**一个顶层目录**里，目录名就用**包 id**
   （不要比这一层再多套一层文件夹）。压完检查 `pack.json` 的路径：
   **必须是 `<包 id>/pack.json`** —— 顶层目录 + 文件名，也就是「深度为 2」。
   **一包一 zip**：不要把 `packs/<包 id>/` **整个目录**再压进去（那会变成 `<包 id>/<包 id>/pack.json`，
   装载器读不到 `pack.json`）。
2. 把 zip **拖到**便携包根目录的 `安装工坊包.bat` 上（或 `安装工坊包.bat <包.zip>`）
3. 装好后包落在 `app/workshop/<包 id>/`，在游戏的工坊界面能看到它

**目录名必须等于 `pack.json` 的 `id`**，否则装载器整包跳过（引擎会报 `PACK_ID_MISMATCH`）。

卸载就是删掉 `app/workshop/<包 id>/`。

> 装了 `combat` 为真的包，对局结果可能与官方不同 —— 请知情后使用。

## 怎么写 / 怎么改包

**两份说明书的分工，先看清再读**：

| 文件 | 给谁 | 讲什么 |
|---|---|---|
| [SKILL.md](SKILL.md) | **包作者** | 包格式、层、`api` 与 `game`、四个沉默的坑（未知顶层键 / `api` 写成数字 / `content` 没声明 `chess` / 未声明的通道）、`notices` 公告与鸣谢、「有更好的逻辑就用我们的」、面板 `ctx`、署名纪律（含「哪份文件归谁」）、工作流、做不成包的情形、术语约定 |
| [AGENTS.md](AGENTS.md) | **维护者 / AI agent** | 五条收录闸门（含「带上真实功能」「`combat` 要标注清楚」）、审核站与兼容包发布流程、操作纪律（批准类端点绝不批量调、绝不打印凭据…） |

两份**不重叠**：一份讲怎么写，一份讲怎么审与怎么发。都读的话，先读 SKILL.md。

包格式与层级的**最终依据是引擎**（本仓库只做索引）—— 冲突时以引擎代码与
`docs/WORKSHOP.md` / `docs/MOD-SURFACE.md` / `docs/design/mod-layer.md` 为准。

> 文档里引用的**最小可抄片段**在 [`docs-copy-examples/`](docs-copy-examples/README.md)（不是包，不参与闸门）。

## 验包

```bash
node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge
```

用**引擎自己那一份装载器**过一遍三个目录，逐个报出「装上了 / 被拒的理由」。
`--root packs` 可以只看某一个目录；`--json` 给机器读。
退出码非 0 表示 **`packs/` 或 `demo/` 里有包装不上**（工具把两者都当闸门，这次退役没有改动工具）。
`demo/` 已**不再对外提供**（见 [`demo/README.md`](demo/README.md)）—— 闸门管的是「文件还装得上」，不是「可下载」。

## 兼容性

包的闸门是 `api`（模组 API 版本区间），引擎**会强制比对**：引擎当前的 `MOD_API_VERSION` 是 `1`，
所以这里的包都声明 `">=1 <2"`（`"1.x"` / `"1"` / `"^1"` 这类写法同样合法）。
引擎抬到 2 时它们会被**明确拒掉**并说明理由 —— 宁可拒绝，也不要带着过时的行为跑起来。
届时本仓库会跟着升级。

## 什么样的包会被收发

- **要带上真实功能**：装上会改变某项游戏内行为（数据 / 界面 / 服务端任一层）才收；
  自述 `documentation-only` / 只读参考 / 只放 JSON 与说明面板的**不予上架**，等它带上真实功能再投
  （见 [AGENTS.md](AGENTS.md) §4）。
- **会改对局结果的包要标注清楚**：`combat: true` 的包**不另设闸门**（mod 由房主建房间时自己选装），
  但**必须在包自述里讲明「会影响对局结果」**；不标才是问题（见 [SKILL.md](SKILL.md) §4）。
