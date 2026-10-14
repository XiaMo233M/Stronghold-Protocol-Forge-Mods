// 审核台「线上那一份页面」的桩测试（**默认跳过**；要它跑，必须显式给地址与令牌）。
//
//   SP_LIVE_BASE=http://127.0.0.1:25570 SP_LIVE_ADMIN=review-2228 SP_LIVE_TOKEN=... node site/selftest-live-admin.mjs
//   （可选）SP_LIVE_COPY=1                另外在**副本实例**上跑那几条「本质上必须写」的断言
//   （可选）SP_LIVE_DATA_DIR=/var/lib/sp-modsite   副本与「一字未变」自证用的生产数据目录
//   （可选）SP_LIVE_COPY_PORT=25591       副本实例用的端口（**绝不能是生产端口**）
//
// 为什么单独一个文件、还不进默认测试：`selftest-admin.mjs` 是**自足**的（自己起服务、
// 自己造数据、跑完就删），任何人 clone 下来都能跑。这条不一样 —— 它打的是**真实部署**，
// 内网/没部署的地方跑了必然红，所以必须显式开（没给环境变量就打印「跳过」并退 0）。
//
// 它治的是「桩里过了、线上那份页面还是死的」这一类：这里喂进去的 HTML 是**服务器实际发出的那一段字节**
// （与部署产物同源），列表数据是**线上真实的 `/list` 响应**，不是造出来的。
// 上次那个 TDZ 事故就是「接口好、页面死」，靠自足测试与线上字节两处都过才算数。
//
// ================================================================
// ⚠️ 2026-10-11 修的 bug（业主口径：**我们的 bug 必须修**）：
//   这一份**原本会写生产数据**。它拿线上的真 `/hide` 端点把某条记录「勾上 → 取消」，
//   每跑一次就往那条记录的 `revisions` **追加 2 笔**（账本是追加式的，**历史无法逐字节复原**），
//   并把 `hiddenAt` 前移。**测试绝不该改生产数据。** 实测：`compat/a84e3a916517` 因此被追加了 2 笔。
//
//   现在分成三件事：
//     ① 保险（`assertWriteAllowed` / `allowCopyBase`）：**默认拒绝**。拿不出「这是副本」的证据
//        （目标 DATA_DIR 里没有哨兵 `.selftest-copy.json`）就当生产处理 —— 对生产**一个非 GET 请求都不发**；
//     ② 主体验法全部**只读**：要验「勾上之后长什么样」，就把线上真实 `/list` 里那一条在**内存里**
//        标成 `hidden:true`（即服务端写完之后 `/list` 会返回的样子），再喂**服务器实际发出的那份 HTML**。
//        一次写操作都不发，覆盖一条不减；
//     ③ 有几条**本质上必须写**才能验（真写盘后的 `changed:true`、幂等、坏形状不写盘、隐藏期间的公开面、
//        可逆），把它们挪到**副本实例**上跑：拷一份 DATA_DIR 到临时目录 → 起临时端口实例 → 跑完销毁。
//        这些断言在输出里一律标着 **【仅副本】**。
// ================================================================
import vm from 'node:vm';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================================================================
// 保险：什么算「生产」，以及写路径凭什么被放行
// ================================================================
/** 副本 DATA_DIR 的哨兵文件名。**只有我们脚本自己造的副本才有这个文件。** */
const COPY_SENTINEL = '.selftest-copy.json';
/** 线上生产实例的端口 / 主机 / 数据目录（来自 /etc/sp-modsite.env 与部署文档）。 */
const PROD_PORTS = new Set([25570]);
const PROD_HOSTS = new Set(['47.103.14.217', 'sp-modsite']);
const PROD_DATA_DIRS = new Set(['/var/lib/sp-modsite', '/opt/sp-modsite/data']);

const originOf = (u) => {
  try { const x = new URL(u); return { host: x.hostname, port: Number(x.port || (x.protocol === 'https:' ? 443 : 80)) }; }
  catch { return null; }
};
const baseOf = (u) => { const o = originOf(u); return o ? `${new URL(u).protocol}//${o.host}:${o.port}` : String(u); };

/** 「这个目录是副本」的**唯一**凭据：里面有一个说自己是副本的哨兵文件。 */
function copySentinelOk(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  try { if (!statSync(dir).isDirectory()) return false; } catch { return false; }
  try { return JSON.parse(readFileSync(join(dir, COPY_SENTINEL), 'utf8'))?.copy === true; } catch { return false; }
}

/**
 * 判断一个写目标是不是生产。**默认拒绝**：说不清、拿不出副本证据，一律算生产。
 * 返回 { production, reasons }；reasons 为空才允许写。
 */
function classifyWriteTarget({ base, dataDirHint = null }) {
  const reasons = [];
  const o = originOf(base);
  if (!o) reasons.push('目标地址读不出来');
  else {
    if (PROD_PORTS.has(o.port)) reasons.push(`端口 ${o.port} 是线上生产实例的端口`);
    if (PROD_HOSTS.has(o.host)) reasons.push(`主机 ${o.host} 是线上生产主机`);
  }
  if (dataDirHint && PROD_DATA_DIRS.has(String(dataDirHint))) reasons.push(`DATA_DIR ${dataDirHint} 是线上生产数据目录`);
  if (!copySentinelOk(dataDirHint)) reasons.push(`DATA_DIR ${dataDirHint || '(没给)'} 里没有副本哨兵 ${COPY_SENTINEL}`);
  return { production: reasons.length > 0, reasons };
}

/** 被显式登记为「可写」的副本 base。**只有**带哨兵的副本实例能进来。 */
const writeOkBases = new Map();
function allowCopyBase(base, dataDirHint) {
  const v = classifyWriteTarget({ base, dataDirHint });
  if (v.production) throw new Error(`保险：拒绝把 ${base} 登记为可写目标 —— ${v.reasons.join('；')}`);
  writeOkBases.set(baseOf(base), { dataDirHint });
  return true;
}
/** 发请求前的最后一道闸：非 GET/HEAD 且目标没被登记过 ⇒ 抛错，**请求一个字节都不发**。 */
function assertWriteAllowed(url, method) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD') return;
  if (writeOkBases.has(baseOf(url))) return;
  const v = classifyWriteTarget({ base: baseOf(url), dataDirHint: null });
  throw new Error(`保险拦下了一次写请求：${m} ${url} —— ${v.reasons.join('；')}。`
    + '本脚本的写路径只允许跑在「带副本哨兵的临时实例」上（SP_LIVE_COPY=1 + SP_LIVE_DATA_DIR）。');
}
/** 所有出网都从这里走：先过闸，再发。`fetchImpl` 只为自证时可注入替身。 */
async function guardedFetch(fetchImpl, url, opts = {}) {
  assertWriteAllowed(url, opts.method);
  return fetchImpl(url, opts);
}
const liveFetch = (url, opts = {}) => guardedFetch(globalThis.fetch, url, opts);

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// ================================================================
// ① 保险自证（离线 · 不碰网络）：喂「生产目标」的假配置 ⇒ 必须拒绝
// ================================================================
console.log('① 保险自证（离线，不碰网络）：喂「生产目标」的假配置 ⇒ 必须拒绝');
{
  const spy = (...a) => { spy.calls++; return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); };
  spy.calls = 0;
  const noSentinel = mkdtempSync(join(tmpdir(), 'sp-guard-nosentinel-'));
  const withSentinel = mkdtempSync(join(tmpdir(), 'sp-guard-copy-'));
  writeFileSync(join(withSentinel, COPY_SENTINEL), '{"copy":true}\n');

  const c1 = classifyWriteTarget({ base: 'http://127.0.0.1:25570' });
  check(c1.production, '生产端口 25570 ⇒ 判为生产', c1.reasons[0]);
  const c2 = classifyWriteTarget({ base: 'http://47.103.14.217:25571' });
  check(c2.production, '生产主机 47.103.14.217 ⇒ 判为生产', c2.reasons[0]);
  const c3 = classifyWriteTarget({ base: 'http://127.0.0.1:25571', dataDirHint: '/var/lib/sp-modsite' });
  check(c3.production, '生产 DATA_DIR /var/lib/sp-modsite ⇒ 判为生产', c3.reasons.join('；'));
  const c4 = classifyWriteTarget({ base: 'http://127.0.0.1:25571', dataDirHint: noSentinel });
  check(c4.production, '目录存在但**没有副本哨兵** ⇒ 默认拒绝（拿不出证据就是生产）', c4.reasons[0]);
  const c5 = classifyWriteTarget({ base: 'http://127.0.0.1:25571' });
  check(c5.production, '数据目录说不清 ⇒ 默认拒绝', c5.reasons[0]);

  let refused = false;
  try {
    await guardedFetch(spy, 'http://127.0.0.1:25570/api/review-2228/hide', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a84e3a916517', hidden: true }),
    });
  } catch { refused = true; }
  check(refused && spy.calls === 0,
    '对生产发 POST /hide ⇒ 抛错，且**一个字节都没发出去**（底层 fetch 调用次数 0）',
    `底层 fetch 被调用 ${spy.calls} 次`);

  const copyBase = 'http://127.0.0.1:25571';
  let registered = false;
  try { registered = allowCopyBase(copyBase, withSentinel); } catch { registered = false; }
  check(registered, '正向对照：带哨兵 + 非生产端口 ⇒ 允许登记为可写目标');
  let posted = false;
  try { await guardedFetch(spy, `${copyBase}/api/review-2228/hide`, { method: 'POST' }); posted = true; } catch { posted = false; }
  check(posted && spy.calls === 1, '正向对照：副本目标上的 POST 照常放行（保险只挡生产，不是「一律拒绝」）', `底层 fetch 被调用 ${spy.calls} 次`);
  let got = false;
  try { await guardedFetch(spy, 'http://127.0.0.1:25570/api/review-2228/list', { method: 'GET' }); got = true; } catch { got = false; }
  check(got && spy.calls === 2, '正向对照：生产上的 GET 照常放行（只读不受影响）', `底层 fetch 被调用 ${spy.calls} 次`);
  let regRefused = false;
  try { allowCopyBase('http://127.0.0.1:25570', withSentinel); } catch { regRefused = true; }
  check(regRefused, '哪怕哨兵齐了，**生产端口**也绝不登记（端口这道独立生效）');
  writeOkBases.delete(copyBase);
  rmSync(noSentinel, { recursive: true, force: true });
  rmSync(withSentinel, { recursive: true, force: true });
}

