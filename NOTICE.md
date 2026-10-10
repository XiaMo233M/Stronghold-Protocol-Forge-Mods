# NOTICE — 来源、署名与许可

本仓库是 **Stronghold-Protocol-Forge** 的工坊包仓库，是非官方同人作品。
**禁止任何形式的商业使用。**《明日方舟》及其素材、名称与商标版权归**鹰角网络**所有；
本仓库与鹰角网络无任何关系。

## 本仓库整体

- 代码与文档：**GPL-3.0-or-later**（全文见 [LICENSE](LICENSE)）
- **每个包仍以自己 `pack.json` 里的 `license` 为准**（见下表），本仓库的整体许可不覆盖它们
- **不含任何游戏素材**：`assets/` 下只有各包自带的同人素材或自制素材

## 收录的包

### `fanpack-kazdel-rhodes` — 非商业同人作品

- **来源**：上游 [sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol) 的
  `fanpack` 分支内容包部分，回移改写成工坊包格式
- **原作者**：原件未署名（原件的 README 与来源说明随包保留）
- **许可**：非商业同人作品。原件的署名与说明**原样保留**：
  [`NOTICE-来源说明.md`](demo/fanpack-kazdel-rhodes/NOTICE-来源说明.md)、
  [`NOTICE-原件-README.md`](demo/fanpack-kazdel-rhodes/NOTICE-原件-README.md)、
  [`NOTICE-原件-内容包-README.md`](demo/fanpack-kazdel-rhodes/NOTICE-原件-内容包-README.md)
- **本仓库做的改动**：把数据落成包格式；原件的行为层（kit / match 元注册表 / 引擎钩子）、
  客户端屏幕、i18n 与口径变体**没有接口，未收录**（详见包内来源说明）
- **包内素材**：两条盟约徽记与 4 张装备图标，随原件提供

### `plugin-pack` — CC0-1.0

- **原作者**：**Ausevay**（上游《卫戍协议：盟约》的作者）
- **许可**：**CC0-1.0**（原件许可；随包保留 [`CREDITS.md`](demo/plugin-pack/CREDITS.md)
  与 [`notice/credits.json`](demo/plugin-pack/notice/credits.json)）
- **本仓库做的改动**：按工坊包接口改写为界面插件（头像选择器、卡面标记、聊天、局域网面板）

### `sp-resource-pack` — GPL-3.0-only

- **来源**：社区分享版（2026-10-09），**原件作者未署名**
- **许可**：**GPL-3.0-only**（原件许可随包保留于
  [`packs/sp-resource-pack/LICENSE`](demo/sp-resource-pack/LICENSE)；
  来源与改写说明见 [`NOTICE-来源说明.md`](demo/sp-resource-pack/NOTICE-来源说明.md)、
  [`README-改写说明.md`](demo/sp-resource-pack/README-改写说明.md)）
- **本仓库做的改动**：把原件按引擎的中间层重写为资源包的导入与准入流程

## 如果你想收录自己的包

见 [SKILL.md](SKILL.md) §8：**保留原作者署名、原样保留原件许可、写清你改了什么**。
不满足这三条的包不会被收录。
