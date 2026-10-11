# `packs/` — 兼容完成的包

**这里只放已经做完兼容、并且验过的包。** 拿到的就是能直接装进游戏的工坊包。

现在是**空的** —— 还没有任何一个包走完兼容流程。想要有内容，先往 [`../incoming/`](../incoming/README.md) 上传。

## 进来的条件（四条都得满足）

1. **装得上**：用引擎自己的装载器验过，`✓` 且 **`errors=0`**：

   ```bash
   node tools/check-packs.mjs --engine /path/to/Stronghold-Protocol-Forge --root packs
   ```

   > **一包一根单独装载**：验证时用**干净的空工坊根**（里面只有这一个包），
   > 并把**原始输出**留下来。混装时一个包被拒是分不清「谁的问题」的。
   >
   > **包形状三条硬规则**（细节见 [`../SKILL.md`](../SKILL.md) §3）：只认
   > `<工坊根>/<包 id>/pack.json`；**目录名必须等于 `pack.json.id`**（否则 `PACK_ID_MISMATCH`）；
   > 打 zip 时**顶层目录 = 包 id**。
2. **只做有接口的事**：原件里没有接口的部分，**如实写进包的来源说明**（哪些没做、为什么），
   而不是硬塞进来（见 [`../SKILL.md`](../SKILL.md) §14）
3. **署名与许可齐全**：每包必带 **`PROVENANCE.md`**（六项：原作者 / 许可 / 兼容改写者 / 来源 /
   改了什么 / 自带素材来源，见 [`../SKILL.md`](../SKILL.md) §9）；原件许可原样保留
   （改名 `NOTICE-原件-*`）；**包内原作者文本与包自带元数据一字不改**
4. **不含任何游戏素材**（[`../SKILL.md`](../SKILL.md) §13 的红线）

> ⚠️ **两个最容易踩的静默坑**（[`../SKILL.md`](../SKILL.md) §5）：
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
**要照抄格式请看引擎的 `docs/WORKSHOP.md`**，不要拿 `demo/` 当模板。
这个目录才是收录闸门：`packs/` 里的包必须全部装上，被拒就是回归。