const BASE = process.env.SP_LIVE_BASE;
const ADMIN_PATH = process.env.SP_LIVE_ADMIN || 'admin';
const TOKEN = process.env.SP_LIVE_TOKEN;
if (!BASE || !TOKEN) {
  console.log('\n（跳过：没有给 SP_LIVE_BASE / SP_LIVE_TOKEN —— 这条只对真实部署有意义）');
  process.exit(failures ? 1 : 0);
}
/** 生产数据目录（只读快照用；也决定副本从哪儿拷）。 */
const PROD_DATA = process.env.SP_LIVE_DATA_DIR || '/var/lib/sp-modsite';

/** 只读走一遍数据目录，取「每条 meta.json 的 sha256 + revisions 总数」。这就是验收核心那份账。 */
function snapshotData(root) {
  if (!root) return null;
  try { if (!statSync(root).isDirectory()) return null; } catch { return null; }
  const shas = new Map();
  let files = 0, revs = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        if (e.name === 'meta.json') {
          const b = readFileSync(p);
          const j = JSON.parse(b.toString('utf8'));
          revs += Array.isArray(j.revisions) ? j.revisions.length : 0;
          shas.set(relative(root, p), createHash('sha256').update(b).digest('hex'));
        }
      }
    }
  };
  try { walk(root); } catch { return null; }
  return { root, files, meta: shas.size, revs, shas };
}
function diffSnapshot(a, b, { ignoreFiles = false } = {}) {
  if (!a || !b) return ['拿不到快照'];
  const out = [];
  for (const [k, v] of a.shas) if (b.shas.get(k) !== v) out.push(`${k}: ${String(v).slice(0, 12)}… → ${String(b.shas.get(k)).slice(0, 12)}…`);
  for (const k of b.shas.keys()) if (!a.shas.has(k)) out.push(`${k}: 新增`);
  for (const k of a.shas.keys()) if (!b.shas.has(k)) out.push(`${k}: 消失`);
  if (a.revs !== b.revs) out.push(`revisions 总数 ${a.revs} → ${b.revs}`);
  if (!ignoreFiles && a.files !== b.files) out.push(`文件数 ${a.files} → ${b.files}`);
  return out;
}
const prodSnap0 = snapshotData(PROD_DATA);
console.log(prodSnap0
  ? `\n生产数据目录 ${PROD_DATA} · ${prodSnap0.meta} 条 meta.json · revisions 合计 ${prodSnap0.revs}（**本次运行前后必须一模一样**）`
  : `\n（读不到生产数据目录 ${PROD_DATA}：不在同一台机器上？「一字未变」自证这条会跳过）`);

// ---------------------------------------------------------------- 最小 DOM 桩（与 selftest-admin.mjs 同一套）
function makeDom() {
  const byId = new Map();
  const node = (tag = 'div') => ({
    tagName: tag, id: '', className: '', value: '', textContent: '', type: '', href: '', download: '',
    placeholder: '', accept: '', rows: 0, disabled: false, checked: false, files: [],
    style: { cssText: '', display: '', margin: '', borderLeft: '' },
    children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    append(...k) { for (const x of k) this.children.push(x); },
    remove() { this.removed = true; },
    click() { if (typeof this.onclick === 'function') return this.onclick(); },
    addEventListener() {}, setAttribute() {}, focus() {},
    querySelector() { return node(); },
  });
  const document = {
    getElementById(id) { if (!byId.has(id)) { const n = node('div'); n.id = id; byId.set(id, n); } return byId.get(id); },
    createElement(t) { return node(t); },
    createTextNode(x) { return { text: String(x), isText: true }; },
    body: { append() {} },
    querySelectorAll() { return []; },
  };
  return { document, byId };
}

function bootInline(html, { fetchImpl, path = `/${ADMIN_PATH}` }) {
  const m = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) throw new Error('页面里没有内联脚本');
  const dom = makeDom();
  const sandbox = {
    document: dom.document, console,
    sessionStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    location: { href: `${BASE}${path}` },
    fetch: fetchImpl,
    alert() {}, URL, URLSearchParams, setTimeout, clearTimeout,
    Blob: class {}, TextDecoder, TextEncoder,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  let threw = null;
  try { vm.runInNewContext(m[1], sandbox, { filename: 'live-inline.js' }); }
  catch (e) { threw = e; }
  return { threw, dom, sandbox };
}

/** 把假 DOM 子树里的文本按顺序摊平（与 selftest-admin.mjs 同一套）。 */
function textOf(n, out = []) {
  if (!n || typeof n !== 'object') return out;
  if (n.isText) { out.push(n.text); return out; }
  if (n.textContent) out.push(String(n.textContent));
  for (const c of (n.children || [])) textOf(c, out);
  return out;
}
/** 在假 DOM 树里按条件找节点（与 selftest-admin.mjs 同一套）。 */
function find(n, pred, out = []) {
  if (!n || typeof n !== 'object' || n.isText) return out;
  if (pred(n)) out.push(n);
  for (const c of (n.children || [])) find(c, pred, out);
  return out;
}

/** 所有请求都过保险（`liveFetch`）：GET 放行，写请求只可能落到登记过的副本 base 上。 */
const admAt = (base, p) => liveFetch(`${base}${p}`, { headers: { 'x-admin-token': TOKEN } });
const adm = (p) => admAt(BASE, p);
/** 取「某个 base 的审核页 HTML」，喂 online 的真实 `/list` 响应，回可见性 + 计数。 */
async function viewProbe(base, listData, id) {
  const out = [];
  for (const [view, label] of [['main', '待审'], ['approved', '已通过'], ['rejected', '已打回']]) {
    const url = view === 'main' ? `/${ADMIN_PATH}` : `/${ADMIN_PATH}?view=${view}`;
    const r = await admAt(base, url);
    const vh = await r.text();
    const b = bootInline(vh, {
      path: url,
      fetchImpl: async (u) => (String(u).endsWith('/list')
        ? { ok: true, status: 200, json: async () => listData }
        : { ok: true, status: 200, json: async () => ({}) }),
    });
    await sleep(50);
    const rows = [...items(b.dom.byId.get('list')), ...items(b.dom.byId.get('alist')), ...items(b.dom.byId.get('rlist'))];
    const shown = rows.filter((li) => li.style.display !== 'none');
    const rr = b.sandbox.readFilter();
    out.push({
      view, label, threw: b.threw,
      visible: shown.some((li) => li.meta && li.meta.id === id),
      drawn: rows.some((li) => li.meta && li.meta.id === id),
      sum: rr.nMain + rr.nApproved + rr.nRejected + rr.nHidden, nHidden: rr.nHidden, total: listData.submissions.length,
    });
  }
  return out;
}

const pageRes = await adm(`/${ADMIN_PATH}`);
const html = await pageRes.text();
const listJson = await (await adm(`/api/${ADMIN_PATH}/list`)).json();
console.log(`线上 ${BASE}/${ADMIN_PATH} · HTTP ${pageRes.status} · ${html.length} 字节 · 记录 ${listJson.submissions.length} 条`);

const { threw, dom, sandbox } = bootInline(html, {
  fetchImpl: async (url) => (String(url).endsWith('/list')
    ? { ok: true, status: 200, json: async () => listJson }
    : { ok: true, status: 200, json: async () => ({}) }),
});
check(!threw, '线上那份 HTML 的内联脚本顶层没有抛错（TDZ 这一类就在这里露头）',
  threw ? `${threw.name}: ${threw.message}` : '');
await sleep(80);

