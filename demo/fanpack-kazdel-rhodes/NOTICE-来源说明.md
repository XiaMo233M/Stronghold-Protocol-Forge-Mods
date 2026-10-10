# NOTICE — 来源、署名与改动范围

本目录是一个**格式转换产物**，不是原创作品。它把社区 mod「fanpack-mod」的内容包部分改写成
《卫戍协议：盟约》（本项目 Stronghold-Protocol）的创意工坊包格式。

## 1. 来源

| 项 | 值 |
|---|---|
| 原件目录 | `E:\destop\卫戍协议罗德岛卡兹戴尔盟约mod`（65 文件 / 7 885 065 字节，未见 LICENSE 文件） |
| 原件本体 | `fanpack-mod/`（安装器 + 载荷；`fanpack-mod/payload/` 是要装进目标树的文件本体） |
| 原内容包 | `fanpack-mod/payload/packs/fanpack/`（`pack.json` + `records/chess/tokens/variants.json` + `art/`） |
| 上游基线 | 原件自述针对上游 **v0.2.1**（`manifest.json` 里 37 条 `original.sha256` 就是该 tag 的 blob） |
| 转换目标 | 本仓库 `E:\destop\harness_1\Stronghold-Protocol`，HEAD `450e9ea8b9e6ba56056809c1ef8d792e44867e56`（已发布的 0.10.0） |
| 转换工具 | `E:\destop\harness_1\_up\fanpack-pack\tools\build-pack.mjs`（可重跑，确定性输出） |
| 自检 | `E:\destop\harness_1\_up\fanpack-pack\tools\selfcheck.mjs` → `out/selfcheck-report.json` |

## 2. 署名与许可（逐字保留原件里的那两句）

原件**没有 LICENSE / NOTICE 文件**（对全部 65 个文件做 `GPL|LICENSE|许可|署名|版权|Copyright` 全文检索：0 命中）。
原件里唯一的署名与许可文字是内容包 `pack.json` 的 `credits` 字段，本包的 `pack.json` 把它**逐字**放进 `license`：

```
非商业同人作品；《明日方舟》及其素材版权归鹰角网络所有。
```

原件 README 里与来源/署名有关的原文（逐字，未改一字）：

- `fanpack-mod/README.md:3-4`：「把「卫戍协议：盟约」上游 **0.2.1**（[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)）装成**带卡兹戴尔 / 罗德岛盟约**的版本：一个可安装、可卸载的覆盖式 mod。」
- `fanpack-mod/README.md:6-7`：「它来自本仓库（`D:\卫戍协议` 的本地分支）里的同人内容包与其引擎挂钩，**不含**干员语音 / 音效、干员时装（皮肤）、口径开关（满练度 / 12 部署位）与低配适配……」
- `fanpack-mod/README.md:64-67`：「`public/assets/**` 是《明日方舟》的素材，版权归鹰角网络 / Yostar 所有，**这个 mod 不分发任何一份**……」

**作者未署名**：原件的 README / `manifest.json` / `pack.json` 里都没有作者名或个人标识
（`manifest.json` 只有 `mod` / `name` / `version` / `app` / `pack` / `upstream` / `generator` / `builtAt`）。
本包 `pack.json` 的 `author` 因此如实写成「原件未署名」，不代填名字。

逐字复制的原件说明文件（未改一字，只换了文件名以便与本包格式区分）：

- `NOTICE-原件-README.md` ← `fanpack-mod/README.md`
- `NOTICE-原件-内容包-README.md` ← `fanpack-mod/payload/packs/fanpack/README.md`

## 3. 改动范围（只做格式转换，不改内容）

| 做了什么 | 没做什么 |
|---|---|
| 把 `records.json` 的 `bonds` / `items` / `garrisons` 三个节拆成同名内容文件；`chess` / `tokens` 从各自文件里取出 `chess` / `tokens` 表 | 没有改任何一条记录的**内容**（71 条新记录与原件逐字相同，自检 C-08） |
| 删掉 `_doc` 说明键（它不是记录）与 `records.assets` 节（它的作用换成 `pack.json` 的 `bondIcons` / `itemIcons`） | 没有把 `assets` 那 6 张图改名或重画（逐字节复制） |
| 官方 id 的记录只保留「相对上游 v0.2.1 的真实改动字段」，并在 `overrides` 里逐条声明 | 没有把 0.2.1 时代的整条官方记录写进包（那会回退我们 0.10.0 自己改过的字段，自检 C-11） |
| `art/index.json` 的 `key → 文件` 映射译成 `bondIcons`（2 条）+ `itemIcons`（4 条），文件放进 `assets/` | 没有新增、也没有下载任何游戏素材 |
| 原件对官方数据的 4 处修改里，能表达的 4 处转成 overrides 补丁；不能表达的 115 处**刻意不转**（见第 4 节与主报告缺口清单） | 没有为了让包「看起来能用」而写任何 schema 里不存在的键 |
| 原件 README 与内容包 README 逐字复制进本目录 | 没有发布 release、没有进发行版、没有改动被转换的仓库（自检 C-15 用 HEAD + git status + `git hash-object` 三重核对） |

## 4. 这个包**没有**带过来的东西（一句话版）

原件是「A 内容 + B 服务端逻辑 + C 客户端界面」三样都有、并且直接改官方数据文件的覆盖式 mod。
本包只带了 **A 内容**那一半（外加两张图标表）。**B 层**（包内 kit、盟约/特质效果、引擎钩子、商店偏向）与
**C 层**（两个新屏幕、语言词条）没有接口可以落，逐条写在
`E:\destop\harness_1\_up\fanpack-pack\README-改写说明.md` 与 `E:\destop\harness_1\_up\fanpack-rewrite-report.md` 的缺口清单里。
