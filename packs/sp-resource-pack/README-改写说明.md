# `sp-resource-pack` —— 改写说明（第二阶段：中间层四项能力已落地，包能单独装了）

> **一句话**：原件那份「完整资源包导入 / 浏览器缓存分发 / 服务端持有证明准入」的第三方 mod，现在是我们格式里
> **一个真的能装、能加载、能被作者侧校验器接受、两半接线被执行验证过的包** —— 它不再需要改引擎一行代码。
>
> **依赖**：0.11.0 及以上（`MOD_API_VERSION = 1`）。它用的是中间层四项能力 `assets` / `client` /
> `server.preDispatch` / `routes`（DESIGN §28.13，`docs/WORKSHOP.md` §1.9）。在 0.10.0 上它会被判 `EMPTY_PACK`
> —— 那**不是** bug：那四组字段 0.10.0 还不存在（实测见 `验证/validate-010.txt`）。
>
> **不自带内容**：这个包没有干员 / 装备 / 怪物 / 地图 / 语音 / 美术。它的全部载荷都是**能力声明**加一个资源容器。

---

## 1. 目录里每一件东西是什么

| 路径 | 是什么 | 谁读它 |
|---|---|---|
| `pack.json` | 包清单。四组能力声明都在这里 | 装载器（`server/workshop.js loadWorkshop`）、编辑器、校验器 |
| `packs/resources-77e70dbd8612.spresources` | **资源容器**（我们格式的字节容器）。本包带的是**样板**，见 §5 | 浏览器（`assets.container`）、服务端只负责流式送 |
| `packs/resources-77e70dbd8612.spresources.sha256` | 旁挂摘要（`<64 hex>  <文件名>`，与 `sha256sum` 输出同形） | 装载期 `assets.verify` 核它；**不进**任何 URL |
| `resource-manifest.json` | **权威清单**：38 条扁平文件表 `{url,size,hash,tier}`，`version` = `sha256(压紧 files)[0:12]` | 客户端导入流程（逐文件核 SHA-1[0:12]）；同时由 `routes` 挂在 `/data/resource-manifest.json` |
| `resources/preloadModal.js` | **C 层面板**：入口闸门 + 导入界面 + 出示持有证明 | 浏览器（`/workshop-panels/sp-resource-pack/resources/preloadModal.js`） |
| `server/resourceAdmission.mjs` | **分发前准入钩子**：挑战 / 证明 / 否决入口消息 | 服务端（`server/modDispatch.js`） |
| `admission-files.json` | **准入策略**：22 条 `{url, sha256}`（完整 SHA-256，不是清单里那 12 位） | 钩子自己（框架原样注入，不解释） |
| `NOTICE-来源说明.md` | 原件出处与许可 | 人 |
| `LICENSE` | GPL-3.0（原件随附的那一份，原样） | 人 |

**没有 `assets/` 目录，这是有意的。** 这个包不分发自己的素材（它分发的是**别人**的素材，走容器）；放一个空
`assets/` 只会触发无关的 `ASSETS_NEED_LICENSE` 闸门，也让读者以为这个包自带素材。

---

## 2. `pack.json` 逐字段（字段名各自的出处，不是凭印象）

| 字段 | 值 | 字段名出处 | 谁读它 |
|---|---|---|---|
| `id` / `name` / `version` / `author` / `license` / `description` / `gameVersion` | 见文件 | `shared/workshop.js PACK_FIELDS` | 身份、编辑器、助战列表 |
| `api` | `"1.x"` | `shared/constants.js MOD_API_VERSION = 1`（DESIGN §28.5） | **声明了才比对**；区间不含本 build 就整包被拒（`MOD_API_INCOMPATIBLE`） |
| `layer` | `"C"` | `shared/modIdentity.js MOD_LAYERS` | 界面标签。**不写也会推出 `C`**（包挂了面板），写出来是为了让作者意图可见 |
| `combat` | `false` | `shared/workshop.js` | **结构性地**为假：注入面里没有任何对局对象，它连改结果的手段都没有 |
| `content` / `overrides` | `[]` | `WORKSHOP_CONTENT_FILES` | 空是有意的，见 §1 末 |
| `assets` | `{container, manifest, serverPolicy:"serve", verify:"sha256"}` | `ASSETS_FIELDS` | 装载器（文件在不在 + 摘要对不对）、`/workshop-resources/` 路由、`welcome.modAssets` |
| `client` | `{panels:[{id:"resource-import", slot:"root.overlays", module:"resources/preloadModal.js", order:10}], requires:["serviceWorker","cacheStorage","webCrypto"]}` | `CLIENT_PANEL_FIELDS` / `CLIENT_PANEL_SLOTS` / `CLIENT_REQUIRES` | `/workshop-panels/` 路由、`welcome.modPanels`、客户端注册点 |
| `server.preDispatch` | `{module:"server/resourceAdmission.mjs", policy:"admission-files.json", intercepts:["room.create","room.join","room.spectate","room.start"]}` | `PRE_DISPATCH_FIELDS`；`intercepts` 逐项按 `shared/protocol.js C2S` 判 | 装载器、`server/modDispatch.js`、`server/net.js onFrame` |
| `routes` | `[{path:"/data/resource-manifest.json", file:"resource-manifest.json", cache:"no-cache"}]` | `ROUTE_FIELDS` / `ROUTE_CACHE_POLICIES` | `server/http/static.js`（**只 GET/HEAD、只 `.json`、只精确路径**） |

