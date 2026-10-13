// 审核台页面自测（不起浏览器、不联网、不部署）：**专治「页面停在『还没载入。』」这一类**。
//
//   node site/selftest-admin.mjs
//
// 为什么要有这个文件：审核台是**一整个内联 <script>**。脚本只要在顶层抛一次错，
// 后面所有的 `onclick` 赋值与自动载入那一段就**全都没执行** —— 页面既不报错也不崩，
// 就是永远停在 HTML 里那句「还没载入。」，点按钮也没反应。浏览器里看不到，接口也是好的。
// （2026-10-11 真发生过一次：`const` 声明写在它被使用之后 → TDZ ReferenceError。）
//
// 所以这里不测「服务端对不对」，而是把**服务器实际发出来的那份 HTML**里的内联脚本，
// 配上一份**真实的** list 响应，塞进最小 DOM 桩里跑一遍，然后断言：
//   ① 顶层没抛错；② 该挂的 onclick 都挂上了；③ 列表真的画出来、条数与磁盘一致；
//   ④ 页面上没有任何 `Mo233` 预填（「兼容者」必填但可空，空 = 未填）；
//   ⑤ 「上传我改好的兼容包并发布」的表单能构造出来，且兼容者那一栏**是空的**；
//   ⑥ 投稿详情页（下载那一行）有那个**独立的上传按钮**，点开发布走的是一次到位的 `publish=1`；
//   ⑦ 公网 /mods 上，compatOf 有值时多画一行「由投稿 … 改写来」（带 id），为空时**整行不画**。
//
//   ⑦b 公网 /mods 的**渲染层去重**：两栏（`compatNote` 与 `note`）逐字相同 ⇒ 只画一次。
//   存储层「发布时把同一段文案同时写进两栏」是有意为之（本页不动它），重复是**渲染层**的事。
//   2026-10-11 业主裁令 (a)：去重只做在渲染层，存储层与任何 `meta.json` 一个字节不动。
//
// 2026-10-11 口径变更（业主）：管理界面里**不再有**独立的「兼容包」区/列表/页面，
// 入口只剩投稿详情页下载按钮那一行的**一个独立上传按钮**（选 zip → 填名 → 点发布 = 上传+通过+发布）。
// 于是本文件里两条相关断言**原地改语义**（不是删掉）：见下面「①」那一段里的注释。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8809;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'admin-selftest-token-0123456789';
const ADMIN_PATH = 'review-selftest-admin';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 最小 DOM 桩
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
/** 把一棵假 DOM 树里所有文字收成一个字符串（看不到树也能断言「页面上写了什么」）。 */
function textOf(n, out = []) {
  if (!n || typeof n !== 'object') return out;
  if (n.isText) { out.push(n.text); return out; }
  if (n.textContent) out.push(String(n.textContent));
  for (const c of (n.children || [])) textOf(c, out);
  return out;
}
/** 在假 DOM 树里按条件找节点。 */
function find(n, pred, out = []) {
  if (!n || typeof n !== 'object' || n.isText) return out;
  if (pred(n)) out.push(n);
  for (const c of (n.children || [])) find(c, pred, out);
  return out;
}

/**
 * 把一份 HTML 里的内联脚本跑起来。
 * @param {{fetchImpl: Function, beforeAsync?: Function}} opts
 *   beforeAsync：可选。内联脚本最后有一段 async IIFE 要等一次 await 才会载入列表；
 *   这个回调在**同步阶段末尾**被调一次 —— 也就是「列表还没载入」那一刻（筛选测试要用它
 *   把关键字打在自动载入之前，这样断言的是自动载入那一路的结果，而不是手动调一次）。
 * @returns {{threw: Error|null, dom: object, sandbox: object}}
 */
function bootInline(html, { fetchImpl, beforeAsync }) {
  const m = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) throw new Error('页面里没有内联脚本');
  const dom = makeDom();
  const sandbox = {
    document: dom.document, console,
    sessionStorage: { getItem: () => '', setItem() {}, removeItem() {} },
    location: { href: `${BASE}/${ADMIN_PATH}` },
    fetch: fetchImpl,
    alert() {}, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    // ⭐ 2026-10-14：admin.html 的上传那一路新增了 `AbortController` 兜底时限与走秒进度
    //    （浏览器自带这两个东西）。桩也必须提供，否则「点上传并发布」会 ReferenceError ——
    //    那不是页面坏了，是**桩缺件**。（实测踩过：没加这一行，selftest-admin 红在 AbortController。）
    AbortController,
    Blob: class {}, TextDecoder, TextEncoder,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__beforeAsync = () => { if (beforeAsync) beforeAsync(dom, sandbox); };
  // 「自动载入」那一段是个 async IIFE，紧跟一个 .catch()。用「.catch() + })();」这对锚点
  // 把它单独找出来（**不是**找文件末尾那个 —— 文件末尾是 detail() 的定义），
  // 在它执行之前插一次 __beforeAsync()：这样能测「维护者先敲了关键字、自动载入才回来」那一路。
  let src = m[1];
  if (beforeAsync) {
    // 把「自动载入」那一段 async IIFE 摘出来当成函数，先跑 __beforeAsync() 再催动它 ——
    // 这样桩能测「维护者先敲了关键字、自动载入才回来」那一路（真实浏览器里也走同一条代码路径）。
    // 变形：`(async () => { const r = await fetch(API + '/list');` → `async function __autoLoad() { ... }`
    const head = "(async () => {";
    const i = src.indexOf(head);
    if (i < 0) throw new Error('找不到自动载入那一段的开头锚点');
    src = src.slice(0, i) + "async function __autoLoad() {" + src.slice(i + head.length);
    // 结尾：`})();` → `}\n__beforeAsync();\n__autoLoad();`（函数声明与调用都在同一个块作用域里）
    const j = src.indexOf('})();', src.indexOf('.catch()'));
    if (j < 0) throw new Error('找不到自动载入那一段的结束锚点');
    src = src.slice(0, j) + '}\n__beforeAsync();\n__autoLoad();' + src.slice(j + '})();'.length);
  }
  let threw = null;
  try { vm.runInNewContext(src, sandbox, { filename: 'inline.js' }); }
  catch (e) { threw = e; }
  return { threw, dom, sandbox };
}

// ---------------------------------------------------------------- 起服务（临时数据目录）
const dataDir = mkdtempSync(join(tmpdir(), 'sp-admin-'));
for (const d of ['submissions', 'flagged', 'compat']) mkdirSync(join(dataDir, d), { recursive: true });

// 直接往磁盘上摆几条记录：这一条测的是**页面**，不是上传流程（上传那条另有一个 selftest）。
const meta = (o) => JSON.stringify({ size: 1234, sha256: 'x'.repeat(64), uploadedAt: '2026-10-11T00:00:00.000Z',
  ip: '127.0.0.1', entries: 1, unpackedBytes: 10, flags: [], suspected: false, ...o }, null, 2);
const put = (area, id, o) => {
  mkdirSync(join(dataDir, area, id), { recursive: true });
  writeFileSync(join(dataDir, area, id, 'meta.json'), meta(o));
};
put('submissions', 'aaaa1111bbbb', { id: 'aaaa1111bbbb', area: 'normal', name: '普通投稿甲' });
put('submissions', 'cccc2222dddd', { id: 'cccc2222dddd', area: 'normal', name: '普通投稿乙' });
// 一条**兼容者未填**的兼容包 —— 页面必须如实显示「未填」，且绝不冒出 Mo233。
// 这条**带 compatOf**（由普通投稿甲 aaaa1111bbbb 改写来）：公网 /mods 页要据此多画一行
// 「由投稿 aaaa1111bbbb 改写来」。业主 2026-10-11 批准加的就是这一行。
put('compat', 'eeee3333ffff', {
  id: 'eeee3333ffff', area: 'compat', kind: 'compat', name: '兼容包（兼容者未填）',
  author: '原作者甲', compatAuthor: '', compatAuthorSource: 'empty',
  compatOf: 'aaaa1111bbbb',
});
// 它得是「已通过」才会出现在公网 /api/mods 那一页上。
writeFileSync(join(dataDir, 'compat', 'eeee3333ffff', 'decision.json'),
  JSON.stringify({ decision: 'approved', reason: null, at: '2026-10-11T00:00:01.000Z', by: 'admin',
    author: '原作者甲', compatAuthor: '' }, null, 2));

// ---- 筛选测试要用的几条（都在**列表显示层**，与上传/审核流程无关）：
//   · 一条 flagged（area='flagged'）+ blocker  → 区域与档位两条筛选都要能单独捞出它；
//   · 一条已打回（decision.decision='rejected'）→ 状态筛选要有「已打回」这一档可捞；
//   · 再一条兼容包，名字里没有关键字、也没有 blocker → 无档位筛选要用到它。
put('flagged', 'ffff4444aaaa', {
  id: 'ffff4444aaaa', area: 'flagged', name: '疑似素材甲', suspected: true, suspectedReasons: ['GAME_ASSET'],
  flags: [{ level: 'blocker', code: 'GAME_ASSET', text: '疑似官方素材' }],
});
put('submissions', 'abcd5555eeee', { id: 'abcd5555eeee', area: 'normal', name: '被退回的投稿丙' });
writeFileSync(join(dataDir, 'submissions', 'abcd5555eeee', 'decision.json'),
  JSON.stringify({ decision: 'rejected', reason: '测试用', at: '2026-10-11T00:00:02.000Z', by: 'admin' }, null, 2));
