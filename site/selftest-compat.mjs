// 维护者侧「兼容包上传与发布」自测（不起真实站点、不联网、不部署）。
//
//   node site/selftest-compat.mjs
//
// 走的是完整那条链：**上传兼容包 → 三档检查 → 通过 → 公开列表**，并逐条钉住四条硬要求：
//   ① 入口在审核通道里（走 /api/<ADMIN_PATH>/compat-submit，要维护者身份）
//   ② 两个署名（原作者 / 兼容者）分开存、分开显示，互不覆盖
//   ③ 包自带的 pack.json 一字未改；「兼容者」不进包，只记站点侧
//   ④ 通过后公开可下的是**改写版**；原件留档（哈希 + 来源 + 由谁改来），不发布
//   ⑤ 公开页面上「由投稿 … 改写来」那一行（compatOf 有值才画；空值整行不画，不留占位）
//
// 「兼容者」的口径（业主 2026-10-11，上一版「预填 + 兜底 Mo233」已作废）：
//   **必填字段，但值可以为空** —— 缺字段 ⇒ 拒绝；空值 ⇒ 照收、如实存空、界面显示「未填」；
//   **任何路径都不许自动出现 `Mo233`**（它只可能是维护者手敲进去的字面值）。
//
// 用的是内部接口直连 + 磁盘文件核对：服务端明确不做「通过之前就能下改写版」这类事，
// 所以「通过前公网能不能下」也要单独断言。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'compat-selftest-token-0123456789';
const ADMIN_PATH = 'review-selftest';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- 极小 zip 写入器（store，含 CRC32）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

function makeZip(files) {
  const locals = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name); offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 起服务（临时数据目录）
const dataDir = mkdtempSync(join(tmpdir(), 'sp-compat-'));
// 默认跑本目录的 server.mjs。设 SP_SERVER_FILE 可以指到**另一份**（用来验证
// 「新加的断言在旧代码上确实是红的」—— 一条永远不会红的测试等于没有测）。
const SERVER_FILE = process.env.SP_SERVER_FILE || join(HERE, 'server.mjs');
/** DATA_DIR 根下的临时文件（上传中途留下的 .part）。正常应当**一个都没有**。 */
const partFiles = () => readdirSync(dataDir).filter((f) => f.endsWith('.part'));
/**
 * 采样「有没有 .part 残留」之前先等一小会儿。
 *
 * 为什么要等：服务端是**先在 finally 里 unlink、才让这一步结束**的，但那之前它已经
 * `res.end()` 了 —— 写入是同步试探着发的，客户端（本测试是另一个进程）完全可能在
 * 服务端跑到那行 unlink 之前就收到 400 并立刻 `readdir`。那一瞬间读到的不是「残留」，
 * 只是**采样太早**。这里统一等一小会儿再采，采到的才算数；真残留照样抓得到。
 */
