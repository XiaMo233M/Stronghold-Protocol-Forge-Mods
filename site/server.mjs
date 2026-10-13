// 工坊包**上传与审核**服务（零依赖，只用 node 内置）。
//
// 为什么要有它：往 GitHub 提 PR 对投稿的人太麻烦。这个服务把流程压成三步 ——
//   ① 投稿的人在网页上填「mod 名 + 备注」并传 zip；
//   ② 维护者（你）把它**下载下来跑测试**；
//   ③ 测试通过、名称与内容审过之后，点「通过」——它就**上线**到公开列表。
//
// 用法：
//   ADMIN_TOKEN=<一个长随机串> node site/server.mjs
//   （可选）PORT / DATA_DIR / MAX_MB / BASE_URL
//
// 安全上的取舍（这是要放到公网上的东西，所以写清）：
//   · 上传只收 **zip**（验魔数），大小默认上限 100 MB，边收边判，超了立刻断；
//   · 落盘用**服务端生成**的 id 当目录名，永不使用客户端给的文件名（防路径穿越）；
//   · 文件只存不执行、不解压到磁盘；读 zip 只读中央目录；
//   · 审核动作全部要 `x-admin-token`，比对用 timingSafeEqual；
//   · 每个 IP 有上传频率限制；公开列表只暴露已通过的东西。
//
// ⚠️ 一条不能忘的操作纪律（2026-10-11 线上回归的教训，写在这里是为了防下一个人重犯）：
//   **`decide` 这类「批准 / 打回」端点，永远只对「明确指定的 id」一个一个调，
//     绝不对「按条件筛出来的集合」批量调用。**
//   为什么：那天有人想「把该上线的都上线」，就对**一批筛出来的**兼容包连着调了
//   `/compat/decide`，结果把刚刚才打回的两条 demo 样板件**又批准了回去** ——
//   两条过时的样板重新出现在公网 `/api/mods` 上，记录里只剩一个「approved」，
//   看不出它是被哪一次批量操作顺带翻回来的。
//   批准是有后果的动作（上线、放开下载、取代原投稿），只能一条一条指名点姓地做；
//   要「按条件处理」，就先把命中的 id **列出来给人看一眼**，再逐条调。
//
// ================================================================
// 2026-10-12 增补：**发布者自助管理**（认领码 → 发布者令牌）＋ **分类筛选**
// ================================================================
// 业主原话：「发布页能不能改成**发布者能自由管理修改**，有人之前上传那个**整合包更新，
//           他想删掉**，**管理员负责审核**，再加入一个**筛选功能**，让需要的人能更快
//           找到对应分类的模组」。
//
// 落到代码里的**四条不许破的边界**（本文件所有新增段落都受它约束）：
//   ① **发布者不直改公开面**：任何自助写端点都**不得**写 `decision=approved`，
//      也**不得**在未复审时替换公开的 `mod.zip`。改了就必须回到待审（见 `clearDecision`）。
//      ⚠️ 2026-10-14 业主给这一条开了一个**窄口子**：`/api/publisher/restore` 会把**发布者自己
//      软删过的那条**恢复成 `approved`（作者撤回自己那次删除 = 恢复即重新公开，见该段注释）。
//      除此之外一个字没放宽：自助写**永远**不能让**别人**的东西上线。
//   ② **零删除**：任何路径都不删记录、不删文件。旧的 `decision.json` 进 `revisions`
//      留痕、旧包体原样留在目录里（见 `promoteCandidate` / `clearDecision`）。
//      ⚠️⚠️ 2026-10-14 业主**明确授权的唯一例外**：`POST /api/publisher/delete-hard` ——
//      发布者删**自己的**那一条、且**必须两次调用二次确认**，才物理删除记录目录与 blob，
//      且**先落墓碑**（`tombstones/`）再删。除它以外，全站一切照旧零删除。
//   ③ **公开面主判据不动**：`state === 'approved'` 仍然是主判据，只在它之上**加**一条
//      「没有待确认的自撤申请」（`isPubliclyVisible`）—— 见下面那一段的完整说明。
//   ④ **不建第二套账密体系**：发布者令牌与 `ADMIN_TOKEN` 平行、互不替代；
//      `isAdmin` 一个字没改，新增的是平行的 `isPublisher`。令牌**只存哈希**。
//
// 新增端点一览（详细形状见各自的段注释）：
//   POST /api/submit                      ← 响应多一枚一次性**认领码**（`claimCode`）
//   POST /api/publisher/claim             ← 认领码 → 发布者令牌（一次性）
//   GET  /api/publisher/mine              ← 「我的投稿」（凭发布者令牌）
//   POST /api/publisher/update            ← 改元数据（name/note/homepage/packKind/funcKind）⇒ 强制回待审
//   POST /api/publisher/blob              ← 换包体 / 上新版本 ⇒ 写成**候选**，公开面照旧展示旧包
//   POST /api/publisher/withdraw          ← 自撤申请 ⇒ 公开面**立刻**不再列出（落终态要管理员确认）
//   POST /api/publisher/delete            ← **档 1 软删** ⇒ superseded，**一按即生效、不经管理员**
//   POST /api/publisher/restore           ← **档 2 恢复** ⇒ 撤回到 approved（只对自己软删过的那条）
//   POST /api/publisher/delete-hard       ← **档 3 硬删**（物理）⇒ ⚠️ 必须两次调用二次确认 + 先落墓碑
//   POST ${ADMIN_API}/withdraw-decide     ← 管理员确认 / 拒绝自撤
//   POST ${ADMIN_API}/promote-blob        ← 管理员批准候选包体（切换公开包体）
//   POST ${ADMIN_API}/issue-claim         ← 管理员手工发认领码（老记录 / 找回令牌）
//   POST ${ADMIN_API}/funkind             ← 管理口**功能类目**归类（6 类，一次一条，记 revisions + audit）
//   POST ${ADMIN_API}/supersede           ← ⭐ **「以新为准」**：一对（newId + oldId，必须同 pack.id）⇒ 旧的
//                                            superseded + replacedBy（**旧的是 compat 也行**，2026-10-13 放开）；
//                                            只追加 decision.json 与一笔 meta.revisions，零删除
//   GET  /mods?kind=…  与  GET /api/mods?kind=…   ← 技术维度筛选，**不传 = 现状**（一字未改）
//   GET  /mods?func=…  与  GET /api/mods?func=…   ← 功能类目筛选（6 类；可与 kind 叠加）
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, createReadStream, statSync, renameSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries, readZipFile, looksLikeZip } from './zip.mjs';
import { reviewName, reviewLabel, reviewEntries, hasBlocker, reviewContainer, reviewSelfDecl, reviewCompatPackJson, needsAcknowledge, ACK_CODES } from './review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, 'pages');

const PORT = Number(process.env.PORT || 8787);
/** 默认只绑回环 —— 想对外就显式设 HOST=0.0.0.0（部署脚本会设）。本机试跑因此不会意外暴露。 */
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = resolve(process.env.DATA_DIR || join(HERE, 'data'));
const SUBS = join(DATA_DIR, 'submissions');   // 普通投稿
const FLAGGED = join(DATA_DIR, 'flagged');    // **疑似夹带游戏素材**的投稿 —— 单独一处，便于整体处理或清空
/**
 * 维护者侧的**兼容包**（已兼容改写完的成品）。单独一处的理由和 flagged/ 一样，是「便于分开处理」：
 *   · <编号>/mod.zip          新包装 —— 它是**通过后公开可下的那一个**（改写版）
 *   · <编号>/orig.zip         被改写的原件 —— **留档，不发布**（要下只有维护者带 ?variant=orig）
 *   · <编号>/meta.json        两份署名（原作者 / 兼容者）＋ 来源与两个哈希
 *   · <编号>/decision.json    审核决定
 *   · <编号>/pack-json.orig.json  改写版里 pack.json 的**原件快照** —— 原注释一字不变的凭据
 */
const COMPAT = join(DATA_DIR, 'compat');
/**
 * ⚠️⚠️ **墓碑区**（tombstone）—— 全站**唯一**一处「删了之后还留着东西」的落点。
 *
 * 为什么要有它：业主 2026-10-14 授权了一条**唯一的零删除例外** —— 发布者**硬删（物理删）
 * 自己的那一条**，且**必须二次确认**。物理删的纪律是「**先审计后删**」：动手之前先把一份
 * 墓碑写进这里（**独立于记录本体**，所以删掉记录目录也带不走它），然后才删记录目录与 blob。
 *
 * 墓碑里放什么：id / name / packId / sha256 / size / 删除时间 / actor / ip / 原因 / 删掉的文件清单。
 * **它不参与任何业务读**：公开面、审核台、`/api/mods` 都不读这里；它只有两个用途：
 *   ① 事后查「这一条到底发生了什么」；② `/api/publisher/restore` 用它区分
 *   「**被物理删过**（不可恢复 ⇒ 410）」与「**压根没这条**（404）」。
 *
 * ⚠️ 边界（写在代码里、也写在报告里）：**只有这一条路**会删东西。除它以外，全站一切照旧零删除。
 */
const TOMBS = join(DATA_DIR, 'tombstones');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BYTES = Number(process.env.MAX_MB || 100) * 1024 * 1024;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
/**
 * 管理口的 IP 白名单（逗号分隔）。设了就**只有**这些地址（外加本机回环）能碰审核页与审核 API。
 * 站点只有 HTTP、没有 HTTPS 时，这条是保护令牌的主要手段 —— 配合 SSH 隧道用：
 *   ssh -L 25570:127.0.0.1:25570 root@<服务器>
 *   （线上生产实例的端口是 25570；代码默认值 8787 只用于本机自起实例）
 * 隧道进来的是回环地址，所以永远放行。
 */
const ADMIN_IPS = (process.env.ADMIN_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
/**
 * 是否信任 `x-forwarded-for`。**默认不信任** —— 直接暴露时这个头谁都能伪造，
 * 拿它当限流或白名单的依据等于没设防。只有确实挂在反代后面（且反代会覆盖这个头）时才设 TRUST_PROXY=1。
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
/**
 * 审核入口的路径名（默认 `admin`）。改成一个别人猜不到的名字，能少掉一大票**自动扫描**：
 * 全网一直在有人按字典扫 `/admin`、`/wp-admin`、`/phpmyadmin` 这类常见路径。
 *
 * **说清楚它是什么**：这只是「减少噪音」，**不是**安全屏障。真正拦住人的是
 * ADMIN_IPS（只认回环）+ 令牌两道。名字只是别让扫描器注意到这里有个门。
 */
const ADMIN_PATH = String(process.env.ADMIN_PATH || 'admin').trim().replace(/^\/+|\/+$/g, '');
if (!/^[a-z0-9][a-z0-9_-]{2,40}$/.test(ADMIN_PATH)) {
  console.error('✖ ADMIN_PATH 只能是小写字母/数字/-/_，3–40 位，且以字母或数字开头。例如 ADMIN_PATH=review-7f3a1c');
  process.exit(2);
}
const ADMIN_API = `/api/${ADMIN_PATH}`;

/**
 * 备注长度上限（业主 2026-10-12 裁定：4000 → 20000）。
 *   · **单一常量**：`/api/submit` 的备注、`compat-submit` 的兼容说明、`compat/note` 与 `note`
 *     都引它 —— 改之前三处各写一个硬编码的 4000，各写各的会继续漂移。
 *   · `NOTE_BODY_MAX` 是**报文体**的上限，不是文案上限：20000 个汉字按 UTF-8 最坏 4 字节/字
 *     是 80 KB，加 JSON 转义与包装 128 KB 足够。旧值 16 KB 会让「上限 20000」在汉字上
 *     先被 413 挡住 —— 文案上限与报文上限必须一起抬。
 *   · ⚠️ 已知边界：`/api/submit` 与 `compat-submit` 的备注是**查询串**传的，
 *     实际天花板是 Node 的请求头上限（默认 16 KB），不是这个常量。
 *     要写长备注走**报文体**那条路（`compat/note` / `note`）。
 */
/** 「装上到底会不会生效」的闭枚举 —— 与 `/api/mods` 的三档一致（那一处缺省给 `unknown`）。
 *  `/api/mods` 的注释逐字：「缺省**绝不可能是 functional**」。 */
const PACK_KINDS = Object.freeze(['functional', 'documentation', 'unknown']);
/**
 * ⭐⭐ **功能类目**（业主 2026-10-14 裁定，6 类）—— 与上面那个 `PACK_KINDS` **是两个维度**，
 * 故意不复用同一个键（复用了就必然互相踩）：
 *
 *   · `packKind` = **技术维度**：「装上到底会不会生效」（functional / documentation / unknown）。
 *     它**一个字节都不改** —— `tools/collect-station.mjs:119` 的镜像入选判据读的就是它，
 *     `mods/` 那 31 条镜像与 `mods/index.json` 的 30 条**全靠这一栏活着**。
 *   · `funcKind` = **功能维度**：「这包是干什么的」（下面这 6 类）。这是业主真正要的那个分类。
 *
 * 为什么是 `uncategorized` 而不是沿用 `unknown`：两个维度各说各的话。老记录**没有** `funcKind`
 * ⇒ 读时缺省落 `uncategorized`（**绝不猜**：业主口径「不确定的一律落未分类，等人工过」）。
 * `unknown` 继续只表示技术维度里的「判不了会不会生效」，语义不许被稀释。
 *
 * 缺省**绝不是**任何一个真功能类 —— 与 `packKind` 那条口径逐字同源：
 * 一条没分过类的记录**不许**在「游戏玩法」区里露面。
 */
const FUNC_KINDS = Object.freeze(['gameplay', 'expansion', 'utility', 'assets', 'documentation', 'uncategorized']);
const FUNC_KIND_TITLES = Object.freeze({
  gameplay: '游戏玩法', expansion: '拓展包', utility: '实用工具',
  assets: '素材替换', documentation: '说明文档', uncategorized: '未分类',
});
/** 「装上会不会生效」那一档里，**算真有功能**的那四个功能类目（`documentation` / `uncategorized` 不算）。 */
const FUNC_KINDS_FUNCTIONAL = Object.freeze(['gameplay', 'expansion', 'utility', 'assets']);

const NOTE_MAX = 20000;
const NOTE_BODY_MAX = 128 * 1024;

/**
 * 「兼容者」= **必填字段，但值可以为空**（业主 2026-10-11 改口径；上一版那套
 * 「表单预填 + 服务端兜底 Mo233」**已作废**，全站不再有 `COMPAT_AUTHOR_DEFAULT`）。
 *   · 提交时这一栏**必须在报文里** —— 缺字段 ⇒ 拒绝，理由「缺少兼容者字段」；
 *   · 值**允许为空** —— 空就如实存空（站点侧标 `compatAuthorSource: 'empty'`），
 *     界面上一律显示「未填」，**不许**编一个名字顶上，也**不许**把这一栏藏掉；
 *   · **任何路径下都不许自动填、不许回落 `Mo233`** —— `Mo233` 只可能是维护者手敲进去的字面值。
 *
 * 判「缺字段」与「值为空」用的是 `URLSearchParams.has()` 与 `get()` 的区别：
 * `?compatAuthor=` 是「填了、但是空的」（合法），连这个参数都没有才是「缺字段」（拒绝）。
 */

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error('✖ 必须设置 ADMIN_TOKEN（至少 16 位），否则谁都能通过审核。例如：');
  console.error('    ADMIN_TOKEN=' + randomBytes(24).toString('hex') + ' node site/server.mjs');
  process.exit(2);
}
mkdirSync(SUBS, { recursive: true });
mkdirSync(FLAGGED, { recursive: true });
mkdirSync(COMPAT, { recursive: true });
mkdirSync(TOMBS, { recursive: true });

const ID_RE = /^[a-z0-9]{6,32}$/;
const nowIso = () => new Date().toISOString();
const idOf = () => randomBytes(6).toString('hex');            // 12 位十六进制
const tokenOf = () => randomBytes(16).toString('hex');        // 给投稿人的回执令牌
/**
 * ⭐ 一次性**认领码**：16 个 Base32 字符（字母表去掉 0/O/1/I/L）—— 目的只有一个，
 * **让人念得出来、抄得下来、抄错还有救**（这就是要交给发布者保存的那一串）。
 * 80 bit 熵，穷举不现实；换令牌走 `timingSafeEqual` 定长比较（形状不对的输入也照比一次）。
 */
const CLAIM_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CLAIM_RE = /^[2-9A-HJ-NP-Z]{16}$/;
const claimOf = () => {
  const b = randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += CLAIM_ALPHABET[b[i] % 32];
  return s;
};
const sha256Hex = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
/** 认领码**只存哈希** ⇒ 盘上（含备份）永远没有明文，泄露也换不出发布者令牌。 */
const claimHashOf = (code) => sha256Hex(`sp-modsite/claim/v1:${String(code || '').trim().toUpperCase()}`);
/** 发布者令牌**只存哈希**。 */
const tokHashOf = (tok) => sha256Hex(`sp-modsite/publisher-token/v1:${String(tok || '')}`);

const EMPTY32 = Buffer.alloc(32);
/**
 * 「这枚令牌是不是这一条记录的发布者令牌」—— **只返回布尔**。
 *
 * ⚠️ 两条纪律（与 `tokenOk` 同源，但比它更严）：
 *   ① **只存哈希**：`meta.publisherTokens[]` 里是 `{ h, at, by }`，没有明文可偷；
 *   ② **定长比较**：输入先哈希成 32 字节，再逐条 `timingSafeEqual`。任何形状的输入
 *      （空串 / 超长 / 非 ASCII）都**照比一次**，不因「长度不对」提前返回 ——
 *      否则「这条在不在」「令牌像不像」会从耗时上漏出去。
 */
function publisherTokenOk(meta, token) {
  const list = Array.isArray(meta?.publisherTokens) ? meta.publisherTokens : [];
  const given = Buffer.from(tokHashOf(token), 'hex');
  let hit = false;
  for (const t of list) {
    let buf = EMPTY32;
    const h = String(t?.h || '');
    if (/^[0-9a-f]{64}$/.test(h)) { try { buf = Buffer.from(h, 'hex'); } catch { buf = EMPTY32; } }
    if (buf.length === given.length && timingSafeEqual(buf, given)) hit = true;
  }
  return hit;
}
/** 一枚认领码在不在这一条的待用清单里（同样定长比较）。 */
function claimOk(meta, code) {
  const list = Array.isArray(meta?.pendingClaim) ? meta.pendingClaim : [];
  const given = Buffer.from(claimHashOf(code), 'hex');
  let hit = false;
  for (const c of list) {
    let buf = EMPTY32;
    const h = String(c?.h || '');
    if (/^[0-9a-f]{64}$/.test(h)) { try { buf = Buffer.from(h, 'hex'); } catch { buf = EMPTY32; } }
    if (buf.length === given.length && timingSafeEqual(buf, given)) hit = true;
  }
  return hit;
}
/**
 * 这枚发布者令牌有没有资格动**这一条**记录。
 * ⚠️ **只在「按 id 指名点姓」的端点里用** —— 绝不做全库枚举（那既是枚举口、又慢）。
 */
const isPublisher = (meta, token) => !!token && publisherTokenOk(meta, token);

/** 令牌从哪来：`x-publisher-token` 头，或 `Authorization: Bearer <token>`。 */
const publisherTokenOf = (req) => {
  const h = String(req.headers['x-publisher-token'] || '').trim();
  if (h) return h;
  const a = String(req.headers.authorization || '');
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
};

/**
 * ⚠️ **公网可见性**（业主 2026-10-12 裁定 ②）：一条记录除了「决定是 approved」，
 * 还**必须没有待确认的自撤申请**。
 *
 * 为什么要有后半句：发布者点「撤下」要**立刻见效** —— 他不想让自己的包再挂在那儿；
 * 而「管理员二次确认」是**流程**上的事，不能拖成「先挂着等人点」。所以申请一提交，
 * 公开面（`/api/mods`、`/mods`、`/api/file` 的公开下载口）立刻不再列它、也不再让人下；
 * 记录、`decision.json`、包体**一个字节都不动**（零删除）。
 * 管理员点确认 ⇒ 才真正落 `decision=superseded`；点拒绝 ⇒ 清标志位，它照旧上线。
 *
 * 这条判据**只加不减**：`state === 'approved'` 那条主判据一个字没改。
 */
const isPubliclyVisible = (s) => s.state === 'approved' && s.withdrawRequested !== true;

/**
 * 审核台「发布者自撤待确认」队列：`withdrawRequested === true` 且**还没转成终态**。只数数、不改盘。
 * 已经 `superseded`（管理员确认过）或这条本来就被打回（`rejected`）的，都不算「待确认」。
 */
const withdrawQueue = () => allSubs().filter((s) => s.withdrawRequested === true
  && s.state !== 'superseded' && s.state !== 'rejected');

// ---------------------------------------------------------------- 数据模型常量（新增段落用）

/** 审计日志：**一行一条 JSON，只追加**（见 audit()）。 */
const AUDIT_LOG = join(DATA_DIR, 'audit.jsonl');
/** 候选包体的文件名：发布者换包体时**新包写这里**，公开面照旧是旧的 `mod.zip`（裁定 ⑦）。 */
const CANDIDATE_BLOB = 'mod.pending.zip';
/** 每条记录最多留几枚发布者令牌（旧令牌丢失就再发一枚，不回收 —— 零删除）。 */
const TOKEN_MAX = 8;
/** 认领码有效期（天）。过期只是不再接受兑换，记录里的哈希照旧留着（零删除）。 */
const CLAIM_TTL_DAYS = 30;
/** 自撤申请原因为空时用的兜底文案；**不是**替发布者编理由，只是给审核台一行可读的字。 */
const WITHDRAW_DEFAULT_REASON = '发布者自撤（未填理由）';
/**
 * ⭐ **发布者自助删除**的缺省理由字面量（业主 2026-10-12 二次裁定）。
 *
 * 为什么是英文的机器可读字面量、而不是一句中文：它要能被**机械判据**认出来
 * （「这条是被发布者自己删的」），手写中文理由会让每个消费者各写一套正则。
 * 发布者自己填了理由时，那一句原样进 `reason`；没填才是这个缺省值。
 */
const PUBLISHER_DELETE_REASON = 'publisher-delete';
/**
 * ⚠️ **硬删（档 3）的二次确认凭据**。
 *
 * 口径（业主 2026-10-14）：硬删**绝不允许一次调用就动手** ——
 *   第一次调用只做**预检**并返回一枚一次性 `confirmToken`（盘上只存它的哈希，与认领码同一套纪律）；
 *   第二次调用必须同时给出 `confirmToken` 与**精确匹配的包名**（`confirmName`）才真删。
 * 令牌有 TTL：过期要重新走一次第一步（避免一枚凭据被无限期挂着当后门）。
 */
const HARD_DELETE_TOKEN_TTL_MS = 10 * 60 * 1000;
const hardDeleteTokenHash = (t) => sha256Hex(`sp-modsite/hard-delete/v1:${String(t || '').trim()}`);

/**
 * ⭐ **极简追加式审计日志**（裁定 ⑧ ①）。
 *
 * 落点 `<DATA_DIR>/audit.jsonl`：**一行一条 JSON，只追加**（`appendFileSync`），从不改写、从不删除。
 * 与 `meta.revisions` 的分工：revisions 是**记录自己**的改动史（翻记录时看得到）；
 * 这份日志是**跨记录的事件流**（谁、什么时候、从哪个 IP、以什么身份、动了哪一条）——
 * 出事第一眼看它，比把几十个 `meta.json` 挨个翻一遍快得多。
 *
 * ⚠️ **不记令牌明文**：认领码、发布者令牌、ADMIN_TOKEN、Basic 头一律一个字节都不写；
 *   记的是**事件**（`claimIssued` / `tokenClaimed` / `adminAuth`），不是凭据。
 * 形状：`{ at, action, id, ip, actor, admin, detail }`，`actor` ∈ `admin` / `publisher` / `public`。
 * 失败**绝不影响主流程**：这是留痕，不是业务。写不进去（只读盘之类）时请求照常成功，控制台告警一行。
 */
function audit(action, { id = null, ip = null, actor = 'public', admin = false, detail = null } = {}) {
  let line;
  try { line = JSON.stringify({ at: nowIso(), action, id, ip, actor, admin: admin === true, detail }) + '\n'; }
  catch { return; }                                     // detail 有循环引用之类：放弃这一笔，不影响请求
  try { appendFileSync(AUDIT_LOG, line, 'utf8'); }
  catch (e) { console.error('[audit] 写不进去（不影响这次请求）：', e.message); }
}
/** 留痕时**只留字段名、不留值** —— 避免把正文/凭据抄进日志。 */
const keysOf = (o) => Object.keys(o || {}).sort();

/**
 * 把一份 `decision.json` **移进 `meta.revisions` 留痕**，并让这条记录的判定回到**缺省**。
 *
 * 为什么这么做（裁定 ⑤）：本站的 `pending` **不是一个写出值**，而是「`decision.json` 不存在」
 * 的**读时缺省**（`allSubs()` 与 `/api/status` 都是这么读的；`/decide` 的白名单也从不收 `pending`）。
 * 所以「发布者改了东西 ⇒ 强制回待审」的正确做法就是：**把那一份决定原样搬进 revisions、文件不再存在**
 * —— 记录与判定一个字都没丢（零删除），而公开面立刻不再列它（`state` 读出来就是 `pending`）。
 *
 * 返回被搬走的那一份（没有就返回 null）。**只动 meta.json，不删任何文件。**
 */
function clearDecision(id, why, by) {
  const P = pathsOf(id);
  if (!P) return null;
  const meta = readJson(P.meta);
  if (!meta) return null;
  const prev = readJson(P.decision);
  if (!prev) return null;                               // 本来就没有决定：已经是待审，无事可做
  const at = nowIso();
  const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
  writeJson(P.meta, {
    ...meta,
    revisions: [...hist, {
      at, by,
      changed: { decision: prev.decision, at: prev.at ?? null, by: prev.by ?? null },
      to: { decision: 'pending（文件缺省：decision.json 已移入本笔留痕）' },
      why,
      // 原样留一份搬走的决定，日后翻记录能逐字看到「上一版是怎么判的」。
      decisionSnapshot: prev,
    }],
  });
  // ⚠️ 这里是**唯一**会移除 decision.json 的地方。它不是「删记录」：
  //    内容已逐字进 revisions.decisionSnapshot，判定回到读时缺省（pending），
  //    记录目录、meta.json、包体、留档原件**一个都没动**（零删除）。
  try { unlinkSync(P.decision); } catch { /* 移不动也不能把请求打挂 */ }
  return prev;
}

/**
 * 把一条记录**原样搬进 superseded**（自撤 / 管理员指定取代者都走这里）。
 *
 * 与 `markReplacedBy` 的关系：那个函数管「被别的记录取代」（`replacedBy` 指向一条真实记录）；
 * 这个函数管**自撤**（`replacedBy: null`，无取代者）—— 业主 2026-10-12 裁定 ①：
 * 「允许 `decision=superseded` 且 `replacedBy: null`（自撤）」，但**只对发布者自撤这条路放宽**；
 * 管理员驱动的 superseded **仍强制要求 `replacedBy` 指向一条 approved**（旧不变量不许被放宽）。
 *
 * 只写它自己的 `decision.json`，**不动 meta.json、不删任何文件**。
 */
function markSelfWithdrawn(id, { reason = WITHDRAW_DEFAULT_REASON, by = 'admin', ip = null, at = null, direct = false } = {}) {
  const q = dirOf(id);
  if (!q || q.area === 'compat') return null;           // 兼容包不来自发布者，不走自撤
  const m = readJson(join(q.dir, 'meta.json'));
  if (!m) return null;
  const when = at || nowIso();
  const prev = readJson(join(q.dir, 'decision.json'));
  // ⚠️ 两条路**合用一个函数**（判据只有一份），差别只在「谁点的」与留痕块的名字：
  //    · direct=false ← `withdraw-decide` 的 confirm：管理员确认发布者的自撤申请；
  //    · direct=true  ← `POST /api/publisher/delete`：发布者凭自己的令牌**自助删除**，
  //      **不经管理员** —— 理由缺省就是这个机器可读字面量（业主口径 `reason:"publisher-delete"`）。
  const why = String(reason || (direct ? PUBLISHER_DELETE_REASON : WITHDRAW_DEFAULT_REASON));
  const trace = direct
    ? {
      publisherDelete: {                              // 自助删除专用的留痕块（与 publisherWithdraw 同层）
        reason: why,
        at: when, by, ip: ip || null,
        requestedAt: m.withdrawRequestedAt || null,
        note: '发布者凭自己的发布者令牌**自助删除**（不经管理员确认）：这一条转为 superseded 终态、'
          + '公开面与下载口立刻不再提供。**软删** —— 记录、包体、留档与全部留痕一个都没删（零删除，可恢复）。',
      },
    }
    : {
      publisherWithdraw: {
        reason: why,
        requestedAt: m.withdrawRequestedAt || null,
        confirmedAt: when,
        by,
        ip: ip || null,
        note: '发布者自撤并经管理员确认：这一条不再单独上线。记录、包体、留档一个都没删（零删除）。',
      },
    };
  writeJson(join(q.dir, 'decision.json'), {
    decision: 'superseded',
    reason: why,
    at: when, by,
    displayName: m.name || null,
    // ⭐ 自撤 / 自助删除：**没有取代者**。这一栏照给（值为 null），免得前端「有键/无键」两种读法。
    replacedBy: null,
    ...trace,
    reasonBeforeSupersede: prev ? (prev.reason ?? null) : null,
  });
  return when;
}

/**
 * ⭐ **恢复（档 2）**：把发布者**自己软删**的那一条放回公开面。
 *
 * 业主口径（2026-10-14）：「给作者一个撤回通道」—— 恢复后回到 `approved`
 * （作者自己的东西，恢复即重新公开），并留三笔痕：`withdrawHistory` / `revisions` / `audit`。
 *
 * ⚠️ 三条边界，缺一条就不许恢复：
 *   ① 只有**发布者自助删除**造成的那种 superseded 能恢复（标志是 `decision.publisherDelete`）；
 *      「被更新的版本取代」（`replacedBy` 指向一条真记录）**不许**在这里复活 —— 那会让公网上
 *      同时出现两版，且顶掉 `markReplacedBy` 的结论（那种要管理员走 `/decide`）。
 *   ② 兼容包不在自助范围内。
 *   ③ `meta.json` 读不出来 ⇒ 返回 null（不动它）。
 *
 * **只写 `decision.json`，不动 meta.json、不删任何文件**（重新公开 = 把那份判定换回 approved）。
 * 返回 `{ at }`；不能恢复返回 `{ error }`（形状不对一律**先算不写**）。
 */