put('compat', 'dddd6666eeee', {
  id: 'dddd6666eeee', area: 'compat', kind: 'compat', name: '另一个兼容包',
  author: '原作者乙', compatAuthor: '维护者乙', compatAuthorSource: 'form',
});
// 一条**已被兼容包取代**的投稿（业主 B 口径）：列表里照样看得见（可追溯、含「被哪条取代」），
// 但它已经**不在待审队列**里了 —— 状态筛「待审」不该再捞到它。
put('submissions', 'beef7777cafe', { id: 'beef7777cafe', area: 'normal', name: '已被取代的投稿丁' });
writeFileSync(join(dataDir, 'submissions', 'beef7777cafe', 'decision.json'),
  JSON.stringify({
    decision: 'superseded',
    reason: '已由兼容包 eeee3333ffff 取代并发布。',
    at: '2026-10-11T00:00:03.000Z', by: 'admin', displayName: '已被取代的投稿丁',
    replacedBy: { id: 'eeee3333ffff', name: '兼容包（兼容者未填）', area: 'compat', at: '2026-10-11T00:00:03.000Z' },
  }, null, 2));

const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir,
    ADMIN_TOKEN: TOKEN, ADMIN_PATH, BASE_URL: BASE, MAX_MB: '8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (b) => { log += b; });
child.stderr.on('data', (b) => { log += b; });
const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* 还没起 */ }
    await sleep(100);
  }
  return false;
};

