// 审核台「线上那一份页面」的桩测试（**默认跳过**；要它跑，必须显式给地址与令牌）。
//
//   SP_LIVE_BASE=http://127.0.0.1:25570 SP_LIVE_ADMIN=review-2228 SP_LIVE_TOKEN=... node site/selftest-live-admin.mjs
//
// 为什么单独一个文件、还不进默认测试：`selftest-admin.mjs` 是**自足**的（自己起服务、
// 自己造数据、跑完就删），任何人 clone 下来都能跑。这条不一样 —— 它打的是**真实部署**，
// 内网/没部署的地方跑了必然红，所以必须显式开（没给环境变量就打印「跳过」并退 0）。
//
// 它治的是「桩里过了、线上那份页面还是死的」这一类：这里喂进去的 HTML 是**服务器实际发出的那一段字节**
// （与部署产物同源），列表数据是**线上真实的 `/list` 响应**，不是造出来的。
// 上次那个 TDZ 事故就是「接口好、页面死」，靠自足测试与线上字节两处都过才算数。
import vm from 'node:vm';

const BASE = process.env.SP_LIVE_BASE;
const ADMIN_PATH = process.env.SP_LIVE_ADMIN || 'admin';
const TOKEN = process.env.SP_LIVE_TOKEN;
if (!BASE || !TOKEN) {
  console.log('（跳过：没有给 SP_LIVE_BASE / SP_LIVE_TOKEN —— 这条只对真实部署有意义）');
  process.exit(0);
}

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const adm = (p) => fetch(`${BASE}${p}`, { headers: { 'x-admin-token': TOKEN } });

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

// 关键字：拿线上真实记录里一个唯一片段来筛
const sample = listJson.submissions.find((s) => (s.name || '').includes('皮肤选择器'));
if (sample) {
  dom.byId.get('fKey').value = '皮肤选择器';
  const r = sandbox.readFilter();
  check(vis() >= 1 && r.visible === vis(), `关键字「皮肤选择器」筛出 ${vis()} 条（线上确有这条）`);
  dom.byId.get('fClear').onclick();
  check(vis() === all.length - liveHidden, '清空筛选 → 恢复（仍然只剩已隐藏的那些不显示）');
}
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
const liveRows = [...items(ul), ...items(al), ...items(rl)];
const liveBoxes = liveRows.map((li) => find(li, (n) => n.tagName === 'input' && n.type === 'checkbox')[0] || null);
check(liveBoxes.length === liveRows.length && liveBoxes.every(Boolean),
  `线上**每一行**都画出了勾选框（${liveBoxes.filter(Boolean).length} / ${liveRows.length} 行）`);
check(liveRows.every((li) => /不再显示（已由兼容包取代）/.test(textOf(li).join(' '))),
  '线上文案就是「不再显示（已由兼容包取代）」');
check(liveBoxes.every((b) => b.checked === false), '线上默认一个都没勾上（谁也不许被悄悄藏起来）',
  `checked 的个数 ${liveBoxes.filter((b) => b.checked).length}`);
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