function restorePublisherDeleted(id, { by = 'publisher', ip = null } = {}) {
  const P = pathsOf(id);
  if (!P) return { error: '没有这条记录' };
  if (P.area === 'compat') return { error: '兼容包不在发布者自助范围内（它是维护者侧的改写成品）' };
  const meta = readJson(P.meta);
  if (!meta) return { error: '这条记录的 meta.json 读不出来（形状不对），不动它' };
  const prev = readJson(P.decision);
  if (!prev || prev.decision !== 'superseded') {
    return { error: '这条现在不在「已撤下」状态里，没有可恢复的东西', state: prev ? prev.decision : 'pending', notRestorable: true };
  }
  const wasPublisherDelete = !!(prev.publisherDelete);
  if (!wasPublisherDelete) {
    return { error: '这条是被**别的版本取代**的（superseded 有取代者），不在这条自助恢复通道的范围内 —— 请找维护者', replacedBy: prev.replacedBy ?? null, notRestorable: true };
  }
  const at = nowIso();
  const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
  const wh = Array.isArray(meta.withdrawHistory) ? meta.withdrawHistory : [];
  writeJson(P.decision, {
    decision: 'approved',
    reason: null, at, by,
    displayName: meta.name || null,
    // 留一份「上一份判定」，翻记录能逐字看到它原先是怎么被撤下的。
    restoredFrom: prev,
    publisherRestored: {
      at, by, ip: ip || null,
      deletedAt: prev.at ?? null,
      note: '发布者凭自己的发布者令牌**撤回了那次自助删除**：这一条重新公开。'
        + '恢复是「把判定换回 approved」，记录、包体、留档**本来就都在**（软删的另一半）。',
    },
  });
  writeJson(P.meta, {
    ...meta,
    withdrawRequested: false,
    withdrawHistory: [...wh, { at, by, action: 'restored', reason: null, ip }],
    revisions: [...hist, {
      at, by,
      changed: { decision: 'superseded（发布者自助删除）' },
      to: { decision: 'approved（发布者撤回删除）' },
      why: '发布者撤回自助删除：判定回到 approved，这一条重新出现在公开面与下载口。零删除 —— 一个字节都没动过。',
    }],
  });
  audit('publisherRestored', { id, ip, actor: by, detail: { deletedAt: prev.at ?? null } });
  return { at };
}

