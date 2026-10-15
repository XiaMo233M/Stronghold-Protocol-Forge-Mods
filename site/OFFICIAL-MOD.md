# §4c「官方 mod」投稿选项 —— 设计、字段形状、文案与判据

> **本刀只做设计 + 文案 + 代码 + 判据；不接生产。**
> `site/server.mjs`、`site/pages/**` 一字未动，**不部署、不重启服务、不碰 `sync` / `nginx` / `/etc/sp-modsite.env`**。
> 已落地的两个文件都是**纯逻辑 / 纯判据**：
> [`site/official-mod.mjs`](official-mod.mjs)（判据与形状，纯函数）· [`site/selftest-official-cert.mjs`](selftest-official-cert.mjs)（判据，红/绿都真跑）。
> 要真正上线，先由业主点头 **W3 / W10**（站侧导入预检接入站点）—— 见下文「三、还差什么」。
>
> 背景与依据：`_up/forge-compat/无损边界与双向清单.md` §4c（不在本仓库内，属交接材料）。

---

## 一、这是什么（作者自选的两档）

| 档 | 作者承诺 | 站侧给什么 |
|---|---|---|
| **兼容（现状，不动）** | 不承诺形态，能跑就行 | 三档检查（`site/review.mjs`）+ 实测记录 |
| ⭐ **官方 mod（新增，可选）** | **只使用官方（上游）架构面**：不用 `server.meta` / `behaviour` / 组件面板 / `@ops/` 等本站独有面；kit 只用交集模块；记录只用官方表达得了的字段 | 一份**可核验的证明**（下面 §二），**与「兼容」标签分开展示** |