const items = (n) => (n?.children || []).filter((c) => c.className === 'item');
// 页面结构随 2026-10-11 那两轮改过：**已打回**不再混在主列表里（单独一块 `#rlist`），
// 「已经通过的也要另开一页」之后**已通过**也单独一份列表（`#alist`）；
// `#clist` 那个独立的「兼容包」区已经撤掉了。所以「线上真实列表」= 三份列表的并集。
const ul = dom.byId.get('list'), al = dom.byId.get('alist'), rl = dom.byId.get('rlist'), cl = dom.byId.get('clist');
const all = [...items(ul), ...items(al), ...items(rl), ...items(cl)];
const vis = () => all.filter((li) => li.style.display !== 'none').length;
// 【原地改语义 · 2026-10-11「不再显示」】线上可能已经有勾了「不再显示」的记录 ——
// 它们照旧**画**在 DOM 里、只是不显示。所以同一个意图从「可见 = 全部」改断成
// 「可见 = 全部 − 已隐藏」；已隐藏那一条单独作证（不许因为隐藏而对不上）。
const hidN = (rows) => rows.filter((s) => s.hidden === true).length;
const liveHidden = hidN(listJson.submissions);
check(all.length === listJson.submissions.length,
  `线上真实列表全画出来了（${all.length} 条 = 服务端 ${listJson.submissions.length} 条）`);
check(vis() === all.length - liveHidden,
  '默认视图只藏了「不再显示」的那些，别的一条没藏',
  `可见 ${vis()} / ${all.length}（其中已隐藏 ${liveHidden} 条）`);

// 【2026-10-11 修「过时断言」· 数据漂移，不是产品 bug】关键字筛选：**不写死任何关键词**。
//   原先写死「皮肤选择器」＝一条**当前线上已经 hidden:true** 的记录 ⇒ 默认视图本来就不画它，
//   筛出 0 条是**正确行为**，是断言写错了。现在改成从**当前线上真实数据**里现挑：
//     · 挑一条**默认可见**（hidden !== true）的记录，取它名字里一段**只有它命中**的片段；
//     · 断言「筛出的可见条数 == 数据里真的命中这个关键词的可见条数」（两边现算，不是常数）；
//     · 再断言它会**真的筛掉别条**（否则「筛」字就是虚的）；
//     · 命中数 > 1 时按名字精确到那一条再断言；== 1 时直接断言那一条可见。
//   ⚠️ 命中判据必须与页面 `matches()` 的 key 那一路**同一套**（id 或 name 含关键词、大小写不敏感）。
const keyHits = (rows, k) => rows.filter((s) => String(s.id || '').toLowerCase().includes(k)
  || String(s.name || '').toLowerCase().includes(k));
const visibleInDom = () => all.filter((li) => li.style.display !== 'none');
// 优先挑一条**整名只命中它自己**的可见记录 —— 关键词取它的名字，正是人真的会敲的那一档。
// 整名都不唯一的记录挑不出「名字型关键词」，退到「名字里只有它命中的一段」，再退到编号。
const firstVisible = listJson.submissions.find((s) => s.hidden !== true);
let kw = null, kwRow = null, kwN = 0;
if (firstVisible) {
  const named = listJson.submissions.find((s) => s.hidden !== true && String(s.name || '').trim()
    && keyHits(listJson.submissions, String(s.name).trim().toLowerCase()).length === 1);
  const pick = named || firstVisible;
  kwRow = pick;
  kw = String(pick.name || '').trim() || String(pick.id);
  if (keyHits(listJson.submissions, kw.toLowerCase()).length !== 1) {
    const nm = String(pick.name || '');
    let found = null;
    for (let len = Math.min(12, nm.length); len >= 2 && !found; len--) {
      for (let i = 0; i + len <= nm.length; i++) {
        const cand = nm.slice(i, i + len);
        const hitsAll = keyHits(listJson.submissions, cand.toLowerCase());
        if (hitsAll.length === 1 && hitsAll[0].id === pick.id) { found = cand; break; }
      }
    }
    kw = found || String(pick.id);
  }
  kwN = keyHits(listJson.submissions, kw.toLowerCase()).filter((s) => s.hidden !== true).length;
}
if (!kw) {
  check(false, '线上没有可用于筛选断言的可搜索字段（难道名字与编号全空？）');
} else {
  console.log(`  用它筛：${kwRow.id}（${kwRow.name}）· 关键词「${kw}」在数据里可见命中 ${kwN} 条`);
  dom.byId.get('fKey').value = kw;
  const rKw = sandbox.readFilter();
  check(vis() === kwN, `关键字「${kw}」筛出 ${vis()} 条 == 数据里的可见命中数 ${kwN} 条`);
  check(visibleInDom().length === kwN && visibleInDom().every((li) => keyHits([li.meta], kw.toLowerCase()).length === 1),
    `筛出的 ${visibleInDom().length} 条**每一条都真的命中**这个关键词（一条不多）`);
  // 这一档**必跑**：把关键词逼成「只命中它一条」的样式，再验「筛出来就是它自己」。
  // 定不下来就显式打一条 ✗（不许静默跳过 —— 跳过就等于这条断言不存在）。
  const soloKw = keyHits(listJson.submissions, String(kwRow.name).toLowerCase()).length === 1
    ? String(kwRow.name)
    : (keyHits(listJson.submissions, String(kwRow.id).toLowerCase()).length === 1 ? String(kwRow.id) : null);
  if (!soloKw) {
    check(false, '找不出一个「只命中它一条」的关键词来验收窄那一档（数据里的名字与编号都不唯一）');
  } else {
    const soloN = keyHits(listJson.submissions, soloKw.toLowerCase()).filter((s) => s.hidden !== true).length;
    dom.byId.get('fKey').value = soloKw;
    const rSolo = sandbox.readFilter();
    check(soloN === 1 && vis() === 1 && visibleInDom().length === 1 && visibleInDom()[0].meta?.id === kwRow.id,
      `把关键词收窄到「${soloKw}」→ 只剩它自己那一条（筛出来的就是它）`,
      `可见 ${vis()} 条 · 数据里可见命中 ${soloN} 条`);
    check(rSolo.visibleHidden === 0, '收窄之后仍然看不到任何已隐藏记录（默认不勾「显示已隐藏」）',
      `可见的已隐藏 ${rSolo.visibleHidden} 条`);
  }
  dom.byId.get('fKey').value = '';
  check(rKw.visibleHidden === 0, '默认（不勾「显示已隐藏」）下筛不到任何已隐藏记录',
    `可见的已隐藏 ${rKw.visibleHidden} 条`);
}
// 反例：一个**压根不存在**的关键词 ⇒ 一条都不该可见（否则筛选是虚的）
const MISSING_KEY = 'zz-no-such-key-zz';
check(keyHits(listJson.submissions, MISSING_KEY).length === 0, `反例关键词「${MISSING_KEY}」在数据里本来就不命中任何记录`);
dom.byId.get('fKey').value = MISSING_KEY;
const rMiss = sandbox.readFilter();
check(vis() === 0 && visibleInDom().length === 0,
  `反例关键词「${MISSING_KEY}」一条都不留（筛选真的在筛）`, `可见 ${vis()} 条`);
dom.byId.get('fKey').value = '';
// 已隐藏那条：默认看不见；勾上「显示已隐藏」才找得回来（**原来那条错断言的真身**）
const hidSample1 = listJson.submissions.find((s) => s.hidden === true && String(s.name || '').trim());
if (!hidSample1) {
  check(false, '线上没有已隐藏记录（一条都没被勾上？）—— 这条断言本来就盯「隐藏 ≠ 消失」');
} else {
  const hidName = String(hidSample1.name);
  const hidHitN = keyHits(listJson.submissions, hidName.toLowerCase()).filter((s) => s.hidden !== true).length;
  dom.byId.get('fKey').value = hidName;
  const rHid = sandbox.readFilter();
  // 【2026-10-12 修「过时断言」· 数据漂移、不是产品 bug】
  // 原判据是「这个关键词的可见命中数 == 0」—— 它暗含一个假设：**这条已隐藏记录的名字在线上是唯一的**。
  // 线上已经不再是：`e7b3b3e1751f`（普通投稿，已隐藏）与 `a84e3a916517`（兼容改写版，可见）
  // **同名**「代号审查（名字策略链）」—— 那正是兼容包与原件同名的那一类，是两个**不同的记录**。
  // 一条可见的同名记录**不是**「隐藏失效」，拿它当红是把无关的事判成了故障。
  // 改成直接断言真正在盯的那件事（**不放松，反而更硬**）：
  //   · 这条已隐藏记录**自己**不在可见那一批里；
  //   · 而且这次筛选里**一条已隐藏记录都没漏出来**（`visibleHidden === 0`）——
  //     这比「关键词 0 命中」更贴近口径：隐藏记录在任何关键词下都不该可见。
  const visIdsHid = visibleInDom().map((li) => li.meta && li.meta.id);
  check(rHid.visibleHidden === 0 && !visIdsHid.includes(hidSample1.id),
    `已隐藏的那条（${hidSample1.id}「${hidName}」）默认筛不出来：它自己不在可见那批里，且可见的已隐藏记录 0 条`
    + (hidHitN ? `（线上另有 ${hidHitN} 条**同名**的可见记录，那是另一个记录 —— 同名不算隐藏失效）` : ''),
    `数据里同名可见命中 ${hidHitN} 条 · 页面可见 ${vis()} 条 · 其中已隐藏 ${rHid.visibleHidden} 条`);
  dom.byId.get('fKey').value = '';
}
// 清空筛选 ⇒ 恢复默认（不管上面哪条路走过，这里都必跑）
dom.byId.get('fClear').onclick();
check(vis() === all.length - liveHidden, '清空筛选 → 恢复（仍然只剩已隐藏的那些不显示）');
// 区域：compat 那一组
dom.byId.get('fArea').value = 'compat';
const rArea = sandbox.readFilter();
const compatN = listJson.submissions.filter((s) => s.kind === 'compat' && s.hidden !== true).length;
check(rArea.visible === vis() && vis() === compatN,
  `区域=compat → 可见 ${vis()} 条（线上未隐藏的 compat 共 ${compatN} 条）`,
  String(dom.byId.get('fCounts')?.textContent || ''));