**`client.panels[0]` 上刻意没有 `gate`。** 这一条值得单独说，因为 `docs/WORKSHOP.md` §1.9.3 的示例把它写成了
`"gate": "session.preloadRequired"` —— 而 `gate` 的语义是「store 里那个路径为真**才**挂载」，`session.preloadRequired`
缺省是 `false`，**而唯一会把它置真的正是这个面板自己**。照那份示例写，全新会话里这个面板**永远挂不上**，导入
界面永远不会出现，而服务器侧的准入闸门照样拦人 —— 一个走不出去的环。所以本包写的是「无条件挂载 + 挂载时自己
关闸」（正是 §1.9.4 那段客户端示例的做法）。这条已按「回报给中间层的几格」报给业主。

---

## 3. 服务端那一半：`server/resourceAdmission.mjs`

### 3.1 契约（`docs/WORKSHOP.md` §1.9.1）

```js
export function createPreDispatch(deps) {
  return {
    onConnection(conn) { /* 连接建立时调用一次 */ },
    preDispatch(conn, msg) { return false; },  // true = 这条消息已被消费
  };
}
```

* **工厂每条连接调用一次**（`server/modDispatch.js` 的 `instancesFor`），所以 `allowed` / `challenge` /
  `lastIssueAt` 都放在工厂的闭包里 —— 那是**连接私有**的。模块**没有**顶层可变状态（自检里有一条断言钉住）。
* 注入面**恰好八个键**：`pack` / `policy` / `policyFile` / `intercepts` / `c2s` / `log` / `now` / `send`。
  **没有** socket、`data`、`lobby`、`Match`、战斗对象。所以钩子能做的只有观察、记录、上报、否决入口消息。
* 时钟一律取 `deps.now()`，不读 `Date.now()`（自检里有一条断言钉住）。
* **不注册第二个 `socket.on('message')`**（自检里有一条断言钉住）。框架是**调用**钩子，不把 socket 交出去。
* **本模块另外导出了可选的 `validatePolicy(policy)`**（`docs/WORKSHOP.md` §1.9.1 的第二个可选导出）：装载期只保证
  `policy` 能解析成一个 JSON **对象**，它不认识 `version` / `files` 这个方言，所以**策略的内部形状只有本模块判得
  出来**。装载器（`server/workshop.js loadWorkshopHooks` → `validateHookPolicy`）会调它，返回「不能用」就按
  `PREDISPATCH_BAD_POLICY` **把整个包移出已加载集合**（`dropUnavailablePreDispatchPacks`）—— 结局与「策略不是
  JSON 对象」完全一样，而不是「包看着装好了、闸门其实一条都没拦」。本轮实测：把 `admission-files.json` 的题库
  改成 2 条，装载期照旧列出这个包，`validatePolicy` 拒绝，装配路径把它裁掉（`验证/proof-mod4.json`）。

### 3.2 与原件逐条差异