const partFilesSettled = async () => { await sleep(250); return partFiles(); };
const child = spawn(process.execPath, [SERVER_FILE], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN, ADMIN_PATH, MAX_MB: '4', HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* 还没起 */ }
    await sleep(120);
  }
  return false;
};
const ADMIN = `/api/${ADMIN_PATH}`;
const adm = (p, opt = {}) => fetch(`${BASE}${p}`, { ...opt, headers: { 'x-admin-token': TOKEN, ...(opt.headers || {}) } });
const post = async (p, obj) => {
  const r = await adm(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

try {
  if (!(await waitUp())) { console.error('服务没起来：\n' + log); process.exit(1); }
  console.log(`临时数据目录：${dataDir}`);
  console.log(`审核入口：/${ADMIN_PATH} · 兼容包接口：${ADMIN}/compat-submit\n`);

  // ---------------- 0. 待审原件（改写的对象）
  console.log('⓪ 先有一个待审原件（组员投来的未兼容包，走既有公网上传页那条路）');
  const origZip = makeZip([
    { name: 'pack.json', data: '{\n  "id": "kaiser-pack",\n  "name": "凯尔希同人内容包",\n  "version": "0.9.0",\n  "author": "社区作者甲",\n  "license": "CC-BY-NC-4.0",\n  "description": "原作说明：这是社区作者甲做的内容包，含自制立绘与语音。",\n  "game": "0.1.x"\n}\n' },
    { name: 'ui/panel.js', data: 'export const v = 1;\n' },
  ]);
  const rOrig = await fetch(`${BASE}/api/submit?name=${encodeURIComponent('凯尔希同人内容包')}&note=${encodeURIComponent('来源：社区')}`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: origZip });
  const jOrig = await rOrig.json();
  check(rOrig.status === 201 && !!jOrig.id, '原件已作为普通投稿收下（待审）', `编号 ${jOrig.id} · ${jOrig.area}`);
  const origId = jOrig.id;
  // 原件里 pack.json 的 description 原文（改写版必须一字不动地保留它）
  const descText = '原作说明：这是社区作者甲做的内容包，含自制立绘与语音。';

  // ---------------- 1. 上传兼容包（原作者留空 → 应当被自动预填）
  console.log('\n① 维护者上传**已经兼容改写完**的包（原作者留空，等它从包里预填）');
  const compatZip = makeZip([
    { name: 'pack.json', data: '{\n  "id": "kaiser-pack",\n  "name": "凯尔希同人内容包",\n  "version": "0.9.0",\n  "author": "社区作者甲",\n  "license": "CC-BY-NC-4.0",\n  "description": "原作说明：这是社区作者甲做的内容包，含自制立绘与语音。",\n  "game": "0.2.x",\n  "api": ">=1 <2"\n}\n' },
    { name: 'ui/panel.js', data: 'export const v = 1;\nexport const patched = true;\n' },
    { name: 'bonds.json', data: '{}' },
  ]);
  const cq = new URLSearchParams({ name: '凯尔希同人内容包（兼容版）', compatAuthor: '维护者乙', author: '',
    compatOf: origId, originUrl: 'https://example.invalid/community/kaiser-pack', compatNote: '① game 抬到 0.2.x ② api 加上 >=1 <2 ③ 面板导出补 patched' });
  const rC1 = await adm(`${ADMIN}/compat-submit?${cq}`, {
    method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': encodeURIComponent('kaiser-compat.zip') }, body: compatZip,
  });
  const jC1 = await rC1.json();
  check(rC1.status === 201 && !!jC1.id, '上传成功并返回编号', `id=${jC1.id}`);
  const cid = jC1.id;
  check(jC1.author === '社区作者甲', '原作者**自动预填**自包里的 pack.json', String(jC1.author));
  check(jC1.authorSource === 'pack.json', '并且标出「这一栏是预填来的」', String(jC1.authorSource));
  check(jC1.compatAuthor === '维护者乙', '兼容者按填的记下', String(jC1.compatAuthor));
  check(jC1.description === descText, '原 description 在包里原样', JSON.stringify(jC1.description).slice(0, 40) + '…');
  check((jC1.flags || []).some((f) => f.level === 'info' && f.code === 'SIZE'), '三档检查跑过（有 info 的 SIZE）');
  check(jC1.suspected === false && jC1.area === 'compat', '不疑似、存在单独的 compat/ 区', `${jC1.area}`);

  // 磁盘上的形状：改写版 + 原件留档位 + 快照
  const cdir = join(dataDir, 'compat', cid);
  check(existsSync(join(cdir, 'mod.zip')) && existsSync(join(cdir, 'meta.json')) && existsSync(join(cdir, 'pack-json.orig.json')),
    '磁盘上是 compat/<编号>/{mod.zip, meta.json, pack-json.orig.json}');
  const cmeta = JSON.parse(readFileSync(join(cdir, 'meta.json'), 'utf8'));
  check(cmeta.author === '社区作者甲' && cmeta.compatAuthor === '维护者乙', '两个署名在 meta.json 里各占一栏');
  check(cmeta.packAuthor === '社区作者甲', '包里 pack.json 的 author 原样另记一份（留痕）');
  check(cmeta.origin && cmeta.origin.id === origId && cmeta.origin.verified === true,
    '「由谁改来」记下了，且原件的 sha256 与磁盘逐字节对得上', `origin.sha256=${String(cmeta.origin.sha256).slice(0, 16)}…`);
  const snap = JSON.parse(readFileSync(join(cdir, 'pack-json.orig.json'), 'utf8'));
  check(snap.pack.description === descText && snap.pack.license === 'CC-BY-NC-4.0',
    '原注释快照存下来了（description / license 一字未改）');
  check(createHash('sha256').update(readFileSync(join(cdir, 'mod.zip'))).digest('hex') === sha(compatZip),
    '改写版落盘与上传逐字节相同');

  // 「兼容者」不许进包：把改写版解出来看 pack.json
  const { readZipFile } = await import('./zip.mjs');
  const inZip = (await readZipFile(join(cdir, 'mod.zip'), ['pack.json'])).get('pack.json').toString('utf8');
  check(!/维护者乙|compatAuthor|compat_author|兼容者/i.test(inZip),
    '「兼容者」**没有**被塞进包的 pack.json（站点侧另存）');
  check(inZip.includes(descText) && inZip.includes('"author": "社区作者甲"'),
    '包里的 description 与 author 保持原样（一个字节没动）');

  // ---------------- 2. 通过 → 公开列表
  console.log('\n② 审核通过 → 公开列表');
  const before = await (await fetch(`${BASE}/api/mods`)).json();
  check(before.mods.length === 0, '通过前公开列表里没有它', `mods=${before.mods.length}`);
  const pubFile = await fetch(`${BASE}/api/file/${cid}`);
  check(pubFile.status === 403, '通过前公网下不到（要维护者身份）', String(pubFile.status));
  // 留档那条**独立性**：原件投稿的目录即使被清，本条的留档副本仍在。
  check(existsSync(join(cdir, 'orig.zip')), '上传时就把原件的字节**拷了一份**进本条目录（不是只留指针）');
  check(JSON.parse(readFileSync(join(cdir, 'meta.json'), 'utf8')).origin.archived === true,
    'meta 里标了 archived: true（留档确实落了）');

  const dlMod = await adm(`${ADMIN}/detail/${cid}`);
  const dMod = await dlMod.json();
  check(dMod.meta.kind === 'compat' && dMod.packJsonOrig?.pack?.description === descText,
    '审核详情里带着原注释快照（description 一字未改）');
  check(dMod.archiveDownload === `/api/file/${cid}?variant=orig`, '详情给出留档原件的入口', String(dMod.archiveDownload));
  const pubMods = await (await fetch(`${BASE}/mods.html`)).text();
  check(pubMods.includes('原作者') && pubMods.includes('兼容改写者'),
    '公网 /mods 页面上两栏都渲染出来、各自带标签（不是并成一栏、也不会被误当成作者）');
  // 【原地改语义 · 2026-10-11 业主批准「加一行」】上面那一条原来只钉「两栏署名都在」。
  // 同一个意图（公网页面把该说的都说全）往前推一步，把**新加的那一行**一起钉上：
  // 「由投稿 … 改写来」必须在那份 HTML 里，而且必须挂在 `m.compatOf` 这个条件上 ——
  // 有值才画、为空整行不画（空值那一路的行为断言在 selftest-admin.mjs 的 /mods DOM 桩里）。
  check(pubMods.includes('由投稿') && pubMods.includes('改写来') && /if\s*\(\s*m\.compatOf\s*\)/.test(pubMods),
    '公网 /mods 页面里带着新加那一行「由投稿 … 改写来」，且只在 compatOf 有值时画');

  // ---------------- 2b. 真正的通过
  console.log('\n②b 点通过');
  // ②b-0 新门（业主令 31）：本条的 pack.json 与**留档原件的根 pack.json** 不同
  //        （夹具里改的正是 compatNote 自己写的「① game 抬到 0.2.x ② api 加上 >=1 <2」）
  //        ⇒ 档位是 warn、但**发布/通过要显式 acknowledge**，不带必须 409。
  const noAck = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved' });
  check(noAck.status === 409 && noAck.body?.needsAcknowledge === true
    && (noAck.body?.flags || []).some((f) => f.code === 'COMPAT_PACKJSON_DIFFERS'),
    '②b-0 pack.json 与留档原件不一致 ⇒ 不带 acknowledge 一律 409（warn 档，需显式确认）',
    `HTTP ${noAck.status} · ${(noAck.body?.flags || []).map((f) => f.code).join(',')}`);
  const noAckText = String((noAck.body?.flags || [])[0]?.text || '');
  check(/game/.test(noAckText) && /api/.test(noAckText),
    '②b-0b 并且把差异键列了出来（game、api）', noAckText.slice(0, 96) + '…');
  const noAckDecPath = join(cdir, 'decision.json');
  const noAckDec = existsSync(noAckDecPath) ? JSON.parse(readFileSync(noAckDecPath, 'utf8')) : null;
  check(!noAckDec || noAckDec.decision !== 'approved',
    '②b-0c 被 409 拦下时状态**没变**（记录照留、没通过）', noAckDec ? String(noAckDec.decision) : '(没有 decision.json)');

  const dec = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved', reason: '本地走一遍', acknowledge: true });
  check(dec.status === 200, '通过成功', JSON.stringify(dec.body?.published || {}));
  check(dec.body?.author === '社区作者甲' && dec.body?.compatAuthor === '维护者乙', '返回里两个署名都在');

  const after = await (await fetch(`${BASE}/api/mods`)).json();
  const m = after.mods.find((x) => x.id === cid);
  check(!!m, '公开列表里出现了它');
  check(m.author === '社区作者甲' && m.compatAuthor === '维护者乙',
    '公开列表里**两个署名分开给**（原作者 + 兼容者）', `原作者=${m.author} · 兼容者=${m.compatAuthor}`);
  check(m.kind === 'compat', '公开列表标出这是兼容改写版');
  check(m.compatOf === origId, '公开数据里带着「由哪条投稿改写来」（compatOf —— 公网页那一行吃的就是它）', String(m.compatOf));
  check(m.download === `/api/file/${cid}`, '公开下载指向的正是这一条（改写版）', m.download);
  check(!!m.archiveDownload, '另外给了留档入口（只维护者能下）', m.archiveDownload);

  const pub = await fetch(`${BASE}/api/file/${cid}`);
  const pubBuf = Buffer.from(await pub.arrayBuffer());
  check(pub.status === 200 && sha(pubBuf) === sha(compatZip),
    '公开下载下来的**就是改写版**（sha256 与上传的改写版一致）');
  check(sha(pubBuf) !== sha(origZip), '而且**不是**原件（两份哈希不同）');
  // 把原件投稿的目录挪走，证明留档副本真的独立
  const stashDir = join(dataDir, '_stash');
  const origDir = join(dataDir, 'submissions', origId);
  mkdirSync(stashDir, { recursive: true });
  try {
    renameSync(origDir, join(stashDir, origId));
  } catch { /* 挪不动就跳过这条 */ }
  const stillThere = await adm(`${ADMIN}/detail/${cid}?variant=orig`);
  check(stillThere.status === 200, '把原件投稿目录挪走后，留档副本照样下得到（留档不依赖那条投稿）', String(stillThere.status));
  try { renameSync(join(stashDir, origId), origDir); } catch { /* 挪回去 */ }

  // ---------------- 3. 反例
  console.log('\n③ 反例：该被拦的都得被拦');

  // 反例 1：「兼容者」的口径 —— **必填字段，但值可以为空**（业主 2026-10-11 改口径；
  //         上一版「表单预填 + 服务端兜底 Mo233」**已作废**）。
  // ①a 报文里**缺这个字段** → 拒绝（必填字段）
  const e1b = await adm(`${ADMIN}/compat-submit?name=${encodeURIComponent('连字段都没带的包')}&compatOf=${origId}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: compatZip,
  });
  const j1b = await e1b.json();
  check(e1b.status === 400 && j1b.needsCompatAuthor === true,
    '①a 报文里**缺 compatAuthor 字段** → 400 拒绝（必填字段，理由点名「缺少兼容者字段」）',
    `HTTP ${e1b.status} · ${String(j1b.error).slice(0, 40)}…`);
  // ①b 字段在、值为空 → 收下，如实存空（空 = 未填，合法）
  const e1q = new URLSearchParams({ name: '兼容者留空的包', compatAuthor: '', compatOf: origId, originUrl: 'https://example.invalid/x' });
  const e1 = await adm(`${ADMIN}/compat-submit?${e1q}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: compatZip,
  });
  const j1 = await e1.json();
  check(e1.status === 201 && j1.compatAuthor === '' && j1.compatAuthorSource === 'empty',
    '①b 字段在、**值为空** → 收下，如实存空字符串（来源 empty = 未填）',
    `HTTP ${e1.status} · 兼容者=${JSON.stringify(j1.compatAuthor)}（来源 ${j1.compatAuthorSource}）`);
  const c1e = JSON.parse(readFileSync(join(dataDir, 'compat', j1.id, 'meta.json'), 'utf8'));
  check(c1e.compatAuthor === '' && !('compatAuthorDefault' in c1e),
    '①b2 meta.json 里 compatAuthor 就是空字符串，且**没有** compatAuthorDefault 这种兜底字段',
    JSON.stringify(c1e.compatAuthor));
  check((c1e.flags || []).some((f) => f.code === 'COMPAT_AUTHOR_EMPTY' && f.level === 'info'),
    '①b3 空值记了一条 info（COMPAT_AUTHOR_EMPTY）—— 「未填」在页面上看得见，不是被悄悄略过');
  // ①c 手敲 Mo233 → 存 Mo233（来源 form：跟兜底无关，就是人敲的字面值）
  const e1c = await adm(`${ADMIN}/compat-submit?${new URLSearchParams({ name: '手敲 Mo233 的包', compatAuthor: 'Mo233', compatOf: origId, originUrl: 'https://example.invalid/x' })}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: compatZip,
  });
  const j1c = await e1c.json();
  check(e1c.status === 201 && j1c.compatAuthor === 'Mo233' && j1c.compatAuthorSource === 'form',
    '①c 手敲 Mo233 → 存 Mo233，来源是 form（说明它是人填的，不是兜底来的）',
    `${j1c.compatAuthor}（来源 ${j1c.compatAuthorSource}）`);
  // ①d 填了别人就以填的为准
  check(jC1.compatAuthor === '维护者乙' && jC1.compatAuthorSource === 'form',
    '①d 填了别人就用填的', `${jC1.compatAuthor}（来源 ${jC1.compatAuthorSource}）`);
  // ①e **任何路径都不会自动产生 Mo233** —— 把这次测试期间落盘的每一条 meta.json 全翻一遍：
  //     出现 `Mo233` 的记录数，必须**恰好等于**「兼容者那一栏就是人敲的 Mo233」的条数。
  const allMeta = [];
  for (const area of ['submissions', 'flagged', 'compat']) {
    const root = join(dataDir, area);
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const p = join(root, d, 'meta.json');
      if (existsSync(p)) allMeta.push({ area, id: d, meta: JSON.parse(readFileSync(p, 'utf8')) });
    }
  }
  const withMo = allMeta.filter((x) => JSON.stringify(x.meta).includes('Mo233'));
  const typedMo = allMeta.filter((x) => x.meta.compatAuthor === 'Mo233');
  check(withMo.length === typedMo.length && typedMo.length === 1,
    `①e 站上出现 Mo233 的记录 ${withMo.length} 条，全部都是人敲进去的那 1 条 —— 没有一条是自动加上去的`,
    `落盘记录 ${allMeta.length} 条 · 带 Mo233 ${withMo.length} 条 · 手敲的 ${typedMo.length} 条`);
  const emptyOnes = allMeta.filter((x) => x.meta.kind === 'compat' && x.meta.compatAuthor === '');
  check(emptyOnes.length >= 1 && emptyOnes.every((x) => !JSON.stringify(x.meta).includes('Mo233')),
    `①f 兼容者为**空**的 ${emptyOnes.length} 条记录里，一个字都没有 Mo233（空就是空，没被顶替）`);
  check(!('compatAuthorDefault' in j1) && !('compatAuthorDefault' in jC1),
    '①g 上传响应里也不再出现 compatAuthorDefault 这个兜底字段');

  // 反例 2：原作者既没填、包里也没有 author
  const noAuthorZip = makeZip([{ name: 'pack.json', data: '{"id":"x","name":"没作者","description":"d"}' }]);
  const e2q = new URLSearchParams({ name: '没原作者的包', compatAuthor: '维护者乙', compatOf: origId, originUrl: 'https://example.invalid/y' });
  const e2 = await adm(`${ADMIN}/compat-submit?${e2q}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: noAuthorZip,
  });
  const j2 = await e2.json();
  check(e2.status === 400 && j2.needsAuthor === true,
    '② 原作者取不到（包里没 author、人也没填）→ 400 被拦', `HTTP ${e2.status} · ${j2.error?.slice(0, 46)}…`);

  // 反例 3：不是成品包（没有 pack.json）→ 400 被拦。
  //         **顺带钉死一件事**：被拒的上传不许在 DATA_DIR 里留下 .part 临时文件。
  //         （2026-10-11 线上实测踩过：这条 400 的 return 在 writeFileSync 之后且无清理，
  //           每被拒一次就在数据目录根下攒一个 <id>.compat.part。）
  const partsBefore = await partFilesSettled();
  const e3q = new URLSearchParams({ name: '没有 pack.json 的包', compatAuthor: '维护者乙' });
  const e3 = await adm(`${ADMIN}/compat-submit?${e3q}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: makeZip([{ name: 'readme.txt', data: 'hi' }]),
  });
  check(e3.status === 400, '③ 没有 pack.json（不是成品包）→ 400 被拦', (await e3.json()).error?.slice(0, 40) + '…');
  const partsAfter = await partFilesSettled();
  check(partsAfter.length === partsBefore.length,
    '③b 被拒的上传**不留 .part 临时文件**（任何失败路径都要清干净）',
    `拒绝前 ${partsBefore.length} 个 · 拒绝后 ${partsAfter.length} 个`
      + (partsAfter.length ? ` · 残留：${partsAfter.join('、')}` : ''));
  // 同一件事再从「临时文件有没有变成正式记录」那头看一眼：被拒的包不该多出一条记录。
  check(!existsSync(join(dataDir, 'compat', 'nonexistent')) && partsAfter.length === 0,
    '③c DATA_DIR 根下此刻一个 .part 都没有');

  // 反例 4：三档检查的 blocker 仍然独立生效（夹带可执行文件）
  const e4q = new URLSearchParams({ name: '夹带脚本的兼容包', compatAuthor: '维护者乙', compatOf: origId, originUrl: 'https://example.invalid/z' });
  const e4 = await adm(`${ADMIN}/compat-submit?${e4q}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' },
    body: makeZip([{ name: 'pack.json', data: '{"id":"e","name":"e","author":"甲","description":"d"}' }, { name: 'run.ps1', data: 'x' }]),
  });
  const j4 = await e4.json();
  check(e4.status === 201 && j4.suspected === true, '④ 三档检查复用：夹带 .ps1 → suspected（照收但标注）');
  check((j4.flags || []).some((f) => f.level === 'blocker' && f.code === 'EXECUTABLE'), '而且 blocker 的 EXECUTABLE 明确报出来');

  // 反例 5（2026-10-11 改口径：原来是反例，现在是**放宽后的正例**）
  //   旧断言：`e5.status === 409 && e5.body?.needsOrigin === true` —— 「第三方包没写来源/由谁改来 → 409 不许通过」。
  //   新语义：业主口径「第三方来源也能为空，因为大部分备注里都有了」⇒ 来源留空**允许通过**（不再 409）。
  //   这条断言**没有被删掉**，是原地改成新口径，并且顺手把「放宽不该拆掉别的门」测出来：
  //   同一批里 encore 断言原作者仍不许为空（⑩e）、原注释快照仍不许被盖（⑥b）、sha 仍要对上（⑥a）。
  console.log('   （反例 5 → 正例：只填了署名、来源留空 → 允许通过（旧版这里 409））');
  const c5q = new URLSearchParams({ name: '无来源的兼容包', compatAuthor: '维护者乙', author: '社区作者丙' });
  const r5 = await adm(`${ADMIN}/compat-submit?${c5q}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' },
    body: makeZip([{ name: 'pack.json', data: '{"id":"n","name":"n","author":"社区作者丙","description":"d"}' }]),
  });
  const j5 = await r5.json();
  check(r5.status === 201 && j5.author === '社区作者丙', '上传先收下（来源可以随后补）', `id=${j5.id}`);
  // 上传时仍然**如实报一条 info**：来源这一栏是空的（只是不再拦人）。
  const c5dir = join(dataDir, 'compat', j5.id);
  const c5meta = JSON.parse(readFileSync(join(c5dir, 'meta.json'), 'utf8'));
  check((c5meta.flags || []).some((f) => f.code === 'ORIGIN_URL_MISSING' && f.level === 'info'),
    '⑤a 来源留空仍然如实标一条 info 的 ORIGIN_URL_MISSING（看得见，但不拦）');
  check(!c5meta.origin && !c5meta.originUrl, '⑤b 记录里来源这两栏确实是空的（没有代填任何值）',
    `origin=${JSON.stringify(c5meta.origin)} · originUrl=${JSON.stringify(c5meta.originUrl)}`);
  const e5 = await post(`${ADMIN}/compat/decide`, { id: j5.id, decision: 'approved' });
  check(e5.status === 200 && e5.body?.state === 'approved',
    '⑤c 第三方来源为空 → 200 通过（**旧版这里是 409 needsOrigin**；放宽的就是这一个门）',
    `HTTP ${e5.status} · ${e5.body?.error || ''}`);
  check(e5.body?.author === '社区作者丙' && !!e5.body?.compatAuthor,
    '⑤d 放宽来源这一栏**没有**动署名两栏（原作者与兼容者照样各占一栏）',
    `${e5.body?.author} / ${e5.body?.compatAuthor}`);
  const c5after = JSON.parse(readFileSync(join(c5dir, 'meta.json'), 'utf8'));
  const c5snap = JSON.parse(readFileSync(join(c5dir, 'pack-json.orig.json'), 'utf8'));
  check(c5snap.pack?.description === 'd' && c5after.author === '社区作者丙',
    '⑤e 通过后原注释快照与原作者栏都原样（放宽来源 ≠ 放宽「原作者」「原 description」那两道硬门）');
  const c5mods = await (await fetch(`${BASE}/api/mods`)).json();
  const c5pub = c5mods.mods.find((x) => x.id === j5.id);
  check(!!c5pub && c5pub.author === '社区作者丙',
    '⑤f 它也真的上了公开列表（/api/mods），两栏署名都在', JSON.stringify({ a: c5pub?.author, c: c5pub?.compatAuthor }));

  // 反例 6：试图用改写版覆盖掉原 description
  console.log('   （反例 6：偷换成 description 改过的包 → 通过时 409）');
  const tampered = Buffer.from(compatZip);
  const idx = tampered.indexOf(Buffer.from(descText, 'utf8'));
  check(idx > 0, '（测试自备：能定位到原文里的 description 字节）');
  // 原文 30 个汉字 × 3 字节 = 90 字节，换成同样 90 字节的 ASCII，
  // 于是 CRC 与压缩后长度都不变 —— 「包被换过」不可能靠 zip 自身露出来，只有原件快照能挡。
  const swapped = Buffer.alloc(Buffer.byteLength(descText, 'utf8'), 0x2e);
  swapped.write('TAMPERED-DESC-OVERWRITTEN-BY-THE-COMPAT-PACKAGER', 0, 'utf8');
  check(swapped.length === Buffer.from(descText, 'utf8').length,
    `（测试自备：换进去的字节数与原文一样 —— ${swapped.length} 字节，zip 结构上查不出来）`);
  swapped.copy(tampered, idx);
  writeFileSync(join(cdir, 'mod.zip'), tampered);

  // 6a：连 sha256 那条也对不上了 → 直接拦
  const e6 = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved', acknowledge: true });
  check(e6.status === 409 && e6.body?.needsResha === true,
    '⑥a 改写版被动过（sha256 对不上）→ 409 被拦', `HTTP ${e6.status} · ${e6.body?.error}`);
  // 6b：把记录里的 sha256 也一起改成被改过的版本（假装一切正常）→ 原件快照仍然拦住
  const metaFix = JSON.parse(readFileSync(join(cdir, 'meta.json'), 'utf8'));
  metaFix.sha256 = sha(tampered);
  writeFileSync(join(cdir, 'meta.json'), JSON.stringify(metaFix, null, 2));
  const e6c = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved', acknowledge: true });
  check(e6c.status === 409 && e6c.body?.needsPackUnchanged === true,
    '⑥b 把 sha 记录也一并改掉 → 仍被原注释快照拦住（这就是快照存在的意义）',
    `HTTP ${e6c.status} · ${e6c.body?.error}`);
  console.log(`      服务端点名的差异：description 快照=${JSON.stringify(e6c.body?.changed?.description?.snapshot)?.slice(0, 20)}… `
    + `现在=${JSON.stringify(e6c.body?.changed?.description?.now)}`);
  // 还原（这份包本来就是自造的，不能留着被改过的版本）；sha 记录也一并还原，
  // 好让下面这条只考「原注释快照」这一道，而不是又被 sha 那道先拦下。
  writeFileSync(join(cdir, 'mod.zip'), compatZip);
  metaFix.sha256 = sha(compatZip);
  writeFileSync(join(cdir, 'meta.json'), JSON.stringify(metaFix, null, 2));
  const e6b = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved', reason: '原样放回', acknowledge: true });
  check(e6b.status === 200, '⑥c 把原样的包放回去 → 又能通过（证明拦的就是「改写版盖掉原注释」那一次）',
    `HTTP ${e6b.status}${e6b.status === 200 ? '' : ' · ' + e6b.body?.error ?? ''}`);

  // 反例 7：拿通用的 decide 接口放兼容包过去 → 400
  const e7 = await post(`${ADMIN}/decide`, { id: cid, decision: 'approved' });
  check(e7.status === 400 && /compat\/decide/.test(String(e7.body?.error)),
    '⑦ 用普通的 /decide 走兼容包 → 400（不许绕开双署名与留档检查）', `HTTP ${e7.status}`);

  // 反例 8：留档原件不对外
  const e8 = await fetch(`${BASE}/api/file/${cid}?variant=orig`);
  check(e8.status === 403, '⑧ 公网取留档原件 → 403（原件不发布）', String(e8.status));
  const e8b = await adm(`${ADMIN}/detail/${cid}?variant=orig`);
  check(e8b.status === 200, '⑧b 维护者能看留档原件那一份的包内结构', String(e8b.status));
  const e8c = await adm(`${ADMIN}/detail/${origId}`);
  check(e8c.status === 200, '⑧c 被改写的原件本身仍在下（原始留档没被动过）', String(e8c.status));
  const e8d = await fetch(`${BASE}/api/file/${origId}`);
  check(e8d.status === 403, '⑧d 而它作为普通待审包，公网同样下不到', String(e8d.status));

  // 反例 9：没令牌 / 篡改 variant
  const e9 = await fetch(`${BASE}${ADMIN}/compat-submit`, { method: 'POST', headers: { 'content-type': 'application/zip' }, body: compatZip });
  check(e9.status === 401, '⑨ 不带令牌上传兼容包 → 401（入口在维护者身份后面）', String(e9.status));
  const e9b = await adm(`${ADMIN}/compat-submit?name=x&compatAuthor=y`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: Buffer.from('这不是 zip'),
  });
  check(e9b.status === 400, '⑨b 非 zip → 400', String(e9b.status));
  const e9c = await adm(`${ADMIN}/detail/${cid}?variant=../..`, {});
  check(e9c.status === 200 || e9c.status === 400, '⑨c variant 只认 mod / orig（别的值不穿路径）', String(e9c.status));

  // ---------------- 4. 署名不互相覆盖：原作者≠兼容者时两栏都在
  console.log('\n④ 署名互不覆盖：原作者与兼容者连一行都不并');
  const finalMods = await (await fetch(`${BASE}/api/mods`)).json();
  const fm = finalMods.mods.find((x) => x.id === cid);
  check(fm.author === '社区作者甲' && fm.compatAuthor === '维护者乙',
    '通过之后再查，两栏仍是两个不同的值', `${fm.author} / ${fm.compatAuthor}`);
  const dFinal = await (await adm(`${ADMIN}/detail/${cid}`)).json();
  check(dFinal.meta.author === '社区作者甲' && dFinal.meta.compatAuthor === '维护者乙',
    '站点侧记录里也各占一栏');
  // 署名/来源在上传后补过的话，要记进 revisions（上传时没填全、通过前才补的情形）。
  // 造一条「老记录」：把 compatAuthor 拿掉，再走一次通过 → 补的动作应当被记下来。
  const beforeRev = JSON.parse(readFileSync(join(cdir, 'meta.json'), 'utf8'));
  delete beforeRev.compatAuthor;
  delete beforeRev.revisions;
  writeFileSync(join(cdir, 'meta.json'), JSON.stringify(beforeRev, null, 2));
  const e10 = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved', compatAuthor: '维护者乙', acknowledge: true });
  check(e10.status === 200, '⑩ 给老记录补上兼容者 → 能通过', `HTTP ${e10.status}`);
  const afterRev = JSON.parse(readFileSync(join(cdir, 'meta.json'), 'utf8'));
  check(Array.isArray(afterRev.revisions) && afterRev.revisions.length === 1
    && afterRev.revisions[0].to.compatAuthor === '维护者乙',
    '补的动作记进了 revisions（谁在什么时候把哪一栏从什么改成什么）',
    JSON.stringify(afterRev.revisions?.[0]?.to || {}));
  // 「兼容者」必填但**值可以为空**：抹成空是合法操作（空 = 未填），不再被拦。
  const e10b = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved', compatAuthor: '', acknowledge: true });
  check(e10b.status === 200,
    '⑩b 把兼容者抹成**空** → 200 通过（空 = 未填，合法；上一版这里是要拦人的）', `HTTP ${e10b.status}`);
  const cleared = JSON.parse(readFileSync(join(cdir, 'meta.json'), 'utf8'));
  check(cleared.compatAuthor === '' && !JSON.stringify(cleared).includes('Mo233'),
    '⑩c 抹空之后存的就是空字符串，也没有冒出一个 Mo233 来顶替', JSON.stringify(cleared.compatAuthor));
  check((cleared.revisions || []).length === 2,
    '⑩d 两次改动（补上 → 抹空）都记进了 revisions', String((cleared.revisions || []).length));
  // 硬门没被这次放宽拆掉：**原作者**为空照样拦。
  const keepAuthor = cleared.author;
  cleared.author = '';
  writeFileSync(join(cdir, 'meta.json'), JSON.stringify(cleared, null, 2));
  const e10e = await post(`${ADMIN}/compat/decide`, { id: cid, decision: 'approved', compatAuthor: '', acknowledge: true });
  check(e10e.status === 409 && e10e.body?.needsSignatures === true,
    '⑩e 原作者为空 → 照样 409 拦下（硬门还在：只是「兼容者」那一条不再算硬门）',
    `HTTP ${e10e.status} · ${String(e10e.body?.error).slice(0, 34)}…`);
  cleared.author = keepAuthor;
  writeFileSync(join(cdir, 'meta.json'), JSON.stringify(cleared, null, 2));

  console.log('\n⑤ 普通投稿那条路没被碰：仍然只有普通投稿，数一数');
  const finalList = await (await adm(`${ADMIN}/list`)).json();
  const comps = finalList.submissions.filter((s) => s.kind === 'compat');
  const normals = finalList.submissions.filter((s) => s.kind !== 'compat');
  // 兼容包 5 条 = 主链那条 + ①b 空兼容者 + ①c 手敲 Mo233 + ④ 夹带脚本 + ⑤ 来源留空（放宽后新收下并已通过）；
  // 普通投稿 1 条（被改写的原件那条）。被 400 拦下的（①a 缺字段、② 没原作者、③ 没 pack.json）不留记录。
  check(comps.length === 5 && normals.length === 1, `兼容包 ${comps.length} 条 · 普通投稿 ${normals.length} 条`,
    `编号：${comps.map((c) => c.id).join(',')} | ${normals.map((c) => c.id).join(',')}`);
  const pubHtml = await (await fetch(`${BASE}/`)).text();
  check(pubHtml.includes('/api/submit'), '公网上传页 / 仍是原来那个 /api/submit（没动）');

  // ---------------- 6. 一步到位（业主 2026-10-11 新口径）
  //   投稿详情页（下载按钮那一行）那个**独立的上传按钮**：选 zip → 填名 → 点发布
  //   ⇒ 一次动作 = 上传 + 通过 + 发布；同时原投稿按 **B 口径**标 superseded、移出待审队列，
  //     但**记录与文件一个都不许少**（这就是「投稿也不是、打回也不是」的解药）。
  //
  // 这一节自己起**第二个**服务实例：本机回环的限流是「每 10 分钟 10 次上传」，
  // 上面那些用例已经把额度用到第 10 次，再加一次会被 429 拦掉 —— 那不是本节要测的东西。
  // 换端口 = 换进程 = 一份新的限流计数；数据目录还是同一个（记录照旧只增不减）。
  console.log('\n⑥ 一步到位：详情页那个按钮 = 上传 + 通过 + 发布（publish=1），原投稿按 B 口径标 superseded');
  const P2 = PORT + 10;
  const BASE2 = `http://127.0.0.1:${P2}`;
  const child2 = spawn(process.execPath, [SERVER_FILE], {
    env: { ...process.env, PORT: String(P2), DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN, ADMIN_PATH, MAX_MB: '4', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log2 = '';
  child2.stdout.on('data', (d) => { log2 += d; });
  child2.stderr.on('data', (d) => { log2 += d; });
  try {
    let up2 = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE2}/healthz`)).ok) { up2 = true; break; } } catch { /* 还没起 */ }
      await sleep(120);
    }
    if (!up2) throw new Error('第二个实例没起来：\n' + log2);
    const adm2 = (p, opt = {}) => fetch(`${BASE2}${p}`, { ...opt, headers: { 'x-admin-token': TOKEN, ...(opt.headers || {}) } });
    const post2 = async (p, obj) => {
      const r = await adm2(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };

    // 造一条**新的**待审原件（不动上面那条），并记下它两个文件的 sha256：
    //   · meta.json —— 按 B 口径**一个字节都不许变**（记录保留）
    //   · mod.zip   —— 包体也必须原样留着（文件一个都不许删）
    const descOne = '原注释：这一栏不许被改写版覆盖。';
    const packOne = (extra) => '{\n  "id": "onelick",\n  "name": "一步到位原件",\n  "version": "1.0.0",\n'
      + '  "author": "社区作者丁",\n  "license": "CC-BY-NC-4.0",\n'
      + `  "description": "${descOne}"\n` + (extra || '') + '}\n';
    const origZip2 = makeZip([
      { name: 'pack.json', data: packOne() },
      { name: 'ui/a.js', data: 'export const a = 1;\n' },
    ]);
    const rO2 = await fetch(`${BASE2}/api/submit?name=${encodeURIComponent('一步到位原件')}`, {
      method: 'POST', headers: { 'content-type': 'application/zip' }, body: origZip2 });
    const jO2 = await rO2.json();
    const origId2 = jO2.id;
    const o2dir = join(dataDir, 'submissions', origId2);
    const o2metaSha = sha(readFileSync(join(o2dir, 'meta.json')));
    const o2blobSha = sha(readFileSync(join(o2dir, 'mod.zip')));
    check(rO2.status === 201, '① 先有一条新的待审原件', `编号 ${origId2}`);
    const listBefore = await (await adm2(`${ADMIN}/list`)).json();
    const rowBefore = listBefore.submissions.find((s) => s.id === origId2);
    check(!!rowBefore && rowBefore.state === 'pending' && !existsSync(join(o2dir, 'decision.json')),
      '② 发布前：原投稿是 pending、还没有 decision.json', `state=${rowBefore?.state}`);

    // 一次动作：compat-submit?publish=1（详情页那个按钮打的就是它）
    const compatZip2 = makeZip([
      { name: 'pack.json', data: packOne('  ,"api": ">=1 <2"\n') },
      { name: 'ui/a.js', data: 'export const a = 1;\nexport const compat = true;\n' },
    ]);
    const q2 = new URLSearchParams({ name: '一步到位原件（兼容版）', compatAuthor: '', author: '',
      compatOf: origId2, compatNote: '一步到位测试', publish: '1', acknowledge: '1' });
    const rP = await adm2(`${ADMIN}/compat-submit?${q2}`, {
      method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': encodeURIComponent('onelick.zip') }, body: compatZip2 });
    const jP = await rP.json();
    const cid2 = jP.id;
    check(rP.status === 201 && jP.state === 'approved',
      '③ 一次动作就发布：compat-submit?publish=1 → state=approved', `HTTP ${rP.status} · state=${jP.state}`);
    check(!!jP.published && jP.published.file === 'onelick.zip', '④ 响应里点名发布了哪一个文件', JSON.stringify(jP.published));
    check(!!cid2 && cid2 !== origId2, '⑤ 兼容包是**另起的一条记录**（新编号）', `${origId2} → ${cid2}`);
    check(jP.compatAuthor === '' && jP.compatAuthorSource === 'empty',
      '⑤b 兼容者留空 = 如实记「未填」，没有冒出任何名字', JSON.stringify(jP.compatAuthor));

    const modsP = await (await fetch(`${BASE2}/api/mods`)).json();
    const pubP = modsP.mods.find((x) => x.id === cid2);
    check(!!pubP, '⑥ 兼容包**已经上线**，出现在公网 /api/mods 里', `mods=${modsP.mods.length}`);
    check(pubP && pubP.compatOf === origId2, '⑦ 公开记录里带着「由哪条投稿改来」（compatOf）', String(pubP?.compatOf));
    check(!modsP.mods.some((x) => x.id === origId2), '⑧ 原投稿**没有**跟着上线（公网只有改写版那一份）');
    const pubFile2 = await fetch(`${BASE2}/api/file/${cid2}`);
    check(pubFile2.status === 200 && sha(Buffer.from(await pubFile2.arrayBuffer())) === sha(compatZip2),
      '⑧b 公网下到的确实是改写版那一份（sha256 与上传的改写版一致）');

    // 原投稿按 B 口径：superseded + 指向兼容包；**记录与文件一个字节都不许少**
    const o2decPath = join(o2dir, 'decision.json');
    check(existsSync(o2decPath), '⑨ 原投稿多了一份 decision.json（记下「已被取代」，不是删记录）');
    const o2dec = JSON.parse(readFileSync(o2decPath, 'utf8'));
    check(o2dec.decision === 'superseded', '⑩ 原投稿状态 = superseded（不再是 pending：移出待审队列）', String(o2dec.decision));
    check(o2dec.replacedBy && o2dec.replacedBy.id === cid2 && o2dec.replacedBy.area === 'compat',
      '⑪ 并且写明「由哪条兼容包取代」（可追溯）', JSON.stringify(o2dec.replacedBy));
    check(sha(readFileSync(join(o2dir, 'meta.json'))) === o2metaSha,
      '⑫ 原投稿的 meta.json **一字未变**（记录原样保留）');
    check(sha(readFileSync(join(o2dir, 'mod.zip'))) === o2blobSha,
      '⑬ 原投稿的包体 mod.zip **一个字节没动**（文件一个都没删）');
    const listAfter = await (await adm2(`${ADMIN}/list`)).json();
    const rowAfter = listAfter.submissions.find((s) => s.id === origId2);
    check(!!rowAfter && rowAfter.state === 'superseded',
      '⑭ 列表接口里它还在（可追溯），但状态已经不是 pending（＝不在待审队列）', `state=${rowAfter?.state}`);
    const pend = listAfter.submissions.filter((s) => (s.decision?.decision || s.state || 'pending') === 'pending');
    check(!pend.some((s) => s.id === origId2), '⑮ 待审队列里已经没有它了',
      `待审 ${pend.length} 条：${pend.map((s) => s.id).join(',')}`);

    // 包这一侧：发布出去的那一份，pack.json 与快照一字不差；站点侧的东西没被塞进包
    const c2dir = join(dataDir, 'compat', cid2);
    const snap2 = JSON.parse(readFileSync(join(c2dir, 'pack-json.orig.json'), 'utf8'));
    const inZip2 = (await readZipFile(join(c2dir, 'mod.zip'), ['pack.json'])).get('pack.json').toString('utf8');
    check(snap2.pack.description === descOne && inZip2.includes(descOne),
      '⑯ 发出去的这一份里，原注释与快照一字不差（原 description 没被覆盖）');
    check(!/compatAuthor|兼容者|一步到位测试/.test(inZip2),
      '⑰ 「兼容者」与站点侧的兼容说明都没被塞进包里（只记站点侧）');
    check(existsSync(join(c2dir, 'orig.zip')), '⑱ 被改写的原件也照样留档（orig.zip，不发布）');

    // 门还在：兼容包仍然走不了普通的 /decide
    const gP = await post2(`${ADMIN}/decide`, { id: cid2, decision: 'approved' });
    check(gP.status === 400 && /compat\/decide/.test(String(gP.body?.error)),
      '⑲ 兼容包用普通 /decide 仍然 400（「只能以兼容包形式发布」这道门还在）', `HTTP ${gP.status}`);

    // 原作者是硬门：包里没有 author、人也没填 → 400（一步到位不许把这些门跳过去）
    const noAuth2 = makeZip([{ name: 'pack.json', data: '{"id":"x","name":"n","description":"d"}' }]);
    const q2b = new URLSearchParams({ name: '没原作者的包', compatAuthor: '', publish: '1' });
    const rNoAuth = await adm2(`${ADMIN}/compat-submit?${q2b}`, {
      method: 'POST', headers: { 'content-type': 'application/zip' }, body: noAuth2 });
    const jNoAuth = await rNoAuth.json();
    check(rNoAuth.status === 400 && jNoAuth.needsAuthor === true,
      '⑳ 一步到位也不放宽「原作者」那道硬门（取不到作者 → 400，没发布）',
      `HTTP ${rNoAuth.status} · ${String(jNoAuth.error).slice(0, 40)}…`);
    const modsAfterNoAuth = await (await fetch(`${BASE2}/api/mods`)).json();
    check(modsAfterNoAuth.mods.length === modsP.mods.length,
      '㉑ 被拦下的那一次**没有**多出任何公开记录（公网条数不变）',
      `${modsP.mods.length} → ${modsAfterNoAuth.mods.length}`);
    const parts2 = await partFilesSettled();
    check(parts2.length === 0, '㉒ 这一节跑完，DATA_DIR 根下也没有 .part 残留',
      parts2.length ? parts2.join('、') : '一个都没有');

    // ---------------- 6b. `compat/link`：给**已经在记录里**的兼容包补 compatOf
    //   业主 2026-10-11 的第二件事：早先手工批准上线的那几条兼容包 `compatOf` 还是空的，
    //   它们对应的原投稿就一直挂在待审列表里、没被标 superseded、没有 replacedBy ——
    //   与「一步发布」那套逻辑不一致。本端点就是把这几条并进去：
    //     · 兼容包只**补** compatOf（name / sha256 / author / compatAuthor / uploadedAt / size / kind
    //       一个都不许动）；
    //     · 原投稿由**同一个** markReplacedBy 处置（superseded + replacedBy + 移出待审），
    //       它的 meta.json 与 mod.zip **一个字节都不许变**。
    //   还要证两件事：**幂等**（重复调不产生第二笔改动）、**一次只认一个 id**
    //   （不许写「循环喂一批」的脚本 —— 那条路害过一次，见 server.mjs 顶上那段纪律）。
    console.log('\n⑥b compat/link：给已上线的兼容包补 compatOf，原投稿按 B 口径，且一次只认一个 id');

    // 造第二个原件 + 第二条兼容包。注意：发布时**不带 compatOf** —— 这样
    // `compat-submit?publish=1` 就不会去动那条原投稿，原投稿保持 pending，
    // 正是「手工批准上线、链没补」那几条的真实状态（否则这条用例测不到东西）。
    const packB = '{\n  "id": "linktest",\n  "name": "补链原件",\n  "version": "1.0.0",\n'
      + '  "author": "社区作者戊",\n  "license": "CC-BY-NC-4.0",\n  "api": ">=1 <2",\n'
      + '  "description": "补链测试原注释。",\n  "client": { "panels": [{ "id": "p", "slot": "screen.game.hud", "module": "ui/p.js" }] }\n}\n';
    const rOB = await fetch(`${BASE2}/api/submit?name=${encodeURIComponent('补链原件')}`, {
      method: 'POST', headers: { 'content-type': 'application/zip' },
      body: makeZip([{ name: 'pack.json', data: packB }, { name: 'ui/p.js', data: 'export const p = 1;\n' }]) });
    const origIdB = (await rOB.json()).id;
    const zB = makeZip([{ name: 'pack.json', data: packB }, { name: 'ui/p.js', data: 'export const p = 2;\n' }]);
    const qB = new URLSearchParams({ name: '补链兼容包', compatAuthor: '维护者丙', author: '', publish: '1' });
    const rPB = await adm2(`${ADMIN}/compat-submit?${qB}`, {
      method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': encodeURIComponent('linktest.zip') }, body: zB });
    const jPB = await rPB.json();
    const cidB = jPB.id;
    check(rPB.status === 201 && jPB.state === 'approved' && !!cidB,
      '㉓ 先造一条已经发布的兼容包（发布时**不带** compatOf —— 复现「链没补」那几条）',
      `原件 ${origIdB} → 兼容包 ${cidB} · compatOf=${jPB.compatOf}`);

    const cBdir = join(dataDir, 'compat', cidB);
    const cBmetaPath = join(cBdir, 'meta.json');
    const cBmeta0 = JSON.parse(readFileSync(cBmetaPath, 'utf8'));
    const cBfrozen = { name: cBmeta0.name, sha256: cBmeta0.sha256, author: cBmeta0.author,
      compatAuthor: cBmeta0.compatAuthor, uploadedAt: cBmeta0.uploadedAt, size: cBmeta0.size, kind: cBmeta0.kind };
    const cBblobSha = sha(readFileSync(join(cBdir, 'mod.zip')));
    check(cBmeta0.compatOf === null,
      '㉔ 这条兼容包的 compatOf 是空的（＝手工批准、链没补的那种状态）', String(cBmeta0.compatOf));

    // 原投稿此时还在待审队列；记下它两个文件的 sha256
    const oBdir = join(dataDir, 'submissions', origIdB);
    const oBmetaSha = sha(readFileSync(join(oBdir, 'meta.json')));
    const oBblobSha = sha(readFileSync(join(oBdir, 'mod.zip')));
    const listB0 = await (await adm2(`${ADMIN}/list`)).json();
    check(listB0.submissions.find((s) => s.id === origIdB)?.state === 'pending',
      '㉕ 补链前：原投稿还是 pending（挂在待审队列里）');
    // 补链**前**抓一次公开面：条数 + 「其余已上线记录**真实下到的字节**的 sha256」
    // 都要在补链后逐字不变（公开 /api/mods 不发 sha256，所以这里下真文件来算 ——
    // 「只补关联」这句话要用**字节**证明，不是用接口字段自证）。
    const modsB0 = await (await fetch(`${BASE2}/api/mods`)).json();
    const liveShas = async (ids) => {
      const out = {};
      for (const id of ids.slice().sort()) {
        const r = await fetch(`${BASE2}/api/file/${id}`);
        out[id] = r.status === 200 ? sha(Buffer.from(await r.arrayBuffer())) : `HTTP${r.status}`;
      }
      return out;
    };
    const othersBIds = modsB0.mods.filter((m) => m.id !== cidB).map((m) => m.id);
    const othersB = JSON.stringify(await liveShas([...othersBIds, cidB]));

    // 一次调用：只指定**一个** id
    const rLink = await post2(`${ADMIN}/compat/link`, { compatId: cidB, originId: origIdB });
    check(rLink.status === 200 && rLink.body?.ok === true && rLink.body?.compatOf === origIdB,
      '㉖ POST compat/link {compatId, originId} → 200，补链成功',
      `HTTP ${rLink.status} · ${JSON.stringify(rLink.body)?.slice(0, 110)}`);
    const cBmeta1 = JSON.parse(readFileSync(cBmetaPath, 'utf8'));
    check(cBmeta1.compatOf === origIdB, '㉗ 兼容包的 compatOf 已指向原投稿', String(cBmeta1.compatOf));
    // 红线：兼容包上除 compatOf（与 flags/revisions 的补记）之外的字段一个都不许动
    const cBfrozenAfter = { name: cBmeta1.name, sha256: cBmeta1.sha256, author: cBmeta1.author,
      compatAuthor: cBmeta1.compatAuthor, uploadedAt: cBmeta1.uploadedAt, size: cBmeta1.size, kind: cBmeta1.kind };
    check(JSON.stringify(cBfrozenAfter) === JSON.stringify(cBfrozen),
      '㉘ 兼容包上 name / sha256 / author / compatAuthor / uploadedAt / size / kind 逐字未变',
      JSON.stringify(cBfrozenAfter));
    check(sha(readFileSync(join(cBdir, 'mod.zip'))) === cBblobSha,
      '㉙ 兼容包的 mod.zip 一个字节没动');
    check(Array.isArray(cBmeta1.revisions) && cBmeta1.revisions.length === (cBmeta0.revisions?.length || 0) + 1,
      '㉚ 补链记进 revisions（留痕，不是悄悄改）', `revisions ${cBmeta0.revisions?.length || 0} → ${cBmeta1.revisions?.length}`);
    check(!(cBmeta1.flags || []).some((f) => f.code === 'COMPAT_OF_MISSING')
      && (cBmeta1.flags || []).some((f) => f.code === 'COMPAT_OF'),
      '㉛ 「还没补」那条 COMPAT_OF_MISSING 已换成 COMPAT_OF', (cBmeta1.flags || []).map((f) => f.code).join(','));

    // 原投稿按 B 口径（同一个 markReplacedBy）
    const oBdec = JSON.parse(readFileSync(join(oBdir, 'decision.json'), 'utf8'));
    check(oBdec.decision === 'superseded' && oBdec.replacedBy?.id === cidB,
      '㉜ 原投稿被同一个 markReplacedBy 标 superseded + replacedBy 指向兼容包',
      JSON.stringify(oBdec.replacedBy));
    check(sha(readFileSync(join(oBdir, 'meta.json'))) === oBmetaSha,
      '㉝ 原投稿的 meta.json 一字未变');
    check(sha(readFileSync(join(oBdir, 'mod.zip'))) === oBblobSha,
      '㉞ 原投稿的 mod.zip 一个字节没动');
    const listB1 = await (await adm2(`${ADMIN}/list`)).json();
    const pendB = listB1.submissions.filter((s) => (s.decision?.decision || s.state || 'pending') === 'pending');
    check(!pendB.some((s) => s.id === origIdB), '㉟ 原投稿已移出待审队列（不在 pending 里了）',
      `待审 ${pendB.length} 条`);
    const modsB = await (await fetch(`${BASE2}/api/mods`)).json();
    const pubB = modsB.mods.find((x) => x.id === cidB);
    check(pubB?.compatOf === origIdB, '㊱ 公网 /api/mods 里这条也带上了 compatOf', String(pubB?.compatOf));
    // 内容面：补链**不发布、不打回**，所以公开条数与「已上线记录真实下到的字节」都必须逐字不变。
    const othersBAfter = JSON.stringify(await liveShas([...othersBIds, cidB]));
    check(modsB.mods.length === modsB0.mods.length,
      '㊲ 补链**没有**改变公网条数（只补关联，不发布、不打回）',
      `补链前 ${modsB0.mods.length} → 补链后 ${modsB.mods.length}`);
    check(othersBAfter === othersB,
      '㊲b 已上线记录**下到的字节**逐字未变（补链没顺手碰别的记录）',
      `${othersBIds.length + 1} 条 · ${othersBAfter === othersB ? 'sha256 全同' : '有变化 → ' + othersBAfter.slice(0, 120)}`);
    check(sha(Buffer.from(await (await fetch(`${BASE2}/api/file/${cidB}`)).arrayBuffer())) === cBblobSha,
      '㊳ 公网下到的还是原来那一份（补链没换包）');

    // 幂等：再调一次不产生第二笔改动
    const rLink2 = await post2(`${ADMIN}/compat/link`, { compatId: cidB, originId: origIdB });
    const cBmeta2 = JSON.parse(readFileSync(cBmetaPath, 'utf8'));
    check(rLink2.status === 200 && rLink2.body?.alreadyLinked === true
      && JSON.stringify(cBmeta2) === JSON.stringify(cBmeta1),
      '㊴ 幂等：重复调同一条 → alreadyLinked=true，meta.json 一字未变（不产生第二笔）',
      `HTTP ${rLink2.status} · alreadyLinked=${rLink2.body?.alreadyLinked}`);

    // 一次只认一个 id：字段缺失 / 形状不对 / 指自己 / 指兼容包 → 400 或 404，绝不「顺手猜一条」
    const bads = [
      [{ compatId: cidB }, 400, '缺 originId'],
      [{ originId: origIdB }, 400, '缺 compatId'],
      [{ compatId: cidB, originId: 'not-an-id!' }, 400, 'originId 形状不对'],
      [{ compatId: cidB, originId: cidB }, 400, '指自己'],
      [{ compatId: cidB, originId: cid2 }, 404, '指另一条兼容包'],
      [{ compatId: cidB, originId: 'zzzz9999zzzz' }, 404, '指一条不存在的投稿'],
      [{ compatId: 'zzzz9999zzzz', originId: origIdB }, 404, '兼容包不存在'],
    ];
    let allBadOk = true;
    const badDetail = [];
    for (const [body, want, label] of bads) {
      const r = await post2(`${ADMIN}/compat/link`, body);
      badDetail.push(`${label}=${r.status}`);
      if (r.status !== want) allBadOk = false;
    }
    check(allBadOk, '㊵ 一次只认一个明确指定的 id：缺字段/形状不对/指自己/指兼容包/不存在 → 全部按预期拒',
      badDetail.join(' · '));
    check(JSON.stringify(JSON.parse(readFileSync(cBmetaPath, 'utf8'))) === JSON.stringify(cBmeta1),
      '㊶ 那一串被拒的请求**一条都没改动**兼容包（先算不写，失败不留半拉状态）');
    const parts3 = await partFilesSettled();
    check(parts3.length === 0, '㊷ 6b 跑完，DATA_DIR 根下仍然没有 .part 残留',
      parts3.length ? parts3.join('、') : '一个都没有');

    // ---------------- 6c. `compat/note`：**只改备注文案**（note + compatNote 两栏）
    //   业主 2026-10-11 的第三件事：早先上线的那三条兼容包，公网页备注留的还是**上传时
    //   那句内部链路实测的话**（「兼容包入口链路实测：只上传，不通过、不发布。」）。
    //   它们**已经发布**在公网上，那句话在公网上是**假的** —— 名字改过了、备注没跟着改。
    //   既有的两条路都到不了这一栏：`compat/decide` 的补全分支只补 `compatNote`、**不碰 `note`**；
    //   而 `/mods` 那一页**两栏都渲染**（`兼容说明：` + 备注正文），只改一栏等于旧文案还在。
    //   所以 server.mjs 另开了这条最小端点。这里要证五件事：
    //     · 一次只认**一个明确指定的 id**（任何「一批」的形状都拒）；
    //     · **数据零变化**：mod.zip / pack-json.orig.json / decision.json 逐字节不变，
    //       name / sha256 / author / compatAuthor / compatAuthorSource / uploadedAt / size / kind /
    //       compatOf 一律不动，公网**下到的字节**也不变；
    //     · **幂等**：重复调不产生第二笔；
    //     · 公网 **/api/mods** 上两栏都是新文案（公网渲染吃的就是这一份），
    //       且整份公开数据里**再也搜不到**「链路实测」「不发布」；
    //     · 失败的调用**先算不写**，一条都不改动记录。
    console.log('\n⑥c compat/note：只改备注文案（note + compatNote），一次一个 id，数据零变化');

    const NOTE_OLD = '兼容包入口链路实测：只上传，不通过、不发布。';
    const NOTE_NEW = '兼容改写版：基于原投稿改写，原作者署名与许可原样保留。';
    // 造一条「和线上那三条同形」的已发布兼容包：**发布时就把旧文案写进 note / compatNote**。
    const packC = '{\n  "id": "notetest",\n  "name": "改备注原件",\n  "version": "1.0.0",\n'
      + '  "author": "社区作者己",\n  "license": "CC-BY-NC-4.0",\n  "api": ">=1 <2",\n'
      + '  "description": "改备注测试原注释。",\n  "client": { "panels": [{ "id": "p", "slot": "screen.game.hud", "module": "ui/p.js" }] }\n}\n';
    const qC = new URLSearchParams({ name: '改备注兼容包', compatAuthor: '', author: '', compatNote: NOTE_OLD, publish: '1' });
    const rPC = await adm2(`${ADMIN}/compat-submit?${qC}`, {
      method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': encodeURIComponent('notetest.zip') },
      body: makeZip([{ name: 'pack.json', data: packC }, { name: 'ui/p.js', data: 'export const p = 3;\n' }]) });
    const jPC = await rPC.json();
    const cidC = jPC.id;
    check(rPC.status === 201 && jPC.state === 'approved' && !!cidC,
      '6c-1 先造一条已发布、备注还是旧文案的兼容包（复现公网那三条的状态）',
      `id=${cidC} · 发布时就写进了旧文案`);
    const cCdir = join(dataDir, 'compat', cidC);
    const cCmetaPath = join(cCdir, 'meta.json');
    const cCmeta0 = JSON.parse(readFileSync(cCmetaPath, 'utf8'));
    const cCfrozen = { name: cCmeta0.name, sha256: cCmeta0.sha256, author: cCmeta0.author,
      compatAuthor: cCmeta0.compatAuthor, compatAuthorSource: cCmeta0.compatAuthorSource,
      uploadedAt: cCmeta0.uploadedAt, size: cCmeta0.size, kind: cCmeta0.kind, compatOf: cCmeta0.compatOf };
    const cCblobSha = sha(readFileSync(join(cCdir, 'mod.zip')));
    const cCorigSha = sha(readFileSync(join(cCdir, 'pack-json.orig.json')));
    const cCdecSha = sha(readFileSync(join(cCdir, 'decision.json')));
    check(cCmeta0.note === NOTE_OLD && cCmeta0.compatNote === NOTE_OLD,
      '6c-2 这条记录的 note 与 compatNote 都是旧文案（就是公网上那句假话）',
      `note=${JSON.stringify(cCmeta0.note)}`);
    const modsC0 = await (await fetch(`${BASE2}/api/mods`)).json();
    const pubC0 = modsC0.mods.find((m) => m.id === cidC);
    check(pubC0?.note === NOTE_OLD && pubC0?.compatNote === NOTE_OLD,
      '6c-3 公开 /api/mods 上它确实**带着旧文案**发布着（不是没上线）',
      `note=${JSON.stringify(pubC0?.note)}`);
    check(JSON.stringify(modsC0).includes('链路实测') && JSON.stringify(modsC0).includes('不发布'),
      '6c-4 修之前：整份公开数据里搜得到「链路实测」「不发布」（这就是要消掉的东西）');

    // 一次调用：只指定**一个** id，只给一句新文案
    const rNote = await post2(`${ADMIN}/compat/note`, { id: cidC, note: NOTE_NEW });
    check(rNote.status === 200 && rNote.body?.ok === true && rNote.body?.changed === true,
      '6c-5 POST compat/note {id, note} → 200，备注改写成功',
      `HTTP ${rNote.status} · changed=${rNote.body?.changed}`);
    const cCmeta1 = JSON.parse(readFileSync(cCmetaPath, 'utf8'));
    check(cCmeta1.note === NOTE_NEW && cCmeta1.compatNote === NOTE_NEW,
      '6c-6 meta.json 的**两栏**都换成了新文案（/mods 两栏都渲染，只改一栏等于没改）',
      `note=${JSON.stringify(cCmeta1.note)} · compatNote=${JSON.stringify(cCmeta1.compatNote)}`);
    const cCfrozenAfter = { name: cCmeta1.name, sha256: cCmeta1.sha256, author: cCmeta1.author,
      compatAuthor: cCmeta1.compatAuthor, compatAuthorSource: cCmeta1.compatAuthorSource,
      uploadedAt: cCmeta1.uploadedAt, size: cCmeta1.size, kind: cCmeta1.kind, compatOf: cCmeta1.compatOf };
    check(JSON.stringify(cCfrozenAfter) === JSON.stringify(cCfrozen),
      '6c-7 其余字段一律原样：name / sha256 / author / compatAuthor / compatAuthorSource / uploadedAt / size / kind / compatOf',
      JSON.stringify(cCfrozenAfter));
    check(sha(readFileSync(join(cCdir, 'mod.zip'))) === cCblobSha,
      '6c-8 mod.zip 一个字节没动（改一句备注不许带出副作用）');
    check(sha(readFileSync(join(cCdir, 'pack-json.orig.json'))) === cCorigSha,
      '6c-9 pack-json.orig.json 一个字节没动（原注释快照不受影响）');
    check(sha(readFileSync(join(cCdir, 'decision.json'))) === cCdecSha,
      '6c-10 decision.json 一个字节没动（没改决定、没重新发布）');
    check(Array.isArray(cCmeta1.revisions) && cCmeta1.revisions.length === (cCmeta0.revisions?.length || 0) + 1,
      '6c-11 改写记进 revisions（留痕，不是悄悄改）',
      `revisions ${cCmeta0.revisions?.length || 0} → ${cCmeta1.revisions?.length}`);
    check(sha(Buffer.from(await (await fetch(`${BASE2}/api/file/${cidC}`)).arrayBuffer())) === cCblobSha,
      '6c-12 公网**下到的字节**也逐字未变（下载 sha256 不受备注改动影响）');

    const modsC1 = await (await fetch(`${BASE2}/api/mods`)).json();
    const pubC1 = modsC1.mods.find((m) => m.id === cidC);
    check(pubC1?.note === NOTE_NEW && pubC1?.compatNote === NOTE_NEW,
      '6c-13 公开 /api/mods 上两栏都变成新文案（公网渲染出的就是这一份）',
      `note=${JSON.stringify(pubC1?.note)}`);
    const modsC1Text = JSON.stringify(modsC1);
    check(!modsC1Text.includes('链路实测') && !modsC1Text.includes('不发布'),
      '6c-14 整份公开数据里**再也搜不到**「链路实测」「不发布」');
    check(modsC1.mods.length === modsC0.mods.length,
      '6c-15 改备注**没有**改变公网条数（不发布、不打回）',
      `${modsC0.mods.length} → ${modsC1.mods.length}`);

    // 幂等：再调一次不产生第二笔
    const rNote2 = await post2(`${ADMIN}/compat/note`, { id: cidC, note: NOTE_NEW });
    const cCmeta2 = JSON.parse(readFileSync(cCmetaPath, 'utf8'));
    check(rNote2.status === 200 && rNote2.body?.changed === false
      && JSON.stringify(cCmeta2) === JSON.stringify(cCmeta1),
      '6c-16 幂等：重复调同一条 → changed=false，meta.json 一字未变（不产生第二笔）',
      `HTTP ${rNote2.status} · changed=${rNote2.body?.changed}`);

    // 一次只认一个 id：任何「一批」的形状 / 形状不对 → 400 或 404，绝不「顺手猜一条」
    const badsC = [
      [{ ids: [cidC], note: NOTE_NEW }, 400, '整批（ids 数组）'],
      [{ id: cidC, batch: [cidC], note: NOTE_NEW }, 400, '夹带 batch'],
      [{ id: cidC, items: [], note: NOTE_NEW }, 400, '夹带 items'],
      [{ id: cidC, list: [], note: NOTE_NEW }, 400, '夹带 list'],
      [{ id: [cidC], note: NOTE_NEW }, 400, 'id 给数组'],
      [{ id: cidC }, 400, '缺 note'],
      [{ id: cidC, note: 123 }, 400, 'note 不是字符串'],
      [{ id: cidC, note: '   ' }, 400, 'note 是空白'],
      [{ id: 'not-an-id!', note: NOTE_NEW }, 400, 'id 形状不对'],
      [{ id: 'zzzz9999zzzz', note: NOTE_NEW }, 404, '不存在的兼容包'],
      [{ id: origIdB, note: NOTE_NEW }, 404, '指一条普通投稿（不在 compat/ 区）'],
    ];
    let allBadCOk = true; const badCDetail = [];
    for (const [body, want, label] of badsC) {
      const r = await post2(`${ADMIN}/compat/note`, body);
      badCDetail.push(`${label}=${r.status}`);
      if (r.status !== want) allBadCOk = false;
    }
    check(allBadCOk, '6c-17 一次只认一个明确指定的 id：一批 / 夹带 / 形状不对 / 不存在 → 全部按预期拒',
      badCDetail.join(' · '));
    check(JSON.stringify(JSON.parse(readFileSync(cCmetaPath, 'utf8'))) === JSON.stringify(cCmeta2),
      '6c-18 那一串被拒的请求**一条都没改动**记录（先算不写，失败不留半拉状态）');
    const parts4 = await partFilesSettled();
    check(parts4.length === 0, '6c-19 6c 跑完，DATA_DIR 根下仍然没有 .part 残留',
      parts4.length ? parts4.join('、') : '一个都没有');
  } finally {
    child2.kill();
    await sleep(200);
  }

  // ---------------- 6d. 「维护者人工确认」：**逐条**放行命中 blocker 的兼容包
  //   业主 2026-10-11 的第四件事：那两个真素材路径的包（.skel / .atlas / spine/op/ / char/portrait）
  //   经人工核对后要上线。规矩是「**不许静默绕过、不许放宽档位定义、不许批量**」，
  //   所以这条路做成一个**显式的、单记录的**开关：`confirmBlockers=1` + 必填理由，
  //   确认那一笔写进 meta.json 与 decision.json（by / at / 理由 / 命中的档位代码）。
  //   这一节要证的就是「没有绕过、也没有放宽」：
  //     · 不带确认时，命中 blocker 的包照旧是「疑似」——不进公网主列表（原文口径一点没变）；
  //     · 带了确认：进主列表，但 `flags` 里的 blocker **一条不少**、`suspectedByTiers` 照旧是 true；
  //     · 缺理由 / 理由太短 / confirmBlockers 值不对 / 干净包乱带确认 ⇒ 全部 400，磁盘不动。
  //
  //   另起**第三个**实例：本机回环的限流是「每 10 分钟 10 次上传」，上面两节已经把额度用满，
  //   再加几次会被 429 拦掉 —— 那不是本节要测的东西。换端口 = 换进程 = 一份新的限流计数；
  //   数据目录还是同一个（记录照旧只增不减）。
  console.log('\n⑥d 维护者人工确认：逐条放行命中 blocker 的包（档位定义与命中明细一条没改）');
  const P3 = PORT + 20;
  const BASE3 = `http://127.0.0.1:${P3}`;
  const child3 = spawn(process.execPath, [SERVER_FILE], {
    env: { ...process.env, PORT: String(P3), DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN, ADMIN_PATH, MAX_MB: '4', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log3 = '';
  child3.stdout.on('data', (d) => { log3 += d; });
  child3.stderr.on('data', (d) => { log3 += d; });
  try {
    let up3 = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE3}/healthz`)).ok) { up3 = true; break; } } catch { /* 还没起 */ }
      await sleep(120);
    }
    if (!up3) throw new Error('第三个实例没起来：\n' + log3);
    const adm3 = (p, opt = {}) => fetch(`${BASE3}${p}`, { ...opt, headers: { 'x-admin-token': TOKEN, ...(opt.headers || {}) } });

    const GHOST_PACK = '{\n  "id": "ghosttest",\n  "name": "幻影包",\n  "version": "1.0.0",\n'
      + '  "author": "社区作者庚",\n  "license": "CC-BY-NC-4.0",\n  "api": ">=1 <2",\n'
      + '  "description": "人工确认测试：原注释一字不许被覆盖。",\n'
      + '  "client": { "panels": [{ "id": "p", "slot": "screen.game.hud", "module": "ui/p.js" }] }\n}\n';
    // 故意带上那四条真素材特征（.skel / .atlas / spine/op/ / char/portrait/）。
    // ⚠️ 档位是「一个文件只算第一条命中的规则」（reviewEntries 里命中就 break），
    // 所以要凑齐四档，`spine/op/` 那一条得有一个**不是 .skel/.atlas** 的文件来命中它。
    const ghostZip = () => makeZip([
      { name: 'pack.json', data: GHOST_PACK },
      { name: 'ui/p.js', data: 'export const p = 4;\n' },
      { name: 'assets/spine/op/char_9_x/char_9.skel', data: 'SKEL' },
      { name: 'assets/spine/op/char_9_x/char_9.atlas', data: 'ATLAS' },
      { name: 'assets/spine/op/char_9_x/char_9.png', data: 'PNG-IN-SPINE-OP' },
      { name: 'assets/char/portrait/char_9.png', data: 'PNG' },
    ]);
    const ghostUpload = (params) => adm3(`${ADMIN}/compat-submit?${new URLSearchParams(params)}`, {
      method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': encodeURIComponent('ghost.zip') },
      body: ghostZip(),
    });
    const baseParams = { name: '幻影包', compatAuthor: '', author: '', publish: '1' };

    // ① 不带确认：与从前完全一样 —— 照收、照留档，只是标疑似、不进公网主列表。
    const rPlain = await ghostUpload(baseParams);
    const jPlain = await rPlain.json();
    const ghost1 = jPlain.id;
    check(rPlain.status === 201 && jPlain.state === 'approved' && jPlain.suspected === true,
      '6d-1 不带确认：命中 blocker 的包照旧标「疑似」（原口径一点没变）',
      `HTTP ${rPlain.status} · state=${jPlain.state} · suspected=${jPlain.suspected}`);
    const modsPlain = await (await fetch(`${BASE3}/api/mods`)).json();
    check(!modsPlain.mods.some((m) => m.id === ghost1) && modsPlain.flagged.some((m) => m.id === ghost1),
      '6d-2 不带确认：它落在公网「疑似素材」那一组，**不在**主列表里',
      `mods=${modsPlain.mods.length} · flagged=${modsPlain.flagged.length}`);

    // ② 形状不对的确认：一律 400，且磁盘一个字节都不动。
    const gmetaPath = join(dataDir, 'compat', ghost1, 'meta.json');
    const gmetaBefore = JSON.stringify(JSON.parse(readFileSync(gmetaPath, 'utf8')));
    const badConfirms = [
      [{ ...baseParams, confirmBlockers: 'yes', confirmReason: '理由够长了吧' }, 400, 'confirmBlockers 值不是 1'],
      [{ ...baseParams, confirmBlockers: '1' }, 400, 'confirmBlockers=1 但没给理由'],
      [{ ...baseParams, confirmBlockers: '1', confirmReason: '太短' }, 400, '理由太短'],
    ];
    let allBadConfirm = true; const badConfirmDetail = [];
    for (const [params, want, label] of badConfirms) {
      const r = await ghostUpload(params);
      badConfirmDetail.push(`${label}=${r.status}`);
      if (r.status !== want) allBadConfirm = false;
    }
    check(allBadConfirm, '6d-3 确认的形状校验：值不是 1 / 缺理由 / 理由太短 → 全部 400',
      badConfirmDetail.join(' · '));
    check(JSON.stringify(JSON.parse(readFileSync(gmetaPath, 'utf8'))) === gmetaBefore,
      '6d-4 那几次被拒的确认**一条都没改动**任何记录（先算不写）');
    // 干净包乱带确认 → 400（这不是一个可以随便带的开关）。
    const rCleanConfirm = await adm3(`${ADMIN}/compat-submit?${new URLSearchParams({
      name: '干净包乱确认', compatAuthor: '', author: '', publish: '1',
      confirmBlockers: '1', confirmReason: '这个包其实没有 blocker',
    })}`, {
      method: 'POST', headers: { 'content-type': 'application/zip' },
      body: makeZip([{ name: 'pack.json', data: GHOST_PACK.replace('ghosttest', 'cleantest') }, { name: 'ui/p.js', data: 'export const p = 5;\n' }]),
    });
    const jClean = await rCleanConfirm.json();
    check(rCleanConfirm.status === 400 && jClean.needsBlockers === true,
      '6d-5 没有命中 blocker 的包带确认 → 400（确认只用于逐条放行真素材路径，不是通用开关）',
      `HTTP ${rCleanConfirm.status} · ${String(jClean.error).slice(0, 46)}…`);

    // ③ 正式确认：一条记录、一段理由 ⇒ 进主列表，但档位明细一条不少。
    const REASON = '业主 2026-10-11 人工核对：这份改写包只用于个人非商业的皮肤替换，真素材路径由原作者随包分发，确认放行。';
    const rConf = await ghostUpload({ ...baseParams, confirmBlockers: '1', confirmReason: REASON });
    const jConf = await rConf.json();
    const ghost2 = jConf.id;
    check(rConf.status === 201 && jConf.state === 'approved' && jConf.suspected === false
      && jConf.suspectedByTiers === true,
      '6d-6 正式确认：进主列表（suspected=false），但**档位照旧判成命中**（suspectedByTiers=true）',
      `HTTP ${rConf.status} · suspected=${jConf.suspected} · suspectedByTiers=${jConf.suspectedByTiers}`);
    const g2dir = join(dataDir, 'compat', ghost2);
    const g2meta = JSON.parse(readFileSync(join(g2dir, 'meta.json'), 'utf8'));
    const g2blockers = (g2meta.flags || []).filter((f) => f.level === 'blocker');
    check(g2blockers.length === 4 && g2meta.suspectedReasons.length === 4
      && g2blockers.every((f) => f.code === 'GAME_ASSET'),
      '6d-7 档位定义与命中明细一条没改：那 4 档 blocker 原样留在 flags 里（不是删掉、也不是降级成 info）',
      `blocker ${g2blockers.length} 档 · ` + g2blockers.map((f) => f.text.slice(0, 20)).join(' | '));
    check(g2meta.maintainerConfirm?.by === 'admin' && !!g2meta.maintainerConfirm?.at
      && g2meta.maintainerConfirm.reason === REASON && g2meta.maintainerConfirm.codes.length === 4,
      '6d-8 确认那一笔写进了 meta.json（by / at / 理由 / 命中的档位代码）',
      JSON.stringify(g2meta.maintainerConfirm).slice(0, 120) + '…');
    const g2dec = JSON.parse(readFileSync(join(g2dir, 'decision.json'), 'utf8'));
    check(g2dec.decision === 'approved' && g2dec.maintainerConfirm?.reason === REASON
      && g2dec.maintainerConfirm?.by === 'admin' && !!g2dec.maintainerConfirm?.at,
      '6d-9 同一笔确认也写进了 decision.json（含 by / at / 理由）',
      JSON.stringify(g2dec.maintainerConfirm).slice(0, 120) + '…');
    check(g2meta.compatAuthor === '' && g2meta.compatAuthorSource === 'empty'
      && g2meta.author === '社区作者庚' && g2meta.authorSource === 'pack.json',
      '6d-10 两个署名照旧分开：原作者预填自 pack.json、兼容者留空＝未填（没有代填任何名字）',
      `${g2meta.author}(${g2meta.authorSource}) / ${JSON.stringify(g2meta.compatAuthor)}(${g2meta.compatAuthorSource})`);
    const g2snap = JSON.parse(readFileSync(join(g2dir, 'pack-json.orig.json'), 'utf8'));
    check(JSON.stringify(g2snap.pack) === JSON.stringify(JSON.parse(GHOST_PACK)),
      '6d-11 原注释快照与包里的 pack.json 一字不差（确认放行没有顺手改包）');
    check(sha(readFileSync(join(g2dir, 'mod.zip'))) === g2meta.sha256,
      '6d-12 落盘的改写版与记录里的 sha256 逐字一致');
    const modsConf = await (await fetch(`${BASE3}/api/mods`)).json();
    check(modsConf.mods.some((m) => m.id === ghost2) && !modsConf.flagged.some((m) => m.id === ghost2),
      '6d-13 确认之后它出现在公网**主列表**里（不在「疑似素材」那一组）',
      `mods=${modsConf.mods.length} · flagged=${modsConf.flagged.length}`);
    check(sha(Buffer.from(await (await fetch(`${BASE3}/api/file/${ghost2}`)).arrayBuffer())) === g2meta.sha256,
      '6d-14 公网下到的就是这一份改写版（字节与记录一致）');
    const parts5 = await partFilesSettled();
    check(parts5.length === 0, '6d-15 6d 跑完，DATA_DIR 根下仍然没有 .part 残留',
      parts5.length ? parts5.join('、') : '一个都没有');
  } finally {
    child3.kill();
    await sleep(200);
  }

  // ---------------------------------------------------------------- ⑥e 「不再显示」在 compat / flagged 区也一样
  // 业主 2026-10-11 要的那个勾选框：**每条记录一个**，三个区（submissions / flagged / compat）
  // 都得能勾。页面那一段「勾上 ⇒ 三视图都不显示」由 selftest-admin.mjs 打；这里补的是
  // **区覆盖**：兼容包那条（compat 区）与原件那条（superseded）都要能勾上、能取消。
  // 同一条铁律照旧：一次一个 id、幂等、只动 meta.json 那一个标志位、公开面不动。
  console.log('\n⑥e 「不再显示」：compat 区与 superseded 的那条也勾得上（一次一个 id · 可逆）');
  const hidePost = (body) => adm(`${ADMIN}/hide`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const cParts = ['compat', cid];
  const cMetaFile = join(dataDir, cParts[0], cParts[1], 'meta.json');
  const cDecFile = join(dataDir, cParts[0], cParts[1], 'decision.json');
  const cZipFile = join(dataDir, cParts[0], cParts[1], 'mod.zip');
  const cZip0 = sha(readFileSync(cZipFile)), cDec0 = sha(readFileSync(cDecFile));
  const pubC0 = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const oMetaFile = join(dataDir, 'submissions', origId, 'meta.json');
  const oDecFile = join(dataDir, 'submissions', origId, 'decision.json');
  const oMeta0 = sha(readFileSync(oMetaFile)), oDec0 = sha(readFileSync(oDecFile));

  const hc = await hidePost({ id: cid, hidden: true });
  const hcb = await hc.json();
  check(hc.status === 200 && hcb.changed === true && hcb.area === 'compat',
    '6e-1 兼容包（compat 区）也勾得上 —— 端点认的是「哪条记录」，不是「哪个区」',
    `HTTP ${hc.status} · area=${hcb.area}`);
  const ho = await hidePost({ id: origId, hidden: true });
  check(ho.status === 200 && (await ho.json()).changed === true,
    '6e-2 被取代的那条原件（superseded）也勾得上（正是业主抱怨的那一份）', `HTTP ${ho.status}`);
  const listH = await (await adm(`${ADMIN}/list`)).json();
  check(listH.submissions.find((s) => s.id === cid)?.hidden === true
    && listH.submissions.find((s) => s.id === origId)?.hidden === true,
    '6e-3 /list 里这两条都带着 hidden:true');
  const hc2 = await hidePost({ id: cid, hidden: true });
  check((await hc2.json()).changed === false, '6e-4 幂等：同一件事发两次，第二次 changed:false');
  check(sha(readFileSync(cZipFile)) === cZip0 && sha(readFileSync(cDecFile)) === cDec0
    && sha(readFileSync(oMetaFile)) !== oMeta0 && sha(readFileSync(oDecFile)) === oDec0,
    '6e-5 只动 meta.json 那一个标志位：mod.zip 与两份 decision.json 的 sha256 一字不变');
  const pubC1 = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  check(pubC1 === pubC0, '6e-6 隐藏期间公网 /api/mods 与基准字节完全一致（隐藏 ≠ 下架）');
  const hc3 = await hidePost({ id: cid, hidden: false });
  const ho3 = await hidePost({ id: origId, hidden: false });
  const listB = await (await adm(`${ADMIN}/list`)).json();
  check((await hc3.json()).hidden === false && (await ho3.json()).hidden === false
    && listB.submissions.find((s) => s.id === cid)?.hidden === false
    && listB.submissions.find((s) => s.id === origId)?.hidden === false,
    '6e-7 取消勾选：两条都写回 hidden:false，又显示出来了（**可逆**）');
  check(JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json()) === pubC0,
    '6e-8 一来一回之后公开面仍然是那串基准字节');

  // ---------------------------------------------------------------- ⑥f `POST /note`：投稿区备注
  // 业主 2026-10-12 裁定：**另开一条只服务投稿区**的备注端点，不把两个区合并进 `/compat/note` ——
  // 字段语义不同（compat 是 `note` + `compatNote` 同一句、公网按「兼容说明」只画一次；
  // 投稿只有 `note`、公网不带标签画）。这里打四件事：
  //   ① 投稿区能写了：200、`note` 变了、其余键值逐字未变、**`compatNote` 没被创建**；
  //   ② 走错端点要看到「该去哪」：同一 id 打到 `compat/note` 现在是**明确的 404**
  //      （区域检查排在长度之前，不再被长度抢先报 400），且文案点名 `…/note`；
  //   ③ 反向也一样：`/note` 收到 compat 区 id ⇒ 400 并点名 `compat/note`；
  //   ④ 上限真的抬了：9000 字写得进去，20001 字被拒且文案写明 20000。
  console.log('\n⑥f POST /note：投稿区备注（一次一个 id · 只动 note · 其余键值一字未变）');
  const notePost = async (p, obj) => {
    const r = await adm(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // 靶子复用 ⓪ 那条**投稿区**原件（`origId`），**不新投一条**：
  // `/api/submit` 与 `compat-submit` 共用同一个「每 IP 每 10 分钟 10 次」的限流计数器
  // （`server.mjs:576-582` 的 `rateLimited`），本文件前面已经用掉若干次；
  // 再投一条会撞 429，而这里要测的是**备注端点**，与上传限流无关。
  const noteSubId = origId;
  // 磁盘上的区目录名是 `submissions` / `flagged`，而 `/api/submit` 响应里的 `area` 是语义名
  // （`normal`）—— 两者不是一回事，所以按**磁盘实况**找（找不到才回落）。
  const noteSubDir = (() => {
    for (const a of ['submissions', 'flagged']) {
      const p = join(dataDir, a, noteSubId);
      try { readFileSync(join(p, 'meta.json')); return p; } catch (_) { /* 换下一个区 */ }
    }
    return join(dataDir, 'submissions', noteSubId);
  })();
  const noteMeta0 = JSON.parse(readFileSync(join(noteSubDir, 'meta.json'), 'utf8'));
  const noteZip0 = sha(readFileSync(join(noteSubDir, 'mod.zip')));
  const NOTE_SUB = '投稿区备注：这一段由 POST /note 写入（只动 note 一栏）。';
  const rNote1 = await notePost(`${ADMIN}/note`, { id: noteSubId, note: NOTE_SUB });
  // 注意：**响应的 `area` 是语义名**（投稿区是 `normal`，磁盘目录才是 `submissions`）——
  // 与 `/hide`、`/list` 同源，都是 `pathsOf().area`。判据写「不是 compat」比写死目录名稳。
  check(rNote1.status === 200 && rNote1.body?.changed === true && rNote1.body?.area !== 'compat',
    '6f-1 POST /note 对投稿区记录 → 200，备注写入成功',
    `HTTP ${rNote1.status} · area=${rNote1.body?.area}`);
  const noteMeta1 = JSON.parse(readFileSync(join(noteSubDir, 'meta.json'), 'utf8'));
  check(noteMeta1.note === NOTE_SUB, '6f-2 meta.note 已是新文案', JSON.stringify(noteMeta1.note));
  check(!('compatNote' in noteMeta1),
    '6f-3 **compatNote 没被创建**（投稿不是兼容包，公网不该给它挂「兼容说明」标签）',
    'compatNote' in noteMeta1 ? `多出了 compatNote=${JSON.stringify(noteMeta1.compatNote)}` : '没有这一栏');
  const stripNoteSub = (o) => { const c = { ...o }; delete c.note; delete c.revisions; return JSON.stringify(c); };
  check(stripNoteSub(noteMeta0) === stripNoteSub(noteMeta1), '6f-4 除 note / revisions 外其余键值逐字未变');
  check(sha(readFileSync(join(noteSubDir, 'mod.zip'))) === noteZip0, '6f-5 mod.zip 一字未动');
  check((noteMeta1.revisions || []).length === (noteMeta0.revisions || []).length + 1, '6f-6 revisions 多了一笔留痕');
  const rNote2 = await notePost(`${ADMIN}/note`, { id: noteSubId, note: NOTE_SUB });
  check(rNote2.status === 200 && rNote2.body?.changed === false, '6f-7 幂等：同一句再发一次 changed:false（不写盘）');
  const rNoteWrong = await notePost(`${ADMIN}/compat/note`, { id: noteSubId, note: NOTE_SUB });
  check(rNoteWrong.status === 404 && /没有这条兼容包/.test(String(rNoteWrong.body?.error || '')),
    '6f-8 同一 id 打到 compat/note → **明确的 404**（区域检查排在长度之前，不再被长度抢先报 400）',
    `HTTP ${rNoteWrong.status}`);
  check(/\/note/.test(String(rNoteWrong.body?.error || '')), '6f-9 那句 404 里点名了正确的端点');
  const rNoteWrong2 = await notePost(`${ADMIN}/note`, { id: cid, note: NOTE_SUB });
  check(rNoteWrong2.status === 400 && /compat\/note/.test(String(rNoteWrong2.body?.error || '')),
    '6f-10 反向：POST /note 收到 compat 区 id → 400，并点名 compat/note', `HTTP ${rNoteWrong2.status}`);
  const rNoteBatch = await notePost(`${ADMIN}/note`, { ids: [noteSubId], note: NOTE_SUB });
  check(rNoteBatch.status === 400, '6f-11 「一批」的形状一律 400（一次一个明确写出的 id）', `HTTP ${rNoteBatch.status}`);
  const rNoteLong = await notePost(`${ADMIN}/note`, { id: noteSubId, note: '长'.repeat(9000) });
  check(rNoteLong.status === 200 && rNoteLong.body?.changed === true,
    '6f-12 9000 字的备注写得进去（上限已从 4000 抬到 20000）', `HTTP ${rNoteLong.status}`);
  const rNoteTooLong = await notePost(`${ADMIN}/note`, { id: noteSubId, note: '长'.repeat(20001) });
  check(rNoteTooLong.status === 400 && /20000/.test(String(rNoteTooLong.body?.error || '')),
    '6f-13 超过 20000 字 → 400，且错误文案里写明了当前上限',
    `HTTP ${rNoteTooLong.status} · ${JSON.stringify(rNoteTooLong.body?.error)}`);
  // 收尾：把靶子的备注还原成**它原来那句**（不是 NOTE_SUB）—— 测试数据目录随后整个删掉，
  // 但「只增」的习惯照旧：测完把动过的字段放回去。
  await notePost(`${ADMIN}/note`, { id: noteSubId, note: noteMeta0.note });

  // ---------------------------------------------------------------- ⑥g `/decide` 的 superseded + `/packkind`
  // 业主 2026-10-12 两件：
  //   ① **投稿取代投稿**：同一个 `pack.json` id 会有多版投稿（v0.2.1 取代 v0.2.0 与 v0.1），
  //      原先只有「兼容包取代投稿」一条路能写 superseded ⇒ 高版本上线后旧版本一直挂在待审队列/公网。
  //      补法：`markReplacedBy` 的 `replacedBy.area` 按取代者的**实际区**给、理由文案按区换词；
  //      `/decide` 多收一个 `superseded`（必须带 `replacedBy`）。
  //   ② **`packKind` 可写**：这一栏原先只有读、没有写 ⇒ 判了分类落不到公网。
  //
  // ⭐ 2026-10-13 追加（业主总政策「以新为准」）：上面那条「取代者不能是兼容包」**已删除**
  //    （6g-9 随之从 400 改成「不再拒」）；判据搬进 `checkSupersede()`，与新端点
  //    `POST ${ADMIN}/supersede` 共用一份实现。那两种组合的真跑在下面的 ⑥h。
  //
  // ⚠️ 这一节**先**钉住「compat→投稿 那条老路径的产出与改动前逐字相同」，再去动别的 ——
  //    老路径零变化是这次补丁的硬要求。
  console.log('\n⑥g superseded（投稿取代投稿）+ packkind（分类可写）');

  // ---- ① 回归钉子：compat→投稿 那条路（① 段发布兼容包时写的）产出必须与从前逐字相同
  {
    const cMetaNow = JSON.parse(readFileSync(join(dataDir, 'compat', cid, 'meta.json'), 'utf8'));
    const oDecNow = JSON.parse(readFileSync(oDecFile, 'utf8'));
    const expReason = `已由兼容包 ${cid}（${cMetaNow.name}）取代并发布 —— 这一条不再单独上线，避免公网出现两份。`;
    check(oDecNow.reason === expReason,
      '6g-1 【回归钉子】compat→投稿 的理由文案与改动前**逐字相同**（byArea=compat 走老词）',
      JSON.stringify(oDecNow.reason));
    check(oDecNow.replacedBy.area === 'compat' && oDecNow.replacedBy.id === cid,
      '6g-2 【回归钉子】replacedBy.area 仍是 compat、id 未变', JSON.stringify(oDecNow.replacedBy));
    check(JSON.stringify(Object.keys(oDecNow)) === JSON.stringify(['decision', 'reason', 'at', 'by', 'displayName', 'replacedBy']),
      '6g-3 【回归钉子】decision.json 的键序与改动前逐字相同', JSON.stringify(Object.keys(oDecNow)));
  }

  // ---- ② 起第四个实例（**同一个 DATA_DIR**、新进程 ⇒ 限流计数器是新的），造一条**已 approved 的投稿**当取代者
  const P4 = 8809;
  const BASE4 = `http://127.0.0.1:${P4}`;
  const child4 = spawn(process.execPath, [SERVER_FILE], {
    env: { ...process.env, PORT: String(P4), DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN, ADMIN_PATH, MAX_MB: '4', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log4 = '';
  child4.stdout.on('data', (d) => { log4 += d; });
  child4.stderr.on('data', (d) => { log4 += d; });
  try {
    let up4 = false;
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(`${BASE4}/healthz`)).ok) { up4 = true; break; } } catch { /* 还没起 */ }
      await sleep(120);
    }
    if (!up4) throw new Error('第四个实例没起来：\n' + log4);
    const adm4 = (p, opt = {}) => fetch(`${BASE4}${p}`, { ...opt, headers: { 'x-admin-token': TOKEN, ...(opt.headers || {}) } });
    const post4 = async (p, obj) => {
      const r = await adm4(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const newZip = makeZip([
      { name: 'pack.json', data: '{\n  "id": "newver",\n  "name": "高版本投稿",\n  "version": "0.2.1",\n  "author": "社区作者辛",\n  "license": "CC-BY-NC-4.0",\n  "description": "同 id 的更高版本。",\n  "api": ">=1 <2"\n}\n' },
      { name: 'ui/a.js', data: 'export const a = 2;\n' },
    ]);
    const rN = await fetch(`${BASE4}/api/submit?name=${encodeURIComponent('高版本投稿')}`, {
      method: 'POST', headers: { 'content-type': 'application/zip' }, body: newZip });
    const jN = await rN.json();
    const newId = jN.id;
    check(rN.status === 201 && !!newId, '6g-4 第四个实例（新进程 ⇒ 新限流计数器）投出一条新投稿', `编号 ${newId}`);

    // ---- ③ 守卫：全都要在**写盘之前**拒掉
    const target = origId;                 // 被取代者（submissions 区）
    const tMeta = join(dataDir, 'submissions', target, 'meta.json');
    const tZip = join(dataDir, 'submissions', target, 'mod.zip');
    const tMeta0 = sha(readFileSync(tMeta)), tZip0 = sha(readFileSync(tZip));
    const g1 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded' });
    check(g1.status === 400, '6g-5 superseded 缺 replacedBy ⇒ 400', `HTTP ${g1.status}`);
    const g2 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded', replacedBy: 'not-an-id' });
    check(g2.status === 400, '6g-6 replacedBy 形状不对 ⇒ 400', `HTTP ${g2.status}`);
    const g3 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded', replacedBy: target });
    check(g3.status === 400, '6g-7 replacedBy 等于自己 ⇒ 400', `HTTP ${g3.status}`);
    const g4 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded', replacedBy: 'zzzzzzzzzzzz' });
    check(g4.status === 404, '6g-8 replacedBy 那条不存在 ⇒ 404', `HTTP ${g4.status}`);
    const g5 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded', replacedBy: cid });
    // ⭐ 【政策改动 2026-10-13】这一条**原先是 400**（「取代者不能是兼容包」）。
    //    「以新为准」把那一栏放开了 —— 取代者可以是兼容包，也可以普通投稿。
    //    而 `target` 此刻**已经**被 `cid` 取代着 ⇒ 这里命中的是**幂等分支**：
    //    200 + changed:false，**不写盘**（下面 6g-13 的逐字节断言照旧成立）。
    check(g5.status === 200 && g5.body?.changed === false,
      '6g-9 【政策改动】replacedBy 是兼容包**不再拒**（以新为准放开）；这一对本来就是这个关系 ⇒ 幂等 changed:false',
      `HTTP ${g5.status} · changed=${g5.body?.changed}`);
    const g6 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded', replacedBy: newId });
    check(g6.status === 409, '6g-10 **取代者还没 approved** ⇒ 409（防公网「两份都没有」）', `HTTP ${g6.status}`);
    const g7 = await post(`${ADMIN}/decide`, { ids: [target], decision: 'superseded', replacedBy: newId });
    check(g7.status === 400, '6g-11 「一批」的形状 ⇒ 400（一次一个明确写出的 id）', `HTTP ${g7.status}`);
    const g8 = await post(`${ADMIN}/decide`, { id: target, decision: 'nonsense' });
    check(g8.status === 400, '6g-12 decision 白名单外的值 ⇒ 400', `HTTP ${g8.status}`);
    check(sha(readFileSync(tMeta)) === tMeta0 && sha(readFileSync(tZip)) === tZip0,
      '6g-13 上面那一串被拒的请求**一个字节都没写**（先算不写）');

    // ---- ④ 成功路径：先把取代者批上线，再取代
    const ap = await post(`${ADMIN}/decide`, { id: newId, decision: 'approved' });
    check(ap.status === 200, '6g-14 把取代者批上线', `HTTP ${ap.status}`);
    const s1 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded', replacedBy: newId });
    check(s1.status === 200 && s1.body?.state === 'superseded' && s1.body?.changed === true,
      '6g-15 投稿取代投稿 ⇒ 200 superseded', `HTTP ${s1.status}`);
    const tDec = JSON.parse(readFileSync(join(dataDir, 'submissions', target, 'decision.json'), 'utf8'));
    check(tDec.replacedBy.area === 'normal' && tDec.replacedBy.id === newId,
      '6g-16 replacedBy.area 按**取代者的实际区**给（submissions 区 ⇒ normal），不再写死 compat',
      JSON.stringify(tDec.replacedBy));
    check(/^已由投稿 /.test(tDec.reason), '6g-17 理由文案按区换词（取代者是投稿 ⇒「已由投稿 …」）', JSON.stringify(tDec.reason));
    check(sha(readFileSync(tMeta)) === tMeta0 && sha(readFileSync(tZip)) === tZip0,
      '6g-18 被取代那条的 meta.json 与 mod.zip **逐字节未变**（只写它自己的 decision.json）');
    const s2 = await post(`${ADMIN}/decide`, { id: target, decision: 'superseded', replacedBy: newId });
    check(s2.status === 200 && s2.body?.changed === false, '6g-19 幂等：同一件事发两次，第二次 changed:false');

    // ---- ⑤ packkind：闭枚举 / 一批 / 幂等 / 只动一栏 / 区无关 / 公网真的变了
    const nMeta = join(dataDir, 'submissions', newId, 'meta.json');
    const nZip = join(dataDir, 'submissions', newId, 'mod.zip');
    const nMeta0 = JSON.parse(readFileSync(nMeta, 'utf8'));
    const nZip0 = sha(readFileSync(nZip));
    const k0 = await post4(`${ADMIN}/packkind`, { id: newId, packKind: 'bogus' });
    check(k0.status === 400, '6g-20 packKind 闭枚举：拼错的值 ⇒ 400', `HTTP ${k0.status}`);
    const k1 = await post4(`${ADMIN}/packkind`, { ids: [newId], packKind: 'functional' });
    check(k1.status === 400, '6g-21 packkind 「一批」的形状 ⇒ 400', `HTTP ${k1.status}`);
    const k2 = await post4(`${ADMIN}/packkind`, { id: newId, packKind: 'functional' });
    check(k2.status === 200 && k2.body?.changed === true && k2.body?.packKind === 'functional',
      '6g-22 packKind 写成功（functional）', `HTTP ${k2.status}`);
    const nMeta1 = JSON.parse(readFileSync(nMeta, 'utf8'));
    check(nMeta1.packKind === 'functional', '6g-23 记录里 packKind = functional');
    const stripPk = (o) => { const c = { ...o }; delete c.packKind; delete c.revisions; return JSON.stringify(c); };
    check(stripPk(nMeta0) === stripPk(nMeta1), '6g-24 除 packKind / revisions 外其余键值逐字未变');
    check(sha(readFileSync(nZip)) === nZip0, '6g-25 mod.zip 一字未动');
    const k3 = await post4(`${ADMIN}/packkind`, { id: newId, packKind: 'functional' });
    check(k3.status === 200 && k3.body?.changed === false, '6g-26 幂等：同一句再发一次 changed:false');
    const k4 = await post4(`${ADMIN}/packkind`, { id: cid, packKind: 'documentation' });
    check(k4.status === 200 && k4.body?.area === 'compat', '6g-27 区无关：compat 区的记录也设得上', `HTTP ${k4.status}`);
    const pub = await (await fetch(`${BASE4}/api/mods`)).json();
    const pubNew = pub.mods.find((x) => x.id === newId);
    check(pubNew && pubNew.packKind === 'functional',
      '6g-28 公网 /api/mods 上这一条**不再是 unknown**，而是 functional（这就是这个端点存在的理由）',
      pubNew ? `packKind=${pubNew.packKind}` : '(不在主列表)');
  } finally {
    child4.kill();
    await sleep(200);
  }

  // ================================================================
  // ⑥h ⭐ **「以新为准」**（业主 2026-10-13 总政策）：`POST ${ADMIN}/supersede`
  //     「以后所有 mod 以新为准：新的上线、旧的下架但不删除」。
  //
  // 这一段把政策要求的**两种组合**都真跑一遍：
  //   ① 旧的普通投稿 ← 新的普通投稿 / 新的兼容包；
  //   ② **旧的本身是兼容包** —— 改动前 `markReplacedBy` 第 1042 行对 `area === 'compat'` 直接
  //      `return null`，这条路**根本做不到**；放开之后才做得到（本任务就是把它做成能做的）。
  // 外加四道守卫（自己取代自己 / 成环 / 不同 pack.id / 读不出 pack.id）与「下架 ≠ 删除」。
  //
  // 夹具**直接写盘**（不走上传口）：唯一的目的是把两条记录包内 `pack.json` 的 `id`
  // 精确控制成**同一个** —— 那正是这条端点要核的那件事。
  console.log(`\n⑥h ⭐「以新为准」：${ADMIN}/supersede（同 pack.id 的一对 ⇒ 旧的 superseded + replacedBy；下架不删）`);
  {
    const mkRec = (area, id, { name, packId = null, decision = null, noPack = false }) => {
      const dir = join(dataDir, area, id);
      mkdirSync(dir, { recursive: true });
      const files = noPack
        ? [{ name: 'ui/a.js', data: `export const ${id} = 1;\n` }]
        : [
          { name: 'pack.json', data: `${JSON.stringify({ id: packId, name, version: '1.0.0', author: '夹具作者', license: 'CC-BY-NC-4.0' }, null, 2)}\n` },
          { name: 'ui/a.js', data: `export const ${id} = 1;\n` },
        ];
      writeFileSync(join(dir, 'mod.zip'), makeZip(files));
      const meta = { name, size: 128, uploadedAt: '2026-10-13T00:00:00.000Z', note: '「以新为准」自测夹具' };
      if (area === 'compat') {
        meta.kind = 'compat'; meta.compatOf = null; meta.compatAuthor = '维护者';
        if (packId) meta.pack = { id: packId };
      }
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      if (decision) writeFileSync(join(dir, 'decision.json'), JSON.stringify(decision, null, 2));
      return dir;
    };
    const appr = (name) => ({ decision: 'approved', reason: null, at: '2026-10-13T00:00:00.000Z', by: 'admin', displayName: name });
    const shaOf = (p) => sha(readFileSync(p));
    const pubIds = async () => {
      const j = await (await fetch(`${BASE}/api/mods`)).json();
      return [...j.mods, ...j.flagged].map((m) => m.id);
    };

    // ① 普通投稿 ↔ 普通投稿（同一个 pack.id）
    mkRec('submissions', 'aa1100000001', { name: '夹具甲·旧版', packId: 'pair-pack-a', decision: appr('夹具甲·旧版') });
    mkRec('submissions', 'aa1100000002', { name: '夹具甲·新版', packId: 'pair-pack-a', decision: appr('夹具甲·新版') });
    // ② 旧的是**兼容包**，新的是普通投稿
    mkRec('compat', 'bb2200000001', { name: '夹具乙·旧兼容版', packId: 'pair-pack-b', decision: appr('夹具乙·旧兼容版') });
    mkRec('submissions', 'bb2200000002', { name: '夹具乙·新投稿', packId: 'pair-pack-b', decision: appr('夹具乙·新投稿') });
    // ③ 旧的是普通投稿，新的是**兼容包**
    mkRec('submissions', 'cc3300000001', { name: '夹具丙·旧投稿', packId: 'pair-pack-c', decision: appr('夹具丙·旧投稿') });
    mkRec('compat', 'cc3300000002', { name: '夹具丙·新兼容版', packId: 'pair-pack-c', decision: appr('夹具丙·新兼容版') });
    // 守卫用的夹具
    mkRec('submissions', 'dd4400000001', { name: '夹具丁·另一个 mod', packId: 'pair-pack-e', decision: appr('夹具丁·另一个 mod') });
    mkRec('submissions', 'dd4400000002', { name: '夹具丁·这个 mod', packId: 'pair-pack-d', decision: appr('夹具丁·这个 mod') });
    mkRec('submissions', 'ee5500000001', { name: '夹具戊·包里没有 pack.json', packId: null, noPack: true, decision: appr('夹具戊') });
    mkRec('submissions', 'ee5500000002', { name: '夹具戊·另一个', packId: 'pair-pack-x', decision: appr('夹具戊·另一个') });
    mkRec('submissions', 'ff6600000001', { name: '夹具己·已被取代的', packId: 'pair-pack-f',
      decision: { decision: 'superseded', reason: '夹具：先造一条已被取代的', at: '2026-10-13T00:00:00.000Z', by: 'admin', displayName: '夹具己·已被取代的', replacedBy: { id: 'ff6600000002', name: '夹具己·取代者', area: 'normal', at: '2026-10-13T00:00:00.000Z' } } });
    mkRec('submissions', 'ff6600000002', { name: '夹具己·取代者', packId: 'pair-pack-f', decision: appr('夹具己·取代者') });
    mkRec('submissions', 'ii9900000001', { name: '夹具辛·还没批', packId: 'pair-pack-g' });
    mkRec('submissions', 'ii9900000002', { name: '夹具辛·已批', packId: 'pair-pack-g', decision: appr('夹具辛·已批') });

    const before = await pubIds();
    check(before.includes('aa1100000001') && before.includes('aa1100000002'),
      '6h-1 夹具就绪：同一个 pack.id 的两条都在公开面上（这是取代的起点）');

    // ---- ① 普通投稿取代普通投稿
    const z1 = shaOf(join(dataDir, 'submissions', 'aa1100000001', 'mod.zip'));
    const m1Before = JSON.parse(readFileSync(join(dataDir, 'submissions', 'aa1100000001', 'meta.json'), 'utf8'));
    const r1 = await post(`${ADMIN}/supersede`, { newId: 'aa1100000002', oldId: 'aa1100000001' });
    check(r1.status === 200 && r1.body?.changed === true && r1.body?.replacedBy === 'aa1100000002' && r1.body?.packId === 'pair-pack-a',
      '6h-2 同 pack.id 的一对 ⇒ 200，旧的转 superseded、replacedBy 指向新的，并回显 packId',
      `HTTP ${r1.status} · ${JSON.stringify({ changed: r1.body?.changed, packId: r1.body?.packId })}`);
    const d1 = JSON.parse(readFileSync(join(dataDir, 'submissions', 'aa1100000001', 'decision.json'), 'utf8'));
    check(d1.decision === 'superseded' && d1.replacedBy?.id === 'aa1100000002',
      '6h-3 旧的 decision.json 逐字落下：superseded + replacedBy', JSON.stringify(d1.replacedBy));
    const after1 = await pubIds();
    check(!after1.includes('aa1100000001') && after1.includes('aa1100000002'),
      '6h-4 公开面**只剩新的**：旧的不再列出，新的照旧在', `旧在=${after1.includes('aa1100000001')} 新在=${after1.includes('aa1100000002')}`);
    check(existsSync(join(dataDir, 'submissions', 'aa1100000001', 'mod.zip'))
      && shaOf(join(dataDir, 'submissions', 'aa1100000001', 'mod.zip')) === z1,
      '6h-5 **下架 ≠ 删除**：旧的 mod.zip 还在，而且逐字节没变');
    const oldPub = await fetch(`${BASE}/api/file/aa1100000001`);
    const oldAdm = await adm('/api/file/aa1100000001');
    check(oldPub.status === 403 && oldAdm.status === 200,
      '6h-6 旧的**仍可下载**：公开口 403（不再对外发布）、管理口 200（维护者照旧取得到）',
      `公开 ${oldPub.status} · 管理 ${oldAdm.status}`);
    const m1b = JSON.parse(readFileSync(join(dataDir, 'submissions', 'aa1100000001', 'meta.json'), 'utf8'));
    const stripRev = (o) => { const c = { ...o }; delete c.revisions; return JSON.stringify(c); };
    check(stripRev(m1b) === stripRev(m1Before)
      && Array.isArray(m1b.revisions) && m1b.revisions.length === ((m1Before.revisions || []).length) + 1
      && m1b.revisions[m1b.revisions.length - 1].to?.replacedBy === 'aa1100000002'
      && shaOf(join(dataDir, 'submissions', 'aa1100000001', 'mod.zip')) === z1,
      '6h-7 旧的 meta.json **只多一笔 revisions**（其余键、mod.zip 一字未动）', `revisions=${m1b.revisions?.length}`);
    const mA1 = shaOf(join(dataDir, 'submissions', 'aa1100000001', 'meta.json'));
    const dA1 = shaOf(join(dataDir, 'submissions', 'aa1100000001', 'decision.json'));
    const r1b = await post(`${ADMIN}/supersede`, { newId: 'aa1100000002', oldId: 'aa1100000001' });
    check(r1b.status === 200 && r1b.body?.changed === false
      && shaOf(join(dataDir, 'submissions', 'aa1100000001', 'meta.json')) === mA1
      && shaOf(join(dataDir, 'submissions', 'aa1100000001', 'decision.json')) === dA1,
      '6h-8 幂等：同一对再发一次 ⇒ 200 changed:false，而且**没写盘**（meta 与 decision 的 sha 都没变）');

    // ---- ② 新的普通投稿取代**旧的兼容包**（改动前 markReplacedBy 直接 return null 的那一种）
    const z2 = shaOf(join(dataDir, 'compat', 'bb2200000001', 'mod.zip'));
    const r2 = await post(`${ADMIN}/supersede`, { newId: 'bb2200000002', oldId: 'bb2200000001' });
    const d2 = JSON.parse(readFileSync(join(dataDir, 'compat', 'bb2200000001', 'decision.json'), 'utf8'));
    check(r2.status === 200 && d2.decision === 'superseded' && d2.replacedBy?.id === 'bb2200000002',
      '6h-9 ⭐ **旧的兼容包也能下课**（改动前这条路 return null 做不到）：转 superseded + replacedBy',
      `HTTP ${r2.status} · replacedBy=${JSON.stringify(d2.replacedBy)}`);
    const after2 = await pubIds();
    check(!after2.includes('bb2200000001') && after2.includes('bb2200000002'),
      '6h-10 公开面上旧的兼容包消失、新的投稿在');
    check(existsSync(join(dataDir, 'compat', 'bb2200000001', 'mod.zip'))
      && shaOf(join(dataDir, 'compat', 'bb2200000001', 'mod.zip')) === z2,
      '6h-11 旧的兼容包的包体也**一个字节没删**（下架 ≠ 删除）');
    const cOldPub = await fetch(`${BASE}/api/file/bb2200000001`);
    const cOldAdm = await adm('/api/file/bb2200000001');
    check(cOldPub.status === 403 && cOldAdm.status === 200,
      '6h-12 旧的兼容包**仍可下载**：公开口 403 / 管理口 200', `公开 ${cOldPub.status} · 管理 ${cOldAdm.status}`);

    // ---- ③ 新的**兼容包**取代旧的普通投稿
    const r3 = await post(`${ADMIN}/supersede`, { newId: 'cc3300000002', oldId: 'cc3300000001' });
    const d3 = JSON.parse(readFileSync(join(dataDir, 'submissions', 'cc3300000001', 'decision.json'), 'utf8'));
    check(r3.status === 200 && d3.decision === 'superseded' && d3.replacedBy?.id === 'cc3300000002' && d3.replacedBy?.area === 'compat',
      '6h-13 ⭐ 取代者**可以是兼容包**（政策放开的那一半）：replacedBy.area === compat',
      `HTTP ${r3.status} · ${JSON.stringify(d3.replacedBy)}`);

    // ---- 四道守卫：全都要在**写盘之前**拒掉
    const gBefore = {
      a: shaOf(join(dataDir, 'submissions', 'aa1100000002', 'meta.json')),
      b: shaOf(join(dataDir, 'submissions', 'dd4400000001', 'meta.json')),
      c: shaOf(join(dataDir, 'submissions', 'ff6600000002', 'decision.json')),
      d: shaOf(join(dataDir, 'submissions', 'ee5500000002', 'decision.json')),
    };
    const gSelf = await post(`${ADMIN}/supersede`, { newId: 'aa1100000001', oldId: 'aa1100000001' });
    check(gSelf.status === 400 && gSelf.body?.code === 'SUPERSEDE_SELF',
      '6h-14 **自己取代自己 ⇒ 拒**（400 · SUPERSEDE_SELF）', `HTTP ${gSelf.status} · ${gSelf.body?.code}`);
    const gCyc = await post(`${ADMIN}/supersede`, { newId: 'ff6600000001', oldId: 'ff6600000002' });
    check(gCyc.status === 409 && gCyc.body?.code === 'SUPERSEDE_CYCLE' && Array.isArray(gCyc.body?.chain),
      '6h-15 **会形成取代环 ⇒ 拒**（409 · SUPERSEDE_CYCLE，并把整条链给出来）',
      `HTTP ${gCyc.status} · ${gCyc.body?.code} · chain=${(gCyc.body?.chain || []).join('→')}`);
    const gPack = await post(`${ADMIN}/supersede`, { newId: 'dd4400000002', oldId: 'dd4400000001' });
    check(gPack.status === 409 && gPack.body?.code === 'SUPERSEDE_PACK_ID_MISMATCH',
      '6h-16 **不同 pack.id ⇒ 拒**（409 · SUPERSEDE_PACK_ID_MISMATCH —— 绝不误下架无关 mod）',
      `HTTP ${gPack.status} · 旧=${gPack.body?.packIdOld} 新=${gPack.body?.packIdNew}`);
    const gNoPack = await post(`${ADMIN}/supersede`, { newId: 'ee5500000002', oldId: 'ee5500000001' });
    check(gNoPack.status === 422 && gNoPack.body?.code === 'SUPERSEDE_PACK_ID_UNREADABLE',
      '6h-17 **读不出 pack.id ⇒ 拒**（422 · SUPERSEDE_PACK_ID_UNREADABLE —— 不猜、不动它）',
      `HTTP ${gNoPack.status} · ${gNoPack.body?.code}`);
    const gBatch = await post(`${ADMIN}/supersede`, { ids: ['aa1100000001'], newId: 'aa1100000002', oldId: 'aa1100000001' });
    check(gBatch.status === 400 && gBatch.body?.code === 'SUPERSEDE_BATCH',
      '6h-18 **一次只处理一对**：报文里出现「一批」的形状 ⇒ 400', `HTTP ${gBatch.status} · ${gBatch.body?.code}`);
    const gPend = await post(`${ADMIN}/supersede`, { newId: 'ii9900000001', oldId: 'ii9900000002' });
    check(gPend.status === 409 && gPend.body?.code === 'SUPERSEDE_NEW_NOT_APPROVED',
      '6h-19 取代者还没上线 ⇒ 409（防公网「两份都没有」）', `HTTP ${gPend.status} · ${gPend.body?.code}`);
    check(shaOf(join(dataDir, 'submissions', 'aa1100000002', 'meta.json')) === gBefore.a
      && shaOf(join(dataDir, 'submissions', 'dd4400000001', 'meta.json')) === gBefore.b
      && shaOf(join(dataDir, 'submissions', 'ff6600000002', 'decision.json')) === gBefore.c
      && shaOf(join(dataDir, 'submissions', 'ee5500000002', 'decision.json')) === gBefore.d,
      '6h-20 上面这一串被拒的请求**一个字节都没写**（先算不写）');
  }

  // 收尾总检查：整场测试跑完（成功的、被拒的、抛错的路径都走过），
  // 数据目录根下**一个 .part 都不该有** —— 临时文件只该以「已经改名成正式 mod.zip」的形式存在。
  const leftover = await partFilesSettled();
  check(leftover.length === 0, '⑦ 全场跑完，DATA_DIR 根下没有任何 .part 残留',
    leftover.length ? `残留 ${leftover.length} 个：${leftover.join('、')}` : '一个都没有');
  // 根下只该有 submissions / flagged / compat 三个**目录**（测试自己还会建一个 _stash 暂存目录），
  // 一个**文件**都不该有 —— 生产数据目录根下出现文件，那就是上传中途留下的垃圾。
  // 【2026-10-12 唯一一处既有断言的改动 —— **不是放宽**】：本条原本要求根下「一个文件都不该有」，
  //   防的是上传中途留下的垃圾（.part 之类）。本次新增了**极简追加式审计日志**
  //   `<DATA_DIR>/audit.jsonl`（裁定 ⑧ ①，落点就在数据目录，只追加、从不改写），
  //   它是**有意的、必须存在的**顶层文件。所以白名单里只多它**一个**：
  //   其余任何顶层文件照旧让这一条失败 —— 对「意外文件」的严格程度一点没降。
  const ROOT_OK = ['audit.jsonl'];
  const strayFiles = readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => e.name).filter((n) => !ROOT_OK.includes(n));
  check(strayFiles.length === 0, '⑦b DATA_DIR 根下没有多余的**文件**（只剩三个数据子目录 + 有意的 audit.jsonl）',
    strayFiles.length ? `多出 ${strayFiles.length} 个：${strayFiles.join('、')}` : '一个都没有');
} finally {
  child.kill();
  await sleep(200);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('');
if (failures) { console.log(`✖ ${failures} 项没通过`); process.exit(1); }
console.log('✔ 兼容包：上传 → 三档检查 → 双署名 → 通过 → 公开列表给改写版、原件留档；'
  + '详情页那个按钮一步到位（publish=1）发布并把原投稿按 B 口径标 superseded；'
  + 'compat/link 补关联、compat/note 只改备注文案（一次一个 id · 数据零变化）、'
  + 'compat-submit 的「维护者人工确认」逐条放行 blocker（档位定义一条没改），整条链通过；'
  + '「以新为准」（/supersede：同 pack.id 的一对 ⇒ 旧的 superseded + replacedBy，'
  + '旧的**是兼容包也行**，下架不删文件、拒环、拒跨 id、拒读不出 pack.id）');