// ---------------------------------------------------------------- 线上「不再显示」勾选框
// 业主 2026-10-11：「有可能 mod 名字和兼容后的名字不一样，导致依旧存在两个 mod（一个在兼容，
// 一个在上传待定），所以给我一个勾选框，选后就不显示这个 mod 了」。
// 这里打的是**真实部署**：真端点、真记录、真三个视图、真计数；**跑完把勾取消掉恢复原状**。
console.log('\n线上「不再显示」勾选框：勾上 ⇒ 三个视图都不见 · 取消 ⇒ 回来 · 计数对得上');
const hidePost = (body) => fetch(`${BASE}/api/${ADMIN_PATH}/hide`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
  body: JSON.stringify(body),
});
/** 把三个视图各拿一份**线上真实 HTML**，喂真 /list，返回「这次可见的行里有没有它」+ 计数。 */
async function viewProbe(listData, id) {
  const out = [];
  for (const [view, label] of [['main', '待审'], ['approved', '已通过'], ['rejected', '已打回']]) {
    const url = view === 'main' ? `/${ADMIN_PATH}` : `/${ADMIN_PATH}?view=${view}`;
    const r = await adm(url);
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
const target = listJson.submissions.find((s) => s.kind === 'compat' && s.hidden !== true)
  || listJson.submissions.find((s) => s.hidden !== true);
if (!target) {
  check(false, '线上没有可用来测勾选框的记录（难道全被隐藏了？）');
} else {
  console.log(`  用它测：${target.id}（${target.name}）`);
  const pubJson0 = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const pubPage0 = await (await fetch(`${BASE}/mods`)).text();
  const hide1 = await hidePost({ id: target.id, hidden: true });
  const hide1b = await hide1.json();
  check(hide1.status === 200 && hide1b.changed === true && hide1b.hidden === true,
    '勾上（线上真端点 · 一次一个 id）', `HTTP ${hide1.status} · ${JSON.stringify({ changed: hide1b.changed, hidden: hide1b.hidden })}`);
  const hide2 = await hidePost({ id: target.id, hidden: true });
  check((await hide2.json()).changed === false, '幂等：再勾一次 → changed:false（不写第二笔）');
  const listHid = await (await adm(`/api/${ADMIN_PATH}/list`)).json();
  check(listHid.submissions.find((s) => s.id === target.id)?.hidden === true, '线上 /list 里这条带着 hidden:true');
  const probeHid = await viewProbe(listHid, target.id);
  for (const p of probeHid) {
    check(!p.threw && !p.visible,
      `线上「${p.label}」那一页：勾上之后**看不到它**（本页画了它吗：${p.drawn ? '画了但不显示' : '不属这页'}）`,
      `可见=${p.visible} · 已隐藏计数=${p.nHidden}`);
    check(p.sum === p.total,
      `线上「${p.label}」那一页：三页相加 + 已隐藏 = 全部`,
      `${p.sum} = ${p.total}（其中已隐藏 ${p.nHidden}）`);
  }
  check(probeHid.reduce((n, p) => n + p.nHidden, 0) === 3 && probeHid.every((p) => p.nHidden === 1),
    '线上三页都算出了「已隐藏 1」（同一份 /list，三页各算一遍）',
    probeHid.map((p) => `${p.label}:${p.nHidden}`).join(' '));
  // 形状：绝不批量 / 不存在 404
  const batchLive = await hidePost({ ids: [target.id], hidden: true });
  check(batchLive.status === 400, '线上：报文里带「一批」的形状（ids）→ 400（绝不批量）', `HTTP ${batchLive.status}`);
  const arrIdLive = await hidePost({ id: [target.id], hidden: true });
  check(arrIdLive.status === 400, '线上：id 给了数组 → 400', `HTTP ${arrIdLive.status}`);
  const noSuch = await hidePost({ id: 'ffffffffffff', hidden: true });
  check(noSuch.status === 404, '线上：不存在的 id → 404', `HTTP ${noSuch.status}`);
  const stillHid = await (await adm(`/api/${ADMIN_PATH}/list`)).json();
  check(stillHid.submissions.find((s) => s.id === target.id)?.hidden === true,
    '那一串坏形状**一条都没写盘**（这条仍然是勾上的那个值）');
  // 公开面不动（隐藏 ≠ 下架）
  const pubJson1 = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const pubPage1 = await (await fetch(`${BASE}/mods`)).text();
  check(pubJson1 === pubJson0, '隐藏期间**线上 /api/mods 一个字节都没变**（条数与下载地址一字不变）');
  check(pubPage1 === pubPage0, '隐藏期间线上 /mods 那一页也一个字都没变');
  // 「显示已隐藏」开关：勾上能看见（便于取消勾选）
  const bShow = bootInline(html, {
    fetchImpl: async (u) => (String(u).endsWith('/list')
      ? { ok: true, status: 200, json: async () => listHid }
      : { ok: true, status: 200, json: async () => ({}) }),
  });
  await sleep(60);
  bShow.dom.byId.get('fHidden').checked = true;
  const rShow = bShow.sandbox.readFilter();
  const rowsShow = [...items(bShow.dom.byId.get('list')), ...items(bShow.dom.byId.get('alist')), ...items(bShow.dom.byId.get('rlist'))];
  check(rShow.visibleHidden === 1 && rowsShow.some((li) => li.meta && li.meta.id === target.id && li.style.display !== 'none'),
    '勾上「显示已隐藏」→ 线上那条被隐藏的又看得见（就是给你取消勾选用的）',
    `可见的已隐藏 ${rShow.visibleHidden} 条`);
  // 取消勾选 ⇒ 回来（**可逆**）
  const un1 = await hidePost({ id: target.id, hidden: false });
  check((await un1.json()).hidden === false, '取消勾选：写回 hidden:false（**可逆**）');
  const listBack = await (await adm(`/api/${ADMIN_PATH}/list`)).json();
  const probeBack = await viewProbe(listBack, target.id);
  const own = probeBack.find((p) => (target.kind === 'compat' ? p.view === 'approved' : p.view === 'main'))
    || probeBack.find((p) => p.drawn);
  check(!!own && probeBack.find((p) => p.view === own.view).visible,
    '取消勾选之后：它又出现在自己该在的那一页上',
    probeBack.map((p) => `${p.label}:可见=${p.visible}`).join(' · '));
  check(probeBack.every((p) => p.nHidden === hidN(listBack.submissions)),
    '取消之后「已隐藏」那一栏回到线上的真实条数（不再因为测试而虚高）',
    probeBack.map((p) => `${p.label}:${p.nHidden}`).join(' '));
  check(JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json()) === pubJson0
    && await (await fetch(`${BASE}/mods`)).text() === pubPage0,
    '一来一回之后，线上公开面仍是那串基准字节（全程没动过）');
}

// ---------------------------------------------------------------- 线上 /mods：备注文案
// 业主 2026-10-11：那三条已上线的兼容包，公网页备注留的还是上传时那句内部链路实测的话
// （「兼容包入口链路实测：只上传，不通过、不发布。」）—— 它们**已经发布**，那句话在公网上是假的。
// 这里喂进去的是**线上 /mods 实际发出的那段字节** + **线上真实的 /api/mods 响应**，
// 断言「渲染出来的备注是新文案，且不含『链路实测』『不发布』」—— 不是拿造的数据自证。
const NOTE_NEW = '兼容改写版：基于原投稿改写，原作者署名与许可原样保留。';
const modsPage = await fetch(`${BASE}/mods`);
const modsHtml = await modsPage.text();
const modsJson = await (await fetch(`${BASE}/api/mods`)).json();
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
check(modsText.includes(NOTE_NEW), '公网渲染出的备注是新文案（正文里能看到）',
  (modsText.match(/.{0,10}兼容改写版.{0,22}/) || ['（没找到）'])[0]);
check(!/链路实测/.test(modsText) && !/不发布/.test(modsText),
  '公网渲染出的备注不含「链路实测」「不发布」',
  (modsText.match(/.{0,14}(链路实测|不发布).{0,14}/) || ['（没有，符合预期）'])[0]);
const rawJson = JSON.stringify(modsJson);
check(!rawJson.includes('链路实测') && !rawJson.includes('不发布'),
  '线上公开数据 /api/mods 里也搜不到「链路实测」「不发布」');
const compatPub = modsJson.mods.filter((m) => m.kind === 'compat');
// 线上备注只允许两种状态：**这句正常文案**，或者**没有备注**（null）。
// 绝不允许再出现旧那句内部链路实测的话 —— 那才是这一条要盯的东西。
check(compatPub.length > 0 && compatPub.every((m) => m.note === m.compatNote),
  `线上每条已发布兼容包的两栏备注都一致（共 ${compatPub.length} 条）`,
  compatPub.map((m) => `${m.id}:${m.note === m.compatNote ? 'ok' : 'MISMATCH'}`).join(' '));
check(compatPub.length > 0 && compatPub.every((m) => m.note === NOTE_NEW || m.note === null),
  `线上每条已发布兼容包的备注都是「新文案」或「没有备注」（共 ${compatPub.length} 条）`,
  compatPub.map((m) => `${m.id}:${m.note === NOTE_NEW ? '新文案' : (m.note === null ? '无备注' : 'CHE?')}`).join(' '));
check(compatPub.some((m) => m.note === NOTE_NEW),
  '线上至少有一条带着那句新文案（备注改写的目标记录确实改到了）');
// 【2026-10-11 业主第四件事】那两个真素材路径的包经逐条人工确认后上线 ——
// 公网页上必须**真的能看见**它们（不是只在接口里存在）。
for (const nm of ['ave-mujica 1.1.0', 'makoto-yuki 1.0.1']) {
  check(modsText.includes(nm), `公网 /mods 上画出了「${nm}」`,
    modsJson.mods.some((m) => m.name === nm) ? '接口里有 · 页面渲染里也有' : '接口里就没有');
}
check(modsJson.mods.length >= 5, `线上公开主列表至少 5 条（本轮 3 → 5）`, `mods=${modsJson.mods.length} · flagged=${modsJson.flagged.length}`);

console.log('');
if (failures) { console.log(`✖ ${failures} 项没通过`); process.exit(1); }
console.log('✔ 线上那一份审核台：脚本跑到底 · 筛选真的减少可见条数 · 清空恢复 · 计数显示（三页相加 + 已隐藏 = 全部）· '
  + '每条记录一个「不再显示」勾选框（勾上三视图都不见、取消就回来）· /mods 备注是新文案');