| # | 原件 `server/admission.cjs` | 本包 | 为什么 |
|---|---|---|---|
| 1 | 自己注册 `socket.on('message')` 并转发游戏消息 | 框架调用 `preDispatch(conn, msg)`，返回 `true` 表示已消费 | Node 的 `ws` 会把同一条消息发给**所有**监听器 ⇒ 再注册一个就是**每条游戏消息被处理两次**（`room.create` / `g.buy` 有副作用，是实打实的双执行）。框架不给你这个口子 |
| 2 | 直接 `socket.send(...)` | 用注入的 `send(conn, msg)` | 框架的发送助手带背压守卫（1 MiB 跳过、16 MiB 断连）；直接写 socket 是第二条写路径 |
| 3 | 拦 `['room.create','room.join','room.spectate','room.start','match.queue','queue.join']` | `intercepts` 只列前四个；`match.queue` / `queue.join` **我们没有** | 装载期按 `C2S` 逐项校验 `intercepts`，写一个协议不认识的名字会**整包被拒**（`PREDISPATCH_UNKNOWN_TYPE`）—— 照抄原件那两个名字，得到的是「包加载不了」而不是「一条静默失效的名单」 |
| 4 | `server/admission.cjs` 自建定时器清理 | 每连接一个挑战、5 分钟过期、重发限流 1 秒 | 同形保留（这几条它写得对） |
| 5 | 拒绝帧只在 `msg.rid != null` 时带 rid | 同形保留 | 客户端的无 rid 错误帧会走 `unhandledError` → 弹一条红条（`public/js/main.js`），玩家看到的是「点了没反应 + 一条看不懂的错误」 |
| 6 | 文案指向某个 QQ 群 | 改成中性文案 | 我们的分发渠道不是 QQ 群 |
| 7 | 准入策略只查 `version` 与 `files.length >= 3` | 逐条查 `url` / `sha256` 形状，并查重复 URL | 一条坏记录会让某个挑战**永远无法通过**，而作者只会看到「有人进不来」 |
| 8 | 抽签范围 1 KiB..256 KiB（`tools/spresources.mjs` 的 `PROOF_MIN_BYTES`/`PROOF_MAX_BYTES`） | 生成策略时**照同一范围**筛（38 条里 22 条入选） | 下界：小于 1 KiB 的文件做第二原像太便宜，等于没出题；上界：一次挑战要让客户端读 hash 三个文件 |

### 3.3 RNG：两处，且是业主裁决明确排除的那一项

业主裁决原文：「当然可以注入，只要在同等情况（**排除 rng**）不会出现注入与不注入结果不一样的情况就行。」

本模块用 RNG 的地方恰好只有两处：挑战的 `nonce`（24 随机字节）与「这一轮抽哪三个文件」。这两处**必须是**不可
预测的 —— 可预测的挑战等于没有挑战。结果层面它们无害：本包 `combat: false`，且注入面里根本没有能改结果的句柄。
**不要**把这份文件当模板去写会改结果的包。

### 3.4 安全口径（诚实，不许对外说成防作弊）

包发给所有玩家，素材也在公开镜像上，任何人拿到包就能离线算出全部证明，根本不用跑游戏。它把门槛从「翻一个
localStorage 标记」抬到「背着整份素材」，**仅此而已**。另外两条必须说清楚：

* 逐文件指纹在**线格式**上是 SHA-1 前 12 位 = 48 bit。**明文 HTTP 下主动 MITM 可以同时替换清单与容器，48 bit
  毫无作用**（所以清单与容器必须走 HTTPS）。
* 服务端这一侧的**二次校验**用的是策略文件里的**完整 SHA-256**（64 hex），不是那 12 位。想再加一层就给清单
  本身签名，别指望那 48 bit。

---

## 4. 客户端那一半：`resources/preloadModal.js`

### 4.1 状态机

```
挂载 → 等宿主登记 assets 声明（有界 20×250ms，见下）
     → setPreload({required:true, ready:false})            ← 关闸，路由停在标题页
     → importStateFor(pack)
         · 没有收据            ⇒ missing：显示「从服务器导入 / 选择本地文件」
         · 收据 stale（换容器）⇒ 撤收据 + 撤索引里被当前清单覆盖的 URL ⇒ missing
         · 有收据              ⇒ 直接向服务器要挑战并出示证明
     → 挑战到达 → 逐文件重算 SHA-256 → 发 resource.proof
     → resource.accepted ⇒ setPreload({ready:true})        ← 开闸（卡片隐藏）
     → resource.rejected ⇒ 撤收据 ⇒ missing（要求重新导入）
```

### 4.2 四个必须踩对的点（错了会静默失效）

1. **资源消息必须走 `ctx.net.sendResourceMessage`。** 服务端的挑战是连接建立时就发出去的，那一刻 `status` 还不是
   `online`，普通 `send` 会**静默丢弃** —— 这正是原件踩过的坑。
2. **挂载时可能已经错过了服务器的挑战。** 挑战在连接建立时发出，面板要等 `welcome.modPanels` 到了才挂载。所以
   挂载后主动要一次 `resource.challenge.request`，并且**要重试**（4 × 1200 ms）：服务端的重发有 1 秒限流，第一次
   请求很可能正好落在窗口里被忽略。