try {
  if (!(await waitUp())) throw new Error('服务没起来：\n' + log);
  const adm = (p) => fetch(`${BASE}${p}`, { headers: { 'x-admin-token': TOKEN } });

  // ---------------------------------------------------------------- ① 审核台页面
  console.log('\n① 审核台页面：服务器发出来的那份 HTML 里的脚本能不能跑到底');
  const pageRes = await adm(`/${ADMIN_PATH}`);
  const html = await pageRes.text();
  check(pageRes.status === 200 && html.length > 1000, '拿到审核台页面', `HTTP ${pageRes.status} · ${html.length} 字节`);
  check(!html.includes('__ADMIN_API__') && html.includes(`/api/${ADMIN_PATH}`), 'API 前缀占位符已替换');
  check(!html.includes('__VIEW__') && /const VIEW = 'main'/.test(html),
    '默认地址就是主列表（待审）那一页：__VIEW__ 已替换成 main');
  check(!html.includes('COMPAT_AUTHOR_DEFAULT'), '页面里不再有 COMPAT_AUTHOR_DEFAULT 这个名字');
  // 「不许自动出现 Mo233」的判据是**代码里没有把它当值**，不是「整页不许提这个词」——
  // 说明文字里点一句「要写就自己敲，不敲就永远不会出现」是好事，不算兜底。
  check(!/['"]Mo233['"]/.test(html), '页面里没有把 Mo233 写成代码里的字面值（没有预填、没有兜底）');
  check(!/value\s*=\s*["']?Mo233/.test(html), '没有任何输入栏的 value 被写成 Mo233');
  // 【原地改语义】旧断言：「详情里有『以兼容包形式发布』按钮」+「#cGo 面板不在了」。
  // 业主 2026-10-11 改口径后，入口是**下载按钮那一行的一个独立上传按钮**，
  // 兼容包自己那个区/列表/页面被整个拿掉。同一个意图，按新语义断言：
  check(html.includes('上传并发布兼容包'), '详情页（下载按钮那一行）有**独立的上传按钮**「上传并发布兼容包…」');
  check(!/id="cGo"/.test(html), '左栏那个独立的「上传兼容包」面板已经不在页面上了');
  check(!/id="clist"/.test(html), '左栏那个独立的「兼容包」区/列表（#clist）已经不在页面上了');
  check(!/<span class="panel__title">兼容包<\/span>/.test(html), '页面上不再有单独的「兼容包」面板标题');

  const listRes = await adm(`/api/${ADMIN_PATH}/list`);
  const listJson = await listRes.json();
  const subs = listJson.submissions.filter((s) => (s.kind || 'submission') !== 'compat');
  const comps = listJson.submissions.filter((s) => s.kind === 'compat');

  const { threw, dom, sandbox } = bootInline(html, {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/list')) return { ok: true, status: 200, json: async () => listJson };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  check(!threw, '内联脚本顶层没有抛错（抛错 = 后面所有 onclick 与自动载入全不执行）',
    threw ? `${threw.name}: ${threw.message}` : '');
  for (const id of ['load', 'save', 'forget']) {
    check(typeof dom.byId.get(id)?.onclick === 'function', `#${id} 的 onclick 挂上了`);
  }

  await sleep(60);                                   // 等自动载入那一段 async IIFE 跑完
  const ul = dom.byId.get('list');
  const al = dom.byId.get('alist');
  const rl = dom.byId.get('rlist');
  const items = (n) => (n?.children || []).filter((c) => c.className === 'item');
  // 【原地改语义】上一版：只剩**一个**列表，全部记录都画在 #list 上。
  // 再上一版：业主 2026-10-11「打回的 mod 放入另外的地方」→ 两个列表（#list + #rlist）。
  // 本版业主追加「已经通过的也要另开一页」→ 同一个意图再改一次：**三个列表是三页的分区**，
  // 一条记录都不少、也一条都不筛掉，只是各画到各页：
  //   · #list  待审那一页 = pending + superseded（业主已定：已被取代的保留可见）
  //   · #alist 已通过那一页 = approved
  //   · #rlist 已打回那一页 = rejected
  // 同一个意图的断言：「三个列表合起来，把磁盘上的全部记录都画出来了」，并且
  // **明确断言 approved 不在待审页、rejected 不在待审页**，以及
  // **三页的条数相加 = 磁盘总数**。
  const ids = (n) => items(n).map((li) => li.meta && li.meta.id);
  const rejectedIds = subs.filter((s) => s.decision?.decision === 'rejected').map((s) => s.id);
  const approvedIds = [...subs, ...comps].filter((s) => s.decision?.decision === 'approved').map((s) => s.id);
  check(items(ul).length + items(al).length + items(rl).length === subs.length + comps.length,
    '三个列表合起来的条数与磁盘一致（待审页 + 已通过页 + 已打回页 = 全部记录）',
    `磁盘 ${subs.length + comps.length} 条（投稿 ${subs.length} + 兼容包 ${comps.length}）· 页面 ${items(ul).length} + ${items(al).length} + ${items(rl).length} 条`);
  check(!!rl && !!al, '页面里有「已通过」与「已打回」各自的列表（#alist / #rlist）');
  // #apanel / #rpanel 是另外两页的面板本身：各自的列表在它们里面。DOM 桩是按 id 现问现造的，
  // 所以这里既按「页面 HTML 里有这两个面板」断言，也按「它们不在主列表那个面板里」断言。
  check(/id="ppanel"/.test(html) && /id="apanel"/.test(html) && /id="rpanel"/.test(html)
    && /id="alist"/.test(html) && /id="rlist"/.test(html),
    '三页各有自己的面板与列表（#ppanel/#list · #apanel/#alist · #rpanel/#rlist）');
  check(html.indexOf('id="ppanel"') < html.indexOf('id="apanel"')
    && html.indexOf('id="apanel"') < html.indexOf('id="rpanel"'),
    '三个面板按「待审 → 已通过 → 已打回」的顺序排（导航上也是这个顺序）');
  check(!dom.byId.has('clist'), '页面里根本没有 #clist 这个节点（独立的兼容包区已经不在了）');
  // 【原地改语义 · 上一版这里是「打回的不在主列表」】现在**两页都不在待审页**：
  // 已通过的不在待审页、已打回的不在待审页；各自都在自己那一页。
  check(rejectedIds.length > 0 && rejectedIds.every((id) => !ids(ul).includes(id)),
    `被退回的那 ${rejectedIds.length} 条**一条都不在待审页里**（不再干扰待审队列）`,
    `rejected=${JSON.stringify(rejectedIds)} · 待审页=${JSON.stringify(ids(ul))}`);
  check(rejectedIds.every((id) => ids(rl).includes(id)),
    '被退回的记录**都在「已打回」那一页**（仍然可见、可追溯、可处置）',
    `#rlist=${JSON.stringify(ids(rl))}`);
  // 【本版新增】「已通过」也另开一页：同样的两条断言。
  check(approvedIds.length > 0 && approvedIds.every((id) => !ids(ul).includes(id)),
    `已通过的那 ${approvedIds.length} 条**一条都不在待审页里**（已通过的另开一页）`,
    `approved=${JSON.stringify(approvedIds)} · 待审页=${JSON.stringify(ids(ul))}`);
  check(approvedIds.every((id) => ids(al).includes(id)),
    '已通过的记录**都在「已通过」那一页**',
    `#alist=${JSON.stringify(ids(al))}`);
  // 【原地改语义】上一版这里只有三个桶（待审页 + 已通过页 + 已打回页 = 全部）。
  // 业主 2026-10-11 追加「不再显示」勾选框之后，一条记录**恰好**落在四个桶里的一个：
  // 待审页 / 已通过页 / 已打回页 / **已隐藏**。同一个意图因此改断成：
  // 「三页相加 **加上已隐藏** = 磁盘上的记录总数」—— 业主明确要求不许因为隐藏而对不上。
  const rSum0 = sandbox.readFilter();
  check(rSum0.nMain + rSum0.nApproved + rSum0.nRejected + rSum0.nHidden === subs.length + comps.length,
    '三页计数之和 + 已隐藏 = 磁盘上的记录总数',
    `待审页 ${rSum0.nMain} + 已通过页 ${rSum0.nApproved} + 已打回页 ${rSum0.nRejected} + 已隐藏 ${rSum0.nHidden} = ${rSum0.nMain + rSum0.nApproved + rSum0.nRejected + rSum0.nHidden}（磁盘 ${subs.length + comps.length}）`);
  check(rSum0.nState === subs.length + comps.length,
    '按状态再数一遍也对得上（待审 + 已通过 + 已打回 + 已被取代 + 已隐藏 = 全部）',
    `${rSum0.np} + ${rSum0.na} + ${rSum0.nr} + ${rSum0.ns} + ${rSum0.nh} = ${rSum0.nState}`);
  const rendered = textOf(ul).join(' ');
  check(rendered.includes('普通投稿甲') && rendered.includes('普通投稿乙'), '两条普通投稿的名字都出现在列表里');
  check(!rendered.includes('还没载入'), '列表不再停在「还没载入。」');


  // 兼容者为空的那条：如实显示「未填」（现在它在同一个列表里）
  check(/未填/.test(rendered) && !/Mo233/.test(rendered),
    '兼容者未填的那条，列表里如实写「未填」，且没有 Mo233',
    (rendered.replace(/\s+/g, ' ').match(/.{0,26}未填.{0,24}/) || [''])[0]);
  check(/共\s*\d+\s*条/.test(String(dom.byId.get('fCounts')?.textContent || '')),
    '筛选栏把总条数显示出来（默认视图也显示）', String(dom.byId.get('fCounts')?.textContent || ''));

  // ---------------------------------------------------------------- ①b 筛选（纯前端）
  console.log('\n①b 筛选：区域 / 状态 / 档位 / 关键字，四条都真的减少可见条数，清空后恢复');
  // 【原地改语义】上一版只有**一个**列表，可见条数就数 #list 上没被 display:none 的那些。
  // 上一版改到两个列表，本版（「已通过也另开一页」）改成**三个列表**，于是同一个意图是：
  // **可见条数 = 三个列表里没被 display:none 的那些之和**（分区不改变筛选口径：
  // 记录一条没筛掉、筛选规则三边同一套 matches()）。
  const visIn = (n) => items(n).filter((li) => li.style.display !== 'none').length;
  const visCount = () => visIn(ul) + visIn(al) + visIn(rl);
  const setF = (id, v) => { dom.byId.get(id).value = v; return sandbox.readFilter(); };
  const clearF = () => { dom.byId.get('fClear').onclick(); return visCount(); };
  const total = items(ul).length + items(al).length + items(rl).length;
  check(visCount() === total && total === subs.length + comps.length,
    '默认视图：一条都没被藏起来（＝加筛选之前看到的东西）', `可见 ${visCount()} / 共 ${total}`);
  check(items(al).length > 0 && visIn(al) === items(al).length,
    '默认视图里「已通过」那一页的列表也照常画着（换页只是显示哪一块，不筛掉记录）',
    `#alist 画了 ${items(al).length} 条`);
  check(items(rl).length > 0 && visIn(rl) === items(rl).length,
    '默认视图里「已打回」那一页的列表也照常画着（同上）',
    `#rlist 画了 ${items(rl).length} 条`);
  check(/共\s*7\s*条/.test(String(dom.byId.get('fCounts')?.textContent || '')),
    '默认视图的计数是磁盘上的总条数 7', String(dom.byId.get('fCounts')?.textContent || ''));
  check(/已打回\s*1/.test(String(dom.byId.get('fCounts')?.textContent || '')),
    '计数行里「已打回」这一档照旧数得出来（口径没变）',
    (String(dom.byId.get('fCounts')?.textContent || '').match(/已打回[^·]*/) || [''])[0]);
  // 【原地改语义】上一版这句是「另放在下面「已打回」那一块」（同一页里另开一块）；
  // 本版业主明确要「另开一页」，所以同一个意图改断成：计数行必须点明**已经另开一页**，
  // 并且把「三页相加 = 全部」这条恒等式写出来。
  // 【再改一次语义 · 2026-10-11「不再显示」】恒等式多了「已隐藏」这一个桶：
  //   三页相加 **+ 已隐藏** = 全部 —— 业主口径：不许因为隐藏而对不上。断言原地跟着改（不是删掉）。
  check(/已通过与已打回各自另开一页/.test(String(dom.byId.get('fCounts')?.textContent || '')),
    '并且点明它们**另开一页**（人一眼知道去哪儿找）',
    (String(dom.byId.get('fCounts')?.textContent || '').match(/（[^）]*另开一页[^）]*）/) || [''])[0]);
  check(/待审页\s*\d+\s*\+\s*已通过页\s*\d+\s*\+\s*已打回页\s*\d+\s*\+\s*已隐藏\s*\d+\s*=\s*全部\s*7\s*条/.test(String(dom.byId.get('fCounts')?.textContent || '')),
    '计数行里写着「三页相加 + 已隐藏 = 全部 N 条」（四处各有几条一眼可见）',
    (String(dom.byId.get('fCounts')?.textContent || '').match(/待审页[^）]*/) || [''])[0]);
  const rPending = setF('fState', 'pending');
  const expPending = subs.filter((s) => (s.decision?.decision || s.state || 'pending') === 'pending').length
    + comps.filter((s) => (s.decision?.decision || s.state || 'pending') === 'pending').length;
  check(visCount() === expPending, `状态=待审 → 只留待审的（${expPending} 条）`,
    `可见 ${visCount()} · ${JSON.stringify(rPending)}`);
  const rKey = setF('fKey', '普通投稿');
  check(visCount() === 2, '关键字「普通投稿」→ 只剩那两条（编号或名称都参与匹配）', `可见 ${visCount()}`);
  const rKeyId = setF('fKey', 'cccc2222');
  check(visCount() === 1, '关键字按**编号**也能过滤（cccc2222 → 1 条）', `可见 ${visCount()}`);
  clearF();
  check(visCount() === total, '清空筛选 → 又看得见全部（控件也回到「全部」）',
    `可见 ${visCount()} · 控件 ${JSON.stringify([dom.byId.get('fArea').value, dom.byId.get('fState').value, dom.byId.get('fBlocker').value, dom.byId.get('fKey').value])}`);
  const rBlocker = setF('fBlocker', 'with');
  check(visCount() === 1, '档位=有 blocker → 只剩那一条（疑似素材甲）', `可见 ${visCount()}`);
  check(visCount() === 1 && rBlocker.visible === 1, '计数与可见条数一致（筛选后条数显示出来）',
    String(dom.byId.get('fCounts')?.textContent || ''));
  setF('fBlocker', 'without');
  check(visCount() === total - 1, `档位=无 blocker → 减掉那一条（${total - 1} 条）`, `可见 ${visCount()}`);
  clearF();
  const flaggedN = listJson.submissions.filter((s) => s.area === 'flagged' && s.kind !== 'compat').length;
  const normalN = subs.length - flaggedN;
  const rAreaFlag = setF('fArea', 'flagged');
  check(visCount() === flaggedN && rAreaFlag.visible === flaggedN, `区域=flagged → 只剩 flagged 那 ${flaggedN} 条`, `可见 ${visCount()}`);
  setF('fArea', 'compat');
  check(visCount() === comps.length, '区域=compat → 只剩兼容包那一组', `可见 ${visCount()}`);
  setF('fArea', 'submissions');
  check(visCount() === normalN, `区域=submissions → 普通投稿那 ${normalN} 条（flagged 的挪出去、含已打回那条）`, `可见 ${visCount()}`);
  const expRej = subs.filter((s) => s.decision?.decision === 'rejected').length;
  const rRej = setF('fState', 'rejected');
  check(visCount() === expRej, `状态=已打回 → 只剩被退回那 ${expRej} 条`, `可见 ${visCount()} · ${JSON.stringify(rRej)}`);
  // 【原地改语义 · 上一版是「都打在独立那块」】现在被退回的只可能在「已打回」那一页：
  // 待审页与已通过页在同一个筛选下**一条都不显示**。
  check(visIn(rl) === expRej && visIn(ul) === 0 && visIn(al) === 0,
    '把「状态=已打回」筛出来时：可见的都在「已打回」那一页（#rlist），待审页与已通过页一条都不显示',
    `#list 可见 ${visIn(ul)} · #alist 可见 ${visIn(al)} · #rlist 可见 ${visIn(rl)} · 计数 ${JSON.stringify(rRej)}`);
  check(rRej.visibleRejected === expRej,
    'applyFilters 的返回值里单独报出「可见的已打回条数」（测试与页面计数同一个来源）',
    `visibleRejected=${rRej.visibleRejected}`);
  clearF();
  // 已被兼容包取代的那条（业主 B 口径）：**看得见、可追溯，但不在待审队列里**。
  const supersededText = textOf(ul).join(' ');
  check(/已被兼容包\s*eeee3333ffff/.test(supersededText),
    '列表里把「被哪条兼容包取代」直接写出来（可追溯）',
    (supersededText.replace(/\s+/g, ' ').match(/.{0,10}已被兼容包.{0,44}/) || [''])[0]);
  check(/已被取代\s*1/.test(String(dom.byId.get('fCounts')?.textContent || '')),
    '筛选栏的计数里有「已被取代 1」（既算得出来，也没跟「已打回」混在一起）',
    String(dom.byId.get('fCounts')?.textContent || ''));
  const rSup = setF('fState', 'superseded');
  check(visCount() === 1 && rSup.visible === 1, '状态=已被兼容包取代 → 只留那一条', `可见 ${visCount()}`);
  setF('fState', 'pending');
  check(!items(ul).some((li) => li.meta && li.meta.id === 'beef7777cafe' && li.style.display !== 'none'),
    '状态=待审 → **捞不到**已被取代的那一条（它已经移出待审队列）', `可见 ${visCount()}`);
  check(items(ul).some((li) => li.meta && li.meta.id === 'beef7777cafe'),
    '但记录**还在列表里**（只是被筛选藏起来）——记录一条都没丢，可追溯');
  clearF();
  // 反证：关键字打在「自动载入」之前也要生效 —— 这条断言走的是**自动载入那一路**，
  // 不是手动再调一次筛选。顺带证明筛选码在 async IIFE 之前就已经初始化好（没有 TDZ）。
  const pre = bootInline(html, {
    fetchImpl: async (url) => (String(url).endsWith('/list')
      ? { ok: true, status: 200, json: async () => listJson }
      : { ok: true, status: 200, json: async () => ({}) }),
    beforeAsync: (d) => { d.document.getElementById('fKey').value = '普通投稿甲'; },
  });
  check(!pre.threw, '另一个桩：自动载入之前先打关键字 → 脚本照样不抛错',
    pre.threw ? `${pre.threw.name}: ${pre.threw.message}` : '');
  await sleep(60);
  const preItems = (n) => (n?.children || []).filter((c) => c.className === 'item');
  // 【原地改语义】`total` 现在是三个列表之和（待审页 + 已通过页 + 已打回页）。
  const preMain = preItems(pre.dom.byId.get('list'));
  const preApp = preItems(pre.dom.byId.get('alist'));
  const preRej = preItems(pre.dom.byId.get('rlist'));
  const preVis = (a) => a.filter((li) => li.style.display !== 'none').length;
  check(preMain.length + preApp.length + preRej.length === total
    && preVis(preMain) === 1 && preVis(preApp) === 0 && preVis(preRej) === 0,
    `自动载入那一路也吃关键字：画完 ${total} 条（${preMain.length} + ${preApp.length} + ${preRej.length}）、可见只剩 1 条（普通投稿甲）`,
    `画了 ${preMain.length} + ${preApp.length} + ${preRej.length} · 可见 ${preVis(preMain)} + ${preVis(preApp)} + ${preVis(preRej)}`);
  check(/普通投稿甲/.test(textOf(pre.dom.byId.get('list')).join(' '))
    && /筛选后可见 1 条/.test(String(pre.dom.byId.get('fCounts')?.textContent || '')),
    '可见的就是关键字命中的那条，计数写「筛选后可见 1 条」',
    String(pre.dom.byId.get('fCounts')?.textContent || ''));

  // ---------------------------------------------------------------- ①c 三个视图（真另开一页）
  console.log('\n①c 三页：待审 / 已通过 / 已打回 —— 三条真实地址、导航可来回、当前那一页看得清');
  // 业主 2026-10-11：「已经通过的也要另开一页」。实现的判据是**地址真的不同**：
  // 三条地址各自返回服务端注入好的那一份 HTML（`__VIEW__` 已被白名单校验过的值替换）。
  const navHrefs = ['?view=main', '?view=approved', '?view=rejected'];
  check(html.includes('id="views"') && navHrefs.every((h) => html.includes(`href="${h}"`)),
    '页面上有三个视图的导航，且都是**真实地址**（?view=main / approved / rejected）',
    navHrefs.join(' · '));
  check(/id="viewNow"/.test(html) && /id="viewNowSub"/.test(html), '页面上有「当前在哪一页」那一行');
  // 默认页 = 主列表（待审）：只有待审那一块显示，标题与导航都指这里。
  check(dom.byId.get('ppanel')?.style.display === '' && dom.byId.get('apanel')?.style.display === 'none'
    && dom.byId.get('rpanel')?.style.display === 'none',
    '待审那一页：只显示待审那块面板（已通过 / 已打回那两块 display:none）',
    `ppanel=${JSON.stringify(dom.byId.get('ppanel')?.style.display)} · apanel=${JSON.stringify(dom.byId.get('apanel')?.style.display)} · rpanel=${JSON.stringify(dom.byId.get('rpanel')?.style.display)}`);
  check(/待审/.test(String(dom.byId.get('viewNow')?.textContent || ''))
    && /on/.test(String(dom.byId.get('vMain')?.className || ''))
    && !/on/.test(String(dom.byId.get('vApproved')?.className || '')),
    '待审那一页：导航上高亮的是「待审」（vMain.on），并且「当前：待审」写在页面上',
    `viewNow=${JSON.stringify(dom.byId.get('viewNow')?.textContent)} · vMain=${JSON.stringify(dom.byId.get('vMain')?.className)} · vApproved=${JSON.stringify(dom.byId.get('vApproved')?.className)}`);
  check(String(dom.byId.get('nMain')?.textContent) !== '0' && String(dom.byId.get('nApproved')?.textContent) !== '0'
    && String(dom.byId.get('nRejected')?.textContent) !== '0',
    '导航三格上都写了条数（三处各有几条，不用点进去也知道）',
    `待审 ${dom.byId.get('nMain')?.textContent} · 已通过 ${dom.byId.get('nApproved')?.textContent} · 已打回 ${dom.byId.get('nRejected')?.textContent}`);

  // 逐页 boot：同一份 /list 数据，只换服务端发出来的那一份 HTML（真地址真页面）。
  const views = [
    { view: 'approved', url: `/${ADMIN_PATH}?view=approved`, label: '已通过', shown: 'apanel', tab: 'vApproved' },
    { view: 'rejected', url: `/${ADMIN_PATH}?view=rejected`, label: '已打回', shown: 'rpanel', tab: 'vRejected' },
  ];
  for (const v of views) {
    const res = await fetch(`${BASE}${v.url}`, { headers: { 'x-admin-token': TOKEN } });
    const vHtml = await res.text();
    check(res.status === 200, `${v.url} → 200（另一页拿得到）`, `HTTP ${res.status}`);
    check(res.status === 200 && !vHtml.includes('__VIEW__'),
      `${v.label}那一页：__VIEW__ 占位符已被替换成白名单里的视图名`,
      (vHtml.match(/const VIEW = '[^']*'/) || ['(没找到)'])[0]);
    const vb = bootInline(vHtml, {
      fetchImpl: async (url) => (String(url).endsWith('/list')
        ? { ok: true, status: 200, json: async () => listJson }
        : { ok: true, status: 200, json: async () => ({}) }),
    });
    check(!vb.threw, `${v.label}那一页的内联脚本也不抛错`,
      vb.threw ? `${vb.threw.name}: ${vb.threw.message}` : '');
    await sleep(60);
    const rr = vb.sandbox.readFilter();
    check(rr.view === v.view, `${v.label}那一页：页面自己知道当前是 view=${v.view}`, String(rr.view));
    check(vb.dom.byId.get(v.shown)?.style.display === '' &&
      ['ppanel', 'apanel', 'rpanel'].filter((x) => x !== v.shown).every((x) => vb.dom.byId.get(x)?.style.display === 'none'),
      `${v.label}那一页：只显示它自己那块面板（另外两块 display:none）`,
      ['ppanel', 'apanel', 'rpanel'].map((x) => `${x}=${JSON.stringify(vb.dom.byId.get(x)?.style.display)}`).join(' '));
    check(/on/.test(String(vb.dom.byId.get(v.tab)?.className || ''))
      && !/on/.test(String(vb.dom.byId.get('vMain')?.className || '')),
      `${v.label}那一页：导航上高亮的是它自己（其他格不高亮）`,
      `${v.tab}=${JSON.stringify(vb.dom.byId.get(v.tab)?.className)} · vMain=${JSON.stringify(vb.dom.byId.get('vMain')?.className)}`);
    check(String(vb.dom.byId.get('viewNow')?.textContent || '') === `当前：${v.label}`,
      `${v.label}那一页：「当前在哪一页」写得清清楚楚`,
      JSON.stringify(vb.dom.byId.get('viewNow')?.textContent));
    // 「三页计数之和 + 已隐藏 = 磁盘总数」在**每一页**都成立（四个数由同一份 /list 算出来）。
    // 【原地改语义】「不再显示」之后多了「已隐藏」这一个桶，断言跟着加上它（不是删掉）。
    check(rr.nMain + rr.nApproved + rr.nRejected + rr.nHidden === subs.length + comps.length,
      `${v.label}那一页：三页计数之和 + 已隐藏仍等于磁盘总数`,
      `${rr.nMain} + ${rr.nApproved} + ${rr.nRejected} + ${rr.nHidden} = ${rr.nMain + rr.nApproved + rr.nRejected + rr.nHidden}（磁盘 ${subs.length + comps.length}）`);
    // 该页的内容：本页的记录都在自己那份列表里（不是靠筛选藏出来的）。
    const want = v.view === 'approved' ? approvedIds : rejectedIds;
    const got = items(vb.dom.byId.get(v.view === 'approved' ? 'alist' : 'rlist')).map((li) => li.meta && li.meta.id);
    check(want.length > 0 && want.every((id) => got.includes(id)),
      `${v.label}那一页：本页的记录都在它自己的列表里`,
      `#${v.view === 'approved' ? 'alist' : 'rlist'}=${JSON.stringify(got)}`);
  }
  // 视图名不在白名单里 → 404，绝不悄悄回落到主列表。
  const badView = await fetch(`${BASE}/${ADMIN_PATH}?view=nope`, { headers: { 'x-admin-token': TOKEN } });
  check(badView.status === 404, 'view 不在白名单里 → 404（不悄悄回落到主列表）', `HTTP ${badView.status}`);
  // 三道防线照旧：三个视图**都要令牌**（没令牌一律 401，页面根本不发出）。
  const noTok = [];
  for (const u of [`/${ADMIN_PATH}`, `/${ADMIN_PATH}?view=approved`, `/${ADMIN_PATH}?view=rejected`]) {
    const r = await fetch(`${BASE}${u}`);
    noTok.push(`${u}=${r.status}`);
  }
  check(noTok.every((x) => x.endsWith('=401')), '三个视图都要令牌（不带令牌 → 401，页面一个字都不发）', noTok.join(' · '));

  // ---------------------------------------------------------------- ①d 「不再显示」勾选框
  // 业主 2026-10-11：「有可能 mod 名字和兼容后的名字不一样，导致依旧存在两个 mod（一个在兼容，
  // 一个在上传待定），所以给我一个勾选框，选后就不显示这个 mod 了」。
  // 这一段的判据就是那句话本身，四条一条都不许松：
  //   ① 每条记录一个勾选框（**列表行上**，**详情里也有一个**），文案写「不再显示（已由兼容包取代）」；
  //   ② 勾上 ⇒ 这条从**三个视图**里都不显示；取消勾选 ⇒ **回来**（可逆）；
  //   ③ 计数对得上：三页相加 **+ 已隐藏** = 全部；
  //   ④ 另给一个「显示已隐藏」开关，勾上就能看见被隐藏的那些（便于取消勾选）。
  // 走的是**真端点**（本文件起的是真服务），不是桩里假造的响应。
  console.log('\n①d 「不再显示」勾选框：勾上 ⇒ 三视图都不见 · 取消 ⇒ 回来 · 计数对得上');
  const hidePost = (body) => fetch(`${BASE}/api/${ADMIN_PATH}/hide`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body),
  });
  const withList = (data) => bootInline(html, {
    fetchImpl: async (u2) => (String(u2).endsWith('/list')
      ? { ok: true, status: 200, json: async () => data }
      : { ok: true, status: 200, json: async () => ({}) }),
  });
  const rowsOf = (d) => [...items(d.dom.byId.get('list')), ...items(d.dom.byId.get('alist')), ...items(d.dom.byId.get('rlist'))];
  // 公网面的**基准字节**（勾之前先冻住）：后面拿它证明「隐藏不是下架」。
  const modsPubBefore = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const modsPageBefore = await (await fetch(`${BASE}/mods`)).text();
  // ① 勾选框就在列表行上，文案与位置都对
  const rows0 = rowsOf({ dom });
  const boxes0 = rows0.map((li) => find(li, (n) => n.tagName === 'input' && n.type === 'checkbox')[0] || null);
  check(boxes0.length > 0 && boxes0.every(Boolean) && boxes0.length === rows0.length,
    `列表**每一行**都有一个勾选框（${boxes0.length} 行 / ${boxes0.filter(Boolean).length} 个）`,
    `行数 ${rows0.length}`);
  check(rows0.every((li) => /不再显示（已由兼容包取代）/.test(textOf(li).join(' '))),
    '文案写的是「不再显示（已由兼容包取代）」（一眼看懂是「不再显示这条」，不是删除）');
  check(boxes0.every((b) => b.checked === false), '初始一个都没勾上（谁也不许被悄悄藏起来）');
  check(/id="fHidden"/.test(html) && /显示已隐藏/.test(html),
    '筛选栏里有「显示已隐藏」这个开关（勾上就能看见被隐藏的，便于取消勾选）');
  check(/id="nHidden"/.test(html) && /已隐藏/.test(html), '导航上多一格「已隐藏」（三页相加 + 这一格 = 全部）');
  // ② 勾上：一次一个 id 的真请求
  const hideId = 'cccc2222dddd';                       // 普通投稿乙（待审，画在 #list 上）
  const hideRes = await hidePost({ id: hideId, hidden: true });
  const hideJson = await hideRes.json();
  check(hideRes.status === 200 && hideJson.changed === true && hideJson.hidden === true,
    '勾上「不再显示」：POST /hide 一次只带这一个 id，写盘成功',
    `HTTP ${hideRes.status} · changed=${hideJson.changed}`);
  const listHid = await (await adm(`/api/${ADMIN_PATH}/list`)).json();
  check(listHid.submissions.find((s) => s.id === hideId)?.hidden === true,
    '标志位落在**记录自己的 meta.json** 上，/list 原样带出 hidden:true');
  // ③ 三个视图里都不显示它（用**新的 /list** 重开一个桩 = 维护者刷新页面那一路）
  const hid = withList(listHid);
  check(!hid.threw, '隐藏之后那份 /list 喂同一个桩也不抛错', hid.threw ? `${hid.threw.name}: ${hid.threw.message}` : '');
  await sleep(60);
  const hidAll = rowsOf(hid);
  const hidRow = hidAll.find((li) => li.meta && li.meta.id === hideId);
  check(hidAll.length === listHid.submissions.length, '记录一条都没丢（还是把全部记录都画出来了）',
    `画了 ${hidAll.length} 条 = /list ${listHid.submissions.length} 条`);
  check(!!hidRow && hidRow.style.display === 'none',
    '勾上之后：**三个视图里都不显示它**（那一行还在 DOM 里，只是不显示）',
    hidRow ? `display=${JSON.stringify(hidRow.style.display)}` : '（没画出来）');
  check(!hidAll.filter((li) => li.style.display !== 'none').some((li) => li.meta && li.meta.id === hideId),
    '可见的那些里一个都没有它（换到哪一页都一样）');
  // ④ 计数：三页相加 + 已隐藏 = 全部
  const rh = hid.sandbox.readFilter();
  check(rh.nMain + rh.nApproved + rh.nRejected + rh.nHidden === listHid.submissions.length && rh.nHidden === 1,
    '计数对得上：三页相加 + 已隐藏 = 全部',
    `${rh.nMain} + ${rh.nApproved} + ${rh.nRejected} + ${rh.nHidden} = ${rh.nMain + rh.nApproved + rh.nRejected + rh.nHidden}（全部 ${listHid.submissions.length}）`);
  check(rh.nState === listHid.submissions.length,
    '按状态再数一遍也对得上（待审 + 已通过 + 已打回 + 已被取代 + 已隐藏 = 全部）',
    `${rh.np} + ${rh.na} + ${rh.nr} + ${rh.ns} + ${rh.nh} = ${rh.nState}`);
  check(/待审页\s*\d+\s*\+\s*已通过页\s*\d+\s*\+\s*已打回页\s*\d+\s*\+\s*已隐藏\s*1\s*=\s*全部\s*7\s*条/.test(String(hid.dom.byId.get('fCounts')?.textContent || '')),
    '计数行原话就是「三页相加 + 已隐藏 = 全部 N 条」',
    (String(hid.dom.byId.get('fCounts')?.textContent || '').match(/待审页[^）]*/) || [''])[0]);
  check(String(hid.dom.byId.get('nHidden')?.textContent) === '1', '导航那一格「已隐藏」显示 1',
    String(hid.dom.byId.get('nHidden')?.textContent));
  // ⑤ 「显示已隐藏」开关：勾上就看得见（便于取消勾选）
  hid.dom.byId.get('fHidden').checked = true;
  const rShow = hid.sandbox.readFilter();
  check(hidRow && hidRow.style.display !== 'none' && rShow.visibleHidden === 1,
    '勾上「显示已隐藏」→ 被隐藏的那条又看得见（就是给你取消勾选用的）',
    `display=${JSON.stringify(hidRow && hidRow.style.display)} · 可见的已隐藏 ${rShow.visibleHidden} 条`);
  check(rShow.nHidden === 1 && rShow.nMain + rShow.nApproved + rShow.nRejected + rShow.nHidden === 7,
    '开关只影响显示，不改那四个计数桶（恒等式照样成立）',
    `${rShow.nMain} + ${rShow.nApproved} + ${rShow.nRejected} + ${rShow.nHidden} = 7`);
  // ⑥ 取消勾选 ⇒ 回来（**可逆**）
  const unRes = await hidePost({ id: hideId, hidden: false });
  const listBack2 = await (await adm(`/api/${ADMIN_PATH}/list`)).json();
  check(unRes.status === 200 && listBack2.submissions.find((s) => s.id === hideId)?.hidden === false,
    '取消勾选：写回 hidden:false（不是把键删掉，是显式的 false）');
  const back = withList(listBack2);
  await sleep(60);
  const backAll = rowsOf(back);
  const rBack = back.sandbox.readFilter();
  check(backAll.filter((li) => li.style.display !== 'none').length === backAll.length
    && backAll.length === 7 && rBack.nHidden === 0,
    '取消勾选之后：三个视图里又都看得见它了（**可逆**，不是一勾就扔）',
    `可见 ${backAll.filter((li) => li.style.display !== 'none').length} / 共 ${backAll.length} · 已隐藏 ${rBack.nHidden}`);
  // ⑦ 行上那个勾选框真的只发一个 id（报文形状）
  const posts = [];
  const rc = bootInline(html, {
    fetchImpl: async (url, opt) => {
      const u = String(url);
      posts.push({ u, method: (opt && opt.method) || 'GET', body: opt && opt.body });
      if (u.endsWith('/list')) return { ok: true, status: 200, json: async () => listBack2 };
      if (u.endsWith('/hide')) return { ok: true, status: 200, json: async () => ({ ok: true, changed: true, hidden: true }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await sleep(60);
  const rcRow = items(rc.dom.byId.get('list'))[0];
  const rcBox = find(rcRow, (n) => n.tagName === 'input' && n.type === 'checkbox')[0];
  rcBox.checked = true;
  await rcBox.onchange();
  await sleep(40);
  const hideCalls = posts.filter((p) => p.u.endsWith('/hide'));
  const sent = hideCalls.length === 1 ? JSON.parse(hideCalls[0].body) : null;
  check(hideCalls.length === 1 && hideCalls[0].method === 'POST' && sent
    && typeof sent.id === 'string' && sent.hidden === true && Object.keys(sent).length === 2,
    '勾一下**只发一个 id**、只发一次请求（报文就是 { id, hidden } 两个键 —— 绝不是一批）',
    hideCalls.length ? `${hideCalls[0].method} ${sent ? hideCalls[0].body : ''}` : '（没发请求）');
  check(/已隐藏/.test(html) === true, '页面上确实有「已隐藏」这一档（不是部署前的旧文件）');
  // ⑧ 详情里也有一个勾选框（业主口径「两者都给更好」）
  const d3Target = listBack2.submissions.find((s) => s.id === hideId);
  const d3 = bootInline(html, {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith('/list')) return { ok: true, status: 200, json: async () => listBack2 };
      if (u.includes('/detail/')) return {
        ok: true, status: 200,
        json: async () => ({
          meta: { ...d3Target, hidden: true, hiddenBy: 'admin', hiddenAt: '2026-10-11T00:00:09.000Z' },
          entries: [], topLevel: {}, variant: 'mod', viewSha256: null,
          download: `/api/file/${hideId}`, archiveDownload: null, packJsonOrig: null,
        }),
      };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  await sleep(60);
  await d3.sandbox.detail(hideId);
  await sleep(20);
  const dBox = d3.dom.byId.get('detail');
  const dCb = find(dBox, (n) => n.tagName === 'input' && n.type === 'checkbox')[0];
  check(!!dCb && dCb.checked === true,
    '详情里也有同一个勾选框，且如实反映它已经被勾上',
    dCb ? `checked=${dCb.checked}` : '（详情里没有勾选框）');
  check(/不再显示（已由兼容包取代）/.test(textOf(dBox).join(' ')), '详情里那句文案与列表行上一致');
  check(/公网 \/mods 与 \/api\/mods 不动/.test(textOf(dBox).join(' ')),
    '详情里写明「公开面不动」（免得把这个勾选框当成下架手段）',
    (textOf(dBox).join(' ').match(/.{0,12}公网 \/mods.{0,26}/) || [''])[0]);
  // ⑨ 隐藏不改公开面：这几条是「隐藏 ≠ 下架」的凭据 —— 拿**勾之前**的公网字节做基准比对。
  const modsPubAfter = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const modsPageAfter = await (await fetch(`${BASE}/mods`)).text();
  check(modsPubAfter === modsPubBefore,
    '隐藏期间**公网 /api/mods 一个字节都没变**（隐藏不是下架）',
    `${modsPubBefore.slice(0, 70)}… → 一致 ${modsPubAfter === modsPubBefore}`);
  check(!modsPubAfter.includes('"hidden"'),
    '公开数据里**根本不暴露** hidden 这一栏（公开面不知道有这回事）');
  check(modsPageAfter === modsPageBefore, '公网 /mods 那一页的字节也一个字都没变');

  // ---------------------------------------------------------------- ② 兼容包表单
  console.log('\n② 「上传我改好的兼容包并发布」表单：构造出来是干净的（没有预填名字）');
  if (typeof sandbox.compatFormFor === 'function') {
    const form = sandbox.compatFormFor({ id: 'aaaa1111bbbb', name: '普通投稿甲', homepage: 'https://example.invalid/src' });
    const inputs = find(form, (n) => n.tagName === 'input');
    const compat = inputs.find((n) => String(n.placeholder).includes('兼容者'));
    const nameIn = inputs.find((n) => String(n.placeholder).includes('上线显示名'));
    const ofIn = inputs.find((n) => String(n.placeholder).includes('由哪个待审原件改写来'));
    check(!!compat, '表单里有「兼容者」这一栏（必填字段）');
    check(compat?.value === '', '兼容者那一栏**是空的**（没有预填任何名字，尤其不是 Mo233）',
      JSON.stringify(compat?.value));
    check(nameIn?.value === '普通投稿甲（兼容版）', '上线显示名按当前这条预填', String(nameIn?.value));
    check(ofIn?.value === 'aaaa1111bbbb', '「由哪个待审原件改写来」预填成当前这一条的编号', String(ofIn?.value));
    const formText = textOf(form).join(' ');
    check(!find(form, (n) => n.tagName === 'input' && n.value === 'Mo233').length,
      '表单里没有任何一栏被预填成 Mo233');
    check(/不会代你填|不敲就永远不会出现/.test(formText),
      '说明文字里明说「不会代你填、不敲就永远不会出现」（提到这个词是为了讲清不会发生，不是兜底）');
    const goBtn = find(form, (n) => n.tagName === 'button' && n.textContent === '上传并发布')[0];
    check(!!goBtn, '表单底部那个按钮就是「上传并发布」（一次动作 = 上传 + 通过 + 发布）',
      find(form, (n) => n.tagName === 'button').map((b) => b.textContent).join(' | '));
  } else {
    check(false, '页面里应当有 compatFormFor（兼容包表单的构造器）');
  }

  // ---------------------------------------------------------------- ②b 详情页那个独立上传按钮
  console.log('\n②b 投稿详情页（下载那一行）：独立的上传按钮 + 点发布 = 一步到位（publish=1）');
  const detailTarget = listJson.submissions.find((s) => s.id === 'aaaa1111bbbb');
  const detailPayload = {
    meta: detailTarget, entries: [], topLevel: {}, variant: 'mod',
    viewSha256: null, download: '/api/file/aaaa1111bbbb', archiveDownload: null, packJsonOrig: null,
  };
  const calls = [];
  const d2 = bootInline(html, {
    fetchImpl: async (url, opt) => {
      const u = String(url);
      calls.push({ u, method: (opt && opt.method) || 'GET' });
      if (u.endsWith('/list')) return { ok: true, status: 200, json: async () => listJson };
      if (u.includes('/detail/')) return { ok: true, status: 200, json: async () => detailPayload };
      if (u.includes('/compat-submit')) {
        return {
          ok: true, status: 201, json: async () => ({
            ok: true, id: 'feedface0001', area: 'compat', kind: 'compat', state: 'approved',
            author: '普通投稿甲', authorSource: 'pack.json', compatAuthor: '', compatAuthorSource: 'empty',
            packageName: '普通投稿甲', description: 'd', size: 1, sha256: 'f'.repeat(64), entries: 1, flags: [],
            published: { file: 'compat.zip', sha256: 'f'.repeat(64) },
            replaced: { id: 'aaaa1111bbbb', at: '2026-10-11T00:00:09.000Z' },
            message: '已发布上线',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  });
  check(!d2.threw, '带 detail 桩的另一个桩：脚本照样不抛错', d2.threw ? `${d2.threw.name}: ${d2.threw.message}` : '');
  await sleep(60);
  await d2.sandbox.detail('aaaa1111bbbb');
  await sleep(20);
  const detailBox = d2.dom.byId.get('detail');
  const dBtns = find(detailBox, (n) => n.tagName === 'button');
  const upBtn = dBtns.find((b) => String(b.textContent).includes('上传并发布兼容包')) || null;
  check(!!upBtn, '详情里有那个**独立的上传按钮**「上传并发布兼容包…」',
    dBtns.map((b) => b.textContent).join(' | ').slice(0, 120));
  // 「在下载按钮那一行」：同一个容器里既有下载按钮，也有这个上传按钮。
  const sameRow = find(detailBox, (n) => (n.children || []).some((c) => String(c.textContent).includes('下载 zip')))
    .some((n) => (n.children || []).some((c) => String(c.textContent).includes('上传并发布兼容包')));
  check(sameRow, '这个上传按钮与「下载 zip」按钮**在同一行**（同一个容器里）');
  if (upBtn) {
    upBtn.click();
    const formNodes = find(detailBox, (n) => String(n.textContent).includes('上传我改好的兼容包并发布'));
    check(formNodes.length > 0, '点了之后就地展开兼容包表单（不跳页）');
    const go2 = find(detailBox, (n) => n.tagName === 'button' && String(n.textContent) === '上传并发布')[0];
    check(!!go2, '表单底部那个按钮是「上传并发布」');
    const fileIn = find(detailBox, (n) => n.tagName === 'input' && n.type === 'file')[0];
    check(!!fileIn, '表单里有选 zip 的输入框');
    if (fileIn) fileIn.files = [{ name: 'compat.zip' }];
    const before = calls.length;
    if (go2) await go2.click();
    const submitCall = calls.slice(before).find((c) => c.u.includes('/compat-submit')) || null;
    check(!!submitCall, '点发布真的发出了 compat-submit 请求');
    const q = submitCall ? decodeURIComponent(submitCall.u) : '';
    check(/publish=1/.test(q), '而且带上了 `publish=1` —— 一步到位：上传 + 通过 + 发布', q.slice(0, 130));
    check(/compatOf=aaaa1111bbbb/.test(q), '并且把「由哪条投稿改来」带上了（compatOf = 当前这条）', q.slice(0, 130));
    const outText = find(detailBox, (n) => n.className === 'out kv').map((n) => String(n.textContent)).join(' ');
    check(/已发布上线/.test(outText), '页面上明确回报「已发布上线」', outText.replace(/\s+/g, ' ').slice(0, 80) + '…');
    check(/移出待审队列/.test(outText), '并说明原投稿已移出待审队列（B 口径：记录与文件都留着）',
      outText.replace(/\s+/g, ' ').slice(0, 110) + '…');
  }

  // ---------------------------------------------------------------- ③ 公网列表页
  console.log('\n③ 公网 /mods：署名两栏 + 「由投稿 … 改写来」那一行（compatOf 有值才画）');
  const modsRes = await fetch(`${BASE}/mods`);
  const modsHtml = await modsRes.text();
  const modsJson = await (await fetch(`${BASE}/api/mods`)).json();
  // 先钉住「服务器实际发出来的那份 HTML 里就带着这一行」：公网页是前端画的，
  // 所以这里查的是那份 HTML 里的渲染代码（文案 + 那个 id 前缀），不是渲染结果。
  check(modsHtml.includes('由投稿') && modsHtml.includes('改写来') && modsHtml.includes('compatof-'),
    '服务器发出来的 /mods HTML 里带着新加那一行的渲染代码（文案 + id 前缀 compatof-）');
  const modsBoot = bootInline(modsHtml, {
    fetchImpl: async (url) => (String(url).includes('/api/mods')
      ? { ok: true, status: 200, json: async () => modsJson }
      : { ok: true, status: 200, json: async () => ({}) }),
  });
  check(!modsBoot.threw, '/mods 的内联脚本顶层没抛错（服务器那份 HTML + 磁盘上的真实数据）',
    modsBoot.threw ? modsBoot.threw.message : '');
  await sleep(60);
  const modsList = modsBoot.dom.byId.get('list');
  const modsText = textOf(modsList).join(' ');
  check(/兼容改写者/.test(modsText), '署名两栏都画了出来（有「兼容改写者」这一栏）');
  check(/未填/.test(modsText), '兼容者为空时显示「未填」，没有把这一栏藏掉',
    (modsText.match(/.{0,18}未填.{0,18}/) || [''])[0]);
  check(!/Mo233/.test(modsText), '公网列表里也没有 Mo233');
  check(!/正在载入/.test(modsText), '公网列表不再停在「正在载入…」');

  // 【2026-10-11 业主批准：「加一行」】公网页每条 compat 记录多画一行「由投稿 … 改写来」。
  // 磁盘上的夹具 eeee3333ffff 带着 compatOf=aaaa1111bbbb，所以这一路吃的是**真实数据**。
  const ofLine = find(modsList, (n) => String(n.id || '').startsWith('compatof-'))[0] || null;
  check(!!ofLine, '公网 /mods 上画出了「由投稿 … 改写来」那一行',
    ofLine ? String(ofLine.textContent) : '（没找到这一行）');
  check(ofLine?.id === 'compatof-eeee3333ffff', '那一行带 id（compatof-<记录编号>）', String(ofLine?.id));
  check(ofLine?.textContent === '由投稿 aaaa1111bbbb 改写来（记录沿革，不是原作者署名）',
    '那一行写的是「由哪条投稿改来」，并点明不是署名', String(ofLine?.textContent));
  check(/原作者/.test(modsText) && /原作者甲/.test(modsText),
    '「原作者」那一栏照旧独立显示（没有被这一行挤掉或覆盖）');

  // 反面：compatOf 为空 ⇒ **整行不画**（不留「未知」「空」之类的占位）。
  // 用的是**同一份服务器发出来的 HTML**，只把数据换成一个 compatOf=null 的兼容包。
  const noOfBoot = bootInline(modsHtml, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      mods: [{ id: 'ffff9999aaaa', kind: 'compat', name: '没写由谁改来的兼容包', author: '原作者丙',
        compatAuthor: '维护者丙', compatOf: null, size: 1048576, uploadedAt: '2026-10-11T00:00:00.000Z',
        download: '/api/file/ffff9999aaaa' }],
      flagged: [],
    }) }),
  });
  check(!noOfBoot.threw, 'compatOf 为空那一份数据喂进同一个 DOM 桩也不抛错',
    noOfBoot.threw ? noOfBoot.threw.message : '');
  await sleep(60);
  const noOfList = noOfBoot.dom.byId.get('list');
  const noOfText = textOf(noOfList).join(' ');
  check(!/由投稿/.test(noOfText) && !/改写来/.test(noOfText),
    'compatOf 为空时那一行**整行不画**（没有「未知/空」占位）',
    (noOfText.match(/.{0,20}改写.{0,20}/) || [''])[0]);
  check(find(noOfList, (n) => String(n.id || '').startsWith('compatof-')).length === 0,
    '空值时连那个 id 都没有（不是画了个空的）');
  check(/兼容改写者/.test(noOfText) && /原作者丙/.test(noOfText),
    '空值时署名两栏照旧都在（不是把整块都省了）',
    (noOfText.match(/.{0,26}原作者丙.{0,26}/) || [''])[0]);

  // 【2026-10-11 补：普通投稿也要照包内 pack.json 读原作者】渲染层的三条边界。
  // 背景：`/api/mods` 现在对**普通投稿**也从包内 `pack.json` 现读 `author`（带 `authorSource:'pack.json'`），
  // 记录一个字节不改。这一页据此把署名框画出来 —— 但**只能画「原作者」这一栏**：
  // 普通投稿没有「兼容」这回事，画一行「兼容改写者：（未记）」就是编了一件事出来。
  // 喂进去的还是**服务器实际发出的那份 HTML**（`modsHtml`），只换数据。
  const cardsIn = async (modsArr) => {
    const b = bootInline(modsHtml, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ mods: modsArr, flagged: [] }) }),
    });
    if (b.threw) return { threw: b.threw };
    await sleep(30);
    const list = b.dom.byId.get('list');
    return {
      text: textOf(list).join(' '),
      sigs: find(list, (n) => String(n.className || '').split(/\s+/).includes('sig')),
      sigks: find(list, (n) => String(n.className || '').split(/\s+/).includes('sigk')),
    };
  };
  const normalAuthor = await cardsIn([{ id: '0ead812ea6b0', kind: 'submission', name: '连接与服务器状态',
    author: 'jingjiangze', authorSource: 'pack.json', compatAuthor: null, compatAuthorSource: null, compatOf: null,
    compatNote: null, note: null, suspected: false, size: 11965, uploadedAt: '2026-10-11T15:32:43.726Z',
    download: '/api/file/0ead812ea6b0' }]);
  check(!normalAuthor.threw, '普通投稿（包内有作者）喂进同一个 DOM 桩不抛错',
    normalAuthor.threw ? `${normalAuthor.threw.name}: ${normalAuthor.threw.message}` : '');
  check(/原作者/.test(normalAuthor.text) && /jingjiangze/.test(normalAuthor.text),
    '普通投稿的署名框**画出来了**，写的是「原作者 jingjiangze」',
    (normalAuthor.text.match(/.{0,20}jingjiangze.{0,10}/) || [''])[0]);
  check(!/兼容改写者/.test(normalAuthor.text),
    '但**没有**「兼容改写者」那一栏（普通投稿没有兼容这回事，也就没有「（未记）」这种占位）');
  check(!/兼容改写版/.test(normalAuthor.text) && !/兼容版/.test(normalAuthor.text),
    '也没有「兼容改写版」徽标', (normalAuthor.text.match(/.{0,10}兼容.{0,10}/) || [''])[0]);
  check(!/由投稿/.test(normalAuthor.text) && !/改写来/.test(normalAuthor.text),
    '也没有「由投稿 … 改写来」那一行');
  check(normalAuthor.sigs.length === 1, '署名块只有一个',
    `sig 节点 ${normalAuthor.sigs.length} 个`);
  check(normalAuthor.sigks.length === 1, '署名块里只有「原作者」**一个**标签（兼容者那一栏整栏不画）',
    `sigk 标签 ${normalAuthor.sigks.length} 个：` + normalAuthor.sigks.map((n) => n.textContent).join('/'));

  // 反面：包内**没写** author ⇒ `/api/mods` 给 null ⇒ 照旧**整块不画**（现行为不变）。
  const normalNoAuthor = await cardsIn([{ id: 'aaaa1111bbbb', kind: 'submission', name: '没写作者的普通投稿',
    author: null, authorSource: null, compatAuthor: null, compatOf: null, compatNote: null, note: null,
    suspected: false, size: 1024, uploadedAt: '2026-10-11T00:00:00.000Z', download: '/api/file/aaaa1111bbbb' }]);
  check(!normalNoAuthor.threw, '普通投稿（包内没写作者）喂进同一个 DOM 桩不抛错',
    normalNoAuthor.threw ? `${normalNoAuthor.threw.name}: ${normalNoAuthor.threw.message}` : '');
  check(!/原作者/.test(normalNoAuthor.text), '包内没写 author ⇒ 署名框**整块不画**（连「原作者」这个标签都不出现）');
  check(normalNoAuthor.sigs.length === 0, '一个 sig 节点都没画', `sig 节点 ${normalNoAuthor.sigs.length} 个`);

  // 正面反面都验完，再验**兼容包没被这次改动碰过** —— 三样照旧齐全（就拿线上那条的形状喂）。
  const compatCard = await cardsIn([{ id: 'a84e3a916517', kind: 'compat', name: '兼容改写版（自测夹具）',
    author: 'jingjiangze', authorSource: 'pack.json', compatAuthor: 'Mo233', compatAuthorSource: 'form',
    compatOf: 'e7b3b3e1751f', compatNote: null, note: null, suspected: false, size: 63524,
    uploadedAt: '2026-10-11T13:25:44.272Z', download: '/api/file/a84e3a916517' }]);
  check(!compatCard.threw, '兼容包那条喂进同一个 DOM 桩不抛错',
    compatCard.threw ? `${compatCard.threw.name}: ${compatCard.threw.message}` : '');
  check(/原作者/.test(compatCard.text) && /jingjiangze/.test(compatCard.text)
    && /兼容改写者/.test(compatCard.text) && /Mo233/.test(compatCard.text)
    && /由投稿 e7b3b3e1751f 改写来/.test(compatCard.text) && /兼容改写版/.test(compatCard.text),
    'compat 记录**照旧三样齐全**：原作者 + 兼容改写者 + 「由投稿 … 改写来」（外加「兼容改写版」徽标）',
    compatCard.text.replace(/\s+/g, ' ').slice(0, 120) + '…');
  check(compatCard.sigks.length === 2
    && compatCard.sigks[0].textContent === '原作者' && compatCard.sigks[1].textContent === '兼容改写者',
    '兼容包那一栏仍是**两行署名**（原作者 + 兼容改写者），没有被普通投稿那条改动挤成一栏',
    compatCard.sigks.map((n) => n.textContent).join(' / '));

  // 【2026-10-11 业主裁令 (a)：渲染层去重】两栏（`compatNote` / `note`）逐字相同 ⇒ **只画一次**。
  // 背景：站点的**存储层**在发布兼容包时把同一段文案同时写进两栏 —— 那是**有意为之**，
  // 谁都不许动（`/compat/note` 的注释里写着为什么）。所以重复不在数据里，在**渲染**里：
  // `mods.html` 早先两栏都画，同一段字就出现两遍。修法只在那一页的渲染层，判据一句话：
  //   两栏都非空且（规范化空白后）逐字相同 ⇒ 只画一次；只有一栏非空 ⇒ 画那一栏；
  //   两栏都空 ⇒ 这一块不画；两栏**不同** ⇒ 两段都画（不相同就不是重复，不许并掉）。
  // 拿**同一份服务器实际发出的 /mods HTML**（`modsHtml`）逐个喂进同一个 DOM 桩，只换数据。
  // 数的是 `note` 那一类节点 —— 它才是「画了一段字」这件事本身，比字符串出现次数硬。
  const noteNodesIn = async (modsArr) => {
    const b = bootInline(modsHtml, {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ mods: modsArr, flagged: [] }) }),
    });
    if (b.threw) return { threw: b.threw };
    await sleep(30);
    const probes = find(b.dom.byId.get('list'), (n) => String(n.className || '').split(/\s+/).includes('note'));
    return { probes, text: textOf(b.dom.byId.get('list')).join(' '), nodes: probes.length };
  };

  // ① 两栏**逐字相同**（就是线上 a84e3a916517 那条的形状）⇒ 那段文字**只出现 1 次**。
  const DUP = '【误伤无救济 · 装前必读】本包会改变对局结果，装前请读完这一段。';
  const dup = await noteNodesIn([{ id: 'a84e3a916517', kind: 'compat', name: '两栏逐字相同的兼容包',
    author: '原作者戊', compatAuthor: '维护者戊', compatOf: 'aaaa1111bbbb',
    compatNote: DUP, note: DUP, size: 4096, uploadedAt: '2026-10-11T00:00:00.000Z',
    download: '/api/file/a84e3a916517' }]);
  const dupHits = dup.probes ? dup.probes.filter((n) => textOf(n).join(' ').includes(DUP)).length : -1;
  check(dupHits === 1, '两栏逐字相同时，那段文字在渲染结果里**只出现 1 次**',
    `出现 ${dupHits} 次 · note 节点 ${dup.nodes} 个`);
  check(dup.nodes === 1, '两栏逐字相同时只画 1 个 note 节点（另一栏不再画一遍）', `note 节点 ${dup.nodes} 个`);
  check(/兼容说明：/.test(dup.text || ''), '相同时留的是「兼容说明」那一栏（带标签，语义栏优先）',
    ((dup.text || '').match(/.{0,8}兼容说明：.{0,16}/) || [''])[0]);

  // ② 只有一栏非空 ⇒ 画那一栏（1 次）。两种都有：只有 compatNote / 只有 note。
  const onlyCompat = await noteNodesIn([{ id: 'aaaabbbb0001', kind: 'compat', name: '只有兼容说明',
    author: '原作者己', compatAuthor: '维护者己', compatNote: '只有兼容说明这一栏有字。', note: null,
    size: 1024, uploadedAt: '2026-10-11T00:00:00.000Z', download: '/api/file/aaaabbbb0001' }]);
  check(onlyCompat.nodes === 1
    && onlyCompat.probes.some((n) => textOf(n).join(' ').includes('只有兼容说明这一栏有字。')),
    '只有 `compatNote` 非空 ⇒ 画那一栏、正好 1 次', `note 节点 ${onlyCompat.nodes} 个`);
  const onlyNote = await noteNodesIn([{ id: 'aaaabbbb0002', kind: 'compat', name: '只有备注',
    author: '原作者庚', compatAuthor: '维护者庚', compatNote: null, note: '只有备注这一栏有字。',
    size: 1024, uploadedAt: '2026-10-11T00:00:00.000Z', download: '/api/file/aaaabbbb0002' }]);
  check(onlyNote.nodes === 1 && onlyNote.probes.some((n) => textOf(n).join(' ').includes('只有备注这一栏有字。')),
    '只有 `note` 非空 ⇒ 画那一栏、正好 1 次', `note 节点 ${onlyNote.nodes} 个`);

  // ③ 两栏**不同** ⇒ **两段都出现**（不相同就不是重复，不许顺手并掉）。
  const diff = await noteNodesIn([{ id: 'aaaabbbb0003', kind: 'compat', name: '两栏不同',
    author: '原作者辛', compatAuthor: '维护者辛', compatNote: '兼容说明这一栏：改了 api 与 game。',
    note: '备注这一栏：另一段完全不同的话。', size: 1024, uploadedAt: '2026-10-11T00:00:00.000Z',
    download: '/api/file/aaaabbbb0003' }]);
  check(diff.nodes === 2, '两栏不同 ⇒ 两栏都画（画 2 个 note 节点），不许把不同内容也并掉',
    `note 节点 ${diff.nodes} 个`);
  check(diff.probes.some((n) => textOf(n).join(' ').includes('兼容说明这一栏：改了 api 与 game。'))
    && diff.probes.some((n) => textOf(n).join(' ').includes('备注这一栏：另一段完全不同的话。')),
    '两栏不同的两份文字在渲染结果里**都在**', JSON.stringify(diff.probes.map((n) => textOf(n).join(' ').slice(0, 12))));

  // ④ 两栏都空 ⇒ **不画**这一块（不留空 note 节点）。
  const bothEmpty = await noteNodesIn([{ id: 'aaaabbbb0004', kind: 'compat', name: '两栏都空',
    author: '原作者壬', compatAuthor: '维护者壬', compatNote: null, note: '',
    size: 1024, uploadedAt: '2026-10-11T00:00:00.000Z', download: '/api/file/aaaabbbb0004' }]);
  check(bothEmpty.nodes === 0, '两栏都空 ⇒ 这一块**不画**（没有空 note 节点、没有空块）',
    `note 节点 ${bothEmpty.nodes} 个`);
  check(!/兼容说明：/.test(bothEmpty.text || ''), '两栏都空时页面上连「兼容说明：」这个标签都没有');

  // ⑤ 只差空白（规范化后相同）⇒ 也算重复，只画一次；而且**展示的是原文**（正文一个字没被改写）。
  // 夹具得**真的只差空白**：两栏去掉首尾空白、把连续空白折叠成单空格之后要逐字相同。
  // 反例（别拿它当夹具）：`…只差空白。` 与 `…只差\n空白。` **不算**只差空白 —— 后者中间多一个空格，
  // 规范完仍不相等，那种情况照旧两段都画（就是上面第 ③ 条的意思）。
  const SPACE_A = '空格判定：这两段只差空白。';
  const SPACE_B = ' \t空格判定：这两段只差空白。\n';
  const sp = await noteNodesIn([{ id: 'aaaabbbb0005', kind: 'compat', name: '只差空白',
    author: '原作者癸', compatAuthor: '维护者癸', compatNote: SPACE_A, note: SPACE_B,
    size: 1024, uploadedAt: '2026-10-11T00:00:00.000Z', download: '/api/file/aaaabbbb0005' }]);
  check(sp.nodes === 1, '两栏只差空白（规范化后逐字相同）⇒ 同样只画一次', `note 节点 ${sp.nodes} 个`);
  check(sp.probes.length === 1 && String(sp.probes[0].textContent).endsWith(SPACE_A),
    '只画的那一段用的是**原文**（规范化只用于相等判定，不拿它改写展示的正文）',
    JSON.stringify(sp.probes.map((n) => n.textContent)));

  // 【2026-10-11 业主：公网上那条备注是假的】备注文案重写之后，公网**渲染出来的**必须是新文案。
  // 喂的是**服务器实际发出的那份 /mods HTML**（不是另写一份），数据换成「两栏都是新文案」的
  // 兼容包。两栏文案相同 ⇒ 按上面的去重判据**只画一次**（这一条原地改了语义：早先要的是 2 处，
  // 那是重复显示还没修的时候；现在同一段文案在整页渲染结果里**只许出现 1 次**）。
  // 两条一起钉住：新文案在、旧那句里的「链路实测」「不发布」不在，而且不重复。
  const NOTE_NEW = '兼容改写版：基于原投稿改写，原作者署名与许可原样保留。';
  const noteBoot = bootInline(modsHtml, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      mods: [{ id: 'aa11bb22cc33', kind: 'compat', name: '备注改写后的兼容包', author: '原作者丁',
        compatAuthor: '维护者丁', compatOf: 'aaaa1111bbbb', note: NOTE_NEW, compatNote: NOTE_NEW,
        size: 2048, uploadedAt: '2026-10-11T00:00:00.000Z', download: '/api/file/aa11bb22cc33' }],
      flagged: [],
    }) }),
  });
  check(!noteBoot.threw, '备注那一份公开数据喂进同一个 DOM 桩也不抛错',
    noteBoot.threw ? noteBoot.threw.message : '');
  await sleep(60);
  const noteText = textOf(noteBoot.dom.byId.get('list')).join(' ');
  check(noteText.includes(NOTE_NEW), '公网渲染出的备注是新文案',
    (noteText.match(/.{0,10}兼容改写版.{0,22}/) || [''])[0]);
  check(!/链路实测/.test(noteText) && !/不发布/.test(noteText),
    '公网渲染出的备注不含「链路实测」「不发布」',
    (noteText.match(/.{0,14}(链路实测|不发布).{0,14}/) || ['（没有，符合预期）'])[0]);
  check((noteText.match(/兼容改写版：基于原投稿改写，原作者署名与许可原样保留。/g) || []).length === 1,
    '这段文字在整页渲染结果里**只出现 1 次**（两栏相同 ⇒ 渲染层去重，不再画两遍）',
    `出现 ${(noteText.match(/兼容改写版：基于原投稿改写，原作者署名与许可原样保留。/g) || []).length} 次`);
} finally {
  child.kill();
  await sleep(200);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('');
if (failures) { console.log(`✖ ${failures} 项没通过`); process.exit(1); }
console.log('✔ 审核台页面：脚本跑到底 · 待审 / 已通过 / 已打回三页各归各位（三页相加 + 已隐藏 = 全部）· '
  + '每条记录一个「不再显示」勾选框（勾上三视图都不见、取消就回来，一次一个 id）· '
  + '兼容者空 = 未填 · 全站没有 Mo233 兜底 · /mods 多一行「由投稿 … 改写来」且备注是新文案、两栏相同只画一次');