dom.byId.get('fClear').onclick();
check(/compat/.test(html) && /fCounts/.test(html), '线上页面上确实是带筛选控件的那一版（不是部署前的旧文件）');

// ---------------------------------------------------------------- 线上：每条记录一个「不再显示」勾选框
// 业主 2026-10-11：「给我一个勾选框，选后就不显示这个 mod 了」。这一条只查**线上那份 HTML**
// 渲染出来的东西：每一行都有勾选框、文案写对、默认不勾；筛选栏有「显示已隐藏」；导航有「已隐藏」。
console.log('\n线上页面：每条记录一个「不再显示」勾选框 + 「显示已隐藏」开关');
// 【2026-10-11 修「过时断言」· 数据漂移】勾选框：**不再假定「一条都没被勾上」**。
//   线上现在确实有 11 条 hidden:true ⇒ 它们的勾选框**本来就该是勾上的**（勾选框反映记录的
//   真实 hidden 值，见 admin.html 的 `cb.checked = isHidden(s)`）。原来写死「默认一个都没勾上」
//   是把「线上一条都没隐藏」当成了不变量 —— 数据一漂移就红，而且它**盯错了对象**：
//   真正要防的是「**画出来给别人看的那些行**被勾上」（＝有记录被悄悄藏起来了）。
//   现在改成**两条现算的比对**（都以当前线上数据为准）：
//     · 被勾上的行数 == 数据里 hidden===true 的条数（多一条少一条都红）；
//     · 被勾上的那些行 == 数据里那批 hidden===true 的记录（id 一个不差；不是随便勾了同样多条数）。
//   前提（也断出来）：线上 hidden 字段一律是**严格布尔** true/false/undefined，没有 Truthy 的杂质。
check(listJson.submissions.every((s) => s.hidden === true || s.hidden === false || s.hidden === undefined),
  '线上 hidden 字段一律是严格布尔（true / false / 缺省）—— 下面按 `!== true` 分流才站得住');
const liveRows = [...items(ul), ...items(al), ...items(rl)];
const liveBoxes = liveRows.map((li) => find(li, (n) => n.tagName === 'input' && n.type === 'checkbox')[0] || null);
check(liveBoxes.length === liveRows.length && liveBoxes.every(Boolean),
  `线上**每一行**都画出了勾选框（${liveBoxes.filter(Boolean).length} / ${liveRows.length} 行）`);
check(liveRows.every((li) => /不再显示（已由兼容包取代）/.test(textOf(li).join(' '))),
  '线上文案就是「不再显示（已由兼容包取代）」');
const drawnIds = new Set(liveRows.map((li) => li.meta && li.meta.id).filter(Boolean));
const hidInData = listJson.submissions.filter((s) => s.hidden === true);
const checkedRows = liveRows.filter((li, i) => liveBoxes[i] && liveBoxes[i].checked === true);
const checkedIds = checkedRows.map((li) => li.meta && li.meta.id).filter(Boolean);
check(checkedRows.length === hidInData.length,
  '勾上的行数 == 线上 hidden===true 的记录条数（勾选框反映的是记录真实的 hidden 值）',
  `勾上 ${checkedRows.length} 行 · 数据里已隐藏 ${hidInData.length} 条`);
check(checkedIds.length === hidInData.length
  && hidInData.every((s) => drawnIds.has(s.id) && checkedIds.includes(s.id))
  && checkedIds.every((id) => hidInData.some((s) => s.id === id)),
  '勾上的那些行**就是**数据里那批 hidden===true 的记录（id 一个不差：没有哪条被多勾 / 少勾）',
  `勾上：${checkedIds.slice(0, 4).join(',')}${checkedIds.length > 4 ? `…（共 ${checkedIds.length}）` : ''}`);
check(/id="fHidden"/.test(html) && /显示已隐藏/.test(html), '线上筛选栏里有「显示已隐藏」开关');
check(/id="nHidden"/.test(html), '线上导航里有「已隐藏」那一格（三页相加 + 这一格 = 全部）');

// ---------------------------------------------------------------- 线上三页（真另开一页）
// 业主 2026-10-11：「已经通过的也要另开一页」。线上三页各拿一次，各自检查
// 「服务端发的就是那一页」「只显示自己那块面板」「导航高亮自己」「页面自己知道当前是 view=X」。
for (const [view, label, panel, tab] of [
  ['approved', '已通过', 'apanel', 'vApproved'],
  ['rejected', '已打回', 'rpanel', 'vRejected'],
]) {
  const r = await adm(`/${ADMIN_PATH}?view=${view}`);
  const vHtml = await r.text();
  check(r.status === 200 && !vHtml.includes('__VIEW__'),
    `线上 /${ADMIN_PATH}?view=${view} → 200，且 __VIEW__ 已替换`,
    `HTTP ${r.status} · ${(vHtml.match(/const VIEW = '[^']*'/) || ['(没找到)'])[0]}`);
  const vb = bootInline(vHtml, {
    path: `/${ADMIN_PATH}?view=${view}`,
    fetchImpl: async (url) => (String(url).endsWith('/list')
      ? { ok: true, status: 200, json: async () => listJson }
      : { ok: true, status: 200, json: async () => ({}) }),
  });
  check(!vb.threw, `线上「${label}」那一页喂 DOM 桩不抛错`,
    vb.threw ? `${vb.threw.name}: ${vb.threw.message}` : '');
  await sleep(60);
  const rr = vb.sandbox.readFilter();
  check(rr.view === view, `线上「${label}」那一页：页面自己知道 view=${view}`, String(rr.view));
  check(vb.dom.byId.get(panel)?.style.display === ''
    && ['ppanel', 'apanel', 'rpanel'].filter((x) => x !== panel).every((x) => vb.dom.byId.get(x)?.style.display === 'none'),
    `线上「${label}」那一页：只显示它自己那块面板`,
    ['ppanel', 'apanel', 'rpanel'].map((x) => `${x}=${JSON.stringify(vb.dom.byId.get(x)?.style.display)}`).join(' '));
  check(String(vb.dom.byId.get('viewNow')?.textContent || '') === `当前：${label}`
    && /on/.test(String(vb.dom.byId.get(tab)?.className || '')),
    `线上「${label}」那一页：当前页写清了、导航高亮的是它自己`,
    `${JSON.stringify(vb.dom.byId.get('viewNow')?.textContent)} · ${tab}=${JSON.stringify(vb.dom.byId.get(tab)?.className)}`);
  check(rr.nMain + rr.nApproved + rr.nRejected + rr.nHidden === listJson.submissions.length,
    `线上「${label}」那一页：三页相加 + 已隐藏 = 线上记录总数`,
    `${rr.nMain} + ${rr.nApproved} + ${rr.nRejected} + ${rr.nHidden} = ${rr.nMain + rr.nApproved + rr.nRejected + rr.nHidden}（线上 ${listJson.submissions.length}）`);
}
const badLive = await adm(`/${ADMIN_PATH}?view=nope`);
check(badLive.status === 404, '线上 view 不在白名单里 → 404（不悄悄回落到主列表）', `HTTP ${badLive.status}`);

// ---------------------------------------------------------------- 线上「不再显示」勾选框：**只读**验法
// 业主 2026-10-11：「有可能 mod 名字和兼容后的名字不一样，导致依旧存在两个 mod（一个在兼容，
// 一个在上传待定），所以给我一个勾选框，选后就不显示这个 mod 了」。
//
// 【2026-10-11 修 bug 的改法（a）】原本这一段**直接打线上 /hide**：勾上 → 取消，每跑一次给那条
// 记录的 revisions 追加 2 笔。现在**一个写请求都不发**：
//   · 「勾上之后长什么样」= 把线上真实 `/list` 里那一条在**内存里**标成 `hidden:true`
//     （这正是服务端写完之后 `/list` 会返回的那份数据），再喂**服务器实际发出的那份 HTML**；
//   · 「取消之后回来」= 直接用**线上真实的那份 `/list`**（这条本来就没被勾上，不必先写再撤）。
// 要验的渲染与计数一条不减；真写盘那一路（`changed:true`/幂等/坏形状/隐藏期间公开面/可逆）
// 挪到 ④ 的副本实例上跑。
console.log('\n线上「不再显示」勾选框（**只读**）：合成「已隐藏」那一份 /list ⇒ 三个视图都不见 · 计数对得上 · 公开面不动');
const target = listJson.submissions.find((s) => s.kind === 'compat' && s.hidden !== true)
  || listJson.submissions.find((s) => s.hidden !== true);