3. **挂载时 `welcome.modAssets` 可能还没登记。** `public/js/main.js` 先 `import('./resources/host.js')` 再登记
   （异步），而本模块也是被动态 `import` 的 —— 两个 promise 谁先落地没有保证。所以有一段**有界等待**
   （20 × 250 ms），而不是一次 `modAssetsFor()` 查不到就永久放弃。
4. **面板不声明 `gate`**（见 §2 末）。

### 4.3 证明算式（必须与服务端逐字一致）

```
proof_i = sha256( nonce + "\n" + url_i + "\n" + sha256(容器里 url_i 的字节) )
```

`url_i` 是**策略文件里写的那个字符串**（逐字，不归一化）；`proofs[i]` 必须对应挑战帧 `files[i]` 的**次序**。
与原件 `integration/client/public/js/resources/preload.js` 的 `prove()` 是同一条式子，所以**原件的客户端能直接对
我们的服务端出示证明** —— 这不是巧合，是刻意保留的线格式兼容。

### 4.4 「证明就是深度校验」

有收据时的快路径**不重新导入**，直接出示证明：证明要求逐文件把缓存里的字节重算一遍 SHA-256，摘要对不上服务端
就会判 `proof[i]` 不合格，面板随之退回「重新导入」。也就是说这一步同时是**验证**，不是「相信收据」。

### 4.5 一处诚实的边界：换容器后的索引残留

引擎的索引（`/__sp-resource-index__`）是 `{url: 指纹}` 的**全局**一份，条目上不记「这条属于哪个包」。所以换容器
之后，一个**不在新清单里出现**的旧 URL 仍会留在索引里、SW 仍会拿它回答。本面板能做的是：撤掉这个包的收据，并把
**当前清单覆盖到的那些 URL** 从索引里摘掉（`revokeStale()`）。要彻底干净，需要引擎把索引**按包分段** —— 这一条
列在 §7。

---

## 5. 容器与清单：本包带的是**样板**，真实部署必须重打

| | 本包带的 | 原件真实分发的那一份 |
|---|---|---|
| 文件数 | **38**（22 条 tier1 + 16 条 tier2） | 完整素材树 |
| 字节 | **247,795**（容器 251,379 B） | 参考实现自述约 770 MiB |
| 内容 | 7 个字体 + 31 个真实素材（`/fonts/*`、`/assets/**`） | 全部 `/assets`、`/fonts`、`/media` |
| 容器 sha256 | `10f0e8ab906a63dde30a5955aaa90824c939ef08332a4bdd2bae6fe6ef6417ab` | — |
| 清单 version | `77e70dbd8612` | — |
| 抽查题库 | 22 条（1 KiB..256 KiB 范围内的全部） | 同规则，成千上万条 |

**为什么带样板**：包要能真的装上去、真的过闸、真的能被校验，就必须带一份**真实字节**的容器；把 770 MiB 塞进
交付物既不现实、也没有意义（素材版权也不归我们）。样板足以跑通整条链路，包括 tier 语义、逐文件校验、深浅校验、
SW 应答与准入抽签。

**真实部署怎么重打**（工具是引擎自带的，`tools/make-spresources.mjs`）：

```bash
node tools/make-spresources.mjs --manifest <你的清单.json> --public public --out <这个包目录> --force
```

它会写出三件：`packs/resources-<version>.spresources`、它的旁挂 `.sha256`、以及 `resource-manifest.json`。
**清单必须显式给**（`tier` 是内容判断，工具不替作者猜）。然后**必须同步改**：

1. `pack.json.assets.container` / `assets.manifest`（容器名带 version，重打就变）；
2. `admission-files.json`（本包的做法：`node tools/make-spresources.mjs` 之后按 1 KiB..256 KiB 重新筛一遍并算
   完整 SHA-256 —— 交付物里的 `工具/build-mod4-policy.mjs` 就是这件事）；
3. 记住**换了容器 = 换了身份**：容器摘要进了包的内容哈希，房间的摘要闸门（`welcome.mods.digest`）随之改变，
   客户端也会据此判定旧缓存作废。

---

## 6. 装上这个包之后，站点会变成什么样（**先读三遍**）

引擎的资源 Service Worker（`public/resource-sw.js`，**不是本包提供的**）由 `installModAssets` 在 `welcome` 里看到
`modAssets` 时就注册，口径是 `type:'module'`、`scope:'/'`、`updateViaCache:'none'`。它接管之后：