/** 墓碑文件路径 / 读墓碑。⚠️ 只有 `ID_RE` 形状的 id 才去读（防路径穿越）。 */
const tombstonePath = (id) => join(TOMBS, `${id}.json`);
const readTombstone = (id) => (ID_RE.test(String(id || '')) ? readJson(tombstonePath(id)) : null);
/** 递归列一个目录下的**文件**（相对路径，`/` 分隔，已排序）—— 硬删前把这一份清单写进墓碑。 */
function listFilesOf(root, prefix = '') {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFilesOf(join(root, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}
/** 写墓碑：**先审计后删**里的「审计」那一半，落在独立目录（删记录目录带不走它）。 */
function writeTombstone(id, entry) {
  mkdirSync(TOMBS, { recursive: true });
  writeJson(tombstonePath(id), entry);
}

/**
 * ⚠️ **硬删前的引用体检**：「有引用时先报人」是业主给的纪律 —— **不擅自动手**。
 *
 * 查两类**站点内**能看见的引用：
 *   ① 有别的记录的 `replacedBy` 指向这一条（删了它，那条的取代链就断了）；
 *   ② 有别的记录用**同一个 `pack.json` id**（引擎不允许同 id 并存，删了会影响对方的存在性判断）。
 * ⚠️ 站点**看不见仓库**：`mods/<packId>/` 那份镜像里还有没有它的目录，**服务器上查不到** ——
 *    这一点在响应里如实写进 `mirrorWarning`，交给人核；**绝不**自作主张去动仓库。
 */
async function hardDeleteRefs(id) {
  const all = allSubs();
  const self = all.find((s) => s.id === id) || null;
  // ⚠️ packId 的取法与 `/api/mods` **同一份实现**（`signatureOf`，带缓存）——
  //    不复用就会有第三种「这个包的 id 是什么」的读法，迟早各说各话。
  const myPack = self ? (await signatureOf(self)).packId : null;
  const refs = [];
  for (const s of all) {
    if (s.id === id) continue;
    if (s.decision && String(s.decision.replacedBy || '') === id) refs.push({ id: s.id, why: '它的 replacedBy 指向这一条' });
    if (myPack) {
      const pid = (await signatureOf(s)).packId;
      if (pid && pid === myPack) refs.push({ id: s.id, why: `同 pack.json id（${myPack}）—— 一次只能装一条` });
    }
  }
  return { refs, packId: myPack };
}

/**
 * ⭐ **批准候选包体**（裁定 ⑦ 的后半句）：把发布者换上的 `mod.pending.zip` 正式切成公开的 `mod.zip`。
 *
 * 「零删除」怎么落：
 *   · 旧的 `mod.zip` **不删** —— 它改名成 `mod.superseded-<ts>.zip` 留在**同一个目录**里；
 *   · 上一版发布时的 `sha256` / `size` / `entryCount` 一起记进 `meta.revisions`，翻记录就能比；
 *   · 候选文件本身是**改名**过来的（不是拷贝后删除），所以全程只是「搬位置」，没有一步是删除。
 *
 * 返回 `{ ok, id, sha256, oldSha256, archived, at }`；形状不对 / 候选不在 / 哈希对不上
 * 一律**先算不写**（磁盘上什么都不动）。
 *
 * ⚠️ `expectedSha256`：候选是发布者传的，批准前必须**照记录里的哈希核一次**，
 *    防「审的是 A、切上去的是 B」（与 `approveGate` 里那条同一个道理）。
 */
function promoteCandidate(id, { by = 'admin', expectedSha256 = null } = {}) {
  const P = pathsOf(id);
  if (!P) return { error: '没有这条记录' };
  const meta = readJson(P.meta);
  if (!meta) return { error: '这条记录的 meta.json 读不出来，不动它' };
  const cand = readJson(join(P.dir, 'candidate.json'));
  if (!cand) return { error: '这条没有待批的候选包体' };
  const candPath = join(P.dir, CANDIDATE_BLOB);
  if (!existsSync(candPath)) return { error: '候选包体的文件不在（记录里有、盘上没有），不动它' };
  const live = createHash('sha256').update(readFileSync(candPath)).digest('hex');
  const want = expectedSha256 || cand.candidate?.sha256 || null;
  if (!want) return { error: '候选记录里没有哈希，不能切 —— 没有哈希就没法证明切上去的就是审过的那一份' };
  if (live !== want) {
    return { error: `候选包体现在磁盘上的哈希 ${live} 与记录里的 ${want} 不一致（文件被换过）。先核对，别切。` };
  }
  const at = nowIso();
  const oldSha = meta.sha256 || null;
  // 旧包体**改名留档**（不是删除）。时间戳取 ISO 里的数字，名字短、可排序。
  let archived = null;
  if (existsSync(P.blobPath)) {
    archived = `mod.superseded-${at.replace(/[^0-9]/g, '')}.zip`;
    let target = archived;
    for (let i = 1; existsSync(join(P.dir, target)); i++) {
      target = `mod.superseded-${at.replace(/[^0-9]/g, '')}-${i}.zip`;
    }
    archived = target;
    renameSync(P.blobPath, join(P.dir, archived));
  }
  renameSync(candPath, P.blobPath);                      // 候选转正（改名，不是拷贝+删除）
  const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
  writeJson(P.meta, {
    ...meta,
    size: cand.candidate?.size ?? meta.size,
    sha256: live,
    entries: cand.candidate?.entries ?? meta.entries,
    unpackedBytes: cand.candidate?.unpackedBytes ?? meta.unpackedBytes,
    blobName: cand.candidate?.blobName || meta.blobName,
    revisions: [...hist, {
      at, by,
      changed: { sha256: oldSha, size: meta.size ?? null, archivedBlob: archived },
      to: { sha256: live, size: cand.candidate?.size ?? null },
      why: '发布者换包体 / 上新版本，管理员核过哈希后批准：公开包体切到这一份；旧包体改名留档（不删）。',
      candidate: cand.candidate || null,
    }],
  });
  // 候选记录本身**不删** —— 它里面是「上一版候选取自哪一次提交」，改个名继续留在目录里。
  writeJson(join(P.dir, `candidate.applied-${at.replace(/[^0-9]/g, '')}.json`), { ...cand, appliedAt: at, appliedBy: by, appliedSha256: live });
  try { unlinkSync(join(P.dir, 'candidate.json')); } catch { /* 留着也不影响：promoteCandidate 以文件在不在为准 */ }
  clearDecision(id, '管理员批准了发布者换上的新包体 ⇒ 本条回到待审，等一次正常的通过 / 打回（公开面露出的仍是这一份新包体，判定由管理员给）。', by);
  return { ok: true, id, sha256: live, oldSha256: oldSha, archived, at };
}

/**
 * ⭐ 分类筛选（裁定 ⑤ / ⑥ / ⑨ 与需求 ③）：**只复用既有的 `packKind` 闭集**，
 * 不新增分类字段、不要求回填老记录。
 *
 * 读法（`GET /mods?kind=…` 与 `GET /api/mods?kind=…` 共用这一份）：
 *   · **不传** ⇒ 返回 `{ kinds: null }`：调用方走**现状**（全量、三区照旧）；
 *   · `functional` / `documentation` / `unknown` 单个或多个（逗号分隔）⇒ 返回去重后的集合；
 *   · 有任何一个值不在闭集里 ⇒ 返回 `{ error }`（调用方 400）——**不悄悄忽略**，
 *     否则「我筛了但列表没变」会变成查不出来的误会。
 * 空串 / 只有逗号（`?kind=`、`?kind=,`）按**不传**处理（等价于现状）。
 */
function kindFilterOf(url) {
  const raw = url.searchParams.get('kind');
  if (raw == null) return { kinds: null };
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { kinds: null };
  const bad = parts.filter((k) => !PACK_KINDS.includes(k));
  if (bad.length) {
    return { error: `kind 只能是 ${PACK_KINDS.join(' / ')} 之一（可以多选：逗号分隔）。不认识的值：${bad.join(' / ')}` };
  }
  const kinds = [...new Set(parts)];
  // 值域就是三档，全选上了与「不传」等价 —— 但**不合并**：调用方要能区分「用户确实点了全选」。
  return { kinds };
}
/** 一条记录的对外分类（缺省 `unknown` —— 与 `/api/mods` 那条口径逐字一致）。 */
const kindOfRec = (s) => (PACK_KINDS.includes(s?.packKind) ? s.packKind : 'unknown');

/**
 * ⭐ **功能类目**的读法/筛选/派生 —— 全部只有这一处实现（判据一份）。
 *
 * 三个函数的分工：
 *   · `funcKindOf(meta)`      一条记录对外显示的功能类目。**缺省 `uncategorized`**：
 *                             老记录（87 条 `packKind=None` 的那一批）没有这一栏 ⇒ 落未分类，
 *                             **绝不给它们猜一个真功能类**（业主口径）。
 *   · `funcKindFilterOf(url)` `GET /mods?func=…` 与 `GET /api/mods?func=…` 共用这一份读法；
 *                             非法值 **400 不悄悄忽略**（与 `kindFilterOf` 同一条纪律）。
 *   · `packKindFor(funcKind)` ⭐ **一致性判据**：功能类目一旦落库，技术维度就**照着它派生**
 *                             —— 「说明文档」这一类装上就不启用功能、四个真功能类就是 functional、
 *                             未分类 ⇒ unknown（**不猜**）。两栏因此不可能各说各话。
 *                             ⚠️ 它**只在新写入时跑**，**绝不回头改老记录**（那才是瞎猜）。
 */
const funcKindOf = (m) => (FUNC_KINDS.includes(m?.funcKind) ? m.funcKind : 'uncategorized');
const packKindFor = (fk) => (fk === 'documentation' ? 'documentation'
  : (FUNC_KINDS_FUNCTIONAL.includes(fk) ? 'functional' : 'unknown'));
function funcKindFilterOf(url) {
  const raw = url.searchParams.get('func');
  if (raw == null) return { funcs: null };
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return { funcs: null };
  const bad = parts.filter((k) => !FUNC_KINDS.includes(k));
  if (bad.length) {
    return { error: `func 只能是 ${FUNC_KINDS.join(' / ')} 之一（可以多选：逗号分隔）。不认识的值：${bad.join(' / ')}` };
  }
  return { funcs: [...new Set(parts)] };
}

// ---------------------------------------------------------------- 数据模型字段（新增）
/**
 * `meta.json` 新增字段（老记录一个都没有 ⇒ 老记录一律**不可认领**，裁定 ④）：
 *
 *   pendingClaim     Array<{ h, at, by, ip }>  待用的**认领码哈希**（`h` 是 sha256，**无明文**）。
 *                                              缺省 / 不存在 ⇒ 这条没有待领的码。
 *   publisherTokens  Array<{ h, at, by }>      发布者令牌哈希（同样无明文）。缺省 ⇒ 无人认领。
 *   publisherChanged boolean                   曾经被发布者改过（审核台加个标记用）。缺省 false。
 *   withdrawRequested boolean                  自撤申请待管理员确认。缺省 false（**不存在就是没有**）。
 *   withdrawRequestedAt string|null            ISO 时间。
 *   withdrawReason   string|null               发布者自己填的理由（可为空字符串）。
 *   withdrawHistory  Array<{...}>              自撤申请的流水（含被拒绝的那些，零删除）。
 *   candidate        object|null              待批的候选包体描述（见下面 `/api/publisher/blob`）。
 *   funcKind         string                     ⭐ **功能类目**（业主 2026-10-14 裁定，6 类）：
 *                                              gameplay / expansion / utility / assets /
 *                                              documentation / uncategorized。**老记录一个都没有** ⇒
 *                                              读时落 `uncategorized`（未分类），等维护者手工过 —— **绝不猜**。
 *   pendingHardDelete object|null              ⚠️ 硬删第一步留下的待确认凭据哈希（`{ h, at, ip }`）。
 *                                              只存 sha256，10 分钟有效、用一次即随记录一起被删掉。
 *
 * `decision.json` 新增字段：
 *   replacedBy: null                           **自撤专用**（裁定 ①）。管理员驱动的 superseded
 *                                              照旧强制要求它是形状正确、且指向 approved 的编号。
 *   publisherWithdraw object                   管理员确认自撤那一笔的完整留痕（谁、什么时候、什么理由）。
 *   publisherDelete  object                    ⭐ 发布者**自助软删**那一笔的留痕（档 1，不经管理员）。
 *   publisherRestored object                  ⭐ 发布者**撤回删除**那一笔的留痕（档 2）；
 *                                              恢复后的判定是 `approved`，原判定留在 `restoredFrom` 里。
 *   reasonBeforeSupersede string|null          自撤前的决定理由（自撤后 `reason` 被换成自撤理由）。
 *
 * 「自撤申请」是**在 meta 上**、不是新状态：`state` 仍然只有 approved / rejected / superseded / pending
 * 四档读法，一个都没新增 —— 所以公开面、审核台三视图、`/api/status` 的老读法全都不受影响。
 */

// ---------------------------------------------------------------- 文件与记录小工具
/**
 * 一个投稿住哪个区：疑似素材的在 flagged/，其余在 submissions/；兼容包在 compat/。
 */
const AREAS = { normal: SUBS, flagged: FLAGGED, compat: COMPAT };
const dirIn = (area, id) => join(AREAS[area] ?? SUBS, id);
/** 按编号找它的目录（三个区都找一遍）；找不到返回 null。 */
const dirOf = (id) => {
  for (const area of ['compat', 'flagged', 'normal']) {
    const d = dirIn(area, id);
    if (existsSync(join(d, 'meta.json'))) return { area, dir: d };
  }
  return null;
};
/**
 * 一个编号对应哪个文件：
 *   `mod`  —— 要**发布**的那一份（普通投稿就是它自己；兼容包是**改写版**）
 *   `orig` —— **只留档、不发布**的原件（只有兼容包有）
 *
 * 用一份实现，免得「公开下载」和「留档下载」哪天走到两个不同的地方去。
 */
const blobNames = { mod: 'mod.zip', orig: 'orig.zip' };
const pathsOf = (id, variant = 'mod') => {
  const f = dirOf(id);
  if (!f) return null;
  const blob = blobNames[variant] || blobNames.mod;
  return {
    ...f, variant, blob,
    meta: join(f.dir, 'meta.json'),
    decision: join(f.dir, 'decision.json'),
    blobPath: join(f.dir, blob),
    packJsonOrig: join(f.dir, 'pack-json.orig.json'),
  };
};
/**
 * 「原件留档」这条链接到底能不能给出 —— **按磁盘实况判**，不看 `kind`、不看记录里怎么写的。
 *
 * 兼容包的 `orig.zip` 只在走 `POST .../compat-submit` 时、且 `compatOf` 有值那一支才会被拷出来
 * （见上面 `copyFileSync(op.blobPath, join(dir,'orig.zip'))`）。早先**手工逐个批准**上线的兼容包，
 * 走的是 `/compat/link` 事后补 `compatOf`，那条路只补字段、**不补文件** —— 于是目录里根本没有 `orig.zip`。
 *
 * 早先这里写的是 `kind === 'compat'`，等于无条件发链接：前端拿到一个 `GET /api/file/<id>?variant=orig`
 * 必然是 404 的地址。业主 2026-10-12 的硬要求是「不能出现下载 mod 但是不能用的情况」，
 * 所以判据改成**只认文件在不在**：不在就输出 `null`（字段照给，值为 null，前端按缺省处理）。
 *
 * 与 `GET /api/file/<id>?variant=orig` 那段共用同一个 `pathsOf`，两处判据不会各说各话。
 */
const origArchiveOf = (id) => {
  const P = pathsOf(id, 'orig');
  return P && existsSync(P.blobPath) ? `/api/file/${id}?variant=orig` : null;
};
/** 「待批候选包体」的同源下载口（只有维护者能下，见 `/api/file` 段）。 */
const candidateArchiveOf = (id) => {
  const P = pathsOf(id);
  return P && existsSync(join(P.dir, CANDIDATE_BLOB)) && existsSync(join(P.dir, 'candidate.json'))
    ? `/api/file/${id}?variant=candidate` : null;
};

const metaPath = (id) => pathsOf(id)?.meta ?? null;
const blobPath = (id) => pathsOf(id)?.blobPath ?? null;
const decisionPath = (id) => pathsOf(id)?.decision ?? null;
const readJson = (p) => { if (!p) return null; try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');

/**
 * 客户端报的文件名**只用来拼下载时显示的名字**，从不参与落盘路径 ——
 * 落盘一律用服务端生成的编号当目录名（防路径穿越）。所以这里可以放心往里带名字。
 */
const blobNameFromHeader = (req, fallback = 'mod.zip') => {
  let n = '';
  try { n = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { n = ''; }
  return n.replace(/[\\/:*?"<>|]/g, '_').slice(-120) || fallback;
};

/** 公开可下的条件：已通过。兼容包同样适用（它通过后公开的就是改写版）。 */
const isPublic = (id) => readJson(decisionPath(id))?.decision === 'approved';

/** 这个投稿是不是「维护者侧兼容包」。 */
const isCompat = (id) => dirOf(id)?.area === 'compat';

/**
 * 「不再显示」标志位（业主 2026-10-11）—— **落在记录自己的 `meta.json` 上**：
 *   `hidden: true|false` ＋ `hiddenBy` ＋ `hiddenAt`。
 *
 * 为什么要有它（业主原话）：「因为有可能 mod 名字和兼容后的名字不一样，导致依旧存在两个 mod
 * （一个在兼容，一个在上传待定），所以给我一个勾选框，选后就不显示这个 mod 了」。
 * 自动配对走的是 `compatOf` + `markReplacedBy`，而**名字不一致时人未必配得上对** ——
 * 于是同一份 mod 会在审核页上出现两次。这个标志位给维护者一个**人眼可判**的开关：
 * 不依赖名字、不依赖自动配对，勾上就不显示、取消就回来。
 *
 * 边界（**定死**，见 `POST ${ADMIN_API}/hide` 那一段的完整说明）：
 *   · 只影响**审核页的三个视图**显不显示这一条；
 *   · **公网 `/api/mods` 与 `/mods` 一个字节都不动** —— 要下架请用「打回」（`decision=rejected`），
 *     所以 `isPublic()`、公开列表、两个下载口**都不看**这个标志位（这里刻意不碰它们）；
 *   · **可逆**：取消勾选写回 `hidden:false`，记录、文件、判定一个都不改。
 */
const isHidden = (m) => !!m && m.hidden === true;

/** 包里的 pack.json（只读它一条，最多 1 MB；读不到/解析不了都返回 null）。 */
async function packJsonFor(file) {
  const m = await readZipFile(file, ['pack.json']);
  const buf = m.get('pack.json');
  if (!buf || buf.length > 1024 * 1024) return null;
  try { return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * 不透明容器（`.spresources`）**看进去**：把 zip 里每个 `.spresources` 条目取出来，
 * 交给 `reviewContainer`（纯函数）解析清单并逐条跑既有判据。
 *
 * 为什么必须有：容器是 ZIP 里**一个**大二进制，ZIP 层的检查只看得到它自己那一条记录
 * （名字 + 大小），容器内部的路径**一条都没过** —— 2026-10-12 那次 43.2 MB 的素材容器
 * 就是这样一路 `info`、`suspected=false` 的。这里补的就是"看一眼里面到底装了什么"。
 */
async function reviewOpaqueFor(zipFile, entries) {
  const out = [];
  const conts = (entries || []).filter((e) => !e.dir && /\.spresources$/i.test(e.name));
  for (const c of conts) {
    let buf = null;
    try { buf = (await readZipFile(zipFile, [c.name])).get(c.name) || null; } catch { buf = null; }
    out.push(...reviewContainer(buf, { containerName: c.name }));
  }
  return out;
}

/**
 * 两处盲区的检查（**warn 档 + 要显式确认**，不是 blocker）：
 *   ① 不透明容器内部清单（`reviewOpaqueFor`）
 *   ② `pack.json.description` 与上传备注里**作者自己的自述**（`reviewSelfDecl`）
 * 返回值还要给调用方算 `ackRequired`：命中 `ACK_CODES` 就得发布时点头。
 */
async function blindSpotFlags(zipFile, entries, { note = null } = {}) {
  const out = [];
  out.push(...(await reviewOpaqueFor(zipFile, entries)));
  let description = null;
  try { const pj = await packJsonFor(zipFile); description = pj && pj.description; } catch { description = null; }
  out.push(...reviewSelfDecl({ note, description }));
  return out;
}

/** 命中"要点头"的 code → 去重后的清单（写进 meta.ackCodes，供审核页与 /decide 用）。 */
const ackCodesOf = (flags) => [...new Set((flags || []).filter((f) => ACK_CODES.includes(f.code)).map((f) => f.code))];

/**
 * 一条记录的**原作者**从哪来 —— 公网 `/api/mods` 那两个署名栏用的就是它。
 *
 * **只推导，绝不回写**（业主 2026-10-11 口径）：这里一个字节都不写进
 * `meta.json` / `decision.json` / `mod.zip`，读完即走。
 *
 *   · **兼容包**（`kind === 'compat'`）：记录里本来就有这两栏 —— 发布时预填自包内 `pack.json`，
 *     或维护者手填（`authorSource: 'maintainer'`）。**原样透出，一个字不动**。
 *   · **普通投稿**：记录里**没有** `author` 这一栏（`/api/submit` 写的 meta 就没有它，
 *     历史记录里也没有），所以去**包内的 `pack.json`** 读 `author` —— 那是这份包自己声明的原作者。
 *     读到了就标 `authorSource: 'pack.json'`：**与兼容包预填时同一个来源名**，不造第二套口径。
 *     包内没写 / 读不出来 / 解析不了 ⇒ `author: null`：**不代填、不编名字**，
 *     公网那一页照旧不画署名框（现行为不变）。
 *
 * **缓存**（为什么必须有、放在哪、什么时候失效）：
 *   · 为什么：`/api/mods` 每个请求都要给每条记录这两个栏位。没有缓存，就是**每个请求解一遍 zip**；
 *   · 放在哪：进程内存里的一个 Map（`id -> { key, value }`）——**不落盘**。
 *     落盘就等于「往记录目录写东西」，那是本任务明文禁止的；
 *   · 什么时候失效：缓存键是 `mod.zip` 的 `size:mtimeMs`。站点从不改写这个文件，
 *     所以它一变（换了文件、重传、手改）键就对不上，下一次请求自然重读；
 *     实例重启缓存清空；记录不存在/读不了就顺手把这一条丢掉。
 *   · 有条数上限只是防止无界增长（记录数本来就在几十条这个量级）。
 */
const AUTHOR_CACHE = new Map();
const AUTHOR_CACHE_MAX = 512;
async function packAuthorOf(id) {
  const file = blobPath(id);
  if (!file) return null;
  let key;
  try {
    const st = statSync(file);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    AUTHOR_CACHE.delete(id);            // 文件没了：缓存跟着走，别拿旧结果顶
    return null;
  }
  const hit = AUTHOR_CACHE.get(id);
  if (hit && hit.key === key) return hit.value;
  let value = null;
  try {
    const pack = await packJsonFor(file);
    const a = pack && typeof pack.author === 'string' ? pack.author.trim() : '';
    // 同一次读顺带把包内 `pack.json` 的 `id` 也带回来 —— 公网要按它找「**同一个 pack id 的成对记录**」
    // （指令㉑：引擎不允许同 id 并存，玩家一次只能装一条，这件事必须在卡片上直接点出来）。
    // 读不到 id 就是 null：**不猜、不编**，拿不到就不画那一行（见 pages/mods.html 的 sameIdPeers）。
    const pid = pack && typeof pack.id === 'string' ? pack.id.trim() : '';
    value = { author: a || null, authorSource: a ? 'pack.json' : null, packId: pid || null };
  } catch {
    value = null;                        // zip 坏了 / 条目加密 ⇒ 当作「读不到」，不是错误页
  }
  if (AUTHOR_CACHE.size >= AUTHOR_CACHE_MAX) AUTHOR_CACHE.delete(AUTHOR_CACHE.keys().next().value);
  AUTHOR_CACHE.set(id, { key, value });
  return value;
}

/** 公网列表里一条记录的两个署名栏（**只读记录，绝不写**；见 packAuthorOf）。 */
async function signatureOf(s) {
  if (s.kind === 'compat') {
    // 兼容包的原始 id 记录里本来就有（发布时从包内 pack.json 抄下来的），不必再解一次 zip。
    return { author: s.author || null, authorSource: s.authorSource || null, packId: (s.pack && s.pack.id) || null };
  }
  const fromPack = await packAuthorOf(s.id);          // 有缓存：同一条记录只解一次 zip
  // 署名：记录里万一已经有这一栏（历史记录或别的入口写进去的），**以记录为准** ——
  // 推导只补「记录里没有」的那一格，绝不覆盖记录里已有的字。
  const auth = s.author
    ? { author: s.author, authorSource: s.authorSource || null }
    : { author: (fromPack && fromPack.author) || null, authorSource: (fromPack && fromPack.authorSource) || null };
  // packId 一律取自包内 pack.json —— 它就是「同 id 不能并存」那条判据里的 id。
  return { ...auth, packId: (fromPack && fromPack.packId) || null };
}

/**
 * 兼容包「可不可以发布」的那三道硬门。**只有一份实现**：
 *   · `POST ${ADMIN_API}/compat-submit?...&publish=1` —— 投稿详情页那个**独立的上传按钮**，
 *     一次动作 = 上传 + 通过 + 发布（业主口径的「点发布就发布兼容包」）；
 *   · `POST ${ADMIN_API}/compat/decide` 的通过分支 —— 对已经在记录里的兼容包补一次通过 / 打回。
 * 两处走同一份规则，免得「从哪个门进来的」决定了检查松紧。
 * （另有一条 `POST ${ADMIN_API}/compat/link`：只给**已经在记录里、已经通过**的兼容包补
 *   `compatOf` 并让原投稿按 B 口径置 superseded。它不改决定、不发布，也不走这三道门。）
 * 返回 `{ error }` 表示不能发（调用方 409 原样回给页面）；返回 `{ ok: true }` 才是放行。
 */
function approveGate(P, M) {
  // ① 两个署名各占一栏。硬要求只有一条：**原作者**不许为空。
  //    「兼容者」是必填字段但**值可以为空**（空 = 未填，如实保留、如实显示），
  //    所以用 required: false —— 空的兼容者**不会**拦在这里。
  const flags = [...reviewName(M.name),
    ...reviewLabel({ label: '原作者', prefix: 'AUTHOR', value: M.author }),
    ...reviewLabel({ label: '兼容者', prefix: 'COMPAT_AUTHOR', value: M.compatAuthor, required: false })];
  const blockers = flags.filter((f) => f.level === 'blocker');
  if (blockers.length) {
    return {
      error: '署名这关没过 —— 见 flags。「原作者」是硬要求（不许为空）；'
        + '「兼容者」这一栏必填但值可以为空，所以空的兼容者不会拦在这里。',
      flags: blockers, needsSignatures: true,
    };
  }
  // ② 第三方来源：**可以为空**（业主口径：「第三方来源也能为空，因为大部分备注里都有了」）。
  //    这里不再 409 —— 来源留白就如实留白（与「兼容者」那一栏同一个口径：字段在、值可以为空）。
  // ③ 原注释快照必须在（这就是「原 description 一字未变」的凭据）。
  const snap = readJson(P.packJsonOrig);
  if (!snap) {
    return { error: '这条缺 pack.json 原件快照，不能通过：那份快照是「原注释一字未变」的凭据。', needsPackSnapshot: true };
  }
  // ④ 要发布的是**现在磁盘上这一份**改写版 —— 用哈希核一次，避免「审的是 A、发的是 B」。
  const liveSha = createHash('sha256').update(readFileSync(P.blobPath)).digest('hex');
  if (liveSha !== M.sha256) {
    return { error: '要发布的那份改写版与记录里的 sha256 不一致（文件被换过）。先核对，别发。', needsResha: true };
  }
  return { ok: true, snapshot: snap };
}

/**
 * 把一份 pack.json 快照与**眼下的** pack.json 逐字段比一遍，把「哪一栏被动了」直接摆出来
 * —— 别只说「不一致」，那对排查没用。返回 null 表示一致。
 */
async function packDiff(P, snapshot) {
  const nowPack = await packJsonFor(P.blobPath);
  if (!nowPack) return { unreadable: true };
  const frozen = JSON.stringify(snapshot.pack, Object.keys(snapshot.pack).sort());
  const current = JSON.stringify(nowPack, Object.keys(nowPack).sort());
  if (frozen === current) return null;
  const changed = {};
  for (const k of new Set([...Object.keys(snapshot.pack || {}), ...Object.keys(nowPack)])) {
    const a = JSON.stringify(snapshot.pack?.[k] ?? null);
    const b = JSON.stringify(nowPack[k] ?? null);
    if (a !== b) changed[k] = { snapshot: snapshot.pack?.[k] ?? null, now: nowPack[k] ?? null };
  }
  return { changed };
}

/** 通过时的完整硬门：署名 → 快照在 → 快照里的原注释一字未变 → 磁盘上那份没被换过。 */
async function compatPublishGate(P, M) {
  const g = approveGate(P, M);
  if (g.error) return g;
  const diff = await packDiff(P, g.snapshot);
  if (!diff) return { ok: true };
  if (diff.unreadable) return { error: '改写版里的 pack.json 现在读不出来 —— 不能发布。' };
  return {
    error: '包自带的 pack.json 与留档快照不一致 —— 「保持原注释不变」是硬要求，不能通过。',
    needsPackUnchanged: true, changed: diff.changed,
  };
}

/**
 * 写决定记录 —— 两个入口共用这一份，字段顺序固定，不各写各的：
 *   · 详情页那个**独立上传按钮**（`compat-submit?...&publish=1`，一步到位发布）；
 *   · `/compat/decide` 的通过 / 打回。
 * `decision.json` 与 `meta.json` 的 `displayName` 一起写。
 *
 * `maintainerConfirm`（可选）＝「维护者人工确认」那一笔（见下面 CONFIRM 那一段的运维注释）：
 * 只在**逐条人工确认**放行的记录上出现，原样写进决定记录，含 by / at / 理由 / 命中的档位代码。
 */
function writeCompatDecision(P, M, { decision, reason = null, displayName = null }) {
  writeJson(P.decision, {
    decision, reason: reason || null, at: nowIso(), by: 'admin',
    displayName: displayName || M.name,
    // 发布的是改写版：把「发布哪一个」明确写进决定记录里。
    publishedVariant: decision === 'approved' ? 'mod.zip（兼容改写版）' : null,
    archivedVariant: M.origin?.archived ? 'orig.zip（被改写的原件，留档不发布）' : null,
    author: M.author || null,
    compatAuthor: M.compatAuthor || null,
    acknowledgedSuspected: M.suspected === true && decision === 'approved',
    // 人工确认放行的那一笔（没有就是 null）：谁、什么时候、为什么、命中了哪几档。
    maintainerConfirm: M.maintainerConfirm || null,
    rewriteSha256: M.sha256 || null,
    originId: M.origin?.id || M.compatOf || null,
    originSha256: M.origin?.sha256 || null,
  });
  // displayName 同时落进 meta.name —— 公网列表读的就是这一栏。
  if (displayName && displayName !== M.name) writeJson(P.meta, { ...M, name: displayName });
}

/**
 * 兼容包发布后，把**被它取代的那条投稿**记一笔：状态置 `superseded`（已取代），
 * 指向取代它的兼容包编号。
 *
 * 业主口径（2026-10-11 **定死为这一种**）：兼容包一发布，原投稿就
 *   · **移出待审队列**（状态不再是 pending —— 这就是「投稿也不是、打回也不是」的解药：
 *     它有了明确的终态，而不是卡在队列里）；同时
 *   · **记录与文件一个都不删**（decision.json 只加不删、meta.json 与 mod.zip 原样留着），
 *     并且 `replacedBy` 里写明「由哪条兼容包取代、那条叫什么、什么时候取代的」——可追溯。
 *
 * 只写它自己的 decision.json，**不动它的 meta.json、不删任何文件**。
 *
 * **取代者是谁**（业主 2026-10-12 扩展）：这个函数本来就不限制取代者 —— 它只拦「**被取代者**不能是兼容包」。
 * 锁住取代者的是**调用点**：`compat-submit?publish=1` / `/compat/decide` / `/compat/link` 传进来的永远是
 * compat 区记录。`/decide` 现在也收 `superseded`（必须带 `replacedBy`）⇒ **投稿取代投稿**这一路也走这里，
 * 于是 `replacedBy.area` **按取代者的实际区给**（不再写死 `'compat'`）、理由文案也按区换词。
 * ⚠️ 兼容性：既有三个调用点传的都是 compat 记录 ⇒ `byArea === 'compat'` ⇒ 产出的 `reason` 与
 * `replacedBy.area` 与从前**逐字相同**（老路径零变化）。
 *
 * ⭐ **2026-10-13 政策「以新为准」**（业主原话：以后所有 mod 以新为准 —— 新的上线、旧的下架但不删除）：
 * 本函数原先那道 `q.area === 'compat'` 的硬拦**已删除** —— **被取代者也可以是兼容包**
 * （同一个 `pack.id` 的旧兼容版被新版本下课时，走的正是这条路）。取代者的类型本来就不设限
 * （投稿、兼容包都行）。判据不再按 area 拦，改为**由调用方在写盘前**走 `checkSupersede()`
 * 统一核「两条都存在 / 不是自己 / 不构成取代环」，新端点再外加一道「同 `pack.id`」。
 * ⚠️ 本函数的**输出形状一个字没改**（`decision.json` 的键与顺序与改动前逐字相同）——
 *    老路径的回归钉子（selftest-compat 的 6g-1/2/3）照旧钉着它。
 * 这个状态**不是锁**：日后要人工纠错，维护者照样可以用 `/decide` 覆盖这一条
 * （本站的原则是「不许把记录弄成不可处置」）。
 *
 * ⚠️ **自撤不走这里**（业主 2026-10-12 裁定 ①）：自撤是 `replacedBy: null`，没有取代者，
 *    走 `markSelfWithdrawn()`。这个函数**一个字没改** —— 它产出的 `replacedBy` 永远是一条真实记录。
 */
function markReplacedBy(origId, byId, byName) {
  if (!origId || origId === byId) return null;
  const q = dirOf(origId);
  // ⭐ 「以新为准」(2026-10-13)：被取代者**可以是 compat** —— 不再按 area 拦，只要求这条记录在。
  if (!q) return null;
  const bq = dirOf(byId);
  const byArea = bq ? bq.area : null;                            // 取代者住在哪个区（不再写死 'compat'）
  const om = readJson(join(q.dir, 'meta.json'));
  if (!om) return null;
  const at = nowIso();
  writeJson(join(q.dir, 'decision.json'), {
    decision: 'superseded',
    reason: `已由${byArea === 'compat' ? '兼容包' : '投稿'} ${byId}（${byName}）取代并发布 —— 这一条不再单独上线，避免公网出现两份。`,
    at, by: 'admin',
    displayName: om.name || null,
    replacedBy: { id: byId, name: byName || null, area: byArea, at },
  });
  return { id: origId, at };
}

/**
 * 一条记录的 `pack.id`（**「以新为准」的同一性判据**）—— 两处证据，按强度取：
 *   ① `mod.zip` 里 `pack.json` 的 `id`（真正会发布的那一份；与 `signatureOf` 同一个读取器）；
 *   ② 退回记录里预填的那一栏 `meta.pack.id`（兼容包发布时从包内抄下来的，见 compat-submit）。
 * 两处都读不到 ⇒ 返回 `null`：**不猜、不编**，调用方据此报 `SUPERSEDE_PACK_ID_UNREADABLE`。
 */
const packIdOfRecord = async (id) => {
  const P = pathsOf(id);
  if (!P) return { packId: null, source: null };
  let packId = '';
  let source = null;
  try {
    const pj = await packJsonFor(P.blobPath);
    if (pj && typeof pj.id === 'string' && pj.id.trim()) { packId = pj.id.trim(); source = 'mod.zip 的 pack.json'; }
  } catch { /* 读不了 zip：下面退回记录里那一栏 */ }
  if (!packId) {
    const m = readJson(P.meta) || {};
    const fromMeta = m.pack && typeof m.pack.id === 'string' ? m.pack.id.trim() : '';
    if (fromMeta) { packId = fromMeta; source = 'meta.pack.id（记录里预填的）'; }
  }
  return { packId: packId || null, source };
};

/**
 * 取代链：从 `id` 起顺着 `decision.json` 的 `replacedBy` 走一遍，返回经过的编号（含起点）。
 * 盘上本来就成环时**见到重复就停**（别在这里转不出来 —— 判据要能对坏数据作出判断）。
 */
function supersedeChain(id, max = 64) {
  const seen = [];
  let cur = id;
  while (cur && seen.length < max) {
    if (seen.includes(cur)) break;
    seen.push(cur);
    const d = readJson(decisionPath(cur));
    cur = d && d.replacedBy && typeof d.replacedBy.id === 'string' ? d.replacedBy.id : null;
  }
  return seen;
}

/**
 * ⭐ **「以新为准」的唯一一份判据**（业主 2026-10-13 总政策）。取代这件事只在这里判一次，
 * 两个入口共用：
 *   · `POST ${ADMIN_API}/supersede` —— 「以新为准」的安全操作，**强制同 `pack.id`** + **要求新的已在公开面**；
 *   · `POST ${ADMIN_API}/decide` 的 `superseded` 分支 —— 管理员的明确指令，历史用法允许跨 id
 *     （人工纠正/合并），因此**不核 pack.id**；可见性也只要求 approved（老口径，一个字没放宽）。
 *
 * **先算不写**：任何一道不过就返回错误对象，磁盘上什么都不改。错误一律带机器可读的 `code`：
 *   SUPERSEDE_OLD_ID_SHAPE       400  oldId 形状不对
 *   SUPERSEDE_NEW_ID_SHAPE       400  newId 形状不对
 *   SUPERSEDE_SELF               400  自己取代自己
 *   SUPERSEDE_OLD_NOT_FOUND      404  被取代的那条不存在
 *   SUPERSEDE_NEW_NOT_FOUND      404  取代者那条不存在
 *   SUPERSEDE_PACK_ID_UNREADABLE 422  读不出 pack.id ⇒ **不猜**、不动它
 *   SUPERSEDE_PACK_ID_MISMATCH   409  两条不是同一个 pack.id（只有 requireSamePack 的入口核这一道）
 *   SUPERSEDE_CYCLE              409  会构成取代环（A→B→A），`chain` 里给出整条链
 *   SUPERSEDE_NEW_NOT_APPROVED   409  取代者还没 approved（防公网「两份都没有」）
 *   SUPERSEDE_NEW_NOT_VISIBLE    409  取代者 approved 但有待确认的自撤申请 ⇒ 现在并不在公开面上
 *
 * ⚠️ 判据顺序：**结构性的排在状态性的之前**（形状 → 自己 → 存在 → pack.id → 环 → 可见性）。
 *    于是「A 已被 B 取代、又反过来要 B 被 A 取代」这种请求报的是**环**（真正的原因），
 *    而不是先甩一句「B 还没 approved」把人引到错的方向。
 */
async function checkSupersede(oldId, newId, { requireSamePack = false, requireVisible = false } = {}) {
  const bad = (status, code, error, extra = {}) => ({ error, code, status, ...extra });
  const o = String(oldId || '').trim();
  const n = String(newId || '').trim();
  if (!ID_RE.test(o)) return bad(400, 'SUPERSEDE_OLD_ID_SHAPE', 'oldId 形状不对（6–32 位小写字母/数字）');
  if (!ID_RE.test(n)) return bad(400, 'SUPERSEDE_NEW_ID_SHAPE', 'newId 形状不对（6–32 位小写字母/数字）');
  if (o === n) return bad(400, 'SUPERSEDE_SELF', '新旧不能是同一条 —— 一条记录不能自己取代自己。');
  if (!existsSync(metaPath(o))) return bad(404, 'SUPERSEDE_OLD_NOT_FOUND', `找不到被取代的那条编号 ${o}（旧的）`);
  if (!existsSync(metaPath(n))) return bad(404, 'SUPERSEDE_NEW_NOT_FOUND', `找不到取代者那条编号 ${n}（新的）`);

  let packId = null;
  if (requireSamePack) {
    const a = await packIdOfRecord(o);
    const b = await packIdOfRecord(n);
    if (!a.packId || !b.packId) {
      return bad(422, 'SUPERSEDE_PACK_ID_UNREADABLE',
        `读不出包内 pack.id（旧 ${o}：${a.packId || '读不到'}；新 ${n}：${b.packId || '读不到'}）—— `
        + '「以新为准」必须先证明这是**同一个 mod 的两个版本**；读不出就不猜、也不动它。',
        { packIdOld: a.packId, packIdNew: b.packId });
    }
    if (a.packId !== b.packId) {
      return bad(409, 'SUPERSEDE_PACK_ID_MISMATCH',
        `两条不是同一个 pack.id（旧 ${o} = ${a.packId}；新 ${n} = ${b.packId}）—— `
        + '不相关的 mod 不许走这条路（避免误下架无关记录）。',
        { packIdOld: a.packId, packIdNew: b.packId });
    }
    packId = a.packId;
  }

  const chain = supersedeChain(n);
  if (chain.includes(o)) {
    // 展示的是**闭环本身**：从新的那条一路走到旧的那条，再回到新的那条。
    const loop = [...chain, n];
    return bad(409, 'SUPERSEDE_CYCLE',
      `会形成取代环：${loop.join(' → ')} —— 取代链必须是一条线，不许绕回自己。`,
      { chain: loop });
  }

  const newMeta = readJson(metaPath(n)) || {};
  const newDec = readJson(decisionPath(n));
  if (!newDec || newDec.decision !== 'approved') {
    return bad(409, 'SUPERSEDE_NEW_NOT_APPROVED',
      `取代者 ${n} 还不是 approved（当前 ${newDec ? newDec.decision : 'pending'}）—— `
      + '先把它批上线再来取代，否则公网上会出现「两份都没有」。');
  }
  if (requireVisible) {
    // 判据复用同一份实现（approved + 没有待确认的自撤申请），不许在这里再写一遍。
    if (!isPubliclyVisible({ ...newMeta, state: newDec.decision })) {
      return bad(409, 'SUPERSEDE_NEW_NOT_VISIBLE',
        `取代者 ${n} 虽然 approved，但还带着**待确认的自撤申请**（withdrawRequested）—— 它现在并不在公开面上，`
        + '这样换过去等于「两份都没有」。先把那条申请处理掉再来。');
    }
  }
  return { ok: true, oldId: o, newId: n, packId, chain, newMeta, newDec };
}

const allSubs = () => {
  const out = [];
  for (const [area, root] of Object.entries(AREAS)) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      const meta = readJson(join(root, e.name, 'meta.json')) || {};
      const decision = readJson(join(root, e.name, 'decision.json')) || null;
      out.push({ id: e.name, area, kind: area === 'compat' ? 'compat' : 'submission', ...meta, decision, state: decision ? decision.decision : 'pending' });
    }
  }
  return out.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
};

// ---------------------------------------------------------------- HTTP 小工具

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers });
  res.end(body);
};
const sendJson = (res, code, obj, headers = {}) =>
  send(res, code, JSON.stringify(obj, null, 2), { 'content-type': 'application/json; charset=utf-8', ...headers });
const sendPage = (res, name) => {
  const p = join(PAGES, name);
  if (!existsSync(p)) return send(res, 404, '页面不存在', { 'content-type': 'text/plain; charset=utf-8' });
  send(res, 200, readFileSync(p), { 'content-type': 'text/html; charset=utf-8' });
};
/** 自带样式表。零依赖：就是读自己 pages/ 下的一个文件发出去，不引外链、不拉 CDN。 */
const sendCss = (res) => {
  const p = join(PAGES, 'theme.css');
  if (!existsSync(p)) return send(res, 404, '没有样式表', { 'content-type': 'text/plain; charset=utf-8' });
  // 样式是包在页面里的同一个服务发的，所以「离线/内网」也能用；缓存放一小时够改版时刷新到。
  send(res, 200, readFileSync(p), { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' });
};
/**
 * 审核页的三个视图（业主 2026-10-11：「已经通过的也要另开一页」）。
 * 它们是**三条真实地址**，不是同一个列表上的一档筛选：
 *   · `/<ADMIN_PATH>`                —— 主列表（待审；**已被兼容包取代**的也留在这里，业主已定口径）
 *   · `/<ADMIN_PATH>?view=approved`  —— 已通过，单独一页
 *   · `/<ADMIN_PATH>?view=rejected`  —— 已打回，单独一页
 * 三条路都先过管理口那两道防线（ADMIN_IPS + 令牌），公网 `/` 与公开面一个字节都没碰。
 * 视图名由服务端**白名单**校验后再注入页面（不把 URL 上的任意值写进 HTML）。
 */
const ADMIN_VIEWS = ['main', 'approved', 'rejected'];
/**
 * 发一个「统一皮肤」的页面：把 __CSS__ 换成同源样式表链接、__ADMIN_API__ 换成当前前缀。
 * 两个替换放在一处，页面上就不会漏掉谁 —— 审核前缀是环境变量决定的，漏了就会打到不存在的地址。
 * 审核页还多一个 __VIEW__（当前在哪一页），同样是**白名单校验过**的值。
 * 列表页多一个 __KINDS__（当前分类筛选，同样白名单校验过；只填进 data 属性，不拼 HTML）。
 * ⭐ __MAX_MB__（2026-10-14 上传断连修复）：上传页要**在本地先判体积**、并把「上限多少 MB」
 *    写进 413 的提示里，所以这个数必须由服务端注入 —— 前端自己写死 100 就会与 `MAX_MB` 漂移。
 */
const renderPage = (res, name, opts = {}) => {
  const p = join(PAGES, name);
  if (!existsSync(p)) return send(res, 404, '页面不存在', { 'content-type': 'text/plain; charset=utf-8' });
  const view = ADMIN_VIEWS.includes(opts.view) ? opts.view : 'main';
  const kinds = Array.isArray(opts.kinds) ? opts.kinds.filter((k) => PACK_KINDS.includes(k)) : [];
  // ⭐ 功能类目的当前筛选（同一个白名单纪律：只注入闭集里过滤过的值）。
  const funcs = Array.isArray(opts.funcs) ? opts.funcs.filter((k) => FUNC_KINDS.includes(k)) : [];
  const html = readFileSync(p, 'utf8')
    .split('__CSS__').join('/theme.css?v=3')
    .split('__ADMIN_API__').join(ADMIN_API)
    .split('__VIEW__').join(view)
    // __KINDS__ 只注入**闭集里过滤过**的值（逗号分隔）；不传就是空串（= 现状）。
    .split('__KINDS__').join(kinds.join(','))
    .split('__FUNCS__').join(funcs.join(','))
    // 上传上限（MB）：整数。只注入数字，别的什么都不拼。
    .split('__MAX_MB__').join(String(MAX_BYTES / 1048576));
  send(res, 200, html, { 'content-type': 'text/html; charset=utf-8' });
};
/** 审核页要告诉前端「管理 API 现在挂在哪个前缀下、当前是哪一页」，所以把占位符换掉再发。 */
const sendAdminPage = (res, view = 'main') => renderPage(res, 'admin.html', { view });
const sendFile = (res, path, downloadName, type = 'application/zip') => {
  const st = statSync(path);
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'content-disposition': `attachment; filename="${downloadName.replace(/[^\w.\-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  });
  createReadStream(path).pipe(res);
};

/** 定长比较，避免用密钥长度泄漏信息。 */
const tokenOk = (given) => {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

/** 客户端的真实地址：默认只认 socket，不信可伪造的 x-forwarded-for。 */
const ipOf = (req) => {
  const sock = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!TRUST_PROXY) return sock;
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || sock;
};
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
/** 管理口：先看 IP 白名单（设了才生效），再看凭据。 */
const adminAllowed = (req) => {
  if (!ADMIN_IPS.length) return true;
  const ip = ipOf(req);
  return isLoopback(ip) || ADMIN_IPS.includes(ip);
};

/**
 * HTTP Basic：让**浏览器自己弹登录框**。
 * 有这个就不用去服务器上翻令牌、也不用把令牌敲进网页表单 —— 浏览器会记住，
 * 而且同源请求会自动带上，页面里的 fetch 不用再手动加头。
 * 用户名固定 `admin`（写别的也行，反正只校验密码），密码就是 ADMIN_TOKEN。
 */
const basicOk = (req) => {
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  let dec = '';
  try { dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch { return false; }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  return tokenOk(dec.slice(i + 1));
};
/**
 * 管理口两道防线合起来判定。**这个函数一个字没改**（硬约束：登录/令牌不许动）。
 * 发布者那一侧是**平行的** `isPublisher`（认同一枚发布者令牌），两套互不替代。
 */
const isAdmin = (req) => adminAllowed(req) && (tokenOk(req.headers['x-admin-token']) || basicOk(req));

/** 401 时要带这个头，浏览器才会弹登录框。 */
const askForLogin = (res) =>
  sendJson(res, 401, { error: '需要登录（用户名 admin，密码是服务器 /etc/sp-modsite.env 里的 ADMIN_TOKEN）' },
    { 'www-authenticate': 'Basic realm="sp-modsite admin", charset="UTF-8"' });

// 简单的按 IP 限流：每 10 分钟最多 10 次上传。
// ⚠️ 窗口长度**只有这一份**（`RATE_WINDOW_MS`）：两套桶都用它，429 的 `retry-after` 也从它算 —— 
// 三处各写一个 600000 的话，改一处就会让「等 N 分钟」这句话开始骗人。
const RATE_WINDOW_MS = 600000;
const RATE_WINDOW_MIN = RATE_WINDOW_MS / 60000;
const hits = new Map();
const rateLimited = (ip) => {
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter((x) => t - x < RATE_WINDOW_MS);
  arr.push(t);
  hits.set(ip, arr);
  return arr.length > 10;
};

/**
 * 发布者侧写端点的限流（裁定 ⑧ ②：「别只限 `/api/submit`」）。
 *
 * 为什么**另开一套桶**而不是复用 `hits`：两件事的频率完全不是一回事 ——
 * 「投稿」一个人一天发一次；「认领 / 改元数据 / 换包体 / 自撤」是**操作**，正常用起来
 * 一分钟能点好几下（改个名字、再改个分类）。共用一个桶的话，发布者刚投完稿就动不了自己那条了。
 *
 * 口径：**每 IP 每 10 分钟 60 次**（正常人手点绝对到不了；脚本刷就被挡）。
 * ⚠️ 只限**写**端点；`/api/publisher/mine` 那种只读查询不限（否则刷新几下就被锁）。
 */
const pubHits = new Map();
const publisherRateLimited = (ip) => {
  const t = Date.now();
  const arr = (pubHits.get(ip) || []).filter((x) => t - x < RATE_WINDOW_MS);
  arr.push(t);
  pubHits.set(ip, arr);
  return arr.length > 60;
};

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      n += c.length;
      if (n > limit) {
        settled = true;
        // 不在这里掐连接：先让调用方把 413 发出去，发完再收（见下面的响应处理）。
        // 直接 req.destroy() 会让客户端只看到 ECONNRESET，看不到「太大了」这句话。
        req.pause();
        reject(Object.assign(new Error('太大'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
  });

// ---------------------------------------------------------------- 路由

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  const ip = ipOf(req);

  // 这一次请求万一在某条上传路径中途失败，它可能已经往数据目录写了临时文件。
  // 登记在这里，交给下面的 finally 兜住 —— 失败路径**一个都不许**在 DATA_DIR 留下 .part 垃圾。
  // （2026-10-11 实测踩过：被拒的兼容包上传在 DATA_DIR 根下留了一个 <id>.compat.part。）
  let partToClean = null;

  try {
    // ---- 页面
    if (req.method === 'GET' && p === '/theme.css') return sendCss(res);
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return renderPage(res, 'index.html');
    // ⭐ 「我的投稿」页（发布者自助的控制台）。零依赖、内联 JS；`__CSS__` 占位符照旧替换。
    // ℹ️ 这一页**本身不校验令牌**（页面里什么都没有，就是几个空表单）——
    //    真正的门在 `/api/publisher/*` 那几个端点上，每个都独立验令牌、独立限流。
    if (req.method === 'GET' && (p === '/mine' || p === '/mine.html')) return renderPage(res, 'mine.html');
    if (req.method === 'GET' && (p === '/mods' || p === '/mods.html')) {
      // ⭐ 分类筛选（需求 ③）：`/mods?kind=functional` / `?kind=functional,documentation`。
      // **不传 = 现状**（全量、三区照旧）。非法值 400 而不是悄悄忽略 —— 「筛了没变化」最难查。
      const kf = kindFilterOf(url);
      if (kf.error) return sendJson(res, 400, { error: kf.error, kinds: PACK_KINDS });
      // ⭐ 功能类目筛选（业主 2026-10-14）：`/mods?func=gameplay,utility`。两条筛选**可以叠加**，
      //    各管一个维度（技术 / 功能），互不覆盖 —— 与 `/api/mods` 是同一份读法。
      const ff = funcKindFilterOf(url);
      if (ff.error) return sendJson(res, 400, { error: ff.error, funcs: FUNC_KINDS });
      return renderPage(res, 'mods.html', { kinds: kf.kinds || [], funcs: ff.funcs || [] });
    }
    // 审核页本身就要认证 —— 只有**顶层导航**的 401 才会让浏览器弹登录框
    // （fetch 拿到 401 是不弹的，所以认证必须卡在页面这一层）。
    if (req.method === 'GET' && (p === `/${ADMIN_PATH}` || p === `/${ADMIN_PATH}/`)) {
      if (!adminAllowed(req)) return sendJson(res, 403, { error: '这个地址不在管理白名单里（ADMIN_IPS）' });
      if (!isAdmin(req)) return askForLogin(res);
      // 「已通过」「已打回」各自一页（业主 2026-10-11）。视图名白名单校验：不认的值直接 404，
      // 不悄悄回落到主列表 —— 免得「我明明点的是已打回那一页」这种误会查不出来。
      const view = String(url.searchParams.get('view') || 'main').trim() || 'main';
      if (!ADMIN_VIEWS.includes(view)) {
        return sendJson(res, 404, { error: `没有这个视图：view 只能是 ${ADMIN_VIEWS.join(' / ')}` });
      }
      return sendAdminPage(res, view);
    }
    if (req.method === 'GET' && p === '/healthz') {
      return sendJson(res, 200, { ok: true, at: nowIso(), submissions: allSubs().length });
    }

    // ---- 公开：已上线的 mod（**疑似素材的单独一组**，前端要分开显示并标注）
    if (req.method === 'GET' && p === '/api/mods') {
      // ⭐ 分类筛选（可选，**不传 = 现状**，向后兼容）：`?kind=functional` 或 `?kind=a,b`。
      const kf = kindFilterOf(url);
      if (kf.error) return sendJson(res, 400, { error: kf.error, kinds: PACK_KINDS });
      // ⭐ 功能类目筛选（可选，同上）：`?func=gameplay` 或 `?func=gameplay,utility`。
      const ff = funcKindFilterOf(url);
      if (ff.error) return sendJson(res, 400, { error: ff.error, funcs: FUNC_KINDS });
      const shape = (s, sig) => ({
        id: s.id, name: s.name, note: s.note, uploadedAt: s.uploadedAt, size: s.size,
        homepage: s.homepage || null, suspected: s.suspected === true,
        suspectedReasons: s.suspectedReasons || [],
        // 兼容包：**两个署名分开给**，谁也不覆盖谁。公网列表那一页照这两栏分别显示。
        // 普通投稿这两栏里通常只有原作者（没有「兼容者」这回事）——但**原作者照给**：
        // 来源是包内的 pack.json，见 signatureOf（推导，不回写记录）。
        kind: s.kind || 'submission',
        // **另一种** kind：这条包「**装上到底会不会生效**」（指令③④）。与上面那个 `kind`
        // （compat / submission，说的是这条记录**怎么来的**）是两回事，所以**故意不复用同一个键**：
        //   functional    装上即生效 —— 站上每条都过了三道核：① `pack.json` 在 ZIP 根
        //                 （否则解压进 workshop 目录根本不被装载）② 在引擎 0.16.0 的干净 workshop
        //                 根**单独装载 errors=0** ③ `pack.json` 的 `api`/`game` 区间与当前
        //                 MOD_API_VERSION / 上游版本相容；
        //   documentation 说明包 / 参考 / 补丁 —— **装上不会启用任何功能**；
        //   unknown       安装器形态等，判不了就**不放进真功能区**。
        // ⚠️ 记录里没有这一栏（还没分类的、或日后新批的）一律按 **unknown** 给：
        // 缺省**绝不可能是 functional** —— 否则「下载了 mod 却不能用」会从新记录那里漏回来。
        packKind: s.packKind || 'unknown',
        // ⭐⭐ **功能类目**（业主 2026-10-14 裁定的 6 类）—— 这才是「这包是干什么的」那一栏。
        // 与上面的 `packKind`（技术维度：装上会不会生效）**是两个维度、两个键**，故意不复用。
        // 缺省 `uncategorized`（未分类）：老记录没有这一栏 ⇒ 落未分类，**绝不猜**。
        funcKind: funcKindOf(s),
        funcKindTitle: FUNC_KIND_TITLES[funcKindOf(s)],
        // 包内 `pack.json` 的 `id`（兼容包取记录里那一栏）。**只用来做一件事**：让公网那一页
        // 能看出「哪几条是同一个 id」——引擎不允许同 id 并存，玩家一次只能装一条。
        // 读不到就是 null，页面不画那一行（不猜）。
        packId: sig.packId ?? null,
        // 原作者：兼容包取记录里那一栏（发布时预填自包内 pack.json，或维护者手填）；
        // 普通投稿记录里从来没有这一栏 ⇒ 去**包内 pack.json** 读（同一个来源名 pack.json）。
        author: sig.author,
        authorSource: sig.authorSource,           // 'pack.json' / 'maintainer' / null（没有来源就没有名字）
        // 兼容者（**只存在站点侧记录里**，不进 pack.json）。空字符串 = 未填，是**合法值** ——
        // 所以这里**不能用 `|| null`**：那会把「未填」和「压根不是兼容包」混成同一个 null，
        // 公网那一页就没法如实把「未填」那一栏显示出来。
        compatAuthor: typeof s.compatAuthor === 'string' ? s.compatAuthor : null,
        compatAuthorSource: s.compatAuthorSource || null,   // 手填（form）还是未填（empty）
        compatOf: s.compatOf || null,             // 由哪个待审原件改写来（追溯用）
        compatNote: s.compatNote || null,         // 改了什么
        // 相对路径：页面在哪个 origin（公网，或隧道里的 127.0.0.1）就打哪个。
        // 用 BASE_URL 拼绝对地址会让隧道里的页面变成跨域 —— <a href> 时代是跳到公网 IP 被白名单挡掉，
        // fetch 时代则直接 Failed to fetch。
        download: `/api/file/${s.id}`,
        // 只给维护者看的留档入口（公开下载这条路走到它会 403，见 /api/file/ 那一段）。
        // ⚠️ 只有留档文件**真的在磁盘上**才给这一栏：没有 `orig.zip` 的兼容包（早先手工批准上线、
        // 以及 `/compat/link` 事后补链的那几条）发出去就是必然 404 的死链。判据见 `origArchiveOf`。
        archiveDownload: origArchiveOf(s.id),
      });
      // ⭐ **公开面过滤器**（2026-10-12 增补，只加不减）：
      //   · 主判据一个字没改：`state === 'approved'`；
      //   · **只多一条**：排除「发布者申请自撤、等管理员确认」的那些（`isPubliclyVisible`）。
      //     「他想删掉」要立刻见效 —— 见 isPubliclyVisible 的完整说明。
      const approved = allSubs().filter((s) => isPubliclyVisible(s));
      // 逐条推署名来源（**只读**）。只有普通投稿真会去解一次 zip，而且结果有缓存
      // （见 packAuthorOf）；兼容包走记录里那两栏，一次 zip 都不读。
      // Promise.all 保序，所以列表顺序与 filter/map 时代完全一致。
      const shaped = await Promise.all(approved.map(async (s) => ({ s, o: shape(s, await signatureOf(s)) })));
      // 分类筛选在**分组之前**做（两组同一条判据），并且**保留三个分区标题**的既有画法：
      // 服务端只筛数据，页面自己按 KIND_OF 分三块，标题一个没动（需求 ③ 的「保留现有三个分区标题」）。
      const picked0 = kf.kinds ? shaped.filter((x) => kf.kinds.includes(kindOfRec(x.s))) : shaped;
      // ⭐ 功能类目筛选（业主 2026-10-14）：与上面那条**各管一个维度**，所以是**串联叠加**，
      //    不是二选一 —— `?kind=functional&func=utility` = 「既装得上、又是实用工具」。
      const picked = ff.funcs ? picked0.filter((x) => ff.funcs.includes(funcKindOf(x.s))) : picked0;
      const body = {
        mods: picked.filter((x) => !x.s.suspected).map((x) => x.o),
        flagged: picked.filter((x) => x.s.suspected).map((x) => x.o),
      };
      // ⭐ 每类计数（需求 ③：「分区标题旁显示每类计数」）。
      // **只在不筛的时候给**：筛过之后「functional 有 3 条」这种数会因为筛选而变小，
      // 反而误导（用户以为站上只有 3 条功能包）。所以筛过时不给 `counts` 字段，
      // 页面退回按当前这批自己数（那才是屏幕上真实的条数）。
      // ⚠️ 数的是**主分区（非疑似素材）**里的条数 —— 与页面实际画出来的那三个区块**同一口径**：
      //    疑似素材在 `/mods` 上另起一块（「含疑似官方素材的 mod」），不并进任何分类区。
      //    计数若把疑似素材那条也算进「说明包」，就会比用户点进去看到的多 1 条
      //    （实测线上 115 条里 `e3a5d09eb6d3` 正是 approved + documentation + suspected，
      //     它进了疑似那一组 ⇒ 计数 22、点进去只有 21）。这种「数对不上」最招人问，所以数同一批。
      const mainOnly = shaped.filter((x) => !x.s.suspected);
      // 两个维度**各自一套计数**：技术维度叫 `counts`（老读法一字不改），
      // 功能维度叫 `counts.func`（新读法）—— 两份都只在**不筛**的时候给。
      if (!kf.kinds && !ff.funcs) {
        const funcCounts = {};
        for (const k of FUNC_KINDS) funcCounts[k] = mainOnly.filter((x) => funcKindOf(x.s) === k).length;
        body.counts = {
          functional: mainOnly.filter((x) => kindOfRec(x.s) === 'functional').length,
          documentation: mainOnly.filter((x) => kindOfRec(x.s) === 'documentation').length,
          unknown: mainOnly.filter((x) => kindOfRec(x.s) === 'unknown').length,
          flagged: shaped.length - mainOnly.length,
          total: mainOnly.length,
          func: funcCounts,
        };
      }
      body.kinds = kf.kinds;
      body.funcs = ff.funcs;
      body.funcKindTitles = FUNC_KIND_TITLES;
      return sendJson(res, 200, body);
    }

    // ---- 投稿人查自己的状态（要回执令牌）
    if (req.method === 'GET' && p.startsWith('/api/status/')) {
      const id = p.slice('/api/status/'.length);
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对' });
      const meta = readJson(metaPath(id));
      if (!meta) return sendJson(res, 404, { error: '没有这条投稿' });
      const givenRec = url.searchParams.get('t');
      const givenTok = publisherTokenOf(req);
      const byReceipt = givenRec != null && givenRec === meta.receipt;
      // ⭐ 发布者令牌也能查自己那条的状态（认领之后就不必再翻回执令牌了）。
      // **失败时回同一句话、同一个码** —— 不区分「这条不存在」与「令牌不对」，
      // 否则这就是一个「报 id 探记录存在性」的口子。定长比较见 publisherTokenOk。
      const byPublisher = !!givenTok && isPublisher(meta, givenTok);
      if (!byReceipt && !byPublisher) return sendJson(res, 403, { error: '回执令牌不对' });
      const d = readJson(decisionPath(id));
      return sendJson(res, 200, {
        id, name: meta.name, state: d ? d.decision : 'pending', reason: d?.reason ?? null, decisionAt: d?.at ?? null,
        // 自撤申请是**在 meta 上**的一条并行信息，不是第五种 state（state 仍然只有四档读法）。
        withdrawRequested: meta.withdrawRequested === true,
        withdrawReason: meta.withdrawReason ?? null,
        withdrawRequestedAt: meta.withdrawRequestedAt ?? null,
      });
    }

    // ---- 下载：已上线的谁都能下；待审的只有维护者能下（你要 down 下来跑测试）
    //      `?variant=orig` 取的是**留档的原件** —— 它**永不公开**，无论这个编号通没通过。
    if (req.method === 'GET' && p.startsWith('/api/file/')) {
      const id = p.slice('/api/file/'.length);
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对' });
      const raw = url.searchParams.get('variant');
      if (raw && raw !== 'mod' && raw !== 'orig' && raw !== 'candidate') {
        return sendJson(res, 400, { error: 'variant 只能是 mod / orig / candidate' });
      }
      // ⭐ 候选包体（发布者换上、还没批的那一份）：**只有维护者能下**，
      //    它与「留档原件」一个性质 —— 是给你核对用的，不是发布物。
      //    公开面上它**一个字节都不露**（裁定 ⑦：批准前公开面继续展示旧包）。
      if (raw === 'candidate') {
        if (!isAdmin(req)) {
          if (!adminAllowed(req)) {
            return sendJson(res, 403, { error: '候选包体只给审核看；管理口只允许回环地址（ADMIN_IPS），走 SSH 隧道再看。' });
          }
          return sendJson(res, 403, { error: '候选包体还没批，只有维护者能下载：请从审核页进入（浏览器会弹登录框），或用 x-admin-token 头带上令牌' });
        }
        const C = pathsOf(id);
        if (!C) return sendJson(res, 404, { error: '没有这条记录' });
        const candPath = join(C.dir, CANDIDATE_BLOB);
        if (!existsSync(candPath)) return sendJson(res, 404, { error: '这条没有待批的候选包体' });
        const cRec = readJson(join(C.dir, 'candidate.json')) || {};
        return sendFile(res, candPath, cRec.candidate?.blobName || `${id}-候选版.zip`);
      }
      const P = pathsOf(id, raw || 'mod');
      if (!P) return sendJson(res, 404, { error: '文件不在' });
      if (!existsSync(P.blobPath)) {
        if (P.variant === 'orig') return sendJson(res, 404, { error: '这条没有留档原件（只有维护者侧的兼容包才有）' });
        return sendJson(res, 404, { error: '文件不在' });
      }
      // 留档原件是「给你追溯用」的，不属于发布物：不看决定、永远要维护者身份。
      if (P.variant === 'orig') {
        if (!isAdmin(req)) {
          if (!adminAllowed(req)) {
            return sendJson(res, 403, { error: '原件只是留档，不对外发布；管理口只允许回环地址（ADMIN_IPS），走 SSH 隧道再看。' });
          }
          return sendJson(res, 403, { error: '原件只是留档，不对外发布：请从审核页进入（浏览器会弹登录框），或用 x-admin-token 头带上令牌。' });
        }
        const mOrig = readJson(metaPath(id)) || {};
        return sendFile(res, P.blobPath, `${id}-原件留档-${(mOrig.author || 'author').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
      }
      const d = readJson(decisionPath(id));
      const mPub = readJson(metaPath(id)) || {};
      // ⭐ 公开下载口也认「待确认的自撤申请」（与 /api/mods 同一条判据，一处写、两处用）：
      //    发布者申请撤下的那一刻起，公网就**下不到**它了 —— 否则「删掉了但链接还能下」是假删除。
      //    维护者（`isAdmin`）照旧能下，跑测试不受影响。
      const publicOk = d?.decision === 'approved' && mPub.withdrawRequested !== true;
      if (!publicOk && !isAdmin(req)) {
        if (mPub.withdrawRequested === true) {
          return sendJson(res, 403, { error: '发布者已申请撤下这一条，等维护者确认；期间公网不再提供下载。' });
        }
        // 报错要自己说清怎么办，不然维护者本人也会以为「我不是维护者吗」
        if (!adminAllowed(req)) {
          return sendJson(res, 403, { error: '这个还没通过审核；而管理口只允许回环地址（ADMIN_IPS），公网上拿不到待审包。走 SSH 隧道再下。' });
        }
        return sendJson(res, 403, { error: '这个还没通过审核，只有维护者能下载：请从审核页进入（浏览器会弹登录框），或用 x-admin-token 头带上令牌' });
      }
      return sendFile(res, P.blobPath, mPub.blobName || `${id}-${(mPub.name || 'mod').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
    }

    // ---- 上传
    if (req.method === 'POST' && p === '/api/submit') {
      if (rateLimited(ip)) return sendJson(res, 429, { error: `传得太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再传`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
      const name = (url.searchParams.get('name') || '').trim();
      const note = (url.searchParams.get('note') || '').trim();
      const homepage = (url.searchParams.get('homepage') || '').trim().slice(0, 300);
      const nameFlags = reviewName(name);
      if (nameFlags.some((f) => f.level === 'blocker')) {
        return sendJson(res, 400, { error: '名称不合格', flags: nameFlags });
      }
      if (note.length > NOTE_MAX) return sendJson(res, 400, { error: `备注太长（最多 ${NOTE_MAX} 字）` });

      // 有 content-length 就先拒：这样客户端拿到的是明明白白的 413，而不是传到一半连接被掐。
      // （XHR / fetch 传 Buffer 或 File 时一定会带这个头；没有的走下面的边收边判。）
      const declared = Number(req.headers['content-length'] || 0);
      if (declared && declared > MAX_BYTES) {
        // `code` / `maxMB`：前端据此显示「文件太大（上限 X MB）」，不用去猜 HTTP 码的含义。
        return sendJson(res, 413, {
          error: `文件 ${(declared / 1048576).toFixed(1)} MB，超过上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB`,
          code: 'TOO_LARGE',
          maxMB: MAX_BYTES / 1048576,
        });
      }

      const body = await readBody(req, MAX_BYTES);
      if (!body.length) return sendJson(res, 400, { error: '没有收到文件' });
      if (!looksLikeZip(body.subarray(0, 4))) return sendJson(res, 400, { error: '只收 zip（这个文件头不是 zip 魔数）' });

      const id = idOf();
      // 先落到临时文件：要读完 zip 才知道它该进哪个区（普通 / 疑似素材）。
      const tmpZip = join(DATA_DIR, `${id}.part`);
      writeFileSync(tmpZip, body);
      partToClean = tmpZip;                    // 从这里起，任何失败都要靠 finally 收掉它

      let entries = [];
      let contentFlags = [];
      try {
        entries = await readZipEntries(tmpZip);
        contentFlags = reviewEntries(entries, { packIdHint: name });
      } catch (e) {
        contentFlags = [{ level: 'blocker', code: 'BAD_ZIP', text: `zip 读不了：${e.message}` }];
      }

      // 两处盲区（2026-10-12 业主裁定）：不透明容器内部 + 作者自述。**warn 档，但发布要显式点头。**
      contentFlags = [...contentFlags, ...(await blindSpotFlags(tmpZip, entries, { note }))];
      const ackCodes = ackCodesOf(contentFlags);
      const ackRequired = needsAcknowledge(contentFlags);

      // **疑似素材照收不拒**（业主裁决）：它进 flagged/ 单独存放，并且处处标注清楚。
      // 「疑似」不等于「确认」—— 投稿人自己也未必知道原件里夹了什么。
      const suspected = hasBlocker(contentFlags);
      const area = suspected ? 'flagged' : 'normal';
      const dir = dirIn(area, id);
      mkdirSync(dir, { recursive: true });
      renameSync(tmpZip, join(dir, 'mod.zip'));
      partToClean = null;                      // 已经是正式的 mod.zip 了，不再是临时文件

      const files = entries.filter((e) => !e.dir);
      // ⭐ 认领码（裁定 ③）：**明文只在这一个响应里出现一次**；盘上存的是它的哈希
      //    （见 `pendingClaim`）。发布者拿它去 `POST /api/publisher/claim` 换一枚发布者令牌。
      const claimCode = claimOf();
      const meta = {
        id, area, name, note, homepage: homepage || null,
        size: body.length, sha256: createHash('sha256').update(body).digest('hex'),
        uploadedAt: nowIso(), ip, receipt: tokenOf(),
        entries: files.length,
        unpackedBytes: entries.reduce((n, e) => n + e.uncompSize, 0),
        flags: [...nameFlags, ...contentFlags],
        suspected,
        suspectedReasons: contentFlags.filter((f) => f.level === 'blocker').map((f) => f.code),
        // 「要显式确认」的标志位（与 `suspected` 是两条不同的路：这一条**不改存放区**、
        // 也**不改公开面对"疑似素材"的既有标注**，只要求发布时 acknowledge）。
        ackRequired,
        ackCodes,
        // 新增（老记录一个都没有 ⇒ 老记录一律不可认领，裁定 ④）：
        pendingClaim: [{ h: claimHashOf(claimCode), at: nowIso(), by: 'submit', ip }],
      };
      writeJson(join(dir, 'meta.json'), meta);
      audit('submit', { id, ip, actor: 'public', detail: { name, area, suspected, claimIssued: true } });

      return sendJson(res, 201, {
        ok: true, id, area, receipt: meta.receipt,
        state: 'pending', suspected,
        size: meta.size, sha256: meta.sha256, entries: meta.entries,
        statusUrl: `${BASE_URL}/api/status/${id}?t=${meta.receipt}`,
        // ⭐ **认领码，只在这里出现一次**：站点不存明文、页面也不回显第二次。
        //    发布者用它换发布者令牌，之后就能自己改这一条（改完照样回待审）。
        claimCode,
        claimPath: '/api/publisher/claim',
        publisherPage: '/mine',
        claimNote: '这串认领码**只显示这一次**：用它去「我的投稿」换一枚发布者令牌，之后这条投稿就归你管'
          + '（改名称/备注/分类、换包体、申请撤下）。站点只存它的哈希，丢了就找不回明文 —— '
          + '丢了也不要紧：请维护者再发一枚即可（老记录也一样，找维护者手工发码）。',
        flags: meta.flags,
        message: suspected
          ? '已收到。包里有疑似官方素材（见 flags），它已被单独存放并会公开标注；维护者人工确认后再决定上不上线。'
          : '已收到。维护者会下载下来跑测试，通过后再上线。',
      });
    }

    // ================================================================
    // ⭐ **发布者自助**（`/api/publisher/*`，2026-10-12 新增）
    //
    // 身份 = **发布者令牌**（认领码换来的），与 `ADMIN_TOKEN` **平行**、互不替代：
    //   · 这一层**不看** `ADMIN_IPS`（发布者在公网上用，回环白名单是给管理口的）；
    //     但也**不可能**因此拿到任何管理能力 —— 每个端点只动**自己那一条**。
    //   · 认领码 / 令牌**只存哈希**（`pendingClaim` / `publisherTokens`），比对走 `timingSafeEqual`。
    //   · 写端点**一律限流**（`publisherRateLimited`，裁定 ⑧ ②）；只读的 `/mine` 不限。
    //
    // ⚠️ 四条不许破的边界（再次写在这里，因为这是最容易写歪的一段）：
    //   ① 自助写**永不**写 `decision=approved`；
    //   ② 自助写**永不**替换公开的 `mod.zip`（新包写成候选 `mod.pending.zip`）；
    //   ③ 任何改动**都回待审**（`clearDecision`）；
    //   ④ 任何路径**都不删**记录 / 文件。
    // ================================================================
    if (p === '/api/publisher/claim' || p.startsWith('/api/publisher/')) {
      const pubToken = publisherTokenOf(req);
      const pubIp = ip;

      // ---- ① 认领码 → 发布者令牌（一次性）
      if (req.method === 'POST' && p === '/api/publisher/claim') {
        if (publisherRateLimited(ip)) return sendJson(res, 429, { error: `操作太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再来`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        const code = typeof inObj.claimCode === 'string' ? inObj.claimCode.trim().toUpperCase() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6–32 位小写字母/数字）' });
        const meta = readJson(metaPath(id));
        // ⚠️ **认不出来就回同一句话、同一个码**：不区分「编号不存在」「没有待领的码」「码不对」，
        //    否则这就是一个「报 id 探记录存在性」的口子。形状不对的码也照比一次（定长比较）。
        const denied = () => sendJson(res, 403, { error: '编号或认领码不对（认领码是一次性的；已用过、已过期、或这条没有待领的码，都会是这个结果）' });
        if (!meta) { claimOk({}, code); return denied(); }
        if (!claimOk(meta, code)) return denied();
        // 认领码过期：不再接受兑换（记录里的哈希照旧留着 —— 零删除）。管理员可再发一枚。
        const claims = (Array.isArray(meta.pendingClaim) ? meta.pendingClaim : []).filter((c) => {
          const at = Date.parse(c?.at || '');
          return !Number.isFinite(at) || (Date.now() - at) <= CLAIM_TTL_DAYS * 86400000;
        });
        if (!claimOk({ pendingClaim: claims }, code)) {
          return sendJson(res, 410, { error: `这枚认领码超过 ${CLAIM_TTL_DAYS} 天，已经不再接受兑换 —— 请维护者再发一枚。` });
        }
        const token = tokenOf();
        const at = nowIso();
        const kept = (Array.isArray(meta.publisherTokens) ? meta.publisherTokens : []).slice(-(TOKEN_MAX - 1));
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        writeJson(metaPath(id), {
          ...meta,
          // 用掉的那一枚从待用清单里去掉（**不是删记录**：只去掉一枚已消费的凭据哈希），
          // 其余待用的码原样保留。
          pendingClaim: claims.filter((c) => c.h !== claimHashOf(code)),
          publisherTokens: [...kept, { h: tokHashOf(token), at, by: 'claim', ip }],
          revisions: [...hist, {
            at, by: 'publisher',
            changed: { publisherTokens: (meta.publisherTokens || []).length },
            to: { publisherTokens: (meta.publisherTokens || []).length + 1 },
            why: '发布者用一次性认领码换了一枚发布者令牌（只存哈希）。',
          }],
        });
        audit('tokenClaimed', { id, ip, actor: 'publisher', detail: { tokens: kept.length + 1 } });
        // ⚠️ 令牌**明文只在这一个响应里出现一次**（盘上只有哈希，丢了只能由管理员重发认领码）。
        return sendJson(res, 200, {
          ok: true, id, publisherToken: token, name: meta.name,
          minePath: '/api/publisher/mine',
          page: '/mine',
          note: '这枚发布者令牌**只显示这一次**（站点只存哈希）。请存好：'
            + '它就是「这条投稿归你管」的凭据 —— 改名称/备注/分类、换包体、申请撤下都靠它。'
            + '丢了找维护者再发一枚认领码即可。',
        });
      }

      // ---- ② 「我的投稿」：凭令牌列出自己认领过的记录（只读，不限流）
      if (req.method === 'GET' && p === '/api/publisher/mine') {
        // ⚠️ 认不下来就 401，而且**不告诉任何事**（不说「你没有认领过」还是「令牌不对」）。
        if (!pubToken) return sendJson(res, 401, { error: '需要发布者令牌（x-publisher-token 头，或 Authorization: Bearer）' });
        const mine = [];
        for (const s of allSubs()) {
          if (s.kind === 'compat') continue;              // 兼容包不出自发布者
          const meta = readJson(metaPath(s.id));
          if (!meta || !isPublisher(meta, pubToken)) continue;
          mine.push({
            id: s.id, name: s.name, state: s.state, area: s.area,
            packKind: kindOfRec(s),
            funcKind: funcKindOf(meta),
            funcKindTitle: FUNC_KIND_TITLES[funcKindOf(meta)],
            size: meta.size ?? null, uploadedAt: meta.uploadedAt ?? null,
            withdrawRequested: meta.withdrawRequested === true,
            withdrawReason: meta.withdrawReason ?? null,
            candidate: meta.candidate ? {
              at: meta.candidate.at ?? null, sha256: meta.candidate.sha256 ?? null, size: meta.candidate.size ?? null,
            } : null,
            revisions: Array.isArray(meta.revisions) ? meta.revisions.length : 0,
            download: `/api/file/${s.id}`,
          });
        }
        // 认下来了但一条也没有（比如认领的是别人的？不可能 —— 令牌就是按条存哈希的）
        // 也照给空数组，不报错：页面照实画「还没有认领的投稿」。
        if (!mine.length) {
          // 「一枚令牌都没匹配上任何记录」时给 401 还是空列表？**给空列表** ——
          // 令牌是按记录存的，认领成功就一定有一条；给空列表不会泄露任何东西，
          // 而 401 会让「记录被管理员整条搬走」这种正常情形看起来像令牌坏了。
          return sendJson(res, 200, { ok: true, mine: [], count: 0 });
        }
        return sendJson(res, 200, { ok: true, mine, count: mine.length });
      }

      // ---- ③ 改元数据（name / note / homepage / packKind）⇒ **强制回待审**
      if (req.method === 'POST' && p === '/api/publisher/update') {
        if (publisherRateLimited(ip)) return sendJson(res, 429, { error: `操作太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再来`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
        const raw = await readBody(req, NOTE_BODY_MAX);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        // 一次一个明确写出的 id（与 /note、/hide、/packkind 同一条铁律）。
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要改 N 条就发 N 次。`,
          });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6–32 位小写字母/数字）' });
        if (!pubToken) return sendJson(res, 401, { error: '需要发布者令牌（x-publisher-token 头）' });
        const meta = readJson(metaPath(id));
        if (!meta) return sendJson(res, 404, { error: '没有这条记录' });
        // ⚠️ **只能碰自己那条**：令牌对不上就是 403，**不是 404** ——
        //    「这条存在但不是你的」与「这条不存在」在这条路上本来就没打算区分，
        //    但 403 更诚实：编号存在（/api/mods 上谁都能看到），只是你没这个权。
        if (!isPublisher(meta, pubToken)) return sendJson(res, 403, { error: '这枚发布者令牌不是这一条的（只能改自己认领过的投稿）' });
        if (dirOf(id)?.area === 'compat') return sendJson(res, 400, { error: '兼容包不在发布者自助范围内（它是维护者侧的改写成品）' });
        // 逐个字段**先算不写**：任何一项不合法就直接返回，磁盘上什么都不改。
        const patch = {};
        if (inObj.name != null) {
          if (typeof inObj.name !== 'string') return sendJson(res, 400, { error: 'name 形状不对（必须是字符串）' });
          const nm = inObj.name.trim();
          if (!nm) return sendJson(res, 400, { error: 'name 不能是空的' });
          if (nm.length > 60) return sendJson(res, 400, { error: 'name 太长（最多 60 字）' });
          const nf = reviewName(nm);
          if (nf.some((f) => f.level === 'blocker')) return sendJson(res, 400, { error: '名称不合格', flags: nf });
          if (nm !== meta.name) patch.name = nm;
        }
        if (inObj.note != null) {
          if (typeof inObj.note !== 'string') return sendJson(res, 400, { error: 'note 形状不对（必须是字符串）' });
          const nt = inObj.note.trim();
          if (nt.length > NOTE_MAX) return sendJson(res, 400, { error: `备注太长（最多 ${NOTE_MAX} 字）` });
          if (nt !== (meta.note ?? '')) patch.note = nt;
        }
        if (inObj.homepage != null) {
          if (typeof inObj.homepage !== 'string') return sendJson(res, 400, { error: 'homepage 形状不对（必须是字符串）' });
          const hp = inObj.homepage.trim().slice(0, 300);
          if (hp !== (meta.homepage ?? '')) patch.homepage = hp || null;
        }
        if (inObj.packKind != null) {
          if (typeof inObj.packKind !== 'string' || !PACK_KINDS.includes(inObj.packKind.trim())) {
            return sendJson(res, 400, { error: `packKind 只能是 ${PACK_KINDS.join(' / ')} 之一（闭枚举：拼错的值不许落进记录）` });
          }
          const pk = inObj.packKind.trim();
          if (pk !== (meta.packKind ?? null)) patch.packKind = pk;
        }
        // ⭐ 功能类目（6 类，业主 2026-10-14）：发布者可以给自己的包填这一类。
        // 与上面 `packKind` 的关系：**写了 funcKind 就按它把技术维度一并归位**（`packKindFor`），
        // 两栏因此不可能各说各话 —— 除非他在同一次报文里**又显式**给了 `packKind`（那就以显式值为准）。
        if (inObj.funcKind != null) {
          if (typeof inObj.funcKind !== 'string' || !FUNC_KINDS.includes(inObj.funcKind.trim())) {
            return sendJson(res, 400, { error: `funcKind 只能是 ${FUNC_KINDS.join(' / ')} 之一（闭枚举：拼错的值不许落进记录）`, funcs: FUNC_KINDS });
          }
          const fk = inObj.funcKind.trim();
          if (fk !== (meta.funcKind ?? null)) {
            patch.funcKind = fk;
            // 同一次写入里，技术维度跟着功能类目走（判据只有 `packKindFor` 一份）。
            const derived = packKindFor(fk);
            if (!('packKind' in patch) && derived !== (meta.packKind ?? null)) patch.packKind = derived;
          }
        }
        if (!Object.keys(patch).length) {
          return sendJson(res, 200, { ok: true, id, changed: false, at: nowIso(), note: '字段与现在完全相同，没有写盘（幂等）。' });
        }
        const at = nowIso();
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        writeJson(metaPath(id), {
          ...meta,
          ...patch,
          publisherChanged: true,
          revisions: [...hist, {
            at, by: 'publisher',
            changed: Object.fromEntries(Object.keys(patch).map((k) => [k, meta[k] ?? null])),
            to: patch,
            why: '发布者自助改元数据（改动即**强制回待审**：上一份决定已移入本记录的 revisions，等管理员复审）。',
          }],
        });
        // ⭐ 强制回待审：**公开面立刻不再列出**这条（`state` 读出来就是 pending）。
        //    不是「删记录」—— 上一份决定逐字进了 revisions.decisionSnapshot（零删除）。
        const moved = clearDecision(id, '发布者改了这条投稿的元数据 ⇒ 强制回到待审，等管理员复审（改动前的决定已留在 revisions 里）。', 'publisher');
        audit('publisherUpdate', {
          id, ip, actor: 'publisher',
          detail: { changed: keysOf(patch), forcedPending: true, previousDecision: moved?.decision ?? null },
        });
        return sendJson(res, 200, {
          ok: true, id, changed: true, at,
          forcedPending: true,
          changedKeys: keysOf(patch),
          previousDecision: moved?.decision ?? null,
          note: moved
            ? `改动已记进 revisions；上一份决定（${moved.decision}）也已移入 revisions，本条回到**待审**。`
            : '改动已记进 revisions；本条本来就是待审。',
          message: '改好了。管理员复审通过后才会重新出现在公开列表上 —— 这是有意的：发布者不直改公开面。',
        });
      }

      // ---- ④ 换包体 / 上新版本 ⇒ 写成**候选**，公开面照旧展示旧包（裁定 ⑦）
      if (req.method === 'POST' && p === '/api/publisher/blob') {
        if (publisherRateLimited(ip)) return sendJson(res, 429, { error: `操作太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再来`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
        const id = (url.searchParams.get('id') || '').trim();
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6–32 位小写字母/数字，放在查询串 ?id=）' });
        if (!pubToken) return sendJson(res, 401, { error: '需要发布者令牌（x-publisher-token 头）' });
        const meta = readJson(metaPath(id));
        if (!meta) return sendJson(res, 404, { error: '没有这条记录' });
        if (!isPublisher(meta, pubToken)) return sendJson(res, 403, { error: '这枚发布者令牌不是这一条的（只能换自己认领过的投稿）' });
        if (dirOf(id)?.area === 'compat') return sendJson(res, 400, { error: '兼容包不在发布者自助范围内' });
        const declared = Number(req.headers['content-length'] || 0);
        if (declared && declared > MAX_BYTES) {
          return sendJson(res, 413, {
            error: `文件 ${(declared / 1048576).toFixed(1)} MB，超过上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB`,
            code: 'TOO_LARGE',
            maxMB: MAX_BYTES / 1048576,
          });
        }
        const body = await readBody(req, MAX_BYTES);
        if (!body.length) return sendJson(res, 400, { error: '没有收到文件' });
        if (!looksLikeZip(body.subarray(0, 4))) return sendJson(res, 400, { error: '只收 zip（这个文件头不是 zip 魔数）' });
        const P = pathsOf(id);
        // 候选先落到**数据目录根下的临时名**，检查全过了才搬进记录目录 ——
        // 与 /api/submit 同一条纪律：失败路径一个 `.part` 都不许留在记录目录里。
        const tmpZip = join(DATA_DIR, `${id}.publisher.part`);
        writeFileSync(tmpZip, body);
        partToClean = tmpZip;
        let entries = [];
        let contentFlags = [];
        try {
          entries = await readZipEntries(tmpZip);
          contentFlags = reviewEntries(entries, { packIdHint: meta.name });
        } catch (e) {
          contentFlags = [{ level: 'blocker', code: 'BAD_ZIP', text: `zip 读不了：${e.message}` }];
        }
        contentFlags = [...contentFlags, ...(await blindSpotFlags(tmpZip, entries, { note: meta.note }))];
        const sha = createHash('sha256').update(body).digest('hex');
        if (sha === meta.sha256) {
          // 同一份文件：不必留候选（幂等），但**也不报错** —— 发布者多半只是想确认传上去了。
          try { unlinkSync(tmpZip); } catch { /* 清不掉由 finally 兜 */ }
          partToClean = null;
          return sendJson(res, 200, {
            ok: true, id, changed: false, at: nowIso(),
            sha256: sha, note: '这一份与现在公开的包体**逐字节相同**，没有留候选。',
          });
        }
        const at = nowIso();
        const dir = P.dir;
        const candPath = join(dir, CANDIDATE_BLOB);
        const candName = blobNameFromHeader(req, `${id}-候选版.zip`);
        // 覆盖上一份**没批的**候选是安全的（它本来就还没生效）；但**先把旧候选留个名**，
        // 免得「我上次传的那份去哪了」查无对证（零删除）。
        let prevCand = null;
        if (existsSync(candPath)) {
          prevCand = `mod.pending-${at.replace(/[^0-9]/g, '')}.zip`;
          let t = prevCand;
          for (let i = 1; existsSync(join(dir, t)); i++) t = `mod.pending-${at.replace(/[^0-9]/g, '')}-${i}.zip`;
          prevCand = t;
          renameSync(candPath, join(dir, prevCand));
        }
        renameSync(tmpZip, candPath);
        partToClean = null;
        const candidate = {
          at, by: 'publisher', ip,
          sha256: sha, size: body.length,
          entries: entries.filter((e) => !e.dir).length,
          unpackedBytes: entries.reduce((n, e) => n + e.uncompSize, 0),
          blobName: candName,
          previousCandidateArchived: prevCand,
          flags: contentFlags,
          ackRequired: needsAcknowledge(contentFlags),
          suspected: hasBlocker(contentFlags),
          note: '发布者换的包体 / 上新版本 —— **候选**：批准前公开面继续展示旧的 mod.zip（裁定 ⑦）。',
        };
        writeJson(join(dir, 'candidate.json'), { id, candidate, previousPublicSha256: meta.sha256 || null });
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        writeJson(P.meta, {
          ...meta,
          publisherChanged: true,
          candidate: {
            at, by: 'publisher', sha256: sha, size: body.length,
            entries: candidate.entries, blobName: candName,
            previousPublicSha256: meta.sha256 || null,
          },
          revisions: [...hist, {
            at, by: 'publisher',
            changed: { sha256: meta.sha256 ?? null, publicBlob: 'mod.zip（未动）' },
            to: { candidateSha256: sha, candidateBlob: CANDIDATE_BLOB },
            why: '发布者换上新的候选包体：**不动公开的 mod.zip**；等管理员核过哈希后批准才切换。',
          }],
        });
        audit('publisherBlob', {
          id, ip, actor: 'publisher',
          detail: { candidateSha256: sha, publicSha256: meta.sha256 ?? null, bytes: body.length, previousCandidateArchived: prevCand },
        });
        return sendJson(res, 200, {
          ok: true, id, changed: true, at,
          candidate: { sha256: sha, size: body.length, entries: candidate.entries },
          publicSha256: meta.sha256 ?? null,
          note: '候选包体已收下（**没有**替换公开的那一份）。公开面从现在起**照旧展示旧包**；'
            + '管理员下载候选、核对无误后点「批准候选包体」，才会切到这一份。',
        });
      }

      // ---- ⑤ 自撤（裁定 ②）⇒ `withdrawRequested`，**公开面立刻不再列出**
      if (req.method === 'POST' && p === '/api/publisher/withdraw') {
        if (publisherRateLimited(ip)) return sendJson(res, 429, { error: `操作太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再来`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6–32 位小写字母/数字）' });
        if (!pubToken) return sendJson(res, 401, { error: '需要发布者令牌（x-publisher-token 头）' });
        if (inObj.reason != null && typeof inObj.reason !== 'string') {
          return sendJson(res, 400, { error: 'reason 形状不对（必须是字符串）' });
        }
        const reason = String(inObj.reason || '').trim().slice(0, 1000);
        const meta = readJson(metaPath(id));
        if (!meta) return sendJson(res, 404, { error: '没有这条记录' });
        if (!isPublisher(meta, pubToken)) return sendJson(res, 403, { error: '这枚发布者令牌不是这一条的（只能撤自己认领过的投稿）' });
        if (dirOf(id)?.area === 'compat') return sendJson(res, 400, { error: '兼容包不在发布者自助范围内' });
        if (meta.withdrawRequested === true) {
          return sendJson(res, 200, {
            ok: true, id, changed: false, withdrawRequested: true, at: meta.withdrawRequestedAt ?? nowIso(),
            note: '这条已经在「待管理员确认自撤」状态里了，没有重复写盘（幂等）。',
          });
        }
        const at = nowIso();
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        const wh = Array.isArray(meta.withdrawHistory) ? meta.withdrawHistory : [];
        writeJson(metaPath(id), {
          ...meta,
          withdrawRequested: true,
          withdrawRequestedAt: at,
          withdrawReason: reason || null,
          withdrawHistory: [...wh, {
            at, by: 'publisher', action: 'requested',
            reason: reason || null,
            stateBefore: readJson(decisionPath(id))?.decision ?? 'pending',
            ip,
          }],
          revisions: [...hist, {
            at, by: 'publisher',
            changed: { withdrawRequested: false },
            to: { withdrawRequested: true },
            why: '发布者申请撤下（自撤）。**公开面立刻不再列出这一条**，等管理员确认；记录、决定、包体一个都没删。',
          }],
        });
        audit('withdrawRequested', {
          id, ip, actor: 'publisher',
          detail: { reason: reason || null, stateBefore: readJson(decisionPath(id))?.decision ?? 'pending' },
        });
        return sendJson(res, 200, {
          ok: true, id, changed: true, at,
          withdrawRequested: true,
          publicVisible: false,
          note: '撤下申请已收到：**公开列表与下载口立刻不再显示这一条**（这是「想删掉就立刻见效」那一半）。'
            + '管理员确认后转为 `superseded`（自撤终态，`replacedBy: null`）；管理员拒绝则恢复公开。'
            + '记录、包体与全部留痕一个都不会删。',
        });
      }

      // ---- ⑥ 发布者**自助删除**：一按即生效，**不经管理员**（业主 2026-10-12 二次裁定）
      //
      // 为什么还要这一个（⑤ 已经有自撤了）：⑤ 只做到「**申请** + 公开面先消失」，
      // 落终态要管理员点一次 `withdraw-decide`。业主的原话是「**他想删掉**」——
      // 那就是发布者自己说了算，不该卡在一个人的确认上。两条路的差别**只有这一条**：
      // 谁来落那个终态。公开面判据、终态语义、零删除口径**完全一样**。
      //
      //   ① **只动自己那条**：归属判据是「令牌对得上这条记录 `publisherTokens` 里的哈希」
      //      （`isPublisher`），**不看、也不接受客户端传来的任何归属字段**；
      //   ② 一按即生效：`/api/mods`、`/mods` 不再列出，`/api/file/<id>` 立即 403；
      //   ③ **软删**：记录、包体、留档**全部保留** —— 落既有「已撤下」语义
      //      `decision=superseded` + `replacedBy: null` + `reason: "publisher-delete"`，
      //      并各留一笔 `revisions` / `audit`。⚠️ **不做物理删除**（零删除是本站主判据；
      //      要连文件一起真删，得业主另行授权）；
      //   ④ 幂等：已经是 superseded 就不再写盘（重复点不会重复留痕）。
      // ⚠️ 与全站同一条铁律：只认**一个明确写出的 id**（`ids`/`batch`/`items`/`list` 一律 400）。
      if (req.method === 'POST' && p === '/api/publisher/delete') {
        if (publisherRateLimited(ip)) return sendJson(res, 429, { error: `操作太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再来`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要删 N 条就发 N 次，每条单独核对。`,
          });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6–32 位小写字母/数字）' });
        if (inObj.reason != null && typeof inObj.reason !== 'string') {
          return sendJson(res, 400, { error: 'reason 形状不对（必须是字符串）' });
        }
        // ⚠️ 无令牌 ⇒ 401。**先看令牌、再看记录**，而且记录不存在时也照比一次哈希
        //    （`publisherTokenOk({}, …)`，与 `/api/publisher/claim` 同一个手法）——
        //    不给「报 id 探记录存在性」留任何口子。
        if (!pubToken) return sendJson(res, 401, { error: '需要发布者令牌（x-publisher-token 头，或 Authorization: Bearer）' });
        const metaD = readJson(metaPath(id));
        if (!metaD) { publisherTokenOk({}, pubToken); return sendJson(res, 404, { error: '没有这条记录' }); }
        // ⚠️ **删别人的 ⇒ 403**（不是 404：编号在 `/api/mods` 上本来就公开可见，
        //    403 更诚实 —— 「这条存在，只是不是你的」）。
        if (!isPublisher(metaD, pubToken)) {
          return sendJson(res, 403, { error: '这枚发布者令牌不是这一条的（只能删自己认领过的投稿）' });
        }
        if (dirOf(id)?.area === 'compat') return sendJson(res, 400, { error: '兼容包不在发布者自助范围内（它是维护者侧的改写成品）' });
        const decBefore = readJson(decisionPath(id));
        if (decBefore?.decision === 'superseded') {
          return sendJson(res, 200, {
            ok: true, id, changed: false, state: 'superseded', replacedBy: decBefore.replacedBy ?? null,
            at: decBefore.at ?? nowIso(), publicVisible: false, softDelete: true, recoverable: true,
            note: '这条已经是「已撤下」终态（superseded），没有重复写盘（幂等）。记录与包体依旧保留。',
          });
        }
        const reason = String(inObj.reason || '').trim().slice(0, 1000);
        const at = markSelfWithdrawn(id, {
          reason: reason || PUBLISHER_DELETE_REASON,
          by: 'publisher', ip, direct: true,
        });
        if (!at) return sendJson(res, 400, { error: '这条记录不能这样删除（兼容包不在自助范围内，或 meta.json 读不出来，不动它）' });
        // 终态已落 ⇒ 清掉可能挂着的「待确认自撤」标志位（那次申请已被本次自助删除消化），
        // 收尾口径与 `withdraw-decide` 的 confirm **逐字一致**（同一处语义只写一遍）。
        const m3 = readJson(metaPath(id)) || metaD;
        const hist = Array.isArray(m3.revisions) ? m3.revisions : [];
        const wh = Array.isArray(m3.withdrawHistory) ? m3.withdrawHistory : [];
        writeJson(metaPath(id), {
          ...m3,
          withdrawRequested: false,
          withdrawHistory: [...wh, { at, by: 'publisher', action: 'deleted', reason: reason || null, ip }],
          revisions: [...hist, {
            at, by: 'publisher',
            changed: {
              decision: decBefore?.decision ?? 'pending（文件缺省：decision.json 不存在）',
              withdrawRequested: m3.withdrawRequested === true,
            },
            to: { decision: 'superseded（replacedBy: null，发布者自助删除）', withdrawRequested: false },
            why: '发布者凭自己的发布者令牌**自助删除**（不经管理员）：公开列表与下载口立刻不再提供这一条。'
              + '**软删** —— 记录、包体、留档与全部留痕一个都没删（零删除，可恢复）。',
          }],
        });
        audit('publisherDeleted', {
          id, ip, actor: 'publisher',
          detail: { reason: reason || PUBLISHER_DELETE_REASON, softDelete: true, stateBefore: decBefore?.decision ?? 'pending' },
        });
        return sendJson(res, 200, {
          ok: true, id, changed: true, at, state: 'superseded', replacedBy: null,
          reason: reason || PUBLISHER_DELETE_REASON,
          publicVisible: false, softDelete: true, recoverable: true,
          note: '已删除，**立即生效**（不需要管理员确认）：公开列表与下载口现在都不再提供这一条。'
            + '这是**软删** —— 记录、包体与全部留痕都保留、可恢复；'
            + '要连文件一起物理删除需另行授权（「零删除」是本站在用的主判据）。',
        });
      }

      // ---- ⑦ 撤回那次自助删除（**档 2**）：把自己的软删恢复成 `approved`
      //
      // 业主口径（2026-10-14）：「软删可以，给作者一个撤回通道」。恢复 = 把判定换回 `approved`
      // ⇒ 作者自己的东西，恢复即重新公开；留 `withdrawHistory` / `revisions` / `audit` 三笔痕。
      // ⚠️ 只能恢复**自己被软删**的那条；**被物理删过**的恢复不了（文件已经不在）⇒ 明确 410。
      // ⚠️ 只认一个明确 id、只认自己的令牌（`isPublisher`）。
      if (req.method === 'POST' && p === '/api/publisher/restore') {
        if (publisherRateLimited(ip)) return sendJson(res, 429, { error: `操作太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再来`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
        const raw = await readBody(req, 4 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要恢复 N 条就发 N 次。`,
          });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6–32 位小写字母/数字）' });
        if (!pubToken) return sendJson(res, 401, { error: '需要发布者令牌（x-publisher-token 头，或 Authorization: Bearer）' });
        const meta = readJson(metaPath(id));
        if (!meta) {
          // ⚠️ 记录不在了：**先看墓碑**再回话 —— 区分「被物理删过（不可恢复）」与「压根没这条」。
          if (readTombstone(id)) {
            return sendJson(res, 410, {
              error: '这一条已经被**物理删除**（硬删），文件不在盘上了 —— 恢复不了。要重新上线请重新投稿。',
              hardDeleted: true, recoverable: false,
            });
          }
          publisherTokenOk({}, pubToken);
          return sendJson(res, 404, { error: '没有这条记录' });
        }
        if (!isPublisher(meta, pubToken)) {
          return sendJson(res, 403, { error: '这枚发布者令牌不是这一条的（只能恢复自己删掉的投稿）' });
        }
        const r = restorePublisherDeleted(id, { by: 'publisher', ip });
        if (r.error) {
          return sendJson(res, r.notRestorable ? 409 : 400, {
            error: r.error, state: r.state ?? null, replacedBy: r.replacedBy ?? null,
          });
        }
        return sendJson(res, 200, {
          ok: true, id, changed: true, at: r.at, state: 'approved',
          publicVisible: true, note: '已撤回那次删除：这一条**重新公开**（判定回到 approved）。'
            + '恢复只是把判定换回来 —— 记录、包体、留档本来一个都没删过。'
            + '⚠️ 但它现在会**立刻出现在公开面**上；不想公开就再撤下一次。',
        });
      }

      // ---- ⑧ 硬删（**档 3**，物理删除）：⚠️ 必须**两次调用**，且是**全站唯一的零删除例外**
      //
      // 业主 2026-10-14 明确授权：「软删可以，给作者一个撤回通道，二次确认就硬删」。
      // 这是本站**唯一**一条会真的删数据的路，边界写死在下面（改之前先问业主）：
      //   ① **只删自己那条**（令牌对得上 `publisherTokens` 的哈希才动，不信客户端传来的归属）；
      //   ② **一次一个 id**（`ids`/`batch`/`items`/`list` 一律 400）；
      //   ③ **两次调用**：第一次只**预检 + 发一枚一次性 `confirmToken`**（盘上只存哈希、10 分钟有效）；
      //      第二次必须同时给 `confirmToken` **与精确匹配的包名** `confirmName` —— 少一个都不删；
      //   ④ **先审计后删**：动手之前先把墓碑写进独立目录 `tombstones/`（删记录带不走它），再删目录与 blob；
      //   ⑤ **有引用就先报人**：别人的 `replacedBy` 指向它、或别人用同一个 `pack.json` id ⇒ **409 不删**；
      //   ⑥ **仓库那边一律不动**：站点看不见 `mods/` 镜像，只在响应里写 `mirrorWarning` 交给人核。
      // 除这一条路之外，全站一切照旧**零删除**。
      if (req.method === 'POST' && p === '/api/publisher/delete-hard') {
        if (publisherRateLimited(ip)) return sendJson(res, 429, { error: `操作太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再来`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要删 N 条就发 N 次。`,
          });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6–32 位小写字母/数字）' });
        if (!pubToken) return sendJson(res, 401, { error: '需要发布者令牌（x-publisher-token 头，或 Authorization: Bearer）' });
        const P = pathsOf(id);
        const metaH = readJson(metaPath(id));
        if (!metaH || !P) {
          if (readTombstone(id)) {
            return sendJson(res, 410, { error: '这一条已经被物理删除过了（墓碑在），没有可再删的东西。', hardDeleted: true, recoverable: false });
          }
          publisherTokenOk({}, pubToken);
          return sendJson(res, 404, { error: '没有这条记录' });
        }
        if (!isPublisher(metaH, pubToken)) {
          return sendJson(res, 403, { error: '这枚发布者令牌不是这一条的（只能彻底删除自己认领过的投稿）' });
        }
        if (P.area === 'compat') return sendJson(res, 400, { error: '兼容包不在发布者自助范围内（它是维护者侧的改写成品）' });

        // 引用体检（**每次调用都做**，第二次也做 —— 两次之间可能有人认领/取代）
        const hd = await hardDeleteRefs(id);
        const packIdOf = hd.packId;
        const refs = hd.refs;
        if (refs.length) {
          return sendJson(res, 409, {
            error: '这一条**有引用**（别的记录指着它 / 同 pack.json id），按纪律**先报人、不擅自动手**。'
              + '请把这份引用清单交给维护者看一眼再决定。',
            refs, hardDeleted: false,
          });
        }

        const confirmToken = typeof inObj.confirmToken === 'string' ? inObj.confirmToken.trim() : '';
        // ---- 第一次调用：只预检 + 发凭据
        if (!confirmToken) {
          const tok = tokenOf();
          const at = nowIso();
          const hist = Array.isArray(metaH.revisions) ? metaH.revisions : [];
          writeJson(metaPath(id), {
            ...metaH,
            pendingHardDelete: { h: hardDeleteTokenHash(tok), at, ip },
            revisions: [...hist, {
              at, by: 'publisher',
              changed: { pendingHardDelete: metaH.pendingHardDelete ? '（上一枚凭据已被替换）' : null },
              to: { pendingHardDelete: '已在盘上（只存哈希）' },
              why: '硬删的**第一步**：预检通过、发了一枚一次性确认凭据。**这一步什么都没有删** —— '
                + '要真删必须再发一次请求，并同时给出这枚凭据与精确匹配的包名。',
            }],
          });
          audit('publisherHardDeleteRequested', {
            id, ip, actor: 'publisher',
            detail: { name: metaH.name ?? null, packId: packIdOf, files: listFilesOf(P.dir).length, state: readJson(decisionPath(id))?.decision ?? 'pending' },
          });
          return sendJson(res, 200, {
            ok: true, id, needsConfirm: true, hardDeleted: false, changed: true, at,
            confirmToken: tok, expiresInMs: HARD_DELETE_TOKEN_TTL_MS,
            expect: { name: metaH.name ?? null, packId: packIdOf, sha256: metaH.sha256 ?? null, size: metaH.size ?? null },
            currentState: readJson(decisionPath(id))?.decision ?? 'pending',
            mirrorWarning: '⚠️ 仓库里 `mods/` 可能还有这个包的镜像目录 —— **站点看不见仓库、也不会去动它**；'
              + '要不要一起清，请交给维护者判断（本条只删站点侧）。',
            note: '**还没有删任何东西。** 这是硬删的第一步：确认要做，请**再发一次**同一个端点，'
              + '带上这枚 confirmToken 与精确匹配的包名 confirmName。凭据 ' + Math.round(HARD_DELETE_TOKEN_TTL_MS / 60000) + ' 分钟内有效、且只能用一次。',
          });
        }

        // ---- 第二次调用：二次确认 → 真删
        const pend = metaH.pendingHardDelete;
        const given = Buffer.from(hardDeleteTokenHash(confirmToken), 'hex');
        let okTok = false;
        if (pend && /^[0-9a-f]{64}$/.test(String(pend.h || ''))) {
          const want = Buffer.from(String(pend.h), 'hex');
          if (want.length === given.length) okTok = timingSafeEqual(want, given);
        }
        const pendAt = Date.parse(pend?.at || '');
        const fresh = Number.isFinite(pendAt) && (Date.now() - pendAt) <= HARD_DELETE_TOKEN_TTL_MS;
        if (!okTok) {
          return sendJson(res, 409, {
            error: '二次确认没通过：confirmToken 不对（或没走过第一步）。**一个字节都没删。**'
              + '请重新发一次不带 confirmToken 的请求拿一枚新的。',
            hardDeleted: false,
          });
        }
        if (!fresh) {
          return sendJson(res, 409, {
            error: `二次确认凭据超过 ${Math.round(HARD_DELETE_TOKEN_TTL_MS / 60000)} 分钟，已失效。**一个字节都没删。**请重新走第一步。`,
            hardDeleted: false,
          });
        }
        const confirmName = typeof inObj.confirmName === 'string' ? inObj.confirmName.trim() : '';
        if (!confirmName || confirmName !== String(metaH.name ?? '')) {
          return sendJson(res, 409, {
            error: '二次确认没通过：`confirmName` 必须与这条的包名**逐字相同**。**一个字节都没删。**',
            expect: { name: metaH.name ?? null }, hardDeleted: false,
          });
        }

        // ---- ⚠️ 先审计后删：墓碑先落盘（独立目录），再删目录与 blob
        const at = nowIso();
        const files = listFilesOf(P.dir);
        const decSnap = readJson(decisionPath(id));
        const tomb = {
          id, name: metaH.name ?? null, packId: packIdOf,
          sha256: metaH.sha256 ?? null, size: metaH.size ?? null,
          area: P.area, deletedAt: at, actor: 'publisher', ip,
          reason: String(inObj.reason || '').trim().slice(0, 1000) || null,
          files,
          decisionSnapshot: decSnap,
          note: '⚠️ 墓碑：业主 2026-10-14 授权的一次**物理删除**的记录（发布者删自己的、且经二次确认）。'
            + '它落在**独立目录**里，所以删掉记录目录带不走它。除这条路外全站零删除。',
        };
        writeTombstone(id, tomb);
        audit('publisherHardDeleted', {
          id, ip, actor: 'publisher',
          detail: { name: tomb.name, packId: tomb.packId, sha256: tomb.sha256, files: files.length, tombstone: `tombstones/${id}.json` },
        });
        // 到这里才动手。**只有这一行会真的删数据。**
        rmSync(P.dir, { recursive: true, force: true });
        return sendJson(res, 200, {
          ok: true, id, changed: true, at, hardDeleted: true, recoverable: false,
          deleted: { files, dir: `${P.area}/${id}` },
          tombstone: `tombstones/${id}.json`,
          mirrorWarning: '⚠️ 仓库里 `mods/` 可能还有这个包的镜像 —— **站点没有动它**（按纪律只动站点侧）。',
          note: '已**物理删除**（记录目录与包体都不在了），**不可恢复**。墓碑已先落进 tombstones/ 留痕。'
            + '这是业主本次明确授权的一次例外；全站其余一切照旧零删除。',
        });
      }

      return sendJson(res, 404, { error: '没有这个发布者端点' });
    }

    // ---- 维护者：列表 / 详情 / 决定
    if (p.startsWith(`${ADMIN_API}/`)) {
      if (!adminAllowed(req)) return sendJson(res, 403, { error: '这个地址不在管理白名单里（ADMIN_IPS）' });
      if (!isAdmin(req)) return askForLogin(res);

      if (req.method === 'GET' && p === `${ADMIN_API}/list`) {
        const subs = allSubs();
        // ⭐ 审核台要一眼看到「发布者自撤待确认」那一条（裁定 ② / 需求 B）。
        //    只**加**一个字段，`submissions` 的形状与从前逐字相同（既有页面读法不受影响）。
        return sendJson(res, 200, { submissions: subs, withdrawQueue: withdrawQueue().map((s) => ({ id: s.id, name: s.name, at: s.withdrawRequestedAt ?? null, reason: s.withdrawReason ?? null })) });
      }

      if (req.method === 'GET' && p.startsWith(`${ADMIN_API}/detail/`)) {
        const id = p.slice(`${ADMIN_API}/detail/`.length);
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对' });
        const meta = readJson(metaPath(id));
        if (!meta) return sendJson(res, 404, { error: '没有这条投稿' });
        // 兼容包：详情用**改写版**（要发布的那个）来看包内结构，另外把留档原件也一并说清楚。
        const variant = url.searchParams.get('variant') === 'orig' ? 'orig' : 'mod';
        const P = pathsOf(id, variant);
        let entries = [];
        try { entries = await readZipEntries(P.blobPath); } catch { /* 读不了就只给 meta */ }
        const top = {};
        for (const e of entries) {
          if (e.dir) continue;
          const seg = e.name.split('/');
          const k = seg.length > 1 ? seg[0] + '/' : '(根)';
          top[k] = (top[k] || 0) + (e.uncompSize || 0);
        }
        // ⭐ 「发布者改了什么」：把 `revisions` 里**发布者那一侧**的改动摘出来给审核页看
        //    （需求 B「审核页显示发布者改了什么」）。`revisions` 本来就是既有字段，
        //    这里只是**只读地挑出 by !== 'admin' 的那些**，一个字节都不写。
        const revisions = Array.isArray(meta.revisions) ? meta.revisions : [];
        const publisherRevisions = revisions
          .filter((r) => r && r.by && r.by !== 'admin')
          .map((r) => ({ at: r.at ?? null, by: r.by, changed: r.changed ?? null, to: r.to ?? null, why: r.why ?? null }));
        const P2 = pathsOf(id, 'mod');
        const candPath = P2 ? join(P2.dir, CANDIDATE_BLOB) : null;
        const candRec = P2 ? readJson(join(P2.dir, 'candidate.json')) : null;
        const candidateLive = candPath && existsSync(candPath)
          ? createHash('sha256').update(readFileSync(candPath)).digest('hex') : null;
        return sendJson(res, 200, { meta, entries: entries.filter((e) => !e.dir).slice(0, 400), topLevel: top,
          variant,
          // 通过时就是照这个哈希核对「改写版没被掉包」的，所以详情里也带上，好让人当场比。
          viewSha256: existsSync(P.blobPath) ? createHash('sha256').update(readFileSync(P.blobPath)).digest('hex') : null,
          // 两个下载都**同一个编号**，用 variant 分开：默认给要发布的那份，留档原件单独一个口。
          download: `/api/file/${id}`,
          archiveDownload: origArchiveOf(id),          // pack.json 的原件快照：原注释一字未变的凭据。判据与公开列表同一份实现。
          packJsonOrig: readJson(P.packJsonOrig) || null,
          // 新增（只加字段，老读法不受影响）：
          publisherRevisions,
          candidate: candRec ? {
            ...candRec.candidate,
            download: `/api/file/${id}?variant=candidate`,
            liveSha256: candidateLive,
            hashMatches: !!(candidateLive && candRec.candidate?.sha256 === candidateLive),
          } : null });
      }

      // 普通投稿的通过 / 打回。
      // ⚠️ 同样只接受**明确指定的 id**：批量喂筛出来的 id 会把刚打回的东西又批准回去
      //   （2026-10-11 线上回归的成因，见文件头那条纪律）。批准 = 上线，一条一条来。
      if (req.method === 'POST' && p === `${ADMIN_API}/decide`) {
        const raw = await readBody(req, 64 * 1024);
        let inObj = {};
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        const { id, decision, reason, displayName, acknowledge, replacedBy } = inObj;
        // 一次一个明确写出的 id（与 `/note`、`/compat/note` 同一条铁律）：任何「一批」的形状直接拒。
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要改 N 条就发 N 次，每条单独核对。`,
          });
        }
        if (!ID_RE.test(String(id || ''))) return sendJson(res, 400, { error: 'id 形状不对' });
        if (!['approved', 'rejected', 'superseded'].includes(decision)) {
          return sendJson(res, 400, {
            error: 'decision 只能是 approved / rejected / superseded（走 superseded 时必须同时给 replacedBy）',
          });
        }
        if (!existsSync(blobPath(id))) return sendJson(res, 404, { error: '没有这条投稿' });
        // 兼容包走自己的那一段（它有「两个署名 + 原件留档 + 原注释不变」几条硬检查）。
        // 从这里放它过去，等于把那些检查全部绕开 —— 所以直接挡住。
        // ⚠️ **唯一的例外**是「按『以新为准』把一条旧兼容包下课」：那件事不属于「给兼容包做决定」，
        //    它有自己的门（判据多一道「两条同 pack.id」），见 `POST ${ADMIN_API}/supersede`。
        if (isCompat(id)) {
          return sendJson(res, 400, {
            error: decision === 'superseded'
              ? `这是兼容包（compat/ 区）：要给**兼容包**下课请用 POST ${ADMIN_API}/supersede（它另外核「两条同 pack.id」）。`
              : `这是维护者侧的兼容包，请用专门的那一段：POST ${ADMIN_API}/compat/decide`,
          });
        }
        const meta = readJson(metaPath(id)) || {};
        // ---- `superseded`：把这一条投稿标成「已被另一条**投稿**取代」（业主 2026-10-12 扩展）
        //   起因：同一个 `pack.json` id 会有多版投稿（`b6a3f39ae9ad` v0.2.1 取代 v0.2.0 与 v0.1），
        //   而原先只有「兼容包取代投稿」一条路能写 superseded ⇒ 高版本上线后旧版本一直挂在待审队列/公网。
        //   判据（缺一个就拒，**先算不写**）：
        //     · `replacedBy` 必填、形状对、不等于 id、那条记录存在；
        //     · **不构成取代环**（2026-10-13 新加：原先没有这一道）；
        //     · **取代者必须已经 approved** —— 否则公网上会出现「两份都没有」；
        //     · 幂等：已经是 superseded 且指向同一个 ⇒ `changed:false`，不写盘。
        //   ⭐ 2026-10-13 政策「以新为准」：原先那条「**取代者不能是兼容包**」**已删除** ——
        //      取代者可以是投稿、也可以是兼容包（被取代者同样两种都行，见 `markReplacedBy`）。
        //      判据本身搬到 `checkSupersede()`（**只有一份实现**，与 `/supersede` 共用，错误带码）。
        //
        //   ⭐ 2026-10-12 增补（裁定 ①）：**`replacedBy: null` 只对「发布者自撤」那条路放宽**，
        //      而且必须**同时带上 `reason: 'publisher-withdraw'`** 这个标志 ——
        //      即：管理员替发布者落一次自撤终态。**管理员驱动的取代（有取代者）一个字没放宽**：
        //      下面那一整段校验（形状 / 不等于自己 / 记录在 / 不是兼容包 / 必须已 approved）原样执行。
        if (decision === 'superseded' && String(reason || '') === 'publisher-withdraw') {
          const prev = readJson(decisionPath(id));
          if (prev && prev.decision === 'superseded' && (prev.replacedBy ?? null) === null) {
            return sendJson(res, 200, { ok: true, id, state: 'superseded', replacedBy: null, changed: false });
          }
          const at = markSelfWithdrawn(id, {
            reason: meta.withdrawReason || displayName || WITHDRAW_DEFAULT_REASON,
            by: 'admin', ip,
          });
          if (!at) return sendJson(res, 400, { error: '这条记录不能这样自撤（兼容包不来自发布者，不在自撤范围内）' });
          audit('withdrawConfirmed', {
            id, ip, actor: 'admin', admin: true,
            detail: { by: 'admin-decide', replacedBy: null, reason: meta.withdrawReason ?? null },
          });
          return sendJson(res, 200, { ok: true, id, state: 'superseded', replacedBy: null, changed: true, at });
        }
        if (decision === 'superseded') {
          const byId = String(replacedBy || '').trim();
          if (!ID_RE.test(byId)) {
            return sendJson(res, 400, { code: 'SUPERSEDE_NEW_ID_SHAPE',
              error: 'superseded 必须同时给 replacedBy（取代它的那条投稿编号），且形状要对。'
              + '（唯一的例外是**发布者自撤**：那条走 reason:\'publisher-withdraw\' + replacedBy:null，见本段注释。）' });
          }
          // 判据只有一份：与 `POST ${ADMIN_API}/supersede` 共用 `checkSupersede()`（见它上面的说明）。
          // ⚠️ 本入口**不强制同 `pack.id`** —— 它是管理员的明确指令，历史上允许跨 id 的人工纠正/合并；
          //    「两条同 pack.id」那道门只开在「以新为准」的新端点里（那条路是给常规版本更替用的）。
          // ⭐ 2026-10-13 政策「以新为准」：`replacedBy` 是**兼容包**也放行了（原先一律 400 拦下）。
          //    取代者必须已经 approved 那一条**一个字没放宽**（防公网「两份都没有」）。
          const chk = await checkSupersede(id, byId, { requireVisible: false });
          if (chk.error) {
            const { error, code, status, ...rest } = chk;
            return sendJson(res, status, { error, code, ...rest });
          }
          const prev = readJson(decisionPath(id));
          if (prev && prev.decision === 'superseded' && prev.replacedBy && prev.replacedBy.id === byId) {
            return sendJson(res, 200, { ok: true, id, state: 'superseded', replacedBy: byId, changed: false });
          }
          const r = markReplacedBy(id, byId, chk.newMeta.name || null);
          if (!r) {
            return sendJson(res, 500, { code: 'SUPERSEDE_WRITE_FAILED',
              error: '这条记录不能这样取代（它的 meta.json 读不出来）—— 磁盘上什么都没改。' });
          }
          audit('superseded', { id, ip, actor: 'admin', admin: true, detail: { replacedBy: byId } });
          return sendJson(res, 200, { ok: true, id, state: 'superseded', replacedBy: byId, replaced: r, changed: true });
        }
        // 疑似素材**可以**上线（业主裁决：照收，但标注清楚），但必须**显式确认**过标记 ——
        // 不允许默默放过：页面上那个勾选会把它带来，少了就拒。
        // 两道「点头才放行」，都**不改档位规则**、只要求发布者显式 acknowledge：
        //   ① 疑似素材（blocker 档 → 上公开面会单独标注，既有行为一字未改）；
        //   ② 盲区 warn 档（不透明容器 / 作者自述夹带官方素材 —— 见 review.mjs 的 ACK_CODES）：
        //      档位是 warn（业主口径：让风险显式、由发布决定承担，不是一律拦住），但**发布要点头**。
        if (decision === 'approved' && (meta.suspected || meta.ackRequired === true) && acknowledge !== true) {
          const warnHits = (meta.flags || []).filter((f) => ACK_CODES.includes(f.code));
          return sendJson(res, 409, {
            error: meta.suspected
              ? '这条带「疑似官方素材」标记，上线后会在公开列表里明确标注。看过标记仍要上线的话，勾上确认再来。'
              : `这条命中「要显式确认」的检查（${[...new Set(warnHits.map((f) => f.code))].join(' / ')}）：`
                + '不透明容器 / 作者自述夹带官方素材。档位是 warn（不是 blocker），但发布要显式点头 —— 看过命中项仍要上线的话，勾上确认再来。',
            flags: meta.suspected ? (meta.flags || []).filter((f) => f.level === 'blocker') : warnHits,
            needsAcknowledge: true,
          });
        }
        writeJson(decisionPath(id), {
          decision, reason: reason || null, at: nowIso(), by: 'admin',
          displayName: displayName || meta.name,
          acknowledgedSuspected: meta.suspected === true && decision === 'approved',
        });
        if (displayName && displayName !== meta.name) writeJson(metaPath(id), { ...meta, name: displayName });
        // 管理员把一条**带自撤申请**的记录重新批回上线 ⇒ 那条申请就算处理掉了（清标志位，留痕）。
        // 这是「管理员拒绝自撤」的另一条等价路径（在决定页直接批回），两条路都留痕、都不删东西。
        const cleared = [];
        if (decision === 'approved' && meta.withdrawRequested === true) {
          const m2 = readJson(metaPath(id)) || meta;
          const hist2 = Array.isArray(m2.revisions) ? m2.revisions : [];
          const wh2 = Array.isArray(m2.withdrawHistory) ? m2.withdrawHistory : [];
          writeJson(metaPath(id), {
            ...m2,
            withdrawRequested: false,
            withdrawHistory: [...wh2, { at: nowIso(), by: 'admin', action: 'rejected-by-approve', reason: null, ip }],
            revisions: [...hist2, {
              at: nowIso(), by: 'admin',
              changed: { withdrawRequested: true }, to: { withdrawRequested: false },
              why: '管理员在决定页把这条重新批回上线 ⇒ 待确认的自撤申请视为被拒绝，公开面恢复。',
            }],
          });
          cleared.push('withdrawRequested');
        }
        audit(decision === 'approved' ? 'approved' : 'rejected', {
          id, ip, actor: 'admin', admin: true, detail: { reason: reason || null, cleared },
        });
        return sendJson(res, 200, { ok: true, id, state: decision, area: meta.area, suspected: meta.suspected === true, cleared });
      }

      // ================================================================
      // ⭐⭐ `POST ${ADMIN_API}/supersede` —— **「以新为准」的安全操作**（业主 2026-10-13 总政策）。
      //
      // 政策原话：「以后所有 mod 以新为准：新的上线、旧的下架但不删除」。
      //   同一个 mod 出了新版 ⇒ **新的进公开面**（它先走 `/decide` 或 `/compat/decide` 上线）、
      //   **旧的转 `superseded` 并写 `replacedBy` 指向新的**、**文件与记录一律保留**（下架 ≠ 删除）。
      //
      // 报文：`{ "newId": "<新的编号>", "oldId": "<旧的编号>", "reason": "<可选，只进 revisions 的 why>" }`
      //   · **一次只处理一对**（禁批量：`ids` / `batch` / `items` / `list` 一律 400）；
      //   · **两条必须同 `pack.id`**（读的是 `mod.zip` 里的 `pack.json`；兼容包退回 `meta.pack.id`）——
      //     不同 `pack.id` 直接 409，**绝不误下架无关 mod**；读不出 `pack.id` ⇒ 422，**不猜**；
      //   · 不得自己取代自己、不得构成取代环（A→B→A）⇒ 400 / 409，**都带明确错误码**；
      //   · 取代者必须**已经在公开面**（approved 且没有待确认的自撤申请）⇒ 否则 409，
      //     免得公网上「两份都没有」；
      //   · 幂等：旧的已经指向这个新的 ⇒ 200 `changed:false`，**不写盘**。
      //
      // 覆盖两种组合（政策要求两种都行）：
      //   ① 旧的普通投稿 ← 新的普通投稿／新的兼容包；
      //   ② **旧的兼容包** ← 新的普通投稿／新的兼容包（原先 `markReplacedBy` 硬拦，本端点放开）。
      //
      // 落盘只两处（都是**追加**，零删除）：
      //   · 旧记录的 `decision.json` —— 由**同一个** `markReplacedBy` 写（superseded + replacedBy）；
      //     ⚠️ 它是**整份覆盖**的，所以旧记录原来那段 reason 会在这里被换掉 ——
      //   · 旧记录的 `meta.json` —— **只追加**一笔 `revisions`（谁取代的、从什么变成什么、为什么，
      //     外加 `decisionSnapshot`：**上一份 `decision.json` 原样留档**，一个字都没丢）；
      //     其余键一个不动；`mod.zip` / `orig.zip` / `pack-json.orig.json` **一个字节都不动**。
      //
      // ⚠️ 与既有三个调用点（`compat-submit?publish=1` / `/compat/decide` / `/compat/link`）的差别：
      //    那三条**只写 `decision.json`**（历史口径，测试里逐字节钉着）—— 本端点多一笔 `revisions`。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/supersede`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { code: 'SUPERSEDE_BODY', error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { code: 'SUPERSEDE_BODY', error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            code: 'SUPERSEDE_BATCH',
            error: `本端点只认**一对**（newId + oldId），不收「一批」（多了这些键：${batchKeys.join(' / ')}）。`
              + '要处理 N 对就发 N 次，每对单独核对。',
          });
        }
        if (inObj.reason != null && typeof inObj.reason !== 'string') {
          return sendJson(res, 400, { code: 'SUPERSEDE_REASON_SHAPE', error: 'reason 形状不对（必须是字符串）' });
        }
        const oldId = String(inObj.oldId || '').trim();
        const newId = String(inObj.newId || '').trim();
        const chk = await checkSupersede(oldId, newId, { requireSamePack: true, requireVisible: true });
        if (chk.error) {
          const { error, code, status, ...rest } = chk;
          return sendJson(res, status, { error, code, ...rest });
        }
        const oldDec = readJson(decisionPath(oldId));
        if (oldDec && oldDec.decision === 'superseded' && oldDec.replacedBy && oldDec.replacedBy.id === newId) {
          return sendJson(res, 200, {
            ok: true, newId, oldId, packId: chk.packId, state: 'superseded', replacedBy: newId, changed: false,
            note: '旧的那条早就指向这个新的了 —— 幂等：**没写盘**（记录、包体、留档照旧）。',
          });
        }
        const replaced = markReplacedBy(oldId, newId, chk.newMeta.name || null);
        if (!replaced) {
          return sendJson(res, 500, { code: 'SUPERSEDE_WRITE_FAILED',
            error: `取代没落成（${oldId} 的 meta.json 读不出来？）—— 磁盘上什么都没改。` });
        }
        // 只追加一笔 revisions（旧记录的 meta.json；其余键、其余文件一个字节不动）。
        // ⚠️ `decisionSnapshot` 是**零删除的关键那一笔**：`markReplacedBy` 是整份覆盖 `decision.json`
        //    的，旧记录里原来那段 reason（可能很长、写着两条的关系与取证）会被换掉 ——
        //    所以在这里把**上一份决定原样留档**，日后翻记录能逐字看到它原先是怎么判的。
        //    （与 `clearDecision` 的 `decisionSnapshot` 同一个形状、同一个理由。）
        const om = readJson(metaPath(oldId)) || {};
        const hist = Array.isArray(om.revisions) ? om.revisions : [];
        const why = String(inObj.reason || '').trim()
          || `「以新为准」：同一个 pack.id（${chk.packId}）的新版本 ${newId}（${chk.newMeta.name || '未命名'}）`
            + '已上线，这一条转为 superseded 下架；记录、包体、留档全部保留（下架 ≠ 删除）。';
        writeJson(metaPath(oldId), {
          ...om,
          revisions: [...hist, {
            at: replaced.at, by: 'admin',
            changed: { decision: oldDec ? oldDec.decision : 'pending', replacedBy: (oldDec && oldDec.replacedBy) || null },
            to: { decision: 'superseded', replacedBy: newId },
            why,
            // 上一次判定**原样**留一份（没有 decision.json 就是 null：那本来就没什么可留的）。
            decisionSnapshot: oldDec || null,
          }],
        });
        audit('supersede', {
          id: oldId, ip, actor: 'admin', admin: true,
          detail: { newId, packId: chk.packId, oldArea: dirOf(oldId)?.area ?? null, newArea: dirOf(newId)?.area ?? null, chain: chk.chain },
        });
        return sendJson(res, 200, {
          ok: true, newId, oldId, packId: chk.packId,
          state: 'superseded', replacedBy: newId, replaced, changed: true, at: replaced.at,
          note: '旧的转 superseded 并写下 replacedBy（公开面与公开下载口立刻不再提供这一条）；'
            + '只追加了 decision.json 与一笔 meta.revisions —— 记录、mod.zip、留档原件一个都没删。',
        });
      }

      // ================================================================
      // ⭐ `POST ${ADMIN_API}/withdraw-decide` —— **发布者自撤待确认**的一键确认 / 拒绝（裁定 ②）。
      //
      // 报文：`{ "id": "<编号>", "action": "confirm" | "reject", "reason": "<可选，拒绝时建议写>" }`
      //   · `confirm` ⇒ 落 `decision=superseded` + **`replacedBy: null`**（自撤终态，走 markSelfWithdrawn）；
      //   · `reject`  ⇒ 清 `withdrawRequested`（公开面恢复），申请进 `withdrawHistory` 留痕。
      //
      // ⚠️ 与全站同一条铁律：**只认一个明确指定的 id**（`ids`/`batch`/`items`/`list` 一律 400）。
      // ⚠️ 零删除：两条路都**不删**记录、包体、决定 —— 拒绝只是清一个布尔标志位并留痕；
      //    确认是把决定换成自撤终态（上一份决定进 revisions）。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/withdraw-decide`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要处理 N 条就发 N 次，每条单独核对。`,
          });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6-32 位小写字母/数字）' });
        const action = String(inObj.action || '').trim();
        if (!['confirm', 'reject'].includes(action)) {
          return sendJson(res, 400, { error: 'action 只能是 confirm（确认自撤）或 reject（拒绝、恢复公开）' });
        }
        if (inObj.reason != null && typeof inObj.reason !== 'string') {
          return sendJson(res, 400, { error: 'reason 形状不对（必须是字符串）' });
        }
        const note = String(inObj.reason || '').trim().slice(0, 1000);
        const P = pathsOf(id);
        if (!P) return sendJson(res, 404, { error: '没有这条记录' });
        const meta = readJson(P.meta);
        if (!meta) return sendJson(res, 404, { error: '这条记录的 meta.json 读不出来（形状不对），不动它' });
        if (P.area === 'compat') return sendJson(res, 400, { error: '兼容包不来自发布者，没有自撤这回事' });
        if (meta.withdrawRequested !== true) {
          return sendJson(res, 409, {
            error: '这条现在没有待确认的自撤申请（withdrawRequested 不是 true）—— 先让发布者从「我的投稿」提交自撤。',
            withdrawRequested: false,
          });
        }
        const at = nowIso();
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        const wh = Array.isArray(meta.withdrawHistory) ? meta.withdrawHistory : [];
        if (action === 'reject') {
          writeJson(P.meta, {
            ...meta,
            withdrawRequested: false,
            withdrawHistory: [...wh, { at, by: 'admin', action: 'rejected', reason: note || null, ip }],
            revisions: [...hist, {
              at, by: 'admin',
              changed: { withdrawRequested: true }, to: { withdrawRequested: false },
              why: '管理员拒绝了发布者的自撤申请：清掉待确认标志位，这条**照旧公开**（记录与包体一个都没动）。',
            }],
          });
          audit('withdrawRejected', { id, ip, actor: 'admin', admin: true, detail: { reason: note || null } });
          return sendJson(res, 200, {
            ok: true, id, action: 'reject', withdrawRequested: false, at,
            note: '已拒绝：这条**恢复公开**（它本来就没被改动过 —— 自撤申请只影响「列不列出来」）。申请已记入 withdrawHistory 留痕。',
          });
        }
        const confirmedAt = markSelfWithdrawn(id, {
          reason: meta.withdrawReason || note || WITHDRAW_DEFAULT_REASON,
          by: 'admin', ip,
        });
        if (!confirmedAt) return sendJson(res, 400, { error: '这条记录不能这样自撤（兼容包不在自撤范围内）' });
        // 终态已落 ⇒ 清掉待确认标志位（申请已经处理完，别再挂着）。
        const m3 = readJson(P.meta) || meta;
        writeJson(P.meta, {
          ...m3,
          withdrawRequested: false,
          withdrawHistory: [...(Array.isArray(m3.withdrawHistory) ? m3.withdrawHistory : []),
            { at: confirmedAt, by: 'admin', action: 'confirmed', reason: note || null, ip }],
          revisions: [...(Array.isArray(m3.revisions) ? m3.revisions : []), {
            at: confirmedAt, by: 'admin',
            changed: { withdrawRequested: true }, to: { withdrawRequested: false, decision: 'superseded（replacedBy: null，自撤）' },
            why: '管理员确认了发布者的自撤申请：这条转为 superseded 自撤终态，公开面不再列出（记录、包体、留档全部保留）。',
          }],
        });
        audit('withdrawConfirmed', {
          id, ip, actor: 'admin', admin: true,
          detail: { replacedBy: null, reason: meta.withdrawReason ?? null, adminNote: note || null },
        });
        return sendJson(res, 200, {
          ok: true, id, action: 'confirm', state: 'superseded', replacedBy: null, at: confirmedAt,
          note: '已确认自撤：`decision=superseded` 且 **`replacedBy: null`**（没有取代者）。'
            + '记录、包体、留档原件与全部留痕一个都没删（零删除）。',
        });
      }

      // ================================================================
      // ⭐ `POST ${ADMIN_API}/promote-blob` —— **批准候选包体**（裁定 ⑦ 的后半句）。
      //
      // 报文：`{ "id": "<编号>" }`（可选 `expectedSha256`：详情页拿到的那个哈希，带上就当场核）。
      //   · 核过哈希才切：候选文件现在磁盘上的 sha256 必须等于记录里那一栏；
      //   · 旧的 `mod.zip` **改名留档**（`mod.superseded-<ts>.zip`），**不删**；
      //   · 切换后本条**回到待审**（`clearDecision`）—— 换包体是有后果的动作，
      //     上线与否仍然由管理员在决定页明确给一次（与「发布者不直改公开面」同一条边界）。
      // ⚠️ 只认一个明确指定的 id。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/promote-blob`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要批 N 条就发 N 次。`,
          });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6-32 位小写字母/数字）' });
        if (inObj.expectedSha256 != null && typeof inObj.expectedSha256 !== 'string') {
          return sendJson(res, 400, { error: 'expectedSha256 形状不对（必须是字符串）' });
        }
        if (isCompat(id)) return sendJson(res, 400, { error: '兼容包走 /compat/submit 那条路，没有候选包体这回事' });
        const r = promoteCandidate(id, { by: 'admin', expectedSha256: inObj.expectedSha256 || null });
        if (r.error) return sendJson(res, r.error.includes('没有') ? 404 : 409, r);
        audit('promoteBlob', {
          id, ip, actor: 'admin', admin: true,
          detail: { sha256: r.sha256, oldSha256: r.oldSha256, archived: r.archived },
        });
        return sendJson(res, 200, {
          ...r,
          note: '候选包体已批准：公开包体切到这一份；旧包体改名留档（不删）。'
            + '本条已**回到待审** —— 请在上面的决定区给它一次明确的「通过并上线」（发布者不直改公开面）。',
        });
      }

      // ================================================================
      // ⭐ `POST ${ADMIN_API}/issue-claim` —— 管理员**手工发一枚认领码**（裁定 ④ / ⑨）。
      //
      // 用途两个，都是带外（微信/群里）交给发布者：
      //   · **老记录**（115 条里没有 `publisherTokens` 的那些）：它们没有提交时的认领码，
      //     要让人能自助管理，就由管理员在这里发一枚；
      //   · **令牌丢了**：发布者把令牌弄丢（站上只有哈希，找不回明文）⇒ 管理员再发一枚认领码，
      //     他换一枚新的即可（旧令牌不回收 —— 零删除）。
      //
      // 报文：`{ "id": "<编号>" }`。返回里**明文只出现这一次**；盘上只落哈希。
      // ⚠️ 只认一个明确指定的 id；**兼容包不发**（它不出自发布者）。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/issue-claim`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要发 N 枚就发 N 次。`,
          });
        }
        const id = typeof inObj.id === 'string' ? inObj.id.trim() : '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对（6-32 位小写字母/数字）' });
        const P = pathsOf(id);
        if (!P) return sendJson(res, 404, { error: '没有这条记录' });
        if (P.area === 'compat') return sendJson(res, 400, { error: '兼容包不来自发布者，不发认领码' });
        const meta = readJson(P.meta);
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          return sendJson(res, 404, { error: '这条记录的 meta.json 读不出来（形状不对），不动它' });
        }
        const code = claimOf();
        const at = nowIso();
        // 待用清单只保留最近的几枚（旧的也没用了，但**不删记录**：只是不再列在待用清单里）。
        const kept = (Array.isArray(meta.pendingClaim) ? meta.pendingClaim : []).slice(-7);
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        writeJson(P.meta, {
          ...meta,
          pendingClaim: [...kept, { h: claimHashOf(code), at, by: 'admin', ip }],
          revisions: [...hist, {
            at, by: 'admin',
            changed: { pendingClaim: (meta.pendingClaim || []).length },
            to: { pendingClaim: kept.length + 1 },
            why: '管理员手工发了一枚认领码（老记录认领 / 发布者令牌丢失后的找回）。只落哈希。',
          }],
        });
        audit('claimIssued', {
          id, ip, actor: 'admin', admin: true,
          detail: { pendingClaims: kept.length + 1, existingTokens: (meta.publisherTokens || []).length },
        });
        return sendJson(res, 200, {
          ok: true, id, claimCode: code, at,
          claimPath: '/api/publisher/claim', page: '/mine',
          note: '这一枚认领码**只在这里出现这一次**（盘上只存哈希）。请**带外**交给这条投稿的发布者：'
            + '他去「我的投稿」页用它换一枚发布者令牌。老记录（没有发布者令牌的）也是这样开通自助管理的。'
            + '⚠️ 别把它贴在公开地方 —— 谁拿到谁就能替这条投稿做自助操作。',
        });
      }

      // ================================================================
      // 维护者侧：**兼容包上传与发布**
      //
      // 业主的原话：「在审核通道额外加一个能上传**已经兼容完的兼容包**，并**注明作者和兼容者**，
      //             **保持原注释不变**，但**通过的是新的兼容改写过的包**」。
      //
      // 落到这里的四条：
      //   ① 上传者是维护者 —— 这一段整体挂在 `${ADMIN_API}/compat/*` 下，与 /api/submit 不是一回事，
      //      两道防线（ADMIN_IPS 回环 + ADMIN_TOKEN/Basic）照旧先过一遍；
      //   ② 两个署名分开存（`author` / `compatAuthor`），谁也不覆盖谁；
      //   ③ 包自带的 pack.json **一个字节都不动**（这里从不改写 zip），原件那一份另外快照成
      //      `pack-json.orig.json`；「兼容者」只写进站点侧的 meta.json，**不进包**；
      //   ④ 通过后公开可下的是 `mod.zip`（改写版），被改写的原件进 `orig.zip`：**留档、不发布**
      //      （`?variant=orig` 只有维护者能下），哈希与来源一起记下来，追得到「谁由谁改来」。
      //
      // 入口（业主 2026-10-11 改口径）：管理界面里**不再有**独立的「兼容包」区/列表/页面；
      // **只在投稿详情页（下载按钮那一行）留一个独立的上传按钮** ——
      // 选 zip → 填名 → 点发布，一次动作 = 上传 + 通过 + 发布（`&publish=1`）。
      // 发布成功后按 **B 口径**处置原投稿：标 `superseded`、移出待审队列，记录与文件都保留
      // （见 markReplacedBy）。兼容包是**另起的一条记录**（新编号），用 `compatOf` / `origin`
      // 记下「由哪条投稿改来」，两条记录状态互不牵连。
      //
      // ----------------------------------------------------------------
      // 「维护者人工确认」`&confirmBlockers=1&confirmReason=…`（业主 2026-10-11 的第四件事）
      //
      // ⚠️ 它**不是**放宽档位规则，也**不是**静默绕过：
      //   · 档位定义（`reviewEntries` 那一份）、命中明细、`flags` 里的 blocker **一条都没改**，
      //     照旧一条不落地写进记录 —— 谁都能看见这条命中过什么；
      //   · 它只是**逐条**的一个人工动作：维护者本人核对过这些真素材路径之后，明确放行这一条。
      //     所以报文里必须同时给 `confirmBlockers=1` 与**一段理由**（`confirmReason`），
      //     两个缺一个都 400 拒掉 —— 没有「默认确认」这种状态；
      //   · 确认这一笔写进 `meta.json.maintainerConfirm` **与** `decision.json.maintainerConfirm`
      //     （含 by / at / 理由 / 命中的档位代码），日后翻记录就能看出「这条是谁在什么时候、
      //     凭什么放行的」；
      //   · **一次请求 = 一个包 = 一条记录**（这个端点的报文就是一个 zip 实体，天然只可能一条），
      //     绝不要写「把一批包循环喂进来」的脚本 —— 与 `/compat/decide`、`/compat/link` 同源那条铁律；
      //   · 命中 blocker 但**没给**确认 ⇒ 与从前完全一样：记录照收、照留档，只是标疑似、
      //     不进公网主列表（落在「疑似素材」那一组）。
      // ================================================================

      if (req.method === 'POST' && p === `${ADMIN_API}/compat-submit`) {
        if (rateLimited(ip)) return sendJson(res, 429, { error: `传得太频繁了，请等 ${RATE_WINDOW_MIN} 分钟再传`, code: 'TOO_FREQUENT', retryAfterMin: RATE_WINDOW_MIN }, { 'retry-after': String(RATE_WINDOW_MS / 1000) });

        const name = (url.searchParams.get('name') || '').trim();
        // 「兼容者」是必填字段：**字段必须在报文里**（缺 ⇒ 拒），但**值可以为空**。
        if (!url.searchParams.has('compatAuthor')) {
          return sendJson(res, 400, {
            error: '缺少「兼容者」字段 —— 这一栏是必填的（值可以为空：留空就如实记成「未填」，但字段本身必须在报文里）。',
            needsCompatAuthor: true,
          });
        }
        const compatAuthorGiven = (url.searchParams.get('compatAuthor') || '').trim();  // 兼容者：谁做的改写（可以是空）
        // 空就存空 —— **不兜底任何名字**（上一版的 Mo233 兜底已作废）。
        const compatAuthor = compatAuthorGiven;
        const compatAuthorSource = compatAuthorGiven ? 'form' : 'empty';
        const authorGiven = (url.searchParams.get('author') || '').trim();           // 原作者：留空则从包里读
        const originUrl = (url.searchParams.get('originUrl') || '').trim().slice(0, 300);
        const compatOf = (url.searchParams.get('compatOf') || '').trim();           // 由哪个待审原件改写来
        const compatNote = (url.searchParams.get('compatNote') || '').trim();       // 改了什么
        if (compatNote.length > NOTE_MAX) return sendJson(res, 400, { error: `兼容说明太长（最多 ${NOTE_MAX} 字）` });
        // 「维护者人工确认」：形状先算不写（校验放在真读包之前，缺理由/形状不对直接拒，磁盘上什么都不动）。
        // 只认字面 `1`；给了理由才算确认。两样缺一个都 400 —— 没有「默认确认」。
        const confirmRaw = (url.searchParams.get('confirmBlockers') || '').trim();
        const confirmReason = (url.searchParams.get('confirmReason') || '').trim();
        if (confirmRaw && confirmRaw !== '1') {
          return sendJson(res, 400, { error: 'confirmBlockers 只认字面 1（要么不带，要么就是 1）' });
        }
        if (confirmRaw === '1' && confirmReason.length < 8) {
          return sendJson(res, 400, {
            error: '带 confirmBlockers=1 就必须同时给一段理由（confirmReason，至少 8 个字）—— '
              + '这是**逐条人工确认**，要留痕到决定记录里，没有「默认确认」这种状态。',
            needsConfirmReason: true,
          });
        }
        if (confirmRaw === '1' && confirmReason.length > 1000) {
          return sendJson(res, 400, { error: '确认理由太长（最多 1000 字）' });
        }

        const nameFlags = reviewName(name);
        if (nameFlags.some((f) => f.level === 'blocker')) return sendJson(res, 400, { error: '名称不合格', flags: nameFlags });
        // 两个署名分开验、分开报错：原作者那一栏允许先留空（下面会用包里的 pack.json 预填）；
        // 兼容者那一栏**必填但可空** —— 所以 required: false（空值不是 blocker），
        // 空值另外记一条 info：让「未填」这件事在页面上看得见，而不是被悄悄略过。
        const authorFlags = authorGiven ? reviewLabel({ label: '原作者', prefix: 'AUTHOR', value: authorGiven }) : [];
        const compatFlags = reviewLabel({ label: '兼容者', prefix: 'COMPAT_AUTHOR', value: compatAuthor, required: false });
        if (!compatAuthor) {
          compatFlags.push({ level: 'info', code: 'COMPAT_AUTHOR_EMPTY',
            text: '兼容者未填（这一栏必填，但值可以为空）—— 站点侧如实记成「未填」，没有代填任何名字；公网列表照样保留这一栏并标「未填」。' });
        }
        const sourceFlags = [];
        if (compatOf) {
          if (!ID_RE.test(compatOf)) return sendJson(res, 400, { error: 'compatOf 形状不对（应当是那个待审原件的编号）' });
          if (!existsSync(metaPath(compatOf))) return sendJson(res, 400, { error: `找不到编号 ${compatOf} 的原件投稿` });
          if (isCompat(compatOf)) return sendJson(res, 400, { error: '一条兼容包不能再指向另一条兼容包（要写的是被改写的那个原件）' });
          sourceFlags.push({ level: 'info', code: 'COMPAT_OF', text: `由待审原件 ${compatOf} 改写而来` });
        } else {
          sourceFlags.push({ level: 'info', code: 'COMPAT_OF_MISSING', text: '没写「由哪个待审原件改写来」——通过之前必须补上（否则日后追不到谁由谁改来）' });
        }
        // 第三方来源：**可以留空**（业主口径 2026-10-11）—— 留空就如实留白，不再拦通过；
        // 填了就记进 meta.originUrl（追溯用）。所以这里只留一条 info，不是硬门。
        if (!originUrl) {
          sourceFlags.push({ level: 'info', code: 'ORIGIN_URL_MISSING', text: '没填原件的来源链接 —— 可以为空（如实留白，不拦通过）；填了就记下来便于追溯' });
        }
        if (compatFlags.some((f) => f.level === 'blocker') || authorFlags.some((f) => f.level === 'blocker')) {
          return sendJson(res, 400, { error: '署名不合格', flags: [...authorFlags, ...compatFlags] });
        }

        const declared = Number(req.headers['content-length'] || 0);
        if (declared && declared > MAX_BYTES) {
          return sendJson(res, 413, {
            error: `文件 ${(declared / 1048576).toFixed(1)} MB，超过上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB`,
            code: 'TOO_LARGE',
            maxMB: MAX_BYTES / 1048576,
          });
        }
        const body = await readBody(req, MAX_BYTES);
        if (!body.length) return sendJson(res, 400, { error: '没有收到文件' });
        if (!looksLikeZip(body.subarray(0, 4))) return sendJson(res, 400, { error: '只收 zip（这个文件头不是 zip 魔数）' });

        const id = idOf();
        const tmpZip = join(DATA_DIR, `${id}.compat.part`);
        writeFileSync(tmpZip, body);
        partToClean = tmpZip;        // 从这里起，任何失败都要靠 finally 收掉它（被拒也要收）

        // 三档检查：**完整复用**既有那一段（reviewEntries）。兼容版不该另立一套标准。
        let entries = [];
        let contentFlags = [];
        try {
          entries = await readZipEntries(tmpZip);
          contentFlags = reviewEntries(entries, { packIdHint: name });
        } catch (e) {
          contentFlags = [{ level: 'blocker', code: 'BAD_ZIP', text: `zip 读不了：${e.message}` }];
        }
        // 与 /api/submit **同一套**盲区检查（兼容版不该另立一套标准）。
        contentFlags = [...contentFlags, ...(await blindSpotFlags(tmpZip, entries, { note: compatNote }))];
        // 业主令 31：本条的 pack.json 与**留档原件的根 pack.json** 比一比 —— 不同 ⇒ warn + 发布要点头；
        // 原件没有根 pack.json（补丁/安装器/套目录形态）⇒ info。**必须在下面算 ackRequired 之前。**
        if (compatOf) {
          const opDiff = pathsOf(compatOf, 'mod');
          let originText = null, originHasRoot = false;
          if (opDiff && existsSync(opDiff.blobPath)) {
            try {
              const b0 = (await readZipFile(opDiff.blobPath, ['pack.json'])).get('pack.json');
              if (b0) { originHasRoot = true; originText = b0.toString('utf8').replace(/^\uFEFF/, ''); }
            } catch { /* 读不了 ⇒ 按"没有根 pack.json"记 info */ }
          }
          let myText = null;
          try {
            const b1 = (await readZipFile(tmpZip, ['pack.json'])).get('pack.json');
            if (b1) myText = b1.toString('utf8').replace(/^\uFEFF/, '');
          } catch { /* 上面已经因为读不到 pack.json 拒过一次了 */ }
          contentFlags = [...contentFlags, ...reviewCompatPackJson({ compatText: myText, originText, originHasRoot })];
        }
        const ackCodes = ackCodesOf(contentFlags);
        const ackRequired = needsAcknowledge(contentFlags);
        const suspectedByTiers = hasBlocker(contentFlags);
        // 档位照样判（`suspectedByTiers` 永远如实算出来，不进包、也不被确认覆盖）；
        // 「维护者人工确认」只决定**这一条算不算疑似**（＝进不进公网主列表），
        // 并把确认这一笔留痕。档位定义与 flags 里的命中明细一条都没动。
        const blockersHit = contentFlags.filter((f) => f.level === 'blocker');
        let maintainerConfirm = null;
        if (confirmRaw === '1') {
          if (!blockersHit.length) {
            return sendJson(res, 400, {
              error: '这一份没有命中任何 blocker 档 —— 不需要（也不接受）维护者确认。'
                + '（确认只用于**人工核对过真素材路径**之后逐条放行，不是一个可以随便带的开关。）',
              needsBlockers: true,
            });
          }
          maintainerConfirm = {
            by: 'admin', at: nowIso(), reason: confirmReason,
            codes: blockersHit.map((f) => f.code),
            text: '维护者人工确认：这些真素材路径经人工核对后**逐条**放行。'
              + '这是人工确认动作本身，不是放宽档位规则 —— 档位定义与命中明细（flags）一条都没改。',
          };
        }
        const suspected = suspectedByTiers && !maintainerConfirm;

        // 原注释：先把包里那份 pack.json 读出来。
        let pack = null;
        try { pack = await packJsonFor(tmpZip); } catch (e) {
          contentFlags.push({ level: 'blocker', code: 'PACK_JSON_UNREADABLE', text: `pack.json 读不出来：${e.message}` });
        }
        if (pack === null) {
          return sendJson(res, 400, {
            error: '这个 zip 里读不到能解析的 pack.json —— 维护者侧的兼容包要的是**已经兼容完的成品包**，包内文件请直接放在 zip 根。'
              + '（组员投来的未兼容原件请走公网上传页 /）',
            flags: contentFlags,
          });
        }
        // 原作者：**自动预填**（从包里读），维护者可以核对后改写。
        const packName = typeof pack.name === 'string' && pack.name.trim() ? pack.name.trim() : null;
        const packAuthor = typeof pack.author === 'string' && pack.author.trim() ? pack.author.trim() : null;
        const author = authorGiven || packAuthor;
        if (!author) {
          return sendJson(res, 400, {
            error: '原作者拿不到：pack.json 里没有 author，你也没填。两个署名都必须有 —— 请把原作者填上（这一栏是硬要求，不允许空着通过）。',
            needsAuthor: true,
          });
        }
        const finalAuthorFlags = reviewLabel({ label: '原作者', prefix: 'AUTHOR', value: author });
        if (finalAuthorFlags.some((f) => f.level === 'blocker')) {
          return sendJson(res, 400, { error: '原作者不合格', flags: finalAuthorFlags });
        }

        const dir = dirIn('compat', id);
        mkdirSync(dir, { recursive: true });
        renameSync(tmpZip, join(dir, 'mod.zip'));
        partToClean = null;          // 已经是正式的 mod.zip 了，不再是临时文件

        // 留档原件：**真的拷一份到本条的目录里**，不是只留个指针。
        // 理由：原件那条投稿日后可能被打回、被清、被覆盖；而「原件留档」要的是
        // 「日后一定能翻出被改写的那一份、且能证明是同一份」。拷过来才独立于它。
        // 拷贝前先照 meta 里的 sha256 核一次 —— 对不上就不算留档，宁可留空。
        let origArchived = false;
        if (compatOf) {
          const op = pathsOf(compatOf, 'mod');
          const om = readJson(metaPath(compatOf)) || {};
          if (op && existsSync(op.blobPath)) {
            const blob = readFileSync(op.blobPath);
            const h = createHash('sha256').update(blob).digest('hex');
            if (!om.sha256 || h === om.sha256) {
              copyFileSync(op.blobPath, join(dir, 'orig.zip'));
              origArchived = true;
            } else {
              sourceFlags.push({ level: 'warn', code: 'ORIG_HASH_MISMATCH', text: `原件 ${compatOf} 的上传哈希与磁盘上的文件对不上，没有留档（请人工核对）` });
            }
          }
        }

        const files = entries.filter((e) => !e.dir);
        const sha = createHash('sha256').update(body).digest('hex');
        // 留档：原件那一份 pack.json 的快照 —— 原注释「一字未变」的凭据，
        // 也让日后能核对「通过了之后有没有人再改过包」。
        writeJson(join(dir, 'pack-json.orig.json'), {
          note: '这是兼容改写版 mod.zip 里 pack.json 的快照（原注释应当一字未变）。站点从不改写它。',
          capturedAt: nowIso(),
          pack,
        });

        // 来源侧：如果指明了是哪个待审原件改写来的，就把那个原件的哈希与来源一并记下来，
        // 这样「谁由谁改来」在没有单独上传原件时也追得到（哈希对得上才说明是同一份）。
        let origin = null;
        if (compatOf) {
          const om = readJson(metaPath(compatOf)) || {};
          const op = pathsOf(compatOf, 'mod');
          origin = {
            id: compatOf,
            area: om.area ?? dirOf(compatOf)?.area ?? null,
            name: om.name ?? null,
            sha256: om.sha256 ?? null,
            sourceUrl: om.homepage ?? null,
            author: om.author ?? null,
            uploadedAt: om.uploadedAt ?? null,
            verified: !!(om.sha256 && op && existsSync(op.blobPath)
              && createHash('sha256').update(readFileSync(op.blobPath)).digest('hex') === om.sha256),
            // 原件那一份已经拷进本条目录（orig.zip）——公开下载永远走它，不走原件投稿。
            archived: origArchived,
            archivedFile: origArchived ? 'orig.zip' : null,
          };
        }

        const meta = {
          id, area: 'compat', kind: 'compat',
          name,
          // 硬要求 2：两个署名**各占一栏**，互不覆盖。
          author,                                        // 原作者（预填自 pack.json 或维护者填）
          authorSource: authorGiven ? 'maintainer' : 'pack.json',
          authorGivenFromMaintainer: authorGiven || null,
          packAuthor,                                    // 包里那一栏原样（留痕，便于日后核对）
          compatAuthor,                                  // 兼容者 —— 只存在站点侧，永远不进 pack.json（空字符串 = 未填）
          compatAuthorSource,                            // 'form'（手填）或 'empty'（未填）——**没有 default 这一档**
          compatOf: compatOf || null,
          compatOfVerified: origin ? origin.verified : false,
          origin,
          originUrl: originUrl || null,
          compatNote: compatNote || null,
          note: compatNote || null,
          size: body.length,
          sha256: sha,
          blobName: blobNameFromHeader(req, `${id}-兼容版.zip`),
          uploadedAt: nowIso(), ip,
          entries: files.length,
          unpackedBytes: entries.reduce((n, e) => n + e.uncompSize, 0),
          pack: { id: pack.id ?? null, name: packName, author: packAuthor,
            license: pack.license ?? null, version: pack.version ?? null,
            description: typeof pack.description === 'string' ? pack.description : null },
          flags: [...nameFlags, ...finalAuthorFlags, ...compatFlags, ...contentFlags, ...sourceFlags],
          suspected,
          ackRequired,
          ackCodes,
          // 档位怎么判的照实记一份（确认放行过的记录：这里是 true、suspected 是 false）——
          // 「命中过、但人确认过」这件事必须一眼看得出来，不能靠 suspected 一个字段糊过去。
          suspectedByTiers,
          // 维护者人工确认那一笔（没有就是 null）。它进 meta.json，也进 decision.json。
          maintainerConfirm,
          suspectedReasons: contentFlags.filter((f) => f.level === 'blocker').map((f) => f.code),
        };
        writeJson(join(dir, 'meta.json'), meta);

        // ---------------- 一步到位（业主口径）：「上传 + 通过 + 发布」一次做完 ----------------
        // 投稿详情页那个**独立的上传按钮**打的就是这条路（`&publish=1`）。
        // 它与 `/compat/decide` 的通过分支走**同一份硬门** compatPublishGate ——
        // 从哪个门进来都是同一个松紧，不因为「顺手发的」就少检一道。
        let published = null;
        let replaced = null;
        if (url.searchParams.get('publish') === '1') {
          // 业主令 31：命中"要显式确认"的检查（`pack.json` 与留档原件不一致 / 不透明容器 / 作者自述…）
          // ⇒ **不发布**，但**记录照留**（与下面 gate 拦下时同形：一条都不删，只是没上线）。
          if (meta.ackRequired === true && url.searchParams.get('acknowledge') !== '1') {
            const hits = (meta.flags || []).filter((f) => ACK_CODES.includes(f.code));
            return sendJson(res, 409, {
              ok: false, id, area: 'compat', kind: 'compat', state: 'pending',
              published: null, replaced: null,
              error: `这一份**没有发布**（记录已作为待审留下，没删任何东西）：命中「要显式确认」的检查`
                + `（${[...new Set(hits.map((f) => f.code))].join(' / ')}）。档位是 warn（不是 blocker）—— `
                + '看过命中项仍要发布的话，带上 `acknowledge=1` 再发一次；理由写进决定记录。',
              flags: hits, needsAcknowledge: true,
            });
          }
          const gate = await compatPublishGate(pathsOf(id), meta);
          if (gate.error) {
            // 拦下了就**停在待审**：记录、改写版、原件留档一个都不删（条数只增不减），
            // 只是没有上线。把原因原样回给页面，修好后从那一条投稿的详情页重发即可。
            return sendJson(res, 409, {
              ...gate,
              ok: false, id, area: 'compat', kind: 'compat', state: 'pending',
              published: null, replaced: null,
              message: '这一份**没有发布**。它已作为一条待审记录留下（改写版与原件留档都在，没删任何东西）；'
                + '按上面的原因处理掉之后，回到那条投稿的详情页重新上传并发布。',
            });
          }
          writeCompatDecision(pathsOf(id), meta, { decision: 'approved' });
          published = { file: meta.blobName || 'mod.zip', sha256: meta.sha256 };
          // 原投稿按 B 口径处置：标 superseded、移出待审队列，记录与文件都保留。
          replaced = markReplacedBy(meta.compatOf, id, meta.name);
        }

        return sendJson(res, 201, {
          ok: true, id, area: 'compat', kind: 'compat',
          state: published ? 'approved' : 'pending', suspected,
          author: meta.author, authorSource: meta.authorSource,
          compatAuthor: meta.compatAuthor, compatAuthorSource: meta.compatAuthorSource,
          packageName: packName, description: meta.pack.description,
          size: meta.size, sha256: meta.sha256, entries: meta.entries,
          flags: meta.flags,
          suspectedByTiers, maintainerConfirm,
          published, replaced,
          message: published
            ? `已发布上线（编号 ${id}）。公开可下的是这一份改写版（原件留档、不发布）。`
              + (replaced
                ? ` 原投稿 ${replaced.id} 已标为「已由兼容包取代」并**移出待审队列** —— 记录与文件都留着，可追溯。`
                : '')
              + (maintainerConfirm
                ? ` 这一份命中了 ${maintainerConfirm.codes.length} 档 blocker（${maintainerConfirm.codes.join(' / ')}），`
                  + '由**维护者逐条人工确认**放行：档位规则一条没改，命中明细照旧留在 flags 里，确认理由已记进决定记录。'
                : '')
            : (suspected
              ? '已收到（维护者侧兼容包）。改写版命中了「疑似官方素材」的特征（见 flags）—— 它已单独存放，上线后公网列表会明确标注。这一份**还没发布**。'
              : '已收到（维护者侧兼容包）。包自带的 pack.json 原样保留，兼容者只记在站点侧。这一份**还没发布**（要上线就带上 publish=1 再发一次，或走 compat/decide）。'),
        });
      }

      // 兼容包的通过 / 打回。比普通那条多三道：两个署名、原注释快照还在、来源可追溯。
      //
      // ⚠️ 铁律（2026-10-11 回归的教训）：这个端点**只接受明确指定的 id**。
      //   永远不要写「把筛出来的一批 id 循环喂进来」的脚本 —— 那次就是这么把两条
      //   刚打回的 demo 样板件又批准回去、重新挂上公网 `/api/mods` 的（见文件头那条纪律）。
      if (req.method === 'POST' && p === `${ADMIN_API}/compat/decide`) {
        const raw = await readBody(req, 64 * 1024);
        let inObj = {};
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        const { id, decision, reason, displayName, acknowledge, compatAuthor: compatAuthorFix, originUrl: originUrlFix, compatNote: compatNoteFix } = inObj;
        if (!ID_RE.test(String(id || ''))) return sendJson(res, 400, { error: 'id 形状不对' });
        if (!['approved', 'rejected'].includes(decision)) return sendJson(res, 400, { error: 'decision 只能是 approved / rejected' });
        const P = pathsOf(id);
        if (!P || P.area !== 'compat') return sendJson(res, 404, { error: '没有这条兼容包' });
        if (!existsSync(P.blobPath)) return sendJson(res, 404, { error: '改写版不在' });
        let meta = readJson(P.meta) || {};
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];

        // 通过前允许把署名/来源补齐（上传时没填全的情形），补的动作记进 revisions。
        // 注意顺序：**先算不写**，等下面几道检查全过了才落盘 ——
        // 否则一次「补个空值」的失败请求会把记录改坏，留下半拉状态。
        const patch = {};
        const norm = (s) => (typeof s === 'string' ? s.trim() : '');
        if (compatAuthorFix != null && norm(compatAuthorFix) !== meta.compatAuthor) patch.compatAuthor = norm(compatAuthorFix);
        if (originUrlFix != null && norm(originUrlFix).slice(0, 300) !== (meta.originUrl || '')) patch.originUrl = norm(originUrlFix).slice(0, 300);
        if (compatNoteFix != null && norm(compatNoteFix) !== (meta.compatNote || '')) patch.compatNote = norm(compatNoteFix);
        const patchedMeta = Object.keys(patch).length
          ? {
            ...meta,
            ...patch,
            // 动了兼容者这一栏，就先把旧的 COMPAT_AUTHOR_EMPTY 标记清掉；
            // 补成空的就再补一条 —— 空 = 未填，是合法状态，得让它继续看得见。
            flags: [
              ...(meta.flags || []).filter((f) => !(patch.compatAuthor != null && f.code === 'COMPAT_AUTHOR_EMPTY')
                && !(patch.originUrl && f.code === 'ORIGIN_URL_MISSING')),
              ...(patch.compatAuthor != null && !patch.compatAuthor
                ? [{ level: 'info', code: 'COMPAT_AUTHOR_EMPTY', text: '兼容者未填（这一栏必填，但值可以为空）—— 站点侧如实记成「未填」。' }]
                : []),
            ],
            revisions: [...hist, {
              at: nowIso(), by: 'admin',
              changed: Object.fromEntries(Object.keys(patch).map((k) => [k, meta[k] ?? null])),
              to: patch, why: 'decide 时补全',
            }],
          }
          : meta;

        if (decision === 'approved') {
          // 与 /decide 同一道「点头」门：盲区 warn 档也要显式 acknowledge 才发布（档位不变）。
          if (patchedMeta.ackRequired === true && acknowledge !== true) {
            const warnHits = (patchedMeta.flags || []).filter((f) => ACK_CODES.includes(f.code));
            return sendJson(res, 409, {
              error: `这条命中「要显式确认」的检查（${[...new Set(warnHits.map((f) => f.code))].join(' / ')}）：`
                + '不透明容器 / 作者自述夹带官方素材。档位是 warn（不是 blocker），但发布要显式点头 —— '
                + '看过命中项仍要上线的话，带上 acknowledge:true 再来。',
              flags: warnHits, needsAcknowledge: true,
            });
          }
          // 三道硬门（署名 / 原件快照 / 改写版没被掉包）只有一份实现 —— 与上传处的
          // `compat-submit?publish=1` 共用，见文件上方的 compatPublishGate。
          const gate = await compatPublishGate(P, patchedMeta);
          if (gate.error) return sendJson(res, 409, gate);
          // 备注：上面的 gate 里已经依次核过「原件快照必须在」与「改写版里的 pack.json
          // 必须与快照一字不差」（原 description 不许被盖掉）—— 那两道硬门一个都没放宽。
        }

        // 检查全过了才落盘：补的东西 + 决定记录，一次写完。
        if (patchedMeta !== meta) writeJson(P.meta, patchedMeta);
        // 决定记录（连同 meta 的 displayName）由**同一份实现**写 ——
        // 与 `compat-submit?...&publish=1` 那条一步到位的路共用，不许两处各写各的。
        writeCompatDecision(P, patchedMeta, { decision, reason, displayName });
        // 通过 = 发布：把**被它取代的那条原投稿**按 B 口径记一笔（superseded、指向本条）。
        const replaced = decision === 'approved'
          ? markReplacedBy(patchedMeta.compatOf, id, displayName || patchedMeta.name)
          : null;
        audit(decision === 'approved' ? 'compatApproved' : 'compatRejected', {
          id, ip, actor: 'admin', admin: true, detail: { replaced: replaced?.id ?? null },
        });
        return sendJson(res, 200, {
          ok: true, id, kind: 'compat', state: decision, suspected: patchedMeta.suspected === true,
          author: patchedMeta.author || null, compatAuthor: patchedMeta.compatAuthor || null,
          published: decision === 'approved' ? { file: patchedMeta.blobName || 'mod.zip', sha256: patchedMeta.sha256 } : null,
          replaced,
        });
      }

      // ================================================================
      // `POST ${ADMIN_API}/compat/link` —— 给一条**已经在记录里**的兼容包补上
      // 「由哪个原件投稿改写来」（`compatOf`），并按 **B 口径**把那条原投稿
      // 标 `superseded` + 移出待审队列。
      //
      // 为什么需要这条路（业主 2026-10-11 的第二件事）：
      //   早先上线的那几条兼容包是**逐个手工批准**的，当时 `compatOf` 还是空的，
      //   它们对应的原投稿就一直挂在待审列表里、没被标 `superseded`、没有 `replacedBy`
      //   —— 与后来上线的「一步发布」那条新逻辑**不一致**。本端点就是把这几条并进
      //   同一套逻辑：链补上、原投稿按 B 口径处置。
      //
      // 一条都没另写：
      //   · 「原投稿 → superseded + replacedBy + 移出待审」调的就是 `markReplacedBy`
      //     —— `compat-submit?publish=1` 与 `/compat/decide` 走的是同一个它；
      //   · `compatOf` / `flags` / `revisions` 的写法与 `/compat/decide` 的补全分支同形。
      //
      // ⚠️ 铁律（与 `/compat/decide` 顶上那条同源）：本端点**只认一个明确指定的 id**，
      //   不认任何形式的「一批」。永远不要写「把筛出来的一批循环喂进来」的脚本 ——
      //   那条路已经害过一次（把两条刚打回的 demo 样板件又批准回去、重新挂上公网 /api/mods）。
      //   一次请求 = 一条兼容包 + 一条原投稿；要补 N 条就发 N 次，每条都能单独核对。
      //
      // 只碰两处、都是**追加/补记**，绝不重写任何内容：
      //   · 兼容包自己的 `meta.json` —— 补 `compatOf`，其余字段原样（`name`/`sha256`/
      //     `author`/`compatAuthor`/`uploadedAt`/`size`/`kind` 一个都不动）；
      //   · 原投稿自己的 `decision.json` —— 由 `markReplacedBy` 写，`meta.json` 与
      //     `mod.zip` 一个字节都不动（这正是「只允许新增关联/取代信息」那条红线）。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/compat/link`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = {};
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        const compatId = String(inObj.compatId || inObj.id || '').trim();
        const originId = String(inObj.originId || inObj.compatOf || '').trim();
        if (!ID_RE.test(compatId)) return sendJson(res, 400, { error: 'compatId 形状不对' });
        if (!ID_RE.test(originId)) return sendJson(res, 400, { error: 'originId 形状不对' });
        if (compatId === originId) return sendJson(res, 400, { error: 'compatId 与 originId 不能是同一条' });

        const C = pathsOf(compatId);
        if (!C || C.area !== 'compat') return sendJson(res, 404, { error: '没有这条兼容包' });
        if (!existsSync(C.meta)) return sendJson(res, 404, { error: '这条兼容包没有 meta.json' });
        const O = pathsOf(originId);
        if (!O || O.area === 'compat') return sendJson(res, 404, { error: '找不到编号 ' + originId + ' 的原件投稿（兼容包不能指另一条兼容包）' });
        if (!existsSync(O.meta)) return sendJson(res, 404, { error: '找不到编号 ' + originId + ' 的原件投稿' });

        const cMeta = readJson(C.meta) || {};
        const hist = Array.isArray(cMeta.revisions) ? cMeta.revisions : [];
        // 幂等：已经是这个指向就不重复追加 revisions（重复调不产生第二笔改动记录）。
        const already = cMeta.compatOf === originId;
        const patched = already ? cMeta : {
          ...cMeta,
          compatOf: originId,
          // COMPAT_OF_MISSING 是「还没补」那条 info 标记；补上了就该把它换成 COMPAT_OF。
          // 只动这两条 flag，别的 flag 一条不碰。
          flags: [
            ...(cMeta.flags || []).filter((f) => f.code !== 'COMPAT_OF_MISSING' && f.code !== 'COMPAT_OF'),
            { level: 'info', code: 'COMPAT_OF', text: `由待审原件 ${originId} 改写而来（后来补记：这条兼容包上线时 compatOf 还是空的）` },
          ],
          revisions: [...hist, {
            at: nowIso(), by: 'admin',
            changed: { compatOf: cMeta.compatOf ?? null },
            to: { compatOf: originId },
            why: '并入「一步发布」那套逻辑：补上原投稿指向',
          }],
        };
        if (!already) writeJson(C.meta, patched);
        // 原投稿按 B 口径处置 —— 与一步发布、/compat/decide 完全同一条实现。
        const replaced = markReplacedBy(originId, compatId, patched.name || cMeta.name || null);
        audit('compatLink', { id: compatId, ip, actor: 'admin', admin: true, detail: { originId, alreadyLinked: already } });
        return sendJson(res, 200, {
          ok: true, compatId, originId, compatOf: originId,
          alreadyLinked: already,
          replaced,
          note: '兼容包只补了 compatOf（其余字段一字未动）；原投稿只加了 decision.json（meta.json 与 mod.zip 一字未动）。',
        });
      }

      // ================================================================
      // `POST ${ADMIN_API}/compat/note` —— **只改备注文案**（`note` + `compatNote` 两栏）。
      //
      // 为什么需要它（业主 2026-10-11 的第三件事：公网那条备注是假的）：
      //   早先上线的那三条兼容包，备注栏留的还是**上传时那句内部链路实测的话**
      //   （「兼容包入口链路实测：只上传，不通过、不发布。」）。它们**早就发布**在公网
      //   `/mods` 上了 —— 名字改过了、备注没跟着改，于是那句话在公网上是**假的**。
      //   既有的两条路都到不了这一栏：`/compat/decide` 的补全分支只补 `compatNote`，
      //   **不碰 `note`**；而 `/mods` 那一页对**两栏逐字相同**的记录只画一次（渲染层去重，
      //   见 `pages/mods.html` 的判据），两栏文案相同的记录画出来的就是 `compatNote` 这一栏；
      //   只改一栏等于旧文案还留在公网上。所以另开这一条最小端点，一次把两栏改成同一句。
      //
      // ⚠️ 铁律（与 `/compat/decide`、`/compat/link` 顶上那条同源）：本端点**只认一个明确指定的 id**。
      //   报文里出现任何「一批」的形状（`ids` / `batch` / `items` / `list`，或 `id` 给了数组）
      //   一律 400 拒掉 —— 永远不要写「把筛出来的一批循环喂进来」的脚本。
      //   三条就发三次，每条单独核对（本次就是这么做的）。
      //
      // 只碰这一处：`meta.json` 的 `note` 与 `compatNote`（外加一条 `revisions` 追加留痕）。
      //   `mod.zip` / `pack-json.orig.json` / `decision.json` **一个字节都不动**；
      //   `name` / `author` / `compatAuthor` / `compatAuthorSource` / `uploadedAt` / `size` /
      //   `kind` / `compatOf` / `sha256` / `flags` 一律原样 —— 改一句备注不该带出任何副作用。
      //   （键序也不动：`note` / `compatNote` 都是**已有的键**，赋值不会改变它们在 JSON 里的位置。）
      //
      // 七道**形状**校验先算不写 —— 任何一道不过就直接返回，磁盘上什么都不改：
      //   ① 报文能解析成一个**普通对象**（不是数组、不是字面量）；
      //   ② 没有「一批」的形状：`ids` / `batch` / `items` / `list` 一个都不许出现；
      //   ③ `id` 是**字符串**且合 `ID_RE`（数组 / 对象直接拒）；
      //   ④ `note` 是**字符串**（数组 / 对象 / null / 缺失都拒）；
      //   ⑤ `note` 去首尾空白后**非空**（备注不许清成空 —— 「没有备注」是另一件事，不在这条路上做）；
      //   ⑥ 这条记录在 `compat/` 区，且 `meta.json` 读出来是个带字符串 `name` 的对象
      //      （**区域检查排在长度之前** —— 业主 2026-10-12 裁定：走错端点的人要看到「该去哪」，
      //        而不是一句关于长度的 400）；
      //   ⑦ 长度 ≤ `NOTE_MAX`（20000，与 `/api/submit` 的备注同一个上限）。
      // 幂等：`note` 与 `compatNote` 都已经是新文案时，直接回 `changed:false`，
      //   **不写盘、不加 revisions** —— 重复发同一个请求不会留下第二笔改动记录。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/compat/note`) {
        const raw = await readBody(req, NOTE_BODY_MAX);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        // ① 必须是一个普通对象
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        // ② 只认一个 id：任何「一批」的形状直接拒
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要改 N 条就发 N 次，每条单独核对。`,
          });
        }
        // ③ id 是字符串且形状对
        if (typeof inObj.id !== 'string' || !ID_RE.test(inObj.id.trim())) {
          return sendJson(res, 400, { error: 'id 形状不对（必须是字符串：6–32 位小写字母/数字）' });
        }
        const id = inObj.id.trim();
        // ④ note 是字符串
        if (typeof inObj.note !== 'string') {
          return sendJson(res, 400, { error: 'note 形状不对（必须是字符串，不能是数组 / 对象）' });
        }
        const nextNote = inObj.note.trim();
        // ⑤ 不许清空
        if (!nextNote) {
          return sendJson(res, 400, { error: 'note 不能是空的 —— 本端点只用来把备注换成一句正常文案' });
        }
        // ⑥ 记录形状：必须在 compat/ 区，meta.json 读得出来
        //    ⚠️ 次序（业主 2026-10-12 裁定）：**区域检查排在长度检查之前** ——
        //    否则一条 submissions 区的记录会被长度抢先报 400，真正的原因（走错了端点）反而看不出来。
        const P = pathsOf(id);
        if (!P || P.area !== 'compat') {
          return sendJson(res, 404, {
            error: `没有这条兼容包。本端点只服务 compat/ 区的记录；submissions / flagged 区的备注请用 POST ${ADMIN_API}/note。`,
          });
        }
        // ⑦ 长度上限
        if (nextNote.length > NOTE_MAX) return sendJson(res, 400, { error: `备注太长（最多 ${NOTE_MAX} 字）` });
        const meta = readJson(P.meta);
        if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.name !== 'string') {
          return sendJson(res, 404, { error: '这条兼容包的 meta.json 读不出来（形状不对），不动它' });
        }
        // 七道全过了，才开始算要写什么。幂等在前：两栏都已经是这句，就什么都不写。
        if (meta.note === nextNote && meta.compatNote === nextNote) {
          return sendJson(res, 200, { ok: true, id, changed: false, note: nextNote, at: nowIso() });
        }
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        // 只动这两栏（都已经是已有的键 ⇒ 键序不变），其余字段靠展开原样带过去。
        writeJson(P.meta, {
          ...meta,
          note: nextNote,
          compatNote: nextNote,
          revisions: [...hist, {
            at: nowIso(), by: 'admin',
            changed: { note: meta.note ?? null, compatNote: meta.compatNote ?? null },
            to: { note: nextNote, compatNote: nextNote },
            why: '公网页备注改写：换成面向下载者的正常文案（只动 note / compatNote 两栏，其余字段一字未动）',
          }],
        });
        audit('compatNote', { id, ip, actor: 'admin', admin: true, detail: { noteLen: nextNote.length } });
        return sendJson(res, 200, {
          ok: true, id, changed: true, note: nextNote,
          note_old: meta.note ?? null,
          at: nowIso(),
          untouched: 'mod.zip / pack-json.orig.json / decision.json 未动；name / author / compatAuthor / uploadedAt / size / kind / compatOf / sha256 原样。',
        });
      }

      // ================================================================
      // ================================================================
      // `POST ${ADMIN_API}/note` —— **投稿区（submissions / flagged）的备注改写**。
      //
      // 为什么另开一条，而不是让 `/compat/note` 顺手管两个区（业主 2026-10-12 裁定）：
      //   · **字段语义不同**：compat 记录把 `note` 与 `compatNote` 写成**同一句**，
      //     `pages/mods.html` 把这一对**只画一次**、带「**兼容说明：**」标签；
      //     投稿记录只有 `note` 有意义，公网**不带标签**地画它。
      //     若让 `/compat/note` 也写投稿记录的 `compatNote`，公网会把一条**普通投稿**的备注
      //     标成「兼容说明」—— 那条记录根本没有兼容改写，这是**说假话**。
      //   · 与站点既有模式一致：`decide`（投稿）与 `compat/decide`（兼容包）就是**按区拆成两条**，
      //     各自**明确拒绝**另一区；合并会让本端点成为全站唯一例外。
      //
      // 报文：`{ "id": "<编号>", "note": "<新备注>" }` —— 与 `/compat/note` 同形。
      // **只写 `meta.note` 一栏**（外加一笔 `revisions` 留痕）；**不碰 `compatNote`** ——
      // 那是 compat 区的「兼容说明」，投稿记录没有这一栏。
      //
      // ⚠️ 铁律（与 `/compat/decide`、`/compat/link`、`/compat/note` 顶上那条同源）：
      //   本端点**只认一个明确指定的 id**。报文里出现任何「一批」的形状一律 400 拒掉 ——
      //   永远不要写「把筛出来的一批循环喂进来」的脚本。
      //
      // 判定次序（业主 2026-10-12 裁定）：**区域检查排在长度检查之前**。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/note`) {
        const raw = await readBody(req, NOTE_BODY_MAX);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        // ① 必须是一个普通对象
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        // ② 只认一个 id：任何「一批」的形状直接拒
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要改 N 条就发 N 次，每条单独核对。`,
          });
        }
        // ③ id 是字符串且形状对
        if (typeof inObj.id !== 'string' || !ID_RE.test(inObj.id.trim())) {
          return sendJson(res, 400, { error: 'id 形状不对（必须是字符串：6–32 位小写字母/数字）' });
        }
        const id = inObj.id.trim();
        // ④ note 是字符串
        if (typeof inObj.note !== 'string') {
          return sendJson(res, 400, { error: 'note 形状不对（必须是字符串，不能是数组 / 对象）' });
        }
        const nextNote = inObj.note.trim();
        // ⑤ 不许清空
        if (!nextNote) {
          return sendJson(res, 400, { error: 'note 不能是空的 —— 本端点只用来把备注换成一句正常文案' });
        }
        // ⑥ 区域检查：本端点只服务投稿区（submissions / flagged）—— **排在长度之前**
        const P = pathsOf(id);
        if (!P) return sendJson(res, 404, { error: '没有这条记录' });
        if (P.area === 'compat') {
          return sendJson(res, 400, {
            error: `这是兼容包（compat/ 区），请用 POST ${ADMIN_API}/compat/note —— 那一条会把 note 与 compatNote 写成同一句（公网页按「兼容说明」只画一次）。`,
          });
        }
        const meta = readJson(P.meta);
        if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.name !== 'string') {
          return sendJson(res, 404, { error: '这条记录的 meta.json 读不出来（形状不对），不动它' });
        }
        // ⑦ 长度上限
        if (nextNote.length > NOTE_MAX) return sendJson(res, 400, { error: `备注太长（最多 ${NOTE_MAX} 字）` });
        // 全过了才开始算要写什么。幂等在前：已经是这句，就什么都不写。
        if (meta.note === nextNote) {
          return sendJson(res, 200, { ok: true, id, area: P.area, changed: false, note: nextNote, at: nowIso() });
        }
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        // 只动 note 一栏（已有的键 ⇒ 键序不变），其余字段靠展开原样带过去。**不写 compatNote。**
        writeJson(P.meta, {
          ...meta,
          note: nextNote,
          revisions: [...hist, {
            at: nowIso(), by: 'admin',
            changed: { note: meta.note ?? null },
            to: { note: nextNote },
            why: '站上备注改写（投稿区）：只动 note 一栏，其余字段一字未动；不写 compatNote（那是 compat 区的「兼容说明」）。',
          }],
        });
        audit('note', { id, ip, actor: 'admin', admin: true, detail: { noteLen: nextNote.length } });
        return sendJson(res, 200, {
          ok: true, id, area: P.area, changed: true, note: nextNote,
          note_old: meta.note ?? null,
          at: nowIso(),
          untouched: 'mod.zip / decision.json 未动；name / author / uploadedAt / size / kind / sha256 原样；compatNote 未创建、未改动。',
        });
      }
      // ================================================================
      // `POST ${ADMIN_API}/packkind` —— 把「这条包装上到底会不会生效」这一栏写进记录。
      //
      // 为什么需要它（业主 2026-10-12）：`packKind` 一直是**只读**的 —— `server.mjs` 里只有
      // `/api/mods` 那一处读（`packKind: s.packKind || 'unknown'`），**没有任何写入端点**，
      // 于是「判了分类」这件事**落不到公网**：判成 functional 的记录在 `/mods` 上照样显示 `unknown`，
      // 而 `/api/mods` 的注释逐字说「缺省**绝不可能是 functional**」⇒ 分类白判，下载者看到的是「判不了」。
      //
      // 报文：`{ "id": "<编号>", "packKind": "functional" | "documentation" | "unknown" }`
      //   · **闭枚举**：写一个拼错的值 ⇒ 400（不许把一个拼错的分类落进记录 —— 与 slot / component
      //     那些闭枚举同一条道理）；
      //   · **一次一个明确写出的 id**（与 `/note`、`/compat/note` 同一条铁律）；
      //   · **只动 `meta.packKind` + 一笔 `revisions`**，其余字段一字未动；幂等；
      //   · **区无关**：submissions / flagged / compat 都能设（compat 记录本来就有这一栏）。
      //
      // ⚠️ 2026-10-12 增补（裁定 ⑥）：**发布者也能填自己那条的分类** —— 走的是
      //    `POST /api/publisher/update` 的 `packKind` 那一栏（发布者令牌鉴权、同样进 revisions）。
      //    本端点**行为一个字没改**，仍然是管理员覆盖用的那条路；两条路都留痕，管理员随时可覆盖。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/packkind`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要改 N 条就发 N 次，每条单独核对。`,
          });
        }
        if (typeof inObj.id !== 'string' || !ID_RE.test(inObj.id.trim())) {
          return sendJson(res, 400, { error: 'id 形状不对（必须是字符串：6–32 位小写字母/数字）' });
        }
        const id = inObj.id.trim();
        const nextKind = typeof inObj.packKind === 'string' ? inObj.packKind.trim() : '';
        if (!PACK_KINDS.includes(nextKind)) {
          return sendJson(res, 400, {
            error: `packKind 只能是 ${PACK_KINDS.join(' / ')} 之一（闭枚举：拼错的值不许落进记录）`,
          });
        }
        const P = pathsOf(id);
        if (!P) return sendJson(res, 404, { error: '没有这条记录' });
        const meta = readJson(P.meta);
        if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.name !== 'string') {
          return sendJson(res, 404, { error: '这条记录的 meta.json 读不出来（形状不对），不动它' });
        }
        if ((meta.packKind ?? null) === nextKind) {
          return sendJson(res, 200, { ok: true, id, area: P.area, changed: false, packKind: nextKind, at: nowIso() });
        }
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        writeJson(P.meta, {
          ...meta,
          packKind: nextKind,
          revisions: [...hist, {
            at: nowIso(), by: 'admin',
            changed: { packKind: meta.packKind ?? null },
            to: { packKind: nextKind },
            why: '站侧分类改写（装上到底会不会生效）：只动 packKind 一栏，其余字段一字未动。',
          }],
        });
        audit('packKind', { id, ip, actor: 'admin', admin: true, detail: { from: meta.packKind ?? null, to: nextKind } });
        return sendJson(res, 200, {
          ok: true, id, area: P.area, changed: true, packKind: nextKind,
          packKind_old: meta.packKind ?? null,
          at: nowIso(),
          untouched: 'mod.zip / decision.json / 其余 meta 字段未动；name / author / uploadedAt / size / kind / sha256 原样。',
        });
      }
      // ================================================================
      // ⭐⭐ `POST ${ADMIN_API}/funkind` —— **功能类目**（业主 2026-10-14 裁定的 6 类）的写入端点。
      //
      // 业主原话：「现在分类不对，要按功能分」—— 于是有了与 `packKind`（技术维度）**并列**的
      // `funcKind`（功能维度）。管理口就是**手工归类**的那条路：老记录没有这一栏 ⇒ 读时落 `uncategorized`，
      // 由维护者**一条一条**看着改，**系统绝不替它猜**。
      //
      // 报文：`{ "id": "<编号>", "funcKind": "gameplay" | "expansion" | "utility" | "assets"
      //                              | "documentation" | "uncategorized" }`
      //   · **闭枚举**：拼错的值 ⇒ 400（不许把一个拼错的类目落进记录）；
      //   · **一次一个明确写出的 id**（与 `/packkind`、`/note` 同一条铁律：`ids`/`batch`/`items`/`list` 一律 400）；
      //   · **只动 `meta.funcKind` + 一笔 `revisions`**，其余字段一字未动；幂等；
      //   · ⭐ **一致性**：写完 `funcKind` 后，技术维度按 `packKindFor()` 一并归位（说明文档 ⇒ documentation、
      //     四个真功能类 ⇒ functional、未分类 ⇒ unknown）。两栏因此不可能各说各话。
      //     想让它不自动派生，就在同一次报文里**显式**再给一个 `packKind`（显式值优先）。
      //   · **区无关**：submissions / flagged / compat 都能设。
      // ⚠️ 这条端点**只写分类**：不动 `mod.zip`、不动 `decision.json`、不改公开与否。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/funkind`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，不收「一批」（多了这些键：${batchKeys.join(' / ')}）。要改 N 条就发 N 次，每条单独核对。`,
          });
        }
        if (typeof inObj.id !== 'string' || !ID_RE.test(inObj.id.trim())) {
          return sendJson(res, 400, { error: 'id 形状不对（必须是字符串：6–32 位小写字母/数字）' });
        }
        const id = inObj.id.trim();
        const nextFunc = typeof inObj.funcKind === 'string' ? inObj.funcKind.trim() : '';
        if (!FUNC_KINDS.includes(nextFunc)) {
          return sendJson(res, 400, {
            error: `funcKind 只能是 ${FUNC_KINDS.join(' / ')} 之一（闭枚举：拼错的值不许落进记录）`,
            funcs: FUNC_KINDS, titles: FUNC_KIND_TITLES,
          });
        }
        // 显式给的 packKind（可选）：给了就按它，不给就按 funcKind 派生。
        let explicitPack = null;
        if (inObj.packKind != null) {
          if (typeof inObj.packKind !== 'string' || !PACK_KINDS.includes(inObj.packKind.trim())) {
            return sendJson(res, 400, { error: `packKind 只能是 ${PACK_KINDS.join(' / ')} 之一（闭枚举）` });
          }
          explicitPack = inObj.packKind.trim();
        }
        const P = pathsOf(id);
        if (!P) return sendJson(res, 404, { error: '没有这条记录' });
        const meta = readJson(P.meta);
        if (!meta || typeof meta !== 'object' || Array.isArray(meta) || typeof meta.name !== 'string') {
          return sendJson(res, 404, { error: '这条记录的 meta.json 读不出来（形状不对），不动它' });
        }
        const nextPack = explicitPack ?? packKindFor(nextFunc);
        const funcSame = (meta.funcKind ?? null) === nextFunc;
        const packSame = (meta.packKind ?? null) === nextPack;
        if (funcSame && packSame) {
          return sendJson(res, 200, {
            ok: true, id, area: P.area, changed: false,
            funcKind: nextFunc, funcKindTitle: FUNC_KIND_TITLES[nextFunc], packKind: nextPack, at: nowIso(),
          });
        }
        const hist = Array.isArray(meta.revisions) ? meta.revisions : [];
        writeJson(P.meta, {
          ...meta,
          funcKind: nextFunc,
          packKind: nextPack,
          revisions: [...hist, {
            at: nowIso(), by: 'admin',
            changed: { funcKind: meta.funcKind ?? null, packKind: meta.packKind ?? null },
            to: { funcKind: nextFunc, packKind: nextPack },
            why: `站侧**功能类目**归类（${FUNC_KIND_TITLES[nextFunc]}）：只动 funcKind 一栏`
              + `${explicitPack ? '（外加显式指定的 packKind）' : '，技术维度按同一口径派生'}，其余字段一字未动。`,
          }],
        });
        audit('funcKind', {
          id, ip, actor: 'admin', admin: true,
          detail: { from: meta.funcKind ?? null, to: nextFunc, packKindFrom: meta.packKind ?? null, packKindTo: nextPack, explicitPack },
        });
        return sendJson(res, 200, {
          ok: true, id, area: P.area, changed: true,
          funcKind: nextFunc, funcKindTitle: FUNC_KIND_TITLES[nextFunc], funcKind_old: meta.funcKind ?? null,
          packKind: nextPack, packKind_old: meta.packKind ?? null,
          at: nowIso(),
          untouched: 'mod.zip / decision.json / 其余 meta 字段未动；name / author / uploadedAt / size / kind / sha256 原样。',
        });
      }

      // `POST ${ADMIN_API}/hide` —— 那条「不再显示」勾选框（业主 2026-10-11）。
      //
      // 报文：`{ "id": "<编号>", "hidden": true|false }`
      //   · `hidden: true`  ⇒ 这条从**审核页的三个视图**里都不再显示；
      //   · `hidden: false` ⇒ 重新显示（**必须可逆** —— 业主口径里写死的一条）。
      //
      // 为什么需要它（业主原话）：「有可能 mod 名字和兼容后的名字不一样，导致依旧存在两个 mod
      // （一个在兼容，一个在上传待定），所以给我一个勾选框，选后就不显示这个 mod 了」。
      // 自动配对靠 `compatOf` / `markReplacedBy`，名字不一致时人可能根本不会去配对 ——
      // 这个开关完全不依赖名字，也不依赖自动配对。
      //
      // ⚠️ 铁律（与 `/compat/decide`、`/compat/link`、`/compat/note` 顶上那条同源）：
      //   本端点**只认一个明确指定的 id**，**绝不批量**。
      //   报文里出现任何「一批」的形状（`ids` / `batch` / `items` / `list`，或 `id` 给了数组）
      //   一律 400 拒掉 —— 永远不要写「把筛出来的一批循环喂进来」的脚本。
      //   要藏 N 条就发 N 次，每条单独核对（批准的教训见文件头那条纪律）。
      //
      // 只碰这一处：`meta.json` 的 `hidden` / `hiddenBy` / `hiddenAt`（外加一条 `revisions` 追加留痕）。
      //   `mod.zip` / `orig.zip` / `pack-json.orig.json` / `decision.json` **一个字节都不动**
      //   —— 隐藏**不改判定**（`decision.json` 照旧是这条记录的状态）；
      //   `name` / `author` / `compatAuthor` / `compatOf` / `sha256` / `uploadedAt` / `size` / `flags` 一律原样。
      //
      // 形状校验**先算不写**（任何一道不过就直接返回，磁盘上什么都不改）：
      //   ① 报文是一个**普通对象**（不是数组、不是字面量）；
      //   ② 没有「一批」的形状：`ids` / `batch` / `items` / `list` 一个都不许出现；
      //   ③ `id` 是**字符串**且合 `ID_RE`（数组 / 对象直接拒）；
      //   ④ `hidden` 是**布尔值**（不接受 'true' / 1 / null —— 免得两个客户端对同一个值有两种理解）；
      //   ⑤ 这条记录在三个区里找得到（`pathsOf`），且 `meta.json` 读出来是个普通对象。
      // 幂等：标志位**已经是目标值**时直接回 `changed:false`，**不写盘、不加 revisions**
      //   —— 重复发同一个请求不会留下第二笔留痕。
      //
      // ⚠️ 公开面：这个端点**只改 meta.json 这一栏**。`/api/mods` 与 `/mods` 从不读它，
      //   `/api/file/*` 也不读它 —— 「隐藏」是审核页的显示开关，不是下架。（要下架用「打回」。）
      //
      // ⚠️ 2026-10-12：**不许把 `hidden` 当下架用**（业主已认过的一条）——「下架」这件事
      //   现在有了正规的路：发布者 `POST /api/publisher/withdraw`（申请）+ 管理员
      //   `POST ${ADMIN_API}/withdraw-decide`（确认）。本端点保持原语义**一个字没改**。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/hide`) {
        const raw = await readBody(req, 16 * 1024);
        let inObj = null;
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        // ① 必须是一个普通对象
        if (!inObj || typeof inObj !== 'object' || Array.isArray(inObj)) {
          return sendJson(res, 400, { error: '报文必须是一个 JSON 对象' });
        }
        // ② 只认一个 id：任何「一批」的形状直接拒
        const batchKeys = ['ids', 'batch', 'items', 'list'].filter((k) => k in inObj);
        if (batchKeys.length) {
          return sendJson(res, 400, {
            error: `本端点只认一个明确指定的 id，绝不批量（多了这些键：${batchKeys.join(' / ')}）。要藏 N 条就发 N 次，每条单独核对。`,
          });
        }
        // ③ id 是字符串且形状对
        if (typeof inObj.id !== 'string' || !ID_RE.test(inObj.id.trim())) {
          return sendJson(res, 400, { error: 'id 形状不对（必须是字符串：6–32 位小写字母/数字）' });
        }
        const id = inObj.id.trim();
        // ④ hidden 是布尔值
        if (typeof inObj.hidden !== 'boolean') {
          return sendJson(res, 400, { error: 'hidden 形状不对（必须是布尔值 true / false，不接受字符串、数字或 null）' });
        }
        const want = inObj.hidden;
        // ⑤ 记录在不在、meta.json 读得出来吗
        const HP = pathsOf(id);
        if (!HP) return sendJson(res, 404, { error: '没有这条记录' });
        const hMeta = readJson(HP.meta);
        if (!hMeta || typeof hMeta !== 'object' || Array.isArray(hMeta)) {
          return sendJson(res, 404, { error: '这条记录的 meta.json 读不出来（形状不对），不动它' });
        }
        // 五道全过了，才开始算要写什么。幂等在前：标志位已经是这个值，就什么都不写。
        const nowHidden = hMeta.hidden === true;
        if (nowHidden === want) {
          return sendJson(res, 200, {
            ok: true, id, hidden: want, changed: false, at: nowIso(),
            area: HP.area, state: readJson(HP.decision)?.decision || 'pending',
            note: '标志位已经是这个值，没有写盘（幂等）；重复发同一个请求不会留下第二笔改动记录。',
          });
        }
        const hAt = nowIso();
        const hHist = Array.isArray(hMeta.revisions) ? hMeta.revisions : [];
        // 只动标志位那三栏（外加 revisions 留痕），其余字段靠展开原样带过去。
        writeJson(HP.meta, {
          ...hMeta,
          hidden: want,
          hiddenBy: 'admin',
          hiddenAt: hAt,
          revisions: [...hHist, {
            at: hAt, by: 'admin',
            changed: { hidden: nowHidden },
            to: { hidden: want },
            why: want
              ? '审核页「不再显示」勾上：这条从审核页三个视图里都不再显示（公网 /api/mods 与 /mods 不动，要下架请用打回）'
              : '审核页「不再显示」取消勾选：这条重新显示（可逆）',
          }],
        });
        audit('hide', { id, ip, actor: 'admin', admin: true, detail: { hidden: want } });
        return sendJson(res, 200, {
          ok: true, id, hidden: want, changed: true, at: hAt,
          area: HP.area, state: readJson(HP.decision)?.decision || 'pending',
          untouched: 'mod.zip / orig.zip / pack-json.orig.json / decision.json 未动（判定不变）；'
            + 'name / author / compatAuthor / compatAuthorSource / compatOf / sha256 / uploadedAt / size / kind 原样。',
        });
      }
    }

    return sendJson(res, 404, { error: '没有这个地址' });
  } catch (e) {
    if (e?.code === 'TOO_LARGE') {
      // 先把 413 发出去，响应发完再把这条连接收掉（没有 content-length 的客户端还在灌数据）
      res.on('finish', () => req.destroy());
      // 413 的响应体**必须写清上限是多少**：客户端（上传页 / 管理台）要能直接把这句话显示给用户，
      // 而不是把 413 说成「网络断了」。`code` / `maxMB` 是给前端分类用的机器可读字段。
      return sendJson(res, 413, {
        error: `文件超过上限（${(MAX_BYTES / 1048576).toFixed(0)} MB）—— 请缩小包体再传`,
        code: 'TOO_LARGE',
        maxMB: MAX_BYTES / 1048576,
      });
    }
    console.error('[error]', e);
    // ⭐ 「传一半就断」这件事，服务端**原来一个字都不回**（只留一行日志，客户端什么都收不到）——
    //    上传页的 onerror 于是只能写死一句「网络断了」，用户拿不到任何可行动的判据。
    //    现在：连接**还能写**的时候尽量回一个可读的 408；确实写不进去（socket 已经断了）
    //    就只留日志，绝不再抛一个新异常出来盖掉原因。
    //    判据：Node 掐断请求时抛的就是 `Error: aborted`（`code` 为 `ECONNRESET`）；客户端自己
    //    关页面 / 隧道掉线走的是同一条路径，所以两者都落进这个分支 —— 文案里如实写两种可能。
    const aborted = e?.code === 'ECONNRESET' || e?.code === 'ABORT_ERR'
      || /aborted/i.test(String(e?.message || ''));
    if (aborted) {
      const got = req.socket?.bytesRead ?? 0;
      const limitMin = server.requestTimeout / 60000;
      try {
        if (!res.headersSent && !res.writableEnded && res.socket && !res.socket.destroyed) {
          return sendJson(res, 408, {
            error: `上传在传完之前中断了（服务端收到 ${got} 字节）。`
              + `服务端给一次上传 ${limitMin} 分钟；若是上行太慢用满了这个时限，请换更快的网络或缩小包体；`
              + `若是客户端 / 中间链路主动断开（关页面、隧道被 reset），重试即可。`,
            code: 'UPLOAD_ABORTED',
            receivedBytes: got,
            requestTimeoutMin: limitMin,
          });
        }
      } catch { /* 连接已经不能写了：只剩上面那行日志，不影响别的请求 */ }
      return;
    }
    return sendJson(res, 500, { error: '服务端出错：' + e.message });
  } finally {
    // 兜底：这次请求留下的临时文件（还没被 rename 成正式文件的那一份）在这里清掉。
    // 放在 finally 里是为了把**所有**失败路径都盖住 —— 提前 return 的 400、抛异常、别的早退，
    // 一个都不许在 DATA_DIR 留下 .part 垃圾。（成功的路径在 rename 之后就把它置空了。）
    if (partToClean && existsSync(partToClean)) {
      try { unlinkSync(partToClean); } catch { /* 清不掉也不能盖住真正的错误 */ }
    }
  }
});