if (!target) {
  check(false, '线上没有可用来验勾选框的记录（难道全被隐藏了？）');
} else {
  console.log(`  用它验：${target.id}（${target.name}）· 线上现在 hidden=${target.hidden === true}`);
  check(target.hidden !== true, '线上这条本来就没被勾上（**测试不需要先写它一下**）', `hidden=${target.hidden}`);
  // 合成的「已隐藏」那一份（只在内存里；一个字节都不落盘）
  const synthHid = { ...listJson, submissions: listJson.submissions.map((s) => (s.id === target.id ? { ...s, hidden: true } : s)) };
  const synthHidden = hidN(synthHid.submissions);
  check(synthHidden === liveHidden + 1,
    '合成的那一份 = 线上那一份 + 这一条标成 hidden:true（**只在内存里**，没落盘）',
    `已隐藏 ${liveHidden} → ${synthHidden}`);
  const probeHid = await viewProbe(BASE, synthHid, target.id);
  for (const p of probeHid) {
    check(!p.threw && !p.visible,
      `线上「${p.label}」那一页：勾上之后**看不到它**（本页画了它吗：${p.drawn ? '画了但不显示' : '不属这页'}）`,
      `可见=${p.visible} · 已隐藏计数=${p.nHidden}`);
    check(p.sum === p.total,
      `线上「${p.label}」那一页：三页相加 + 已隐藏 = 全部`,
      `${p.sum} = ${p.total}（其中已隐藏 ${p.nHidden}）`);
  }
  check(probeHid.every((p) => p.nHidden === synthHidden),
    '线上三页各自算出的「已隐藏」= 合成之后的真实条数（三页都没多算也没少算）',
    `${probeHid.map((p) => `${p.label}:${p.nHidden}`).join(' ')} vs ${synthHidden}`);
  // 「显示已隐藏」开关：勾上能看见（便于取消勾选）—— 喂合成那一份
  const bShow = bootInline(html, {
    fetchImpl: async (u) => (String(u).endsWith('/list')
      ? { ok: true, status: 200, json: async () => synthHid }
      : { ok: true, status: 200, json: async () => ({}) }),
  });
  await sleep(60);
  bShow.dom.byId.get('fHidden').checked = true;
  const rShow = bShow.sandbox.readFilter();
  // ⚠️ 必须**现读 DOM**，不许用 readFilter 之前抓下来的一份数组快照：
  //    快照会在「这条记录从 DOM 里被吞掉」时仍然留着它，断言就退化成了永真。
  //    而且筛选条件必须带上 `display !== 'none'` —— 隐藏的那些**也画在 DOM 里**，只是不显示。
  const shownHiddenIds = () => [...items(bShow.dom.byId.get('list')), ...items(bShow.dom.byId.get('alist')), ...items(bShow.dom.byId.get('rlist'))]
    .filter((li) => li.meta && li.meta.hidden === true && li.style.display !== 'none')
    .map((li) => li.meta.id);
  check(rShow.visibleHidden === synthHidden && shownHiddenIds().length === synthHidden,
    '勾上「显示已隐藏」→ 可见的已隐藏条数 == 数据里的已隐藏条数（**从数据现算，不是常数**）',
    `页面 ${rShow.visibleHidden} 条 · DOM 里显示着的 ${shownHiddenIds().length} 条 · 合成数据 ${synthHidden} 条`);
  check(shownHiddenIds().includes(target.id),
    '勾上「显示已隐藏」→ 现场挑中用来验的那条被隐藏的**又看得见**（就是给你取消勾选用的）',
    `它现在显示着：${shownHiddenIds().includes(target.id)}`);
  // 公开面：隐藏 ≠ 下架。只读版的两条独立证据 ——
  //   ① /api/mods 的字段里**根本没有** hidden 这一栏（服务端不读它）；
  //   ② 连读两次字节一致（服务端也没在别处偷偷用它改输出）。
  // 「真在隐藏状态下的公开面字节」那一条挪到 ④ 的副本上验（那才是真隐藏着取的）。
  const pubJsonA = JSON.stringify(await (await liveFetch(`${BASE}/api/mods`)).json());
  const pubPageA = await (await liveFetch(`${BASE}/mods`)).text();
  check(!/"hidden"/.test(pubJsonA),
    '公网 /api/mods 的字段里没有 hidden 这一栏 ⇒ 隐藏不改公开面（隐藏 ≠ 下架）');
  check(pubJsonA === JSON.stringify(await (await liveFetch(`${BASE}/api/mods`)).json())
    && pubPageA === await (await liveFetch(`${BASE}/mods`)).text(),
    '公网 /api/mods 与 /mods 各连读两次，字节完全一致（全程没动过）');
  // 取消勾选 ⇒ 回来（**可逆**）：用线上真实那一份 /list，不必先写
  const listBack = listJson;
  const probeBack = await viewProbe(BASE, listBack, target.id);
  const own = probeBack.find((p) => (target.kind === 'compat' ? p.view === 'approved' : p.view === 'main'))
    || probeBack.find((p) => p.drawn);
  check(!!own && probeBack.find((p) => p.view === own.view).visible,
    '没被勾上的那条：它出现在自己该在的那一页上',
    probeBack.map((p) => `${p.label}:可见=${p.visible}`).join(' · '));
  check(probeBack.every((p) => p.nHidden === hidN(listBack.submissions)),
    '「已隐藏」那一栏就是线上的真实条数（测试没有让它虚高）',
    probeBack.map((p) => `${p.label}:${p.nHidden}`).join(' '));
}

// ---------------------------------------------------------------- 线上 /mods：备注（结构，不是写死的文案）
// 业主 2026-10-11：那三条已上线的兼容包，公网页备注留的还是上传时那句内部链路实测的话
// （「兼容包入口链路实测：只上传，不通过、不发布。」）—— 它们**已经发布**，那句话在公网上是假的。
// 这里喂进去的是**线上 /mods 实际发出的那段字节** + **线上真实的 /api/mods 响应**，
// 断言「备注不含『链路实测』『不发布』、两栏一致、渲染层只画一次」—— 不是拿造的数据自证。
// 【2026-10-11 修「过时断言」】原先这里还写死了一句「新文案」的常量去比对 ——
//   那条记录（a84e3a916517）的备注后来改成了另一段真实的「装前必读」长文，
//   于是断言因为**内容变了**而红。内容本来就会变，不该拿它当断言；现在一律从线上数据现取。
const modsPage = await liveFetch(`${BASE}/mods`);
const modsHtml = await modsPage.text();
const modsJson = await (await liveFetch(`${BASE}/api/mods`)).json();
console.log(`线上 ${BASE}/mods · HTTP ${modsPage.status} · ${modsHtml.length} 字节 · 公开 ${modsJson.mods.length} 条`);
const modsBoot = bootInline(modsHtml, {
  path: '/mods',
  fetchImpl: async (url) => (String(url).includes('/api/mods')
    ? { ok: true, status: 200, json: async () => modsJson }
    : { ok: true, status: 200, json: async () => ({}) }),
});
check(!modsBoot.threw, '线上 /mods 那份真实 HTML 喂 DOM 桩不抛错',
  modsBoot.threw ? `${modsBoot.threw.name}: ${modsBoot.threw.message}` : '');
await sleep(80);
const modsList = modsBoot.dom.byId.get('list');
const modsText = textOf(modsList).join(' ');
// ---- 「这条记录自己那张卡」：**只有这一处**认卡，下面几段都用它 --------------------
// 【2026-10-15 修「过时断言」时顺手钉死的一件事】认卡必须认**身份行**
//   「… 上传于 <日期> · 编号 <id>」（`server.mjs:1436` 那一行）。
//   ⚠️ 只搜 `编号 <id>` 这个子串是不够的：同 id 提示那一行写的是「（编号 <id>）」
//   （`server.mjs:1441`），备注正文里也可能出现**别人的**编号 —— 只按子串认，
//   排在前面那张卡会把后面那条认领走，断言就验错了对象。
const ownCard = (m) => find(modsList, (n) => /panel/.test(String(n.className || ''))
  && new RegExp(`上传于 [^·]{0,40}· 编号 ${m.id}`).test(textOf(n).join(' ')))[0] || null;
const cardText = (m) => { const c = ownCard(m); return c ? textOf(c).join(' ') : ''; };
/** 卡里的**署名框**（`sigbox`）：原作者 / 兼容改写者两栏都画在这个元素里（`server.mjs:1455`）。
 *  ⚠️ 判「署名框画没画」必须看**这个元素在不在**，不能拿整张卡的文本去搜「原作者」三个字 ——
 *     备注正文里本来就可能写着「原作者：某某」（线上就有 4 条是那样），那是假红。 */
const sigboxOf = (m) => {
  const c = ownCard(m);
  return c ? find(c, (n) => /sigbox/.test(String(n.className || '')))[0] || null : null;
};
const notedPub = modsJson.mods.filter((m) => typeof m.compatNote === 'string' && m.compatNote.trim() !== '');
const firstNote = notedPub.length ? notedPub[0].compatNote : null;
check(!!firstNote && modsText.includes(firstNote),
  '公网渲染出的备注就是线上数据里那条（**从 /api/mods 现取，不比对写死的文案**）',
  firstNote ? `${firstNote.length} 字 · 出现 ${modsText.split(firstNote).length - 1} 次` : '线上没有带备注的兼容包');