* 只处理 `GET`，且路径落在 `/assets/`、`/fonts/` 或 `/media/` 的请求，其它一律放行给网络；
* 命中的那些**只用本地已导入并通过校验的缓存**回答，**命不中回 412，绝不回源**。

⇒ **任何**声明了 `assets` 的包都会让这三棵树对**没导入过的玩家**变成 412，而**这与 `serverPolicy` 无关** ——
`serverPolicy` 决定的是**服务端**回不回源（`serve` / `cache-only`），SW 那一半是客户端自己的决策。所以：

* `serverPolicy: "serve"` **不是**「对玩家没有影响」；
* 在一个真实部署里，容器的内容必须覆盖**页面真的会去取的**那三棵树，否则玩家会看到一页没有素材的界面
  （入口闸门会把他拦在标题页，但标题页自己的图也会 412）。

本包带的是**样板容器**，所以：**只应当在「准备导入完整容器」的部署里安装它**；要真的玩起来，先按 §5 重打一份
覆盖完整素材树的容器。这一条已列进 §7 报给业主（措辞上「`serve` 缺省 = 与 B2 之后逐字节相同」容易被读成
「装了也没影响」，实际不是）。

---

## 7. 已验证 / 未验证（一条都不含糊）

> 本节引用的证据文件，在**交付包**里的位置是 `验证/` 与 `工具/`；在作者的开发目录里则是包目录旁边的 `out/`
> 与同级的 `*.mjs`。名字相同，只是目录不同。

### 7.1 已经**被执行过**的（`proof-mod4.mjs`，38/38 通过，产物 `验证/proof-mod4.json`）

装载与装配（用 0.11.0 的**真装载器**，走完整启动路径）：

* `loadWorkshop` 认下这个包；`panelModuleIssues` / `assetsIssues` / `preDispatchIssues` / `i18nIssues` 全过；
* `loadWorkshopHooks` 真的 `import` 了 `server/resourceAdmission.mjs` 并拿到 `createPreDispatch`；
* `dropUnavailablePreDispatchPacks` 没有把它移出已加载集合；
* `loadWorkshopPanels` 注册了 `/workshop-panels/sp-resource-pack/resources/preloadModal.js?v=<hash12>`；
* 旁挂摘要与容器**字节**逐字节核对通过；
* 作者侧校验器：**0 error / 0 warning**（`验证/authoring-validate.json`）。

服务端钩子（自己扮演客户端发帧）：

* 连接建立即收到 `resource.challenge`，3 个 URL 都在容器里，次序即契约；
* 没过闸门时 `room.create` / `room.join` / `room.spectate` / `room.start` **逐个被消费**，回执是
  `RESOURCE_REQUIRED` 且**带 rid**；`intercepts` 之外的类型（`room.loadout`）不消费；
* 用容器里那三个文件的**真实字节**算出的证明 ⇒ `resource.accepted`；放行之后入口消息交给大厅；
* 负例全部被拒：**同一个 nonce 重放**（`detail: "challenge"`）、**错证明**（`detail: "proof[i]"`）、
  **过期的挑战**、**拿另一条连接的 nonce**；
* 结构约束：不注册 socket 监听器、不读全局时钟、模块没有顶层可变状态、`intercepts` 并集正确。

客户端面板（把裸导入改写成 file URL 后在 Node 里真跑：假 DOM + 假 CacheStorage + 真 `crypto.subtle`，导入改写有
**往返逐字节相同**的断言）：

* 挂载即关闸（`required:true, ready:false`）并主动要一次挑战；
* 用**引擎的真导入器**把容器逐文件写进假缓存（38 个文件）；
* **面板算出来的证明被上面那个真服务端模块判为 `accepted`** —— 两半的算式一致不是「照抄注释」，是被执行过的；
* 收到 `accepted` 后面板开闸（`ready:true`）；
* 缓存缺件时**不发**证明（而不是发一个错的）；
* `unmount` 撤掉全部订阅（4 → 0）并摘掉自己的 DOM。

### 7.2 **没有**验证的（本机没有 Chrome）

* 浏览器里真的 `import` 这个面板模块、真的渲染、真的样式叠放；
* 真 SW 的注册 / 作用域 / `clients.claim()` 时序；
* 真 `caches` 的配额行为、`<input type=file>` 的 `File`、`fetch` 真容器（数百 MB）的流式与进度；
* 玩家真的走过的端到端：装包 → 开页 → 导入 → 证明 → 进房间。

