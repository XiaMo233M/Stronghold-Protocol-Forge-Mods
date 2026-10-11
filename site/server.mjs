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
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, createReadStream, statSync, renameSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries, readZipFile, looksLikeZip } from './zip.mjs';
import { reviewName, reviewLabel, reviewEntries, hasBlocker } from './review.mjs';

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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BYTES = Number(process.env.MAX_MB || 100) * 1024 * 1024;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
/**
 * 管理口的 IP 白名单（逗号分隔）。设了就**只有**这些地址（外加本机回环）能碰审核页与审核 API。
 * 站点只有 HTTP、没有 HTTPS 时，这条是保护令牌的主要手段 —— 配合 SSH 隧道用：
 *   ssh -L 8787:127.0.0.1:8787 root@<服务器>
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

const ID_RE = /^[a-z0-9]{6,32}$/;
const nowIso = () => new Date().toISOString();
const idOf = () => randomBytes(6).toString('hex');            // 12 位十六进制
const tokenOf = () => randomBytes(16).toString('hex');        // 给投稿人的回执令牌

/** 一个投稿住哪个区：疑似素材的在 flagged/，其余在 submissions/；兼容包在 compat/。 */
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

/** 包里的 pack.json（只读它一条，最多 1 MB；读不到/解析不了都返回 null）。 */
async function packJsonFor(file) {
  const m = await readZipFile(file, ['pack.json']);
  const buf = m.get('pack.json');
  if (!buf || buf.length > 1024 * 1024) return null;
  try { return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
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
 * 普通投稿 `/decide` 那条路仍只收 approved / rejected 作为**入参**（不认 superseded），
 * 所以这个状态不会被误当成一个可以随手传进来的值；但它**不是锁**：日后要人工纠错，
 * 维护者照样可以用 `/decide` 覆盖这一条（本站的原则是「不许把记录弄成不可处置」）。
 */
function markReplacedBy(origId, compatId, compatName) {
  if (!origId || origId === compatId) return null;
  const q = dirOf(origId);
  if (!q || q.area === 'compat') return null;                    // 只取代普通投稿（含 flagged）
  const om = readJson(join(q.dir, 'meta.json'));
  if (!om) return null;
  const at = nowIso();
  writeJson(join(q.dir, 'decision.json'), {
    decision: 'superseded',
    reason: `已由兼容包 ${compatId}（${compatName}）取代并发布 —— 这一条不再单独上线，避免公网出现两份。`,
    at, by: 'admin',
    displayName: om.name || null,
    replacedBy: { id: compatId, name: compatName || null, area: 'compat', at },
  });
  return { id: origId, at };
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
/** 发一个「统一皮肤」的页面：把 __CSS__ 换成同源样式表链接、__ADMIN_API__ 换成当前前缀。
 * 两个替换放在一处，页面上就不会漏掉谁 —— 审核前缀是环境变量决定的，漏了就会打到不存在的地址。
 * 审核页还多一个 __VIEW__（当前在哪一页），同样是**白名单校验过**的值。
 */
const renderPage = (res, name, opts = {}) => {
  const p = join(PAGES, name);
  if (!existsSync(p)) return send(res, 404, '页面不存在', { 'content-type': 'text/plain; charset=utf-8' });
  const view = ADMIN_VIEWS.includes(opts.view) ? opts.view : 'main';
  const html = readFileSync(p, 'utf8')
    .split('__CSS__').join('/theme.css?v=3')
    .split('__ADMIN_API__').join(ADMIN_API)
    .split('__VIEW__').join(view);
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
const isAdmin = (req) => adminAllowed(req) && (tokenOk(req.headers['x-admin-token']) || basicOk(req));

/** 401 时要带这个头，浏览器才会弹登录框。 */
const askForLogin = (res) =>
  sendJson(res, 401, { error: '需要登录（用户名 admin，密码是服务器 /etc/sp-modsite.env 里的 ADMIN_TOKEN）' },
    { 'www-authenticate': 'Basic realm="sp-modsite admin", charset="UTF-8"' });

// 简单的按 IP 限流：每 10 分钟最多 10 次上传。
const hits = new Map();
const rateLimited = (ip) => {
  const t = Date.now();
  const arr = (hits.get(ip) || []).filter((x) => t - x < 600000);
  arr.push(t);
  hits.set(ip, arr);
  return arr.length > 10;
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
    if (req.method === 'GET' && (p === '/mods' || p === '/mods.html')) return renderPage(res, 'mods.html');
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
      const shape = (s) => ({
        id: s.id, name: s.name, note: s.note, uploadedAt: s.uploadedAt, size: s.size,
        homepage: s.homepage || null, suspected: s.suspected === true,
        suspectedReasons: s.suspectedReasons || [],
        // 兼容包：**两个署名分开给**，谁也不覆盖谁。公网列表那一页照这两栏分别显示。
        // 没有这两栏的就是普通投稿（前端按缺省处理，不显示署名栏）。
        kind: s.kind || 'submission',
        author: s.author || null,                 // 原作者（兼容包时来自原件/维护者核对）
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
        archiveDownload: s.kind === 'compat' ? `/api/file/${s.id}?variant=orig` : null,
      });
      const approved = allSubs().filter((s) => s.state === 'approved');
      return sendJson(res, 200, {
        mods: approved.filter((s) => !s.suspected).map(shape),
        flagged: approved.filter((s) => s.suspected).map(shape),
      });
    }

    // ---- 投稿人查自己的状态（要回执令牌）
    if (req.method === 'GET' && p.startsWith('/api/status/')) {
      const id = p.slice('/api/status/'.length);
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对' });
      const meta = readJson(metaPath(id));
      if (!meta) return sendJson(res, 404, { error: '没有这条投稿' });
      if (url.searchParams.get('t') !== meta.receipt) return sendJson(res, 403, { error: '回执令牌不对' });
      const d = readJson(decisionPath(id));
      return sendJson(res, 200, { id, name: meta.name, state: d ? d.decision : 'pending', reason: d?.reason ?? null, decisionAt: d?.at ?? null });
    }

    // ---- 下载：已上线的谁都能下；待审的只有维护者能下（你要 down 下来跑测试）
    //      `?variant=orig` 取的是**留档的原件** —— 它**永不公开**，无论这个编号通没通过。
    if (req.method === 'GET' && p.startsWith('/api/file/')) {
      const id = p.slice('/api/file/'.length);
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对' });
      const raw = url.searchParams.get('variant');
      if (raw && raw !== 'mod' && raw !== 'orig') return sendJson(res, 400, { error: 'variant 只能是 mod / orig' });
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
      if (d?.decision !== 'approved' && !isAdmin(req)) {
        // 报错要自己说清怎么办，不然维护者本人也会以为「我不是维护者吗」
        if (!adminAllowed(req)) {
          return sendJson(res, 403, { error: '这个还没通过审核；而管理口只允许回环地址（ADMIN_IPS），公网上拿不到待审包。走 SSH 隧道再下。' });
        }
        return sendJson(res, 403, { error: '这个还没通过审核，只有维护者能下载：请从审核页进入（浏览器会弹登录框），或用 x-admin-token 头带上令牌' });
      }
      const meta = readJson(metaPath(id)) || {};
      return sendFile(res, P.blobPath, meta.blobName || `${id}-${(meta.name || 'mod').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
    }

    // ---- 上传
    if (req.method === 'POST' && p === '/api/submit') {
      if (rateLimited(ip)) return sendJson(res, 429, { error: '传得太频繁了，过一会儿再来' });
      const name = (url.searchParams.get('name') || '').trim();
      const note = (url.searchParams.get('note') || '').trim();
      const homepage = (url.searchParams.get('homepage') || '').trim().slice(0, 300);
      const nameFlags = reviewName(name);
      if (nameFlags.some((f) => f.level === 'blocker')) {
        return sendJson(res, 400, { error: '名称不合格', flags: nameFlags });
      }
      if (note.length > 4000) return sendJson(res, 400, { error: '备注太长（最多 4000 字）' });

      // 有 content-length 就先拒：这样客户端拿到的是明明白白的 413，而不是传到一半连接被掐。
      // （XHR / fetch 传 Buffer 或 File 时一定会带这个头；没有的走下面的边收边判。）
      const declared = Number(req.headers['content-length'] || 0);
      if (declared && declared > MAX_BYTES) {
        return sendJson(res, 413, { error: `文件 ${(declared / 1048576).toFixed(1)} MB，超过上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB` });
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

      // **疑似素材照收不拒**（业主裁决）：它进 flagged/ 单独存放，并且处处标注清楚。
      // 「疑似」不等于「确认」—— 投稿人自己也未必知道原件里夹了什么。
      const suspected = hasBlocker(contentFlags);
      const area = suspected ? 'flagged' : 'normal';
      const dir = dirIn(area, id);
      mkdirSync(dir, { recursive: true });
      renameSync(tmpZip, join(dir, 'mod.zip'));
      partToClean = null;                      // 已经是正式的 mod.zip 了，不再是临时文件

      const files = entries.filter((e) => !e.dir);
      const meta = {
        id, area, name, note, homepage: homepage || null,
        size: body.length, sha256: createHash('sha256').update(body).digest('hex'),
        uploadedAt: nowIso(), ip, receipt: tokenOf(),
        entries: files.length,
        unpackedBytes: entries.reduce((n, e) => n + e.uncompSize, 0),
        flags: [...nameFlags, ...contentFlags],
        suspected,
        suspectedReasons: contentFlags.filter((f) => f.level === 'blocker').map((f) => f.code),
      };
      writeJson(join(dir, 'meta.json'), meta);

      return sendJson(res, 201, {
        ok: true, id, area, receipt: meta.receipt,
        state: 'pending', suspected,
        size: meta.size, sha256: meta.sha256, entries: meta.entries,
        statusUrl: `${BASE_URL}/api/status/${id}?t=${meta.receipt}`,
        flags: meta.flags,
        message: suspected
          ? '已收到。包里有疑似官方素材（见 flags），它已被单独存放并会公开标注；维护者人工确认后再决定上不上线。'
          : '已收到。维护者会下载下来跑测试，通过后再上线。',
      });
    }

    // ---- 维护者：列表 / 详情 / 决定
    if (p.startsWith(`${ADMIN_API}/`)) {
      if (!adminAllowed(req)) return sendJson(res, 403, { error: '这个地址不在管理白名单里（ADMIN_IPS）' });
      if (!isAdmin(req)) return askForLogin(res);

      if (req.method === 'GET' && p === `${ADMIN_API}/list`) return sendJson(res, 200, { submissions: allSubs() });

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
        return sendJson(res, 200, { meta, entries: entries.filter((e) => !e.dir).slice(0, 400), topLevel: top,
          variant,
          // 通过时就是照这个哈希核对「改写版没被掉包」的，所以详情里也带上，好让人当场比。
          viewSha256: existsSync(P.blobPath) ? createHash('sha256').update(readFileSync(P.blobPath)).digest('hex') : null,
          // 两个下载都**同一个编号**，用 variant 分开：默认给要发布的那份，留档原件单独一个口。
          download: `/api/file/${id}`,
          archiveDownload: existsSync(join(P.dir, 'orig.zip')) ? `/api/file/${id}?variant=orig` : null,          // pack.json 的原件快照：原注释一字不变的凭据。
          packJsonOrig: readJson(P.packJsonOrig) || null });
      }

      // 普通投稿的通过 / 打回。
      // ⚠️ 同样只接受**明确指定的 id**：批量喂筛出来的 id 会把刚打回的东西又批准回去
      //   （2026-10-11 线上回归的成因，见文件头那条纪律）。批准 = 上线，一条一条来。
      if (req.method === 'POST' && p === `${ADMIN_API}/decide`) {
        const raw = await readBody(req, 64 * 1024);
        let inObj = {};
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        const { id, decision, reason, displayName, acknowledge } = inObj;
        if (!ID_RE.test(String(id || ''))) return sendJson(res, 400, { error: 'id 形状不对' });
        if (!['approved', 'rejected'].includes(decision)) return sendJson(res, 400, { error: 'decision 只能是 approved / rejected' });
        if (!existsSync(blobPath(id))) return sendJson(res, 404, { error: '没有这条投稿' });
        // 兼容包走自己的那一段（它有「两个署名 + 原件留档 + 原注释不变」几条硬检查）。
        // 从这里放它过去，等于把那些检查全部绕开 —— 所以直接挡住。
        if (isCompat(id)) {
          return sendJson(res, 400, { error: `这是维护者侧的兼容包，请用专门的那一段：POST ${ADMIN_API}/compat/decide` });
        }
        const meta = readJson(metaPath(id)) || {};
        // 疑似素材**可以**上线（业主裁决：照收，但标注清楚），但必须**显式确认**过标记 ——
        // 不允许默默放过：页面上那个勾选会把它带来，少了就拒。
        if (decision === 'approved' && meta.suspected && acknowledge !== true) {
          return sendJson(res, 409, {
            error: '这条带「疑似官方素材」标记，上线后会在公开列表里明确标注。看过标记仍要上线的话，勾上确认再来。',
            flags: (meta.flags || []).filter((f) => f.level === 'blocker'),
            needsAcknowledge: true,
          });
        }
        writeJson(decisionPath(id), {
          decision, reason: reason || null, at: nowIso(), by: 'admin',
          displayName: displayName || meta.name,
          acknowledgedSuspected: meta.suspected === true && decision === 'approved',
        });
        if (displayName && displayName !== meta.name) writeJson(metaPath(id), { ...meta, name: displayName });
        return sendJson(res, 200, { ok: true, id, state: decision, area: meta.area, suspected: meta.suspected === true });
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
        if (rateLimited(ip)) return sendJson(res, 429, { error: '传得太频繁了，过一会儿再来' });

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
        if (compatNote.length > 4000) return sendJson(res, 400, { error: '兼容说明太长（最多 4000 字）' });
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
          return sendJson(res, 413, { error: `文件 ${(declared / 1048576).toFixed(1)} MB，超过上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB` });
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
      //   **不碰 `note`**；而 `/mods` 那一页**两栏都渲染**（`兼容说明：` + 备注正文），
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
      //   ⑥ 长度 ≤ 4000（与 `/api/submit` 的备注同一个上限）；
      //   ⑦ 这条记录在 `compat/` 区，且 `meta.json` 读出来是个带字符串 `name` 的对象。
      // 幂等：`note` 与 `compatNote` 都已经是新文案时，直接回 `changed:false`，
      //   **不写盘、不加 revisions** —— 重复发同一个请求不会留下第二笔改动记录。
      // ================================================================
      if (req.method === 'POST' && p === `${ADMIN_API}/compat/note`) {
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
        // ⑥ 长度上限
        if (nextNote.length > 4000) return sendJson(res, 400, { error: '备注太长（最多 4000 字）' });
        // ⑦ 记录形状：必须在 compat/ 区，meta.json 读得出来
        const P = pathsOf(id);
        if (!P || P.area !== 'compat') return sendJson(res, 404, { error: '没有这条兼容包' });
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
        return sendJson(res, 200, {
          ok: true, id, changed: true, note: nextNote,
          note_old: meta.note ?? null,
          at: nowIso(),
          untouched: 'mod.zip / pack-json.orig.json / decision.json 未动；name / author / compatAuthor / uploadedAt / size / kind / compatOf / sha256 原样。',
        });
      }
    }

    return sendJson(res, 404, { error: '没有这个地址' });
  } catch (e) {
    if (e?.code === 'TOO_LARGE') {
      // 先把 413 发出去，响应发完再把这条连接收掉（没有 content-length 的客户端还在灌数据）
      res.on('finish', () => req.destroy());
      return sendJson(res, 413, { error: `文件超过上限（${(MAX_BYTES / 1048576).toFixed(0)} MB）` });
    }
    console.error('[error]', e);
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

server.listen(PORT, HOST, () => {
  console.log(`工坊包上传站已起：${BASE_URL}`);
  console.log(`  监听     ${HOST}:${PORT}`);
  console.log(`  上传页   ${BASE_URL}/`);
  console.log(`  已上线   ${BASE_URL}/mods`);
  console.log(`  审核页   ${BASE_URL}/${ADMIN_PATH}   （浏览器会弹登录框；用户名 admin，密码是 ADMIN_TOKEN）`);
  console.log(`  审核 API ${ADMIN_API}/*`);
  console.log(`  兼容包   ${ADMIN_API}/compat-submit?publish=1（投稿详情页那一个上传按钮：上传即发布，双署名）`);
  console.log(`  补关联   ${ADMIN_API}/compat/link（给已上线的兼容包补 compatOf；一次只认一个 id，见端点注释）`);
  console.log(`  改备注   ${ADMIN_API}/compat/note（只改 note + compatNote 两栏文案；一次只认一个 id，见端点注释）`);
  console.log(`  人工确认 ${ADMIN_API}/compat-submit?publish=1&confirmBlockers=1&confirmReason=…（逐条确认真素材路径，不是放宽档位；留痕到决定记录）`);
  console.log(`  数据目录 ${DATA_DIR}`);
  console.log(`  上传上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB`);
  if (ADMIN_IPS.length) console.log(`  管理白名单 ${ADMIN_IPS.join(', ')}（外加本机回环）`);
  else if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log('  ⚠ 没有设 ADMIN_IPS，而这个实例对外监听 —— 管理口只靠令牌保护。');
    console.log('    只有 HTTP 时令牌是明文过网的。建议设 ADMIN_IPS，或用 SSH 隧道访问 /admin：');
    console.log('      ssh -L 8787:127.0.0.1:8787 <user>@<服务器>');
  }
  if (TRUST_PROXY) console.log('  （TRUST_PROXY=1：按 x-forwarded-for 判客户端地址 —— 仅当确实挂在反代后面时才该这样）');
});