check(!!firstNote && modsText.split(firstNote).length - 1 === 1,
  '公网渲染出的备注**只出现一次**（渲染层去重：两栏逐字相同时只画一遍）',
  firstNote ? `出现 ${modsText.split(firstNote).length - 1} 次` : '（无线索）');
check(!/链路实测/.test(modsText) && !/不发布/.test(modsText),
  '公网渲染出的备注不含「链路实测」「不发布」',
  (modsText.match(/.{0,14}(链路实测|不发布).{0,14}/) || ['（没有，符合预期）'])[0]);
const rawJson = JSON.stringify(modsJson);
check(!rawJson.includes('链路实测') && !rawJson.includes('不发布'),
  '线上公开数据 /api/mods 里也搜不到「链路实测」「不发布」');
const compatPub = modsJson.mods.filter((m) => m.kind === 'compat');
// 【2026-10-11 修「过时断言」· 数据漂移、不是产品 bug】备注：**不再比对写死的文案**。
//   原先写死「备注 == 那一句『兼容改写版：基于原投稿改写…』或 null」——
//   而 `a84e3a916517` 的备注已经**改成了另一段真实的「装前必读」长文**（那是内容，不是 bug）。
//   客户端也**不许**再出现旧的内部链路话术（那才是这一条当初要盯的东西）。
//   现在改成**结构断言**（口径来自 2026-10-11 那次「两栏逐字相同只画一次」的渲染层去重）：
//     · 两栏备注**渲染判据**逐条对（相同只画一次 / 不同两段都画 —— 见下面那条）；
//     · 没有哪条备注还是旧的『链路实测 / 不发布』话术；
//     · 至少一条有备注、至少一条没有 —— 两边都非空，断言才不是空转；
//     · /mods 渲染出来的那张卡里，**该条备注只出现一次** —— 这正是去重那条的回归位。
// 【2026-10-15 修「过时断言」· 数据漂移、不是产品 bug】
//   原来断言「两栏（note / compatNote）**逐字相同**」—— 那是**存储层**的惯例
//   （发布兼容包时把同一段文案同时写进两栏），**不是渲染层的判据**。渲染层的判据明文写着：
//   两栏都非空且相同 ⇒ 只画一次；**不同 ⇒ 两段都画**（不相同就不是重复，不许并掉）
//   —— `server.mjs:1491`。线上实测 39 条里有 4 条两栏不同：那 4 条的 `compatNote` 是站侧
//   2026-10-12 **事后更正**过的真值（「按实测改真值，见 revisions」），`note` 仍是更正前的
//   原文 ⇒ 「两栏不同」是**记录数据里的合法状态**，是断言本身过时了（产品行为没坏）。
//   现在改成对着**渲染层真正的判据**逐条验，全部从线上数据现算（两栏值都从 `/api/mods` 取）：
const noteKey = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const samePub = compatPub.filter((m) => noteKey(m.note) !== '' && noteKey(m.note) === noteKey(m.compatNote));
const diffPub = compatPub.filter((m) => noteKey(m.note) !== '' && noteKey(m.note) !== noteKey(m.compatNote));
const noteDrawBad = [];
for (const m of samePub) {
  const n = cardText(m).split(m.compatNote).length - 1;
  if (n !== 1) noteDrawBad.push(`${m.id}:两栏相同却画了 ${n} 次`);
}
for (const m of diffPub) {
  const t = cardText(m);
  const a = t.split(m.compatNote).length - 1, b = t.split(m.note).length - 1;
  if (a < 1 || b < 1) noteDrawBad.push(`${m.id}:两栏不同（compatNote ${a} 次 / note ${b} 次，两段都该画）`);
}
//   ⚠️ 防空转：两栏都有文案的记录**至少得有一条**（两栏全空时上面两个循环一次都不进，
//      断言就变成永真 —— 本文件其他地方也是这么防的）。
check(compatPub.length > 0 && samePub.length + diffPub.length > 0 && noteDrawBad.length === 0,
  `线上每条已发布兼容包的两栏备注**渲染判据**都对（共 ${compatPub.length} 条：两栏相同 ${samePub.length} 条 ⇒ 只画一次 · 两栏不同 ${diffPub.length} 条 ⇒ 两段都画）`,
  noteDrawBad.length ? noteDrawBad.join(' ')
    : `相同 ${samePub.length} 条 / 不同 ${diffPub.length} 条（有文案的共 ${samePub.length + diffPub.length} 条，非空转）`);
const compatWithNote = compatPub.filter((m) => typeof m.compatNote === 'string' && m.compatNote.trim() !== '');
const compatNoNote = compatPub.filter((m) => m.compatNote === null);
check(compatWithNote.length > 0,
  '线上至少有一条已发布兼容包**带备注**（备注这一路确实在发数据）',
  `带备注 ${compatWithNote.length} 条 / 共 ${compatPub.length} 条`);
check(compatNoNote.length > 0,
  '线上也至少有一条**没有备注**（没有备注是合法值，不是错）', `无备注 ${compatNoNote.length} 条`);
check(compatWithNote.every((m) => !/链路实测/.test(m.compatNote) && !/不发布/.test(m.compatNote)),
  '线上**没有任何一条**备注还在讲旧的内部链路话术（「链路实测」「不发布」）',
  compatWithNote.map((m) => `${m.id}:${/链路实测|不发布/.test(m.compatNote) ? 'STALE' : 'ok'}`).join(' '));
const modsCards = find(modsList, (n) => /panel/.test(String(n.className || '')));
// 【2026-10-15】这里原来另有一份「按 name 认卡」的 `cardTextOf` —— 已并入上面那份 `cardText`
//   （按身份行认卡）：按 name 认会被**备注里提到别人名字**的卡抢走，不如身份行稳。
for (const m of compatWithNote) {
  const t = cardText(m);
  const appears = t ? t.split(m.compatNote).length - 1 : 0;
  check(appears === 1,
    `公网 /mods 上「${m.name}」那张卡里，它那条备注**只出现一次**（渲染层去重：两栏相同时只画一遍）`,
    `出现 ${appears} 次 · 备注 ${m.compatNote.length} 字`);
}
check(compatWithNote.length === 0 || modsCards.length >= compatWithNote.length,
  '公网 /mods 上确实画出了那些带备注的卡（卡片数 ≥ 带备注的条数）',
  `卡片 ${modsCards.length} 张 · 带备注 ${compatWithNote.length} 条`);
// 原来的「至少有一条带着那句新文案」仍然要成立，但**不把那句话写死**：
//   它现在从线上数据里现取（哪条带备注就取哪条），断言的是「那条备注真的画到了页面上」。
const anyNoted = compatWithNote[0];
check(!!anyNoted && cardText(anyNoted).includes(anyNoted.compatNote),
  '线上带备注的那条，备注真的画到了公网页上（备注改写的目标记录确实改到了）',
  anyNoted ? `${anyNoted.id} · ${anyNoted.compatNote.length} 字` : '线上没有带备注的兼容包');
// 【2026-10-11 业主第四件事】那两个真素材路径的包经逐条人工确认后上线 ——
// 公网页上必须**真的能看见**它们（不是只在接口里存在）。
// 【2026-10-15 修「过时断言」· 数据漂移、不是产品 bug】
//   原来把两个包名**写死**（`ave-mujica 1.1.0` / `makoto-yuki 1.0.1`）—— 前一个**已被新版
//   取代下架**（公开面按「记录」列，取代后旧的那条不再列出 ⇒ `/api/mods` 里已经没有它），
//   于是断言因为「某条记录不在了」而红。要盯的从来不是那两个名字，而是
//   「**接口里有的，页面上真的看得见**」这件事本身。现在按公开面**逐条**验 name 有没有画出来 ——
//   数据怎么变（加新包 / 旧包被取代）都该绿，除非真的「接口有、页面没有」。
const notDrawn = modsJson.mods.filter((m) => !modsText.includes(m.name));
check(modsJson.mods.length > 0 && notDrawn.length === 0,
  `公网 /mods 上把公开面**每一条**都画出来了（逐条比对 name，共 ${modsJson.mods.length} 条）`,
  notDrawn.length ? `接口里有、页面没画：${notDrawn.map((m) => m.id).join(' ')}` : '逐条都在');
check(modsJson.mods.length >= 5, `线上公开主列表至少 5 条（本轮 3 → 5）`, `mods=${modsJson.mods.length} · flagged=${modsJson.flagged.length}`);