/**
 * ⭐⭐ 请求超时：**必须显式写死**（2026-10-14「上传传一半就断」的治本那一条）。
 *
 * 为什么非写不可：Node v22 的 `server.requestTimeout` 默认值是 **300000 ms（300 秒）**，而它判的是
 * 「**整个请求**从收到第一个字节到响应写完的**总时长**」，不是「空闲多久」。所以慢速大包必被掐：
 * 25 MB 的包在 50 KB/s 的上行上要约 500 秒 ⇒ 第 300 秒被 Node 主动断开（回 408 + 断连），
 * 服务端只留下一行 `[error] Error: aborted` + `at abortIncoming (node:_http_server:805:17)` + `ECONNRESET`。
 * 这就是看起来很像是「20 MB 体积门」的真相 —— **判据是耗时，不是体积**：同一个 25 MB 的包，
 * 200 KB/s（约 128 秒）能过、50 KB/s（约 500 秒）必断；也解释了「挂梯子反而更容易断」——
 * 跨境上行更慢 ⇒ 总时长更长 ⇒ 更容易撞上这道时限，而这道时限跟客户端出口 IP 毫无关系。
 *
 * ⚠️ 位置说明：这三个属性只能在 `createServer()` **返回之后**赋（Node 不提供对应的 createServer 选项），
 *    所以紧贴在上面这个 `});` 之后、`listen()` 之前 —— 这是「一处集中」，别再散落到别处去设。
 *
 * 三个值的取法：
 *   · `requestTimeout = 900_000`（**15 分钟**）：给慢上行留足余量。
 *     ⚠️ **不要设 0**：0 的含义是「关掉这道保护」，慢连接可以永远挂着不放，等于把防线拆了；
 *     给一个大而有限的值才对 —— 既容纳慢速大包，又保证僵尸连接最终会被收掉。
 *     时限换算给用户看的判据：包大小 ÷ 上行带宽 < 900 秒。⇒ 25 MB 要约 **29 KB/s** 以上、
 *     100 MB 要约 114 KB/s 以上。（旧时限 300 秒时 25 MB 的判据是 85 KB/s，那个数已随修复作废。）
 *   · `headersTimeout = 60_000`：把头传完的时限。必须**大于** `keepAliveTimeout`（Node 的建议），
 *     且不大于 `requestTimeout`；60 秒对任何正常客户端都足够。
 *   · `keepAliveTimeout = 10_000`：空闲长连接的回收时限（默认 5 秒偏短，跨境链路上浏览器与
 *     服务器容易抢跑，日志里看着像「随机断连」）。
 */