**它是标准，不是更好的 mod** —— 这三句话必须一起给作者看（见 §四的文案，判据盯着它们不许被删）。
**为什么说它是标准而不是主流**：见 [§七](#七为什么这一档一开始会很冷清实证不是空口) 的实测数字 ——
扫了 27 个真包，**`ok=true` 且 `dropped=0` 的一个都没有**。

---

## 二、证书核什么、字段从哪来、怎么核

七道闸，**全过才发证**；任意一道不过 ⇒ `certificate: null` + 逐条理由（`site/official-mod.mjs` 的 `GATES`）。

| # | 闸（`id`） | 判什么 | 字段从哪来 | 怎么核 |
|---|---|---|---|---|
| 1 | `import-ok` | 上游导入器 `ok=true` 且 `issues` 空 | `import-forge --dry-run --json` 的 `ok` / `issues`（上游 `server/plugins/forgeImport.js:2180-2193`） | `site/forge-precheck.mjs:129-131` 把这几个字段读成 `upstream.*`；判据用**真包**跑一遍 |
| 2 | `dropped-0` | `dropped` **0 条** | 同一份报告的 `skipped` | 同上（`forge-precheck.mjs:129`） |
| 3 | `assumed-0` | `assumed`（`[ASSUMED]`）**0 条** | 同一份报告的 `assumed` | 同上（`forge-precheck.mjs:131`） |
| 4 | `strict-0` | `check --strict` 的 **0 problem 且 0 warning**、退出码 0 | **另跑一次** `node tools/plugin.mjs check <导入产物> --strict --json` | 数字在 `tools/plugin.mjs:307`（`{folders, problems, warnings}`）；`--strict` 的失败条件是 `problems \|\| (strict && warnings)`（`:309`）⇒ **只要 `--strict` 通过，就必然两者都是 0** |
| 5 | `engine-clean` | 我们装载器**未拒包**、`0 error`、恰好装载 1 个包 | `site/forge-precheck.mjs:167-175` 的 `engine.refused` / `errors` / `packs` | 判据里对真包真跑 |
| 6 | `real-run` | **真装上 + 真跑一局**：`matchHostReady=true`，且有房间码或 seed | 站上**既有真装真跑流程**（照交接材料的实测口径） | ⚠️ **本刀不产这一份**（不部署、不跑对局）⇒ 判据绿例的这格是**夹具**，已如实标注 |
| 7 | `fingerprint` | 上游**版本**（含来源字段名）+ 包字节 **SHA-256**（64 位 hex） | 上游版本取自 `<根>/MANIFEST.json:app`，读不到退 `package.json:version`（`forge-precheck.mjs:85-95`）；SHA-256 由站侧对 `mod.zip` 现算 | 判据里核真值（实测 `0.3.0 ← MANIFEST.json:app`） |

### 证书形状（落记录 `meta.json` 的 `officialCert`，**独立于** `compatOf` / `compatAuthor`）

```jsonc
"officialCert": {
  "standard": "official-arch",          // 闭枚举：目前只有这一档
  "standardVersion": 1,                 // ★ 本「规则」的版本（规则改了要抬）。与上游软件版本是两个数
  "certifiedAt": "2026-10-15T00:00:00.000Z",
  "status": "valid",                    // valid | expired —— 过期由 revalidate() 按下面两格算
  "upstream": { "version": "0.3.0", "versionSource": "MANIFEST.json:app",
                "importerTool": "tools/plugin.mjs import-forge --dry-run" },
  "pack":     { "packId": "boss-fixed-pool", "sha256": "<64 位 hex>", "bytes": 8382 },
  "checks": {
    "dropped": 0, "assumed": 0,
    "importCheckText": "check --strict 与 pack 通过；外观走 visual set，数据走 content set。",  // 上游那句**人读**结论，原样存
    "strictProblems": 0, "strictWarnings": 0, "strictExitCode": 0,                          // 独立跑出来的**数字**
    "engineErrors": 0, "engineRefused": false, "enginePacks": 1,
    "realRun": { "ranAt": "…", "how": "…", "roomCode": null, "seed": "…",
                 "matchHostReady": true, "engineVersion": "0.3.0", "reportRef": null }
  },
  "reportSha256": "<预检报告 json 的 sha256>"   // 两端拿同一个包重跑即可逐字复核
}
```

> ⚠️ **`importCheckText` 是字符串、`strictProblems` 是数字，两个都留** —— 上游导入报告里的 `check`
> 是**字符串**（实测形如上面那句），拿不到数字；数字只能**另跑一次** `check --strict --json` 才拿得到。
> 两个字段名不同、含义不同，**不要**把字符串塞进一个叫 `strictProblems` 的格子里。

### 过期怎么判（提醒 ③ 的机器落点）

`revalidate(cert, { upstreamVersion, packSha256 })`：

| 情形 | 结果 |
|---|---|
| 上游版本与签发时**相同**、包字节 SHA-256 也**相同** | `valid` |
| 上游**升了版本**（如 `0.3.0 → 0.3.1`） | `expired` —— 必须复验 |
| 包字节**变了**（SHA-256 不一致） | `expired` —— 旧证明不覆盖新字节 |
| 当前版本或字节**核不到** | `expired` —— **不许默认有效** |

### 公开面分开展示

徽标文案由 `badgeText(cert)` 给（**与「兼容」栏并列，不合并成一栏**）：

```
官方架构（已核验）：0 丢弃 · 0 猜测 · check --strict 通过 · 真跑通过 · 上游 0.3.0 · sha256 29d56786
过期后同一格改写成：… · 已过期 —— 上游升级后未复验
```

---

## 三、还差什么（**本刀刻意不做**，留给下一刀）

| # | 差什么 | 落点（`文件:行`，本刀**未改**） |
|---|---|---|
| 1 | 投稿页多一个「官方 mod」勾选框 + 旁边三条提醒 | `site/pages/index.html` 表单区（`:32-40` 那两块 `field` 之间） |
| 2 | 服务端收这一栏、跑七道闸、发证 | `site/server.mjs` 的投稿分支（`:2106-2195`）；`meta.json` 加 `officialCert` |
| 3 | 公开面多一栏独立徽标 | `site/server.mjs:1667 collectPublicMods` 的形状（`:1748` 附近）+ `/mods` 预渲染（`:1971-2008`） |
| 4 | 真装真跑那一格**真产** | 站上既有兼容包流程；本刀只有夹具，**核不到 = 不给证** |
| 5 | 上游版本变了时**自动**把证书刷成过期 | 每次发 `officialCert` 时调一次 `revalidate` |
| 6 | 证书规则的版本策略（`standardVersion` 什么时候抬） | 待裁决：规则一改就抬，否则旧证书含义会漂 |

**接入顺序**：W3 / W10（站侧导入预检接入站点）是它的地基 —— **预检不通，证书无从谈起**（同一套 `forge-precheck` 报告就是闸 1/2/3/5 的证据来源）。

---

## 四、文案（**只此一份**，在 `site/official-mod.mjs` 的 `REMINDERS`）

| id | 必须出现在 | 文案 |
|---|---|---|
| `cold-start` | 投稿页 + 公开页 | ⭐ 一开始会很冷清：实测 52 个真投稿里只有 1 个做到「0 丢弃 + 0 猜测」。它是**标准**，不是主流 —— 请允许它长期是一小众档。 |
| `not-better` | 投稿页 + 公开页 | ⭐ 它**不等于「更好的 mod」**：官方架构面**比本站的面窄** —— 少 5 个界面挂载点、少 tier2–6 与 `@ops/` 官方 kit、少字段级 `overrides` 与口径（`variants`）通道。换来的是**跨站可用 + 可核验**，**不是功能更强**。 |
| `revalidate` | 证书详情 | ⭐ **上游一升级就要复验**：证书里记的是签发时的上游版本 + 包字节 SHA-256。上游出新版本后，这条证书会变成「已过期」，必须重跑一次才会重新有效。 |

`where` 是**必须出现的位置**，判据逐条盯着（提醒被删掉就是红）。

---

## 五、判据（`node site/selftest-official-cert.mjs --upstream <上游根>`）

| # | 判什么 | 红 / 绿 |
|---|---|---|
| ① | 七道闸 id 唯一、三条提醒都在且都写了位置 | 绿 |
| ② | 拿**两个真包**采真报告；并**真跑一次** `check --strict --json`，证明 `strictProblems` 是**真数字** | 绿（实测 `{"problems":0,"warnings":0,"exitCode":0}`） |
| ③ | `boss-fixed-pool` 的真报告（`dropped=4`）⇒ **拒发**、理由点名 `dropped-0` | 真红（真数据） |
| ④ | `duel-data` 的真报告（`dropped=0`、`assumed=0`，但上游**被拒**）⇒ **仍然拒发**、理由点名 `import-ok` | 真红（真数据）—— 专证「只看 dropped / assumed 不够」 |
| ⑤ | 七闸全过的证据（**夹具**）⇒ 发证，证书字段逐个核 | 绿 |
| ⑥ | 逐闸红 12 例：`dropped=1` / `assumed=1` / `problems=1` / `warnings=1` / 没跑 strict / `errors=1` / `refused=true` / 没真跑 / `matchHostReady=false` / sha 不是 hex / 版本为空 ⇒ **只坏一格也拒发**，理由 id 对得上 | 红（每条都断言） |
| ⑦ | `revalidate`：版本变了 / 字节变了 / 核不到 ⇒ `expired`；都没变 ⇒ `valid` | 红 + 绿 |
| ⑧ | 跑完前后两个真包 zip 的 sha256 一字不变（只读） | 绿 |

**「改前必红」怎么证的**：本判据是**突变测试**验证的 ——
把 `dropped-0` 那道闸改成永远通过 ⇒ 判据 2 项红；把 `revalidate` 的版本检查关掉 ⇒ 判据 1 项红。
两次突变都已复原，复原后重跑全绿（原始输出在交付说明里）。

---

## 六、核不到 / 未验证（如实记）

1. **真装真跑那一格本刀不产** —— 不部署、不跑对局。判据绿例用的是**夹具**，已在那条断言上写明。
2. **上游 `check --strict` 的上限**：只核到 `problems` / `warnings` 两个数与退出码；上游是否还有别的严格档位未读全。
3. **界面面板类不可能无损**（架构差异）—— 所以「官方 mod」这一档对界面包基本不适用；文案里已用「面更窄」讲明，但没有逐条列清单。

---

## 七、为什么这一档「一开始会很冷清」（实证，不是空口）

**做法**：用 [`forge-precheck.mjs`](forge-precheck.mjs) 逐个跑上游导入器，扫本站 `mods/` 下 **27 个 < 5 MB 的真包**
（不含 `ave-mujica` 18.8 MB 与 `duel-assets` 25 MB：前者超上游 `ZIP_RAW_MAX`、后者本刀未扫）。原始数字：

| 指标 | 数字 |
|---|---|
| 真包总数 | **27** |
| `dropped = 0` 的包 | **1**（`duel-data`）—— 而它**上游被拒**（`PLUGIN_FORGE_JSON`）⇒ 闸 1 先过不去 |
| ⭐ `ok = true` **且** `dropped = 0` 的包 | **0** —— 也就是说：**今天一个能过闸 1+2 的真包都没有** |
| `dropped ≥ 1` / `≥ 2` 的包 | **26** / **26** |
| `dropped` 里含 `.md` / `.txt` 随包说明的包 | **25**（只有 `duel-data` 与 `duel-mode` 不含） |

**根因（这一条是可推的）**：本站的包**都带** `PROVENANCE.md` / `README.md` / `NOTICE-*`，
而 `pack.json` **没有任何字段能引用 `.md`**（`notices` 指向 `.json`、`content` 指向固定名单的 json、
`art` 指向素材、`client` 指向模块）⇒ 上游**必然**把它们记进 `dropped` ⇒ **闸 2（`dropped-0`）对 25/27 的包直接过不去**。

**⇒ 结论**：拿「官方 mod」证书要求包**一个未引用文件都不带**，这在本站现行惯例
（每包必带 `PROVENANCE.md`，见 `AGENTS.md` §3）下是**特例、不是常态**。
这正是提醒 ① 那句「一开始会很冷清 —— 它是**标准**，不是主流」的**实证**：
它说明这个档**不能当默认**，只能当作者自选的小众档；把它做成默认 = 声称几乎所有包都不合格。

> 顺带一个**正面**信号（同一次扫掠）：压掉「本来就不走导入」那两类之后，**22/27 的包仍有「可行动」的未引用文件**
> （共 26 条，如 `srv-notice` 的 `notice/announcement.json`）—— 说明 W4 那条提示**真有信号**，不是摆设。

