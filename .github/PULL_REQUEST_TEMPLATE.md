## 这个 PR 做了什么

<!-- 一句话。例如：上传 <mod 名字> 到 incoming/；或 把 <mod 名字> 兼容成包放进 packs/ -->

## 上传到 `incoming/`（未完成兼容的 mod）

- [ ] 目录是 `incoming/<mod 名字>/`，目录名就是 mod 的名字
- [ ] 里面有 `SOURCE.md`，五件事都写了（照 [`incoming/SOURCE.template.md`](../incoming/SOURCE.template.md)）
- [ ] **原始出处可追溯**（能给出 URL / 发布页 / 群文件）
- [ ] 原作者写清了 —— 没署名就写「原件未署名」，**没有自己填一个名字**
- [ ] 夹带游戏素材（解包出的美术 / 音频 / 字体 / 数据导出物）的话，已在 `SOURCE.md` 里**如实写明**
      —— 那种**照收**，未标注才是问题（素材口径见 [`SKILL.md`](../SKILL.md) §14）
- [ ] 原作者**没有**禁止再分发

## 提到 `packs/`（兼容完成的包）

- [ ] `node tools/check-packs.mjs --engine <引擎目录> --root packs` 通过（全部 `✓`、无 `✗`）
- [ ] `pack.json` 的字段都在引擎的 `PACK_FIELDS` 里，`id` 与目录名一致，`api` 与引擎的 `MOD_API_VERSION` 对得上
- [ ] 只 import 了白名单别名（`@kit/*`、`@sim/*`、`@battle/index.js`）
- [ ] 原作者署名与原件许可齐全（原件许可原样保留，改名 `NOTICE-原件-*`）
- [ ] 原件里**没有接口**的部分，已在包内来源说明里如实写清（没做、为什么）
- [ ] 自带素材逐条写明来源与授权；含官方素材的已写明「**含官方素材**」+ 实测清点（**未标注才是问题**）

## 我跑过的验证

<!-- 把命令与结果贴上来。例如：
node tools/check-packs.mjs --engine E:\...\Stronghold-Protocol-Forge
── packs/（闸门）
   ✓ <包 id>  1.0.0  层 B  api=>=1 <2
✓ 闸门通过
-->

## 其它

<!-- 需要维护者裁决的点、已知做不了的部分、对原件的疑问 -->