// ---------------------------------------------------------------- 线上 /mods：普通投稿的「原作者」
// 【2026-10-11 补】普通投稿的 `author` 记录里**没有**这一栏，站点是**读的时候**从包内
// `pack.json` 现读的（推导，不回写记录；`authorSource:'pack.json'`，与兼容包预填同一个口径）。
// 这一段喂的还是**线上 /mods 实际发出的那段字节** + **线上真实的 /api/mods 响应**，
// 断言全部**从线上数据现推**，不写死任何一条记录的名字或作者 —— 数据变了它照样该绿。
// 三条边界：
//   ① 普通投稿有作者 ⇒ 署名框画出来、写的就是那个名字，且**没有**「兼容改写者」那一栏、
//      没有「兼容改写版」徽标、没有「由投稿 … 改写来」那一行（普通投稿没有兼容这回事）；
//   ② 普通投稿没作者（author=null）⇒ 连「原作者」这个标签都不画（现行为不变）；
//   ③ 同一页上的兼容包**照旧三样齐全**（原作者 + 兼容改写者 + compatOf 有值时的「由投稿 … 改写来」）。
// 【2026-10-15】认卡的 `ownCard` / `cardText` / `sigboxOf` 已在上面「线上 /mods：备注」那一段
//   之前定义（**本文件只有那一份**），这里不再重定义第二份。
const plainPub = modsJson.mods.filter((m) => m.kind !== 'compat');
const plainWithAuthor = plainPub.filter((m) => typeof m.author === 'string' && m.author.trim() !== '');
const plainNoAuthor = plainPub.filter((m) => m.author == null);
console.log(`  · 公网普通投稿 ${plainPub.length} 条：带原作者 ${plainWithAuthor.length} 条 / 无作者 ${plainNoAuthor.length} 条`);
check(plainWithAuthor.length > 0,
  '线上至少有一条**普通投稿**带着原作者（有值才谈得上渲染对不对）',
  plainWithAuthor.map((m) => `${m.id}:${m.author}`).join(' ') || '（一条都没有）');
check(plainPub.every((m) => m.author == null || m.authorSource === 'pack.json'),
  '普通投稿的作者只有一个来源：包内 `pack.json`（不造第二套口径）',
  plainPub.map((m) => `${m.id}:${JSON.stringify(m.authorSource)}`).join(' '));
for (const m of plainWithAuthor) {
  // 署名框那两条只看 `sigbox` 这个元素（理由见 `sigboxOf` 的注释）：整张卡的文本里还混着
  // 备注正文，备注措辞一变就会把断言带红。
  const box = sigboxOf(m);
  const bt = box ? textOf(box).join(' ') : '';
  check(!!box && /原作者/.test(bt) && bt.includes(m.author),
    `公网 /mods 上普通投稿 ${m.id} 的署名框**画出来了**，写的是「原作者 ${m.author}」`,
    bt ? bt.replace(/\s+/g, ' ').slice(0, 96) : '（卡里没有 sigbox）');
  check(!!box && !/兼容改写者/.test(bt),
    `并且**没有**「兼容改写者」那一栏（${m.id}：普通投稿没有兼容这回事）`);
  const t = cardText(m);
  check(!!t && !/兼容改写版|兼容版/.test(t) && !/由投稿/.test(t),
    `也没有「兼容改写版」徽标、没有「由投稿 … 改写来」那一行（${m.id}）`);
}
// 【2026-10-15 修「过时断言」· 数据漂移、不是产品 bug】
//   原来拿**整张卡的文本**搜「原作者」三个字 —— 而这 4 条的备注正文里本来就写着
//   「原作者：jingjiangze · 许可：GPL-3.0-or-later」（站侧 2026-10-12 更正过的说明），
//   记录自己的 `author` 栏仍是 null、署名框**确实整块没画** ⇒ 断言因为备注**措辞**变了而红。
//   要盯的是**署名框这个元素在不在**，不是「卡里有没有这三个字」。现在只看 `sigbox`。
for (const m of plainNoAuthor) {
  const box = sigboxOf(m);
  check(!box,
    `包内没写作者的普通投稿 ${m.id}：署名框**整块不画**（卡里没有 sigbox 这个元素）`,
    `记录 author=${JSON.stringify(m.author)} · 卡里 sigbox=${box ? '有（不该有）' : '没有'}`);
}
const compatOnPage = modsJson.mods.filter((m) => m.kind === 'compat');
const compatSigOk = compatOnPage.filter((m) => m.author || m.compatAuthor !== null);
check(compatSigOk.length > 0 && compatSigOk.every((m) => {
  const t = cardText(m);
  return /原作者/.test(t) && /兼容改写者/.test(t) && (!m.compatOf || t.includes(`由投稿 ${m.compatOf} 改写来`));
}), `同一页上的兼容包**照旧三样齐全**（原作者 + 兼容改写者 + 有 compatOf 就有「由投稿 … 改写来」，共 ${compatOnPage.length} 条）`,
  compatSigOk.map((m) => { const t = cardText(m); return `${m.id}:${/原作者/.test(t) ? 'A' : '-'}${/兼容改写者/.test(t) ? 'C' : '-'}${!m.compatOf || t.includes(`由投稿 ${m.compatOf} 改写来`) ? 'L' : '-'}`; }).join(' '));

