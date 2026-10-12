# `packs/` — 兼容完成的包

**这里只放已经做完兼容、并且验过的包。** 拿到的就是能直接装进游戏的工坊包。

现在有 **3 个包** —— 都是**站上已发布**的成品，从站侧导出**逐字节**搬进来（包内容**只读**，要改请回站上走兼容包流程）：

| 包 | 形态 | 它演示什么 |
|---|---|---|
| [`theme-night/`](theme-night) | 纯 `pack.json`（`client.theme.vars`，零代码，2 个文件） | **最小完整包** —— 一行代码都不写也能是标准包 |
| [`notice-board/`](notice-board) | `notices` 数据面（公告 + 鸣谢两个 `.json`） | 纯文本、零代码，与引擎自带公告**追加合并** |
| [`cdn-source/`](cdn-source) | `client.panels`（`root.overlays`）+ 自带测试 | 有代码的面板包；也演示原件许可**改名 `NOTICE-原件-*`** 随包保留 |

> **站上已发布的包是另一份清单**（存在站点的数据目录里；站上**全部**已通过的成品镜像在
> [`../mods/`](../mods/README.md)，由 `tools/build-index.mjs` 生成）—— 本仓库的 `packs/` 只收
> **提交进这里**的那几个，两份清单**不互相同步**。
>
> ⚠️ **要「字节级就是站上那份」，请用 [`../mods/<包 id>/<版本>/mod.zip`](../mods/README.md)**（那份是
> **不透明 zip**，换行不会被改，`index.json` 里还有它的 sha256）。这里放的是**解开的文件**：搬进来时逐条比对过
> sha256（14 个文件全部相同），但 git 的换行归一化（`core.autocrlf`）会让**仓库里存的那一份**与站上 zip 差几个
> 字节 —— `cdn-source` 那三个 CRLF 文件就是这种情况（这与 `mods/README.md`「为什么不把 zip 解开」是同一条理由）。

## 进来的条件（五条都得满足）

1. **装得上**：用引擎自己的装载器验过，`✓` 且 **`errors=0`**：

   ```bash
   node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs
   ```

   > **一包一根单独装载**：验证时用**干净的空工坊根**（里面只有这一个包），
   > 并把**原始输出**留下来。混装时一个包被拒是分不清「谁的问题」的。
   >
   > **包形状三条硬规则**（细节见 [`../SKILL.md`](../SKILL.md) §3）：只认
   > `<工坊根>/<包 id>/pack.json`；**目录名必须等于 `pack.json.id`**（否则 `PACK_ID_MISMATCH`）；
   > 打 zip 时**顶层目录 = 包 id**，也就是 zip 里 `pack.json` 的路径必须是 `<包 id>/pack.json`。
   > （这条是**仓库收录 / 本地装载**的形状；**投站上传要扁平**：只读 zip 根的 `pack.json`，
   > 见 [`../SKILL.md`](../SKILL.md) §3 与 [`../AGENTS.md`](../AGENTS.md) §6 ⑧。）
2. **只做有接口的事**：原件里没有接口的部分，**如实写进包的来源说明**（哪些没做、为什么），
   而不是硬塞进来（见 [`../SKILL.md`](../SKILL.md) §15）
3. **署名与许可齐全**：每包必带 **`PROVENANCE.md`**（六项：原作者 / 许可 / 兼容改写者 / 来源 /
   改了什么 / 自带素材来源，见 [`../SKILL.md`](../SKILL.md) §10）；原件许可原样保留
   （改名 `NOTICE-原件-*`）；**包内原作者文本与包自带元数据一字不改**
4. **素材已标注**：含游戏素材的包**可以收录**，但 `PROVENANCE.md`（机械清点 + 来源授权）
   与站上备注必须写明「**含官方素材**」（见 [`../AGENTS.md`](../AGENTS.md) §3「素材口径」）
   —— **未标注才是问题**
5. **带上真实功能**：装上之后会改变某项游戏内行为（数据 / 界面 / 服务端任一层）才收。
   自述 `documentation-only` / 只读参考 / 只放 JSON 与说明面板的**不上架** —— 但**处理方式是
   「留在待审」，不是「打回」**：**记录与简介要保留**，那是我们**做兼容包改写的依据**
   （打回会写下 `decision.json` 的 `rejected`、该条离开待审队列掉到 `?view=rejected`），
   等它带上真实功能再上架（判据见 [`../SKILL.md`](../SKILL.md) §15.1 与
   [`../AGENTS.md`](../AGENTS.md) §4）。

> **会改对局结果的包要标注清楚**：`combat: true` 的包**不另设闸门**（mod 是房主建房间时自己选装的），
> 但**必须在包自述里讲明「会影响对局结果」**；不标才是问题（[`../SKILL.md`](../SKILL.md) §4、
> [`../AGENTS.md`](../AGENTS.md) §5.1）。

> ⚠️ **两个最容易踩的静默坑**（[`../SKILL.md`](../SKILL.md) §5.1 / §5.3）：
> `pack.json` 的**未知顶层键会让整包被拒**（`PACK_UNKNOWN_FIELD`，实测踩过
> `type` / `app` / `englishName` / `target` / `capabilities` / `authors` 这几个不存在的键）；
> **`content` 没声明 `chess`，加载器就完全不读这个包的 `chess.json`** —— 商店摇不到、试玩里没有，
> 而且**日志里没有错误**。

## 流程

```
incoming/<mod>      组员上传原件
      ↓  读 SOURCE.md，判断哪些部分有接口
      ↓  改写成工坊包格式（pack.json + 数据/界面/行为/素材）
      ↓  干净 workshop 根、一包一根单独装载，要 errors=0
      ↓  node tools/check-packs.mjs --engine <引擎> --root packs
      ↓  补 PROVENANCE.md（六项）
packs/<包 id>       兼容完成，可安装
```

`demo/` 已**退役、不再对外提供**（三份旧包，其能力引擎已内建，见 [`../demo/README.md`](../demo/README.md)）——
**要照抄格式请看引擎的 `docs/WORKSHOP.md`**，`notices` 这类形状看
[`../docs-copy-examples/`](../docs-copy-examples/README.md)，**不要拿 `demo/` 当模板**。
这个目录才是收录闸门：`packs/` 里的包必须全部装上，被拒就是回归。