server.requestTimeout = 900_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 10_000;

server.listen(PORT, HOST, () => {
  console.log(`工坊包上传站已起：${BASE_URL}`);
  console.log(`  监听     ${HOST}:${PORT}`);
  console.log(`  上传页   ${BASE_URL}/`);
  console.log(`  已上线   ${BASE_URL}/mods（分类筛选：/mods?kind=functional,documentation —— 不传即现状）`);
  console.log(`  审核页   ${BASE_URL}/${ADMIN_PATH}   （浏览器会弹登录框；用户名 admin，密码是 ADMIN_TOKEN）`);
  console.log(`  审核 API ${ADMIN_API}/*`);
  console.log(`  兼容包   ${ADMIN_API}/compat-submit?publish=1（投稿详情页那一个上传按钮：上传即发布，双署名）`);
  console.log(`  补关联   ${ADMIN_API}/compat/link（给已上线的兼容包补 compatOf；一次只认一个 id，见端点注释）`);
  console.log(`  改备注   ${ADMIN_API}/compat/note（只改 note + compatNote 两栏文案；一次只认一个 id，见端点注释）`);
  console.log(`  不再显示 ${ADMIN_API}/hide（勾选框：hidden:true/false，可逆；只影响审核页三视图，公开面不动；一次只认一个 id、绝不批量）`);
  console.log(`  人工确认 ${ADMIN_API}/compat-submit?publish=1&confirmBlockers=1&confirmReason=…（逐条确认真素材路径，不是放宽档位；留痕到决定记录）`);
  console.log(`  发布者   /mine（我的投稿）· POST /api/publisher/claim|update|blob|withdraw（认领码换令牌；改动一律回待审，绝不直改公开面）`);
  console.log(`  自撤确认 ${ADMIN_API}/withdraw-decide（发布者申请自撤的一键确认 / 拒绝；确认后 decision=superseded 且 replacedBy:null）`);
  console.log(`  批准包体 ${ADMIN_API}/promote-blob（发布者换上候选包体后，核过哈希才切换；旧包改名留档，不删）`);
  console.log(`  以新为准 ${ADMIN_API}/supersede（同一个 pack.id 的新版上线后，把旧的转 superseded + replacedBy；`
    + '只认一对、必须同 pack.id、不得成环；下架不删文件）');
  console.log(`  手工发码 ${ADMIN_API}/issue-claim（老记录认领 / 令牌丢失找回；明文只出现一次，盘上只存哈希）`);
  console.log(`  数据目录 ${DATA_DIR}`);
  console.log(`  审计日志 ${AUDIT_LOG}（追加式 JSONL；不记令牌明文）`);
  console.log(`  上传上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB`);
  if (ADMIN_IPS.length) console.log(`  管理白名单 ${ADMIN_IPS.join(', ')}（外加本机回环）`);
  else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('  ⚠ 没有设 ADMIN_IPS，而这个实例对外监听 —— 管理口只靠令牌保护。');
    console.log('    只有 HTTP 时令牌是明文过网的。建议设 ADMIN_IPS，或用 SSH 隧道访问 /admin：');
    console.log('      ssh -L 25570:127.0.0.1:25570 <user>@<服务器>');
  }
  if (TRUST_PROXY) console.log('  （TRUST_PROXY=1：按 x-forwarded-for 判客户端地址 —— 仅当确实挂在反代后面时才该这样）');
});
