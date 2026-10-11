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
check(all.length === listJson.submissions.length,
  `线上真实列表全画出来了（${all.length} 条 = 服务端 ${listJson.submissions.length} 条）`);
check(vis() === all.length, '默认视图一条都没藏', `可见 ${vis()} / ${all.length}`);

// 关键字：拿线上真实记录里一个唯一片段来筛
const sample = listJson.submissions.find((s) => (s.name || '').includes('皮肤选择器'));
if (sample) {
  dom.byId.get('fKey').value = '皮肤选择器';
  const r = sandbox.readFilter();
  check(vis() >= 1 && r.visible === vis(), `关键字「皮肤选择器」筛出 ${vis()} 条（线上确有这条）`);
  dom.byId.get('fClear').onclick();
  check(vis() === all.length, '清空筛选 → 恢复全部');
}
// 区域：compat 那一组
dom.byId.get('fArea').value = 'compat';
const rArea = sandbox.readFilter();
const compatN = listJson.submissions.filter((s) => s.kind === 'compat').length;
check(rArea.visible === vis() && vis() === compatN,
  `区域=compat → 可见 ${vis()} 条（线上 compat 共 ${compatN} 条）`,
  String(dom.byId.get('fCounts')?.textContent || ''));
check(/compat/.test(html) && /fCounts/.test(html), '线上页面上确实是带筛选控件的那一版（不是部署前的旧文件）');

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
  check(rr.nMain + rr.nApproved + rr.nRejected === listJson.submissions.length,
    `线上「${label}」那一页：三页计数之和 = 线上记录总数`,
    `${rr.nMain} + ${rr.nApproved} + ${rr.nRejected} = ${rr.nMain + rr.nApproved + rr.nRejected}（线上 ${listJson.submissions.length}）`);
}
const badLive = await adm(`/${ADMIN_PATH}?view=nope`);
check(badLive.status === 404, '线上 view 不在白名单里 → 404（不悄悄回落到主列表）', `HTTP ${badLive.status}`);

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
console.log('✔ 线上那一份审核台：脚本跑到底 · 筛选真的减少可见条数 · 清空恢复 · 计数显示 · /mods 备注是新文案');