这些与 `docs/WORKSHOP.md` §1.9.4 / §4.4 的 standing gap 是同一格（`SP_E2E=1` + 有 Chrome 的机器）。

---

## 8. 仍然存在的缺口（诚实清单）

| # | 缺口 | 性质 |
|---|---|---|
| 1 | **`cache-only` 只有两半合起来才成立**：服务端回 412 且不回源那一半在 B3a 已实现；客户端那一半依赖 SW，而 SW 的应答在本机**没有真浏览器验过** | 引擎侧 standing gap（不是本包能补的） |
| 2 | **索引不分包**：换容器后，不在新清单里的旧 URL 会留在索引里，SW 仍会拿它回答（§4.5） | 引擎侧；要补得让索引按包分段 |
| 3 | **`serverPolicy:"serve"` 的措辞**：SW 与 `serverPolicy` 无关，声明 `assets` 就等于把那三棵树交给 SW 的 412（§6） | 文档措辞 + 引擎行为；见 §9 |
| 4 | ~~**策略文件的内部形状没有装载期闸门**~~ —— **本刀已闭合**：模块导出可选的 `validatePolicy(policy)`，装载器在装配路径上调用它，拒绝就按 `PREDISPATCH_BAD_POLICY` 把**整包**移出已加载集合（§3.1 最后一条；实测见 `验证/proof-mod4.json`）。仍然判不出来的是「一个**不导出** `validatePolicy` 的模块 + 一份内部形状坏掉的策略」——那一格只能由作者自己构建时验 | 已闭合（引擎侧 B6 段，`df805e7` 之后） |
| 5 | **`docs/WORKSHOP.md` §1.9.3 的面板示例把 `gate` 写在「唯一那个会打开闸门的面板」上** ⇒ 照抄会死锁 | 文档；见 §9 |
| 6 | 原件里那些**不属于这个包**的东西：分发用的 QQ 群 / 群文件清单、安装器 / 卸载器 / `mod-manifest.json`、以及原件那套「全局资源集 + 四个产物」的目录布局 | 我们的是「每个包自带一份」，见 `tools/spresources.mjs` 的来源说明；分发渠道是业主的事 |
| 7 | 原件客户端里那些**这个包用不到**的界面细节（进度条的视觉、群公告、`pack-config.js` 那两个常量） | 面板已用引擎流程重写；要复原视觉请改 `resources/preloadModal.js`，不需要任何新接口 |

---

## 9. 需要业主裁决 / 顺手可修的几格（都不是本包能单方面决定的）

1. **`workshop-validate.mjs` 已经修好了**（本仓 `df805e7`）：它原来把「覆盖官方记录的差量补丁」当完整记录判，
   一份**合法**的社区内容包拿到 **184 个 error**。现在对 `pack.json.overrides` 声明过的 id 判的是 `loadData` 的
   合并体（与引擎、编辑器同一份），并补了回归测试。⇒ 这一格本包已经吃到好处：三份包现在都是 **0 error**。
2. **`docs/WORKSHOP.md` §1.9.3 的 `gate` 示例**：原示例把 `"gate": "session.preloadRequired"` 写在**唯一那个会打开
   这个标志的面板**上 ⇒ 照抄的面板**永远挂不上**（`gate` 是「路径为真才挂」，而缺省是 `false`）。**本刀已改**：
   示例去掉了那个 `gate`，并就地加了一段警告说明为什么；§1.9.3 的 `gate` 段也一并改准。
3. **`serverPolicy` 的措辞**：`serve` 那一行「行为与 B2 之后逐字节相同」说的是**服务端**。**本刀已改**：§1.9.4 的
   那张表标题改成「**服务端**对 `/assets`、`/fonts` 做什么」，并加了一段警告 —— SW 的 412 与 `serverPolicy` 无关，
   声明 `assets` 就等于把那三棵树交给 SW，「装了没影响」这个读法是错的。
4. **策略文件的内部形状**：**本刀已落地**（本包已经在用）：`server.preDispatch.module` 可以额外导出
   `validatePolicy(policy)`，装载器在装配路径上调用它（`server/workshop.js validateHookPolicy`），拒绝就按
   `PREDISPATCH_BAD_POLICY` **把整个包移出已加载集合** —— 与「策略不是 JSON 对象」同一个结局。见 §3.1 最后一条。
5. **索引按包分段**（§8 第 2 格）：换容器之后的旧 URL 残留，只有引擎能彻底解决。