// ================================================================
// ④ **写依赖**断言 —— 只在副本实例上跑（SP_LIVE_COPY=1）
//
// 这几条**本质上必须写**才能验，所以生产上一条都不发，全部挪到副本：
//   · /hide 真写盘后的返回（changed:true / hidden:true）与幂等（changed:false 不留第二笔）
//   · /list 里真的带着 hidden:true（服务端**读盘**那一路，不是内存合成）
//   · 勾上之后三个视图真的都不见（服务端 /list 真的变了）
//   · 坏形状（ids 一批 / id 数组 / 不存在的 id）→ 400 / 400 / 404，且**一条都没写盘**
//   · 隐藏期间 /api/mods 与 /mods 字节不变（真在隐藏状态下取的）
//   · 取消勾选 ⇒ 真的写回 hidden:false（**可逆**）
// ================================================================
if (process.env.SP_LIVE_COPY !== '1') {
  console.log('\n④ 写依赖断言（副本实例）：**跳过** —— 没给 SP_LIVE_COPY=1。'
    + '生产上一条写请求都不会发（本次运行所有非 GET 请求都被保险拦着）。');
} else if (!prodSnap0) {
  check(false, `副本实例：读不到生产数据目录 ${PROD_DATA}（SP_LIVE_DATA_DIR 指对了吗？）`);
} else {
  console.log(`\n④ 写依赖断言（**仅副本**）：把 ${PROD_DATA} 拷到临时目录 ⇒ 起临时实例 ⇒ 在副本上写`);
  const tmp = mkdtempSync(join(tmpdir(), 'sp-live-copy-'));
  const dataDir = join(tmp, 'data');
  const port = Number(process.env.SP_LIVE_COPY_PORT || 25591);
  const copyBase = `http://127.0.0.1:${port}`;
  let child = null;
  let childLog = '';
  try {
    cpSync(PROD_DATA, dataDir, { recursive: true });
    writeFileSync(join(dataDir, COPY_SENTINEL), JSON.stringify({ copy: true, at: new Date().toISOString(), from: PROD_DATA }) + '\n');
    const verdict = classifyWriteTarget({ base: copyBase, dataDirHint: dataDir });
    check(!verdict.production, '副本目标过了保险（带哨兵 + 非生产端口 + 非生产主机）', verdict.reasons.join('；') || '无理由拒绝');
    if (verdict.production) throw new Error('副本目标被保险判为生产，不跑写路径');
    const copySnap0 = snapshotData(dataDir);
    const drift = diffSnapshot(prodSnap0, copySnap0, { ignoreFiles: true });
    check(drift.length === 0, '副本与生产**逐字节相同**（每条 sha256 + revisions 总数；多出的 1 个文件是副本哨兵）',
      drift.length ? drift.join(' ; ') : `副本 revisions=${copySnap0.revs}`);
    allowCopyBase(copyBase, dataDir);

    child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
      env: {
        ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
        ADMIN_TOKEN: TOKEN, ADMIN_PATH, BASE_URL: copyBase, MAX_MB: '100', ADMIN_IPS: '127.0.0.1', TRUST_PROXY: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b) => { childLog += b; });
    child.stderr.on('data', (b) => { childLog += b; });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
      try { up = (await liveFetch(`${copyBase}/healthz`)).ok; } catch { /* 还没起 */ }
      if (!up) await sleep(100);
    }
    check(up, `副本实例起来了（:${port}）`, up ? (childLog.split('\n').find((l) => l.includes('数据目录')) || '').trim() : childLog.slice(-300));
    // 前置断言：答话的必须是**从副本起的**那个实例（编排踩过一次：端口被 env 覆盖 ⇒ 又打到生产）
    check(up && new RegExp(`监听\\s+127\\.0\\.0\\.1:${port}`).test(childLog) && childLog.includes(`数据目录 ${dataDir}`),
      '答话的就是这个副本实例（启动日志里写着副本数据目录与端口 —— 前置断言，防端口被覆盖后又打到生产）');
    if (!up) throw new Error('副本实例没起来');
    const copyHtml = await (await admAt(copyBase, `/${ADMIN_PATH}`)).text();
    check(copyHtml === html, '副本发的审核页 HTML 与生产一字不差（同一份代码、同一份数据）');
    const copyList0 = await (await admAt(copyBase, `/api/${ADMIN_PATH}/list`)).json();
    check(JSON.stringify(copyList0) === JSON.stringify(listJson), '副本实例的 /list 与生产一字不差（**同一份数据**）');

    const t = listJson.submissions.find((s) => s.kind === 'compat' && s.hidden !== true)
      || listJson.submissions.find((s) => s.hidden !== true);
    if (!t) throw new Error('副本上没有可用来测勾选框的记录');
    console.log(`  · 在副本上写它：${t.id}（${t.name}）`);
    const hidePost = (body) => liveFetch(`${copyBase}/api/${ADMIN_PATH}/hide`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify(body),
    });
    const pubJson0 = JSON.stringify(await (await liveFetch(`${copyBase}/api/mods`)).json());
    const pubPage0 = await (await liveFetch(`${copyBase}/mods`)).text();

    const hide1 = await hidePost({ id: t.id, hidden: true });
    const hide1b = await hide1.json();
    check(hide1.status === 200 && hide1b.changed === true && hide1b.hidden === true,
      '【仅副本】勾上（真端点 · 一次一个 id）', `HTTP ${hide1.status} · changed=${hide1b.changed} hidden=${hide1b.hidden}`);
    const hide2 = await hidePost({ id: t.id, hidden: true });
    check((await hide2.json()).changed === false, '【仅副本】幂等：再勾一次 → changed:false（不写第二笔）');
    const listHid = await (await admAt(copyBase, `/api/${ADMIN_PATH}/list`)).json();
    check(listHid.submissions.find((s) => s.id === t.id)?.hidden === true,
      '【仅副本】/list 里这条带着 hidden:true（服务端**读盘**那一路）');
    const probeHid = await viewProbe(copyBase, listHid, t.id);
    for (const p of probeHid) {
      check(!p.threw && !p.visible,
        `【仅副本】线上「${p.label}」那一页：勾上之后**看不到它**（本页画了它吗：${p.drawn ? '画了但不显示' : '不属这页'}）`,
        `可见=${p.visible} · 已隐藏计数=${p.nHidden}`);
      check(p.sum === p.total,
        `【仅副本】线上「${p.label}」那一页：三页相加 + 已隐藏 = 全部`,
        `${p.sum} = ${p.total}（其中已隐藏 ${p.nHidden}）`);
    }
    check(probeHid.every((p) => p.nHidden === hidN(listHid.submissions)),
      '【仅副本】三页各自算出的「已隐藏」= 写盘之后的真实条数',
      `${probeHid.map((p) => `${p.label}:${p.nHidden}`).join(' ')}（真实 ${hidN(listHid.submissions)}）`);
    // 形状：绝不批量 / 不存在 404
    const batchLive = await hidePost({ ids: [t.id], hidden: true });
    check(batchLive.status === 400, '【仅副本】报文里带「一批」的形状（ids）→ 400（绝不批量）', `HTTP ${batchLive.status}`);
    const arrIdLive = await hidePost({ id: [t.id], hidden: true });
    check(arrIdLive.status === 400, '【仅副本】id 给了数组 → 400', `HTTP ${arrIdLive.status}`);
    const noSuch = await hidePost({ id: 'ffffffffffff', hidden: true });
    check(noSuch.status === 404, '【仅副本】不存在的 id → 404', `HTTP ${noSuch.status}`);
    const stillHid = await (await admAt(copyBase, `/api/${ADMIN_PATH}/list`)).json();
    check(stillHid.submissions.find((s) => s.id === t.id)?.hidden === true,
      '【仅副本】那一串坏形状**一条都没写盘**（这条仍然是勾上的那个值）');
    // 公开面不动（隐藏 ≠ 下架）—— 这一条**只在真隐藏着的副本上**才验得实
    const pubJson1 = JSON.stringify(await (await liveFetch(`${copyBase}/api/mods`)).json());
    const pubPage1 = await (await liveFetch(`${copyBase}/mods`)).text();
    check(pubJson1 === pubJson0, '【仅副本】隐藏期间 /api/mods 一个字节都没变（条数与下载地址一字不变）');
    check(pubPage1 === pubPage0, '【仅副本】隐藏期间 /mods 那一页也一个字都没变');
    // 「显示已隐藏」开关：**写盘之后**真去取一次
    const bShow = bootInline(copyHtml, {
      fetchImpl: async (u) => (String(u).endsWith('/list')
        ? { ok: true, status: 200, json: async () => listHid }
        : { ok: true, status: 200, json: async () => ({}) }),
    });
    await sleep(60);
    bShow.dom.byId.get('fHidden').checked = true;
    const rShow = bShow.sandbox.readFilter();
    const rowsShow = [...items(bShow.dom.byId.get('list')), ...items(bShow.dom.byId.get('alist')), ...items(bShow.dom.byId.get('rlist'))];
    check(rowsShow.some((li) => li.meta && li.meta.id === t.id && li.style.display !== 'none'),
      '【仅副本】勾上「显示已隐藏」→ 那条被隐藏的又看得见（就是给你取消勾选用的）',
      `可见的已隐藏 ${rShow.visibleHidden} 条`);
    // 取消勾选 ⇒ 回来（**可逆**）
    const un1 = await hidePost({ id: t.id, hidden: false });
    check((await un1.json()).hidden === false, '【仅副本】取消勾选：写回 hidden:false（**可逆**）');
    const listBack = await (await admAt(copyBase, `/api/${ADMIN_PATH}/list`)).json();
    const probeBack = await viewProbe(copyBase, listBack, t.id);
    const own = probeBack.find((p) => (t.kind === 'compat' ? p.view === 'approved' : p.view === 'main'))
      || probeBack.find((p) => p.drawn);
    check(!!own && probeBack.find((p) => p.view === own.view).visible,
      '【仅副本】取消勾选之后：它又出现在自己该在的那一页上',
      probeBack.map((p) => `${p.label}:可见=${p.visible}`).join(' · '));
    check(probeBack.every((p) => p.nHidden === hidN(listBack.submissions)),
      '【仅副本】取消之后「已隐藏」那一栏回到真实条数（不再因为测试而虚高）',
      probeBack.map((p) => `${p.label}:${p.nHidden}`).join(' '));
    check(JSON.stringify(await (await liveFetch(`${copyBase}/api/mods`)).json()) === pubJson0
      && await (await liveFetch(`${copyBase}/mods`)).text() === pubPage0,
      '【仅副本】一来一回之后，公开面仍是那串基准字节（全程没动过）');
    // 写**确实**发生了 —— 而且只落在副本的账本上
    const copySnap1 = snapshotData(dataDir);
    check(copySnap1.revs === copySnap0.revs + 2,
      '【仅副本】写确实发生了：副本账本 revisions +2（这就是**原来**会落到生产上的那 2 笔）',
      `副本 revisions ${copySnap0.revs} → ${copySnap1.revs}`);
    const keyT = [...copySnap1.shas.keys()].find((k) => k.endsWith(`/${t.id}/meta.json`) || k === `${t.id}/meta.json`);
    check(!!keyT && copySnap0.shas.get(keyT) !== copySnap1.shas.get(keyT),
      '【仅副本】副本里**那一条**的 meta.json 真的被改了（而且只有它）',
      keyT ? `${keyT}: ${String(copySnap0.shas.get(keyT)).slice(0, 12)}… → ${String(copySnap1.shas.get(keyT)).slice(0, 12)}…` : '没找到那条的 meta.json');
    check(diffSnapshot(prodSnap0, snapshotData(PROD_DATA)).length === 0,
      '【仅副本】此刻生产 DATA_DIR 仍与开跑前逐字节相同（写只落在副本上）');
  } catch (e) {
    check(false, '副本实例那一段没能跑完', `${e?.name}: ${e?.message}`);
  } finally {
    if (child) child.kill('SIGTERM');
    await sleep(150);
    rmSync(tmp, { recursive: true, force: true });
    console.log(`  · 副本已销毁（${tmp}）：${existsSync(tmp) ? '还在（异常，请看一眼）' : '已清掉'}`);
  }
}

// ================================================================
// ⑤ 验收核心自证：本次运行**没有**改动生产数据
// ================================================================
console.log('\n⑤ 验收核心自证：本次运行前后，生产 DATA_DIR 逐字节未变');
const prodSnap1 = snapshotData(PROD_DATA);
if (!prodSnap0 || !prodSnap1) {
  console.log(`  · （读不到 ${PROD_DATA}：这条自证跳过 —— 在服务器上跑才会生效）`);
} else {
  const drift = diffSnapshot(prodSnap0, prodSnap1);
  check(drift.length === 0,
    `生产 ${prodSnap1.meta} 条 meta.json 的 sha256 与 revisions 总数（${prodSnap1.revs}）一字未变`,
    drift.length ? drift.join(' ; ') : `meta=${prodSnap1.meta} · revisions=${prodSnap1.revs} · 文件=${prodSnap1.files}`);
  check(prodSnap1.revs === prodSnap0.revs, 'revisions 总笔数没涨（一次运行不再产生任何新历史）',
    `${prodSnap0.revs} → ${prodSnap1.revs}`);
}

console.log('');
if (failures) { console.log(`✖ ${failures} 项没通过`); process.exit(1); }
console.log('✔ 线上那一份审核台（**只读**）：脚本跑到底 · 筛选真的减少可见条数 · 清空恢复 · 计数显示'
  + '（三页相加 + 已隐藏 = 全部）· 每条记录一个「不再显示」勾选框（合成「已隐藏」那一份 ⇒ 三视图都不见；'
  + '真实那一份 ⇒ 回来）· /mods 备注结构（两栏**渲染判据** · 不含旧链路话术 · 渲染层只画一次）'
  + '· 公开面逐条都画在页面上 · 生产数据一字未变');
