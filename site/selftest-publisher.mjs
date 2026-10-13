// 发布者自助 + 分类筛选 + 审计日志的自测（2026-10-12 新增）。
//
//   node site/selftest-publisher.mjs
//
// 与既有三个自测同一套写法：零依赖、只用 node 内置、自带一个 store 模式的极小 zip 写入器、
// 起一个**真正的新实例**（自己的端口 + 自己的临时数据目录），全程走 HTTP。
//
// 它专门盯这几件事（业主需求原话：「发布者能自由管理修改」「他想删掉」「管理员负责审核」
// 「筛选功能」）：
//   ①  提交后**拿到认领码** → 换发布者令牌成功；错令牌被拒、且**不泄露记录是否存在**
//   ②  发布者改元数据 ⇒ 公开面**立即不再列出**、记录仍在、revisions 有痕
//   ③  发布者换包体 ⇒ **公开面仍展示旧包**（裁定 ⑦）；管理员批准后才切换，旧包改名留档
//   ④  发布者自撤 ⇒ 公开面立即不再列出 + 审核台出现待确认 + 管理员确认后
//      decision=superseded 且 **replacedBy:null**（新校验）；管理员拒绝则恢复公开
//   ⑤  **管理员驱动的 superseded 仍必须带 replacedBy**（旧不变量不许被放宽）
//   ⑥  packKind 筛选：单值 / 多值 / 不传 / 非法值 ⇒ 行为正确且向后兼容
//   ⑦  审计日志有对应条目、**不含令牌明文**
//   ⑧  发布者令牌**只能碰自己那条**（拿 A 的令牌改 B ⇒ 403）
//   ⑨  零删除：跑完全部用例后**记录与文件数只增不减**
//   ⑫  **发布者自助删除**：删自己的 ⇒ 公开面立刻消失 + 下载 403 + 落 superseded/replacedBy:null/
//       reason:publisher-delete 软删；删别人的 ⇒ 403；无令牌 ⇒ 401；幂等；零删除
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8807;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'selftest-publisher-token-0123456789';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- 极小 zip 写入器（store）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
/** 一个**干净的**包体：根 pack.json，没有不透明容器、没有作者自述 ⇒ 发布不需要任何「点头」。 */
const goodPack = (author, ver) => makeZip([{
  name: 'pack.json',
  data: JSON.stringify({ id: 'mine-test', name: '我的包', author, version: ver, api: 1, game: '0.16.0' }),
}]);

// ---------------------------------------------------------------- 起服务
const dataDir = mkdtempSync(join(tmpdir(), 'sp-pubsite-'));
const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN, MAX_MB: '4' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUp = async () => {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* 等 */ }
    await sleep(120);
  }
  return false;
};
const admin = (p, opt = {}) => fetch(`${BASE}${p}`, { ...opt, headers: { 'x-admin-token': TOKEN, ...(opt.headers || {}) } });
const submit = async (buf, { name, note = '', file = 'x.zip' } = {}) => {
  const q = new URLSearchParams({ name, note });
  const r = await fetch(`${BASE}/api/submit?${q}`, {
    method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': encodeURIComponent(file) }, body: buf,
  });
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body };
};
/** 发布者侧的请求：令牌走 `x-publisher-token` 头（与站点文档一致）。 */
const pubInit = (init, token) => (token ? { ...init, headers: { ...(init.headers || {}), 'x-publisher-token': token } } : init);
const pub = (p, init = {}, token = null) => fetch(`${BASE}${p}`, pubInit(init, token));
const postJson = (p, obj, token = null) => pub(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
}, token);
/** 读一个响应：把**原文**先读出来再解析（解析失败就 null，绝不吞掉状态码）。 */
const readRes = async (r) => {
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text || '{}'); } catch { body = null; }
  return { status: r.status, body, text };
};
const postJsonRead = async (p, obj, token = null) => readRes(await postJson(p, obj, token));
/** 发布者侧的读端点（GET）也要同一份读法 —— 否则「解析失败」会被静默吞成 null。 */
const pubJson = async (p, init = {}, token = null) => readRes(await pub(p, init, token));

/** 递归列出数据目录里每个文件（相对路径，'/' 分隔）。 */
const listFiles = (dir = dataDir, prefix = '') => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])).sort();
/** 记录条数 = 三个区里 meta.json 的个数（**只数，不改**）。 */
const countRecords = () => ['submissions', 'flagged', 'compat']
  .flatMap((a) => { const d = join(dataDir, a); return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${a}/${e.name}`) : []; })
  .filter((id) => existsSync(join(dataDir, id, 'meta.json'))).length;
const publicIds = async () => {
  const j = await (await fetch(`${BASE}/api/mods`)).json();
  return [...(j.mods || []), ...(j.flagged || [])].map((m) => m.id);
};
const auditLines = () => {
  const p = join(dataDir, 'audit.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

try {
  check(await waitUp(), '自测实例起来了');

  const before = { records: countRecords(), files: listFiles().length };

  // ================================================================
  console.log('① 提交 → 拿到一次性认领码 → 换发布者令牌；错令牌被拒且不泄露记录存在性');
  const A = await submit(goodPack('A君', '1.0.0'), { name: 'A 的包' });
  check(A.status === 201 && A.body?.id, '正常投稿拿到 201', `id=${A.body?.id}`);
  const idA = A.body.id;
  check(typeof A.body.claimCode === 'string' && /^[2-9A-HJ-NP-Z]{16}$/.test(A.body.claimCode),
    '响应里带一枚**一次性认领码**（16 位 Base32，抄得下来）', String(A.body.claimCode).length + ' 位');
  const claimA = A.body.claimCode;
  // 盘上**不许有明文**：meta.json 里只有哈希。
  const metaA = readFileSync(join(dataDir, 'submissions', idA, 'meta.json'), 'utf8');
  check(!metaA.includes(claimA), '**盘上没有认领码明文**（只存哈希）');
  check(metaA.includes('pendingClaim') && /"h":\s*"[0-9a-f]{64}"/.test(metaA),
    'meta.json 里落的是 pendingClaim[].h（sha256）');

  const claimWrong = await postJsonRead('/api/publisher/claim', { id: idA, claimCode: 'AAAAAAAAAAAAAAAA' });
  check(claimWrong.status === 403, '错的认领码 → 403', String(claimWrong.status));
  const claimGhostId = 'ffffffffffff';
  const claimGhost = await postJsonRead('/api/publisher/claim', { id: claimGhostId, claimCode: claimA });
  check(claimGhost.status === 403, '不存在的编号 → 403', String(claimGhost.status));
  check(claimWrong.body?.error === claimGhost.body?.error,
    '**两种失败回同一句话**（不泄露「这条记录存不存在」）',
    JSON.stringify(claimWrong.body?.error) === JSON.stringify(claimGhost.body?.error) ? '逐字相同' : '两句话不同');

  const claim1res = await postJson('/api/publisher/claim', { id: idA, claimCode: claimA });
  const claim1 = await readRes(claim1res);   // {status, body, text}
  check(claim1.status === 200 && /^[0-9a-f]{32}$/.test(claim1.body?.publisherToken || ''),
    '用认领码换到发布者令牌', claim1.status + ' · ' + String(claim1.body?.publisherToken).slice(0, 6) + '…');
  const tokA = claim1.body.publisherToken;
  const metaA2 = readFileSync(join(dataDir, 'submissions', idA, 'meta.json'), 'utf8');
  check(!metaA2.includes(tokA), '**盘上没有发布者令牌明文**（只存哈希）');
  check(!metaA2.includes(claimA), '用掉的认领码也从待用清单里消失了（明文依旧不在盘上）');

  const claimAgain = await postJsonRead('/api/publisher/claim', { id: idA, claimCode: claimA });
  check(claimAgain.status === 403, '同一枚认领码**用过就失效**（一次性）→ 403', String(claimAgain.status));

  const mineA = await pubJson('/api/publisher/mine', {}, tokA);
  check(mineA.status === 200 && (mineA.body?.mine || []).some((m) => m.id === idA),
    '「我的投稿」凭令牌列出了自己那一条', `count=${mineA.body?.count}`);
  const mineNoTok = await pubJson('/api/publisher/mine', {}, null);
  check(mineNoTok.status === 401, '不带令牌 → 401', String(mineNoTok.status));
  const mineBadTok = await pubJson('/api/publisher/mine', {}, 'deadbeef'.repeat(4));
  check(mineBadTok.status === 200 && (mineBadTok.body?.mine || []).length === 0,
    '错的令牌 → 空列表（不是 401，也不泄露任何一条）', `count=${mineBadTok.body?.count}`);

  // ================================================================
  console.log('⑤ 管理员驱动的 superseded **仍必须带 replacedBy**（旧不变量不许被放宽）');
  const B = await submit(goodPack('B君', '1.0.0'), { name: 'B 的包' });
  const idB = B.body.id;
  const supNoBy = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idB, decision: 'superseded' }),
  });
  check(supNoBy.status === 400, '管理员 superseded 不带 replacedBy → 400（老规矩没松）', String(supNoBy.status));
  const byNotApproved = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idB, decision: 'superseded', replacedBy: idA }),
  });
  check(byNotApproved.status === 409, '取代者还没 approved → 409（老规矩没松）', String(byNotApproved.status));

  // 把 A、B 都批上线，好验证「公开面」的各种变化。
  const appA = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idA, decision: 'approved' }),
  });
  const appB = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idB, decision: 'approved' }),
  });
  check(appA.status === 200 && appB.status === 200, 'A、B 两条都批上线（公开面基准）');
  check((await publicIds()).includes(idA) && (await publicIds()).includes(idB),
    '两条都出现在公开面', JSON.stringify(await publicIds()));

  // ================================================================
  console.log('② 发布者改元数据 ⇒ 公开面**立即不再列出**、记录仍在、revisions 有痕');
  const upd = await postJsonRead('/api/publisher/update', { id: idA, name: 'A 的包（改过名）', packKind: 'functional' }, tokA);
  check(upd.status === 200 && upd.body?.forcedPending === true, '改元数据成功且**强制回待审**', JSON.stringify(upd.body?.changedKeys));
  check(upd.body?.previousDecision === 'approved', '上一份决定是 approved（被移进了 revisions）', String(upd.body?.previousDecision));
  check(!(await publicIds()).includes(idA), '**公开面立刻不再列出**它（这就是「改了要重审」）');
  check(existsSync(join(dataDir, 'submissions', idA, 'meta.json')), '记录目录与 meta.json 原样都在（零删除）');
  check(!existsSync(join(dataDir, 'submissions', idA, 'decision.json')), 'decision.json 已**移入 revisions**（pending 是文件缺省的读法）');
  const metaA3 = JSON.parse(readFileSync(join(dataDir, 'submissions', idA, 'meta.json'), 'utf8'));
  check(Array.isArray(metaA3.revisions) && metaA3.revisions.some((r) => r.by === 'publisher' && r.decisionSnapshot?.decision === 'approved'),
    'revisions 里留有发布者那一笔 **且带着被搬走的决定快照**',
    `revisions=${metaA3.revisions.length}`);
  check(metaA3.packKind === 'functional', '分类也一并写进去了（发布者能填自己的分类，裁定 ⑥）');
  const stA = await (await fetch(`${BASE}/api/status/${idA}?t=${A.body.receipt}`)).json();
  check(stA.state === 'pending', '投稿人凭回执查到的状态是 pending', String(stA.state));

  // ================================================================
  console.log('③ 发布者换包体 ⇒ **公开面仍展示旧包**（裁定 ⑦）；批准后才切换，旧包改名留档');
  // 先让 A 回到公开面（管理员复审通过），这样「换包体后公开面还展示旧包」才**看得出来**。
  const reApprove = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idA, decision: 'approved' }),
  });
  check(reApprove.status === 200, '管理员复审通过 ⇒ A 又回到公开面');
  const oldSha = A.body.sha256;
  const oldBytes = readFileSync(join(dataDir, 'submissions', idA, 'mod.zip'));
  check(createHash('sha256').update(oldBytes).digest('hex') === oldSha, '旧包体哈希 = 上传时的哈希（基准）');

  const newPack = goodPack('A君', '2.0.0');
  const blobRes = await pub(`/api/publisher/blob?id=${idA}`, {
    method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': encodeURIComponent('v2.zip') }, body: newPack,
  }, tokA);
  const blobBody = await readRes(blobRes);
  check(blobRes.status === 200 && blobBody.body.changed === true, '换包体被接收（写成候选）', String(blobRes.status));
  check(existsSync(join(dataDir, 'submissions', idA, 'mod.pending.zip')), '候选落在 mod.pending.zip（另存，不动公开那份）');
  check(createHash('sha256').update(readFileSync(join(dataDir, 'submissions', idA, 'mod.zip'))).digest('hex') === oldSha,
    '**公开的 mod.zip 一个字节都没动**（还是旧包）');
  // ⭐ 裁定 ⑦ 的核心：公开面仍展示旧包。
  const modsAfterBlob = await (await fetch(`${BASE}/api/mods`)).json();
  const pubA = [...modsAfterBlob.mods, ...modsAfterBlob.flagged].find((m) => m.id === idA);
  check(!!pubA, '换包体期间这一条**照旧在公开面上**');
  const dlOld = await fetch(`${BASE}/api/file/${idA}`);
  const dlOldBuf = Buffer.from(await dlOld.arrayBuffer());
  check(dlOld.status === 200 && createHash('sha256').update(dlOldBuf).digest('hex') === oldSha,
    '**公开下载拿到的仍是旧包**（裁定 ⑦：批准前公开面继续展示旧包）');
  const candDlOutsider = await fetch(`${BASE}/api/file/${idA}?variant=candidate`);
  check(candDlOutsider.status === 403, '候选包体对外 403（它不是发布物）', String(candDlOutsider.status));
  const candDlAdmin = await admin(`/api/file/${idA}?variant=candidate`);
  const candBuf = Buffer.from(await candDlAdmin.arrayBuffer());
  check(candDlAdmin.status === 200 && createHash('sha256').update(candBuf).digest('hex') === blobBody.body.candidate.sha256,
    '维护者能下到候选，且哈希与记录一致');
  const candMeta = JSON.parse(readFileSync(join(dataDir, 'submissions', idA, 'meta.json'), 'utf8'));
  const candSha = candMeta.candidate.sha256;

  const promoteBad = await admin('/api/admin/promote-blob', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idA, expectedSha256: 'f'.repeat(64) }),
  });
  check(promoteBad.status === 409, '批准时哈希对不上 → 409（先算不写，不切换）', String(promoteBad.status));
  check(createHash('sha256').update(readFileSync(join(dataDir, 'submissions', idA, 'mod.zip'))).digest('hex') === oldSha,
    '被拒之后公开包体依旧是旧的（一步都没动）');

  const promote = await admin('/api/admin/promote-blob', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idA, expectedSha256: candSha }),
  });
  const promoteBody = (await readRes(promote)).body;
  check(promote.status === 200 && promoteBody.sha256 === candSha, '管理员批准候选包体 ⇒ 切换成功', String(promote.status));
  check(createHash('sha256').update(readFileSync(join(dataDir, 'submissions', idA, 'mod.zip'))).digest('hex') === candSha,
    '公开的 mod.zip 现在就是候选那一份');
  check(!!promoteBody.archived && existsSync(join(dataDir, 'submissions', idA, promoteBody.archived)),
    '旧包体**改名留档**在同一个目录里（不删）', String(promoteBody.archived));
  check(JSON.parse(readFileSync(join(dataDir, 'submissions', idA, 'meta.json'), 'utf8')).sha256 === candSha,
    'meta.sha256 跟着切到新的（记录与文件一致）');
  check(!existsSync(join(dataDir, 'submissions', idA, 'decision.json')),
    '批准换包体后本条**回到待审**（发布者不直改公开面，上线与否仍由管理员给一次）');
  check(!(await publicIds()).includes(idA), '因此它暂时不在公开面上（等管理员那次明确的「通过并上线」）');
  const promoteAgain = await admin('/api/admin/promote-blob', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idA }),
  });
  check(promoteAgain.status === 404, '候选已经用掉，再批准一次 → 404（无候选可批）', String(promoteAgain.status));

  // ================================================================
  console.log('④ 发布者自撤 ⇒ 公开面立即不再列出 + 审核台出现待确认 + 管理员确认后 superseded / replacedBy:null');
  const appA2 = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idA, decision: 'approved' }),
  });
  check(appA2.status === 200 && (await publicIds()).includes(idA), '先把它批回公开面（自撤的基准）');

  const wd = await postJsonRead('/api/publisher/withdraw', { id: idA, reason: '作者不想再发布这一版了' }, tokA);
  const wdBody = wd.body;
  check(wd.status === 200 && wdBody.withdrawRequested === true, '自撤申请被接收', String(wd.status));
  check(wdBody.publicVisible === false, '响应里明确写了 publicVisible=false');
  check(!(await publicIds()).includes(idA), '**公开面立即不再列出**它（「想删掉」要立刻见效）');
  const dlWithdrawn = await fetch(`${BASE}/api/file/${idA}`);
  check(dlWithdrawn.status === 403, '公开下载口也立刻拒绝 → 403（假删除要不得）', String(dlWithdrawn.status));
  check(existsSync(join(dataDir, 'submissions', idA, 'mod.zip')) && existsSync(join(dataDir, 'submissions', idA, 'meta.json')),
    '记录与包体原封不动（零删除）');
  const stW = await (await fetch(`${BASE}/api/status/${idA}?t=${A.body.receipt}`)).json();
  check(stW.state === 'approved' && stW.withdrawRequested === true,
    '自撤**不是一个新 state**：state 仍是 approved，外加 withdrawRequested 标志', `${stW.state} / ${stW.withdrawRequested}`);
  const list = await (await admin('/api/admin/list')).json();
  check(Array.isArray(list.withdrawQueue) && list.withdrawQueue.some((x) => x.id === idA),
    '审核台出现「发布者自撤待确认」那一条', JSON.stringify(list.withdrawQueue?.map((x) => x.id)));
  check(Array.isArray(list.submissions) && list.submissions.length > 0,
    'list.submissions 的形状与从前一致（老读法不受影响）', `submissions=${list.submissions.length}`);

  // 幂等
  const wd2 = await postJsonRead('/api/publisher/withdraw', { id: idA, reason: '再说一次' }, tokA);
  check(wd2.status === 200 && (await postJsonRead('/api/publisher/withdraw', { id: idA, reason: '第三次' }, tokA)).body.changed === false, '重复申请 → changed:false（幂等，不重复写盘）');

  const wdConfirm = await admin('/api/admin/withdraw-decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idA, action: 'confirm' }),
  });
  const wdConfirmBody = (await readRes(wdConfirm)).body;
  check(wdConfirm.status === 200 && wdConfirmBody.state === 'superseded', '管理员确认自撤 ⇒ superseded', String(wdConfirm.status));
  const decA = JSON.parse(readFileSync(join(dataDir, 'submissions', idA, 'decision.json'), 'utf8'));
  check(decA.decision === 'superseded' && decA.replacedBy === null,
    '**decision=superseded 且 replacedBy:null 被接受**（新校验：只对自撤放宽）', JSON.stringify(decA.replacedBy));
  check(decA.publisherWithdraw && decA.publisherWithdraw.reason === '作者不想再发布这一版了',
    '自撤那一笔留痕在 decision.publisherWithdraw 里（谁/何时/什么理由）');
  check(!(await publicIds()).includes(idA), '终态之后依旧不在公开面');
  const list2 = await (await admin('/api/admin/list')).json();
  check(!(list2.withdrawQueue || []).some((x) => x.id === idA), '待确认队列里那条已经清掉');
  const metaA4 = JSON.parse(readFileSync(join(dataDir, 'submissions', idA, 'meta.json'), 'utf8'));
  check(metaA4.withdrawRequested === false && Array.isArray(metaA4.withdrawHistory)
    && metaA4.withdrawHistory.some((h) => h.action === 'confirmed'),
  'meta 上 withdrawRequested 清掉、withdrawHistory 留下「已确认」那一笔');

  // 管理员拒绝那一半：用 B 走一遍
  const tokB = await (async () => {
    const c = await postJsonRead('/api/publisher/claim', { id: idB, claimCode: B.body.claimCode });
    return c.body.publisherToken;
  })();
  check(typeof tokB === 'string' && tokB.length === 32, 'B 也能认领（每条各自一枚令牌）');
  await postJsonRead('/api/publisher/withdraw', { id: idB, reason: '反悔一下' }, tokB);
  check(!(await publicIds()).includes(idB), 'B 申请自撤后也不在公开面');
  const wdReject = await admin('/api/admin/withdraw-decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idB, action: 'reject', reason: '这一版还有人在用，先留着' }),
  });
  check(wdReject.status === 200, '管理员拒绝自撤 → 200', String(wdReject.status));
  check((await publicIds()).includes(idB), '**拒绝之后它恢复公开**（本来就是原样，只是不再被排除）');
  const metaB = JSON.parse(readFileSync(join(dataDir, 'submissions', idB, 'meta.json'), 'utf8'));
  check(metaB.withdrawRequested === false && metaB.withdrawHistory.some((h) => h.action === 'rejected'),
    '拒绝也留痕（withdrawHistory 里有 rejected 那一笔）');
  const wdNoReq = await admin('/api/admin/withdraw-decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idB, action: 'confirm' }),
  });
  check(wdNoReq.status === 409, '没有待确认申请时去确认 → 409（不瞎写）', String(wdNoReq.status));

  // ================================================================
  console.log('⑧ 发布者令牌**只能碰自己那条**（拿 A 的令牌改 B ⇒ 403）');
  const cross = await postJsonRead('/api/publisher/update', { id: idB, name: '越权改名' }, tokA);
  check(cross.status === 403, '拿 A 的令牌改 B → **403**', String(cross.status));
  const crossW = await postJsonRead('/api/publisher/withdraw', { id: idB, reason: '越权撤下' }, tokA);
  check(crossW.status === 403, '拿 A 的令牌撤 B → 403', String(crossW.status));
  const crossB = await pub(`/api/publisher/blob?id=${idB}`, {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: goodPack('X', '9.9.9'),
  }, tokA);
  check(crossB.status === 403, '拿 A 的令牌换 B 的包体 → 403', String(crossB.status));
  const metaB2 = JSON.parse(readFileSync(join(dataDir, 'submissions', idB, 'meta.json'), 'utf8'));
  check(metaB2.name !== '越权改名', '越权那几次**一个字节都没写进 B**', String(metaB2.name));

  // ================================================================
  console.log('⑥ packKind 筛选：单值 / 多值 / 不传 / 非法值（向后兼容）');
  // 造齐三档：B 设 functional、再造一条 documentation、一条 unknown（不设就是缺省 unknown）。
  await admin('/api/admin/packkind', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idB, packKind: 'functional' }),
  });
  const C = await submit(goodPack('C君', '1.0.0'), { name: 'C 的说明包' });
  const idC = C.body.id;
  await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idC, decision: 'approved' }),
  });
  await admin('/api/admin/packkind', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idC, packKind: 'documentation' }),
  });
  const D = await submit(goodPack('D君', '1.0.0'), { name: 'D 的未分类包' });
  const idD = D.body.id;
  await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idD, decision: 'approved' }),
  });

  const all = await (await fetch(`${BASE}/api/mods`)).json();
  check((all.mods || []).length >= 3, '不传 kind = **现状**（全量）', `mods=${all.mods.length}`);
  check(all.kinds === null, '不传时 kinds 为 null（= 不过滤）', JSON.stringify(all.kinds));
  check(all.counts && all.counts.functional >= 1 && all.counts.documentation >= 1 && all.counts.unknown >= 1,
    '不传时带每类计数（分区标题旁要显示的那个数）', JSON.stringify(all.counts));
  const onlyDoc = await (await fetch(`${BASE}/api/mods?kind=documentation`)).json();
  check(onlyDoc.mods.every((m) => m.packKind === 'documentation') && onlyDoc.mods.length === all.counts.documentation,
    'kind=documentation ⇒ 只剩说明包', `${onlyDoc.mods.length} 条`);
  const multi = await (await fetch(`${BASE}/api/mods?kind=functional,documentation`)).json();
  check(multi.mods.every((m) => m.packKind === 'functional' || m.packKind === 'documentation')
    && multi.mods.length === all.counts.functional + all.counts.documentation,
  'kind=functional,documentation ⇒ 两档都在（多选）', `${multi.mods.length} 条`);
  check(multi.counts === undefined, '筛过之后**不给 counts**（免得「functional 只有 1 条」这种被筛小的数误导）',
    JSON.stringify(multi.counts));
  const unk = await (await fetch(`${BASE}/api/mods?kind=unknown`)).json();
  check(unk.mods.every((m) => m.packKind === 'unknown'), 'kind=unknown ⇒ 未分类的自然落这里（老记录不用回填）', `${unk.mods.length} 条`);
  const badKind = await fetch(`${BASE}/api/mods?kind=beautify`);
  const badKindBody = (await readRes(badKind)).body;
  check(badKind.status === 400 && /functional/.test(badKindBody.error || ''), '非法 kind → 400（不悄悄忽略）', String(badKind.status));
  const emptyKind = await (await fetch(`${BASE}/api/mods?kind=`)).json();
  check(emptyKind.kinds === null, '空的 kind= 按「不传」处理（等价现状）', JSON.stringify(emptyKind.kinds));
  const pageFiltered = await (await fetch(`${BASE}/mods?kind=documentation`)).text();
  check(pageFiltered.includes('__KINDS__') === false, '列表页的 __KINDS__ 占位符已替换（不留占位符）');
  check(/"documentation"/.test(pageFiltered), '列表页里注入了当前筛选值', 'documentation');
  const pageAll = await (await fetch(`${BASE}/mods`)).text();
  check(pageAll.includes('data-kinds=""'), '不筛选时注入空值（页面走现状那条路）');
  const pageBad = await fetch(`${BASE}/mods?kind=nope`);
  check(pageBad.status === 400, '列表页非法 kind → 400', String(pageBad.status));

  // ================================================================
  console.log('⑦ 审计日志：有对应条目、**不含令牌明文**');
  const logs = auditLines();
  const actions = new Set(logs.map((l) => l.action));
  for (const a of ['submit', 'tokenClaimed', 'publisherUpdate', 'publisherBlob', 'withdrawRequested', 'withdrawConfirmed', 'withdrawRejected', 'promoteBlob', 'approved']) {
    check(actions.has(a), `审计里有 ${a} 这一笔`, String([...actions].length) + ' 种动作');
  }
  const rawLog = readFileSync(join(dataDir, 'audit.jsonl'), 'utf8');
  check(!rawLog.includes(tokA) && !rawLog.includes(tokB), '**审计日志里没有发布者令牌明文**');
  check(!rawLog.includes(claimA) && !rawLog.includes(B.body.claimCode), '**审计日志里没有认领码明文**');
  check(!rawLog.includes(TOKEN), '**审计日志里没有 ADMIN_TOKEN 明文**');
  const one = logs.find((l) => l.action === 'withdrawConfirmed');
  check(one && one.id && one.at && one.actor === 'admin' && one.admin === true && typeof one.ip === 'string',
    '条目形状 = { at, action, id, ip, actor, admin, detail }', JSON.stringify(Object.keys(one || {})));
  const beforeLen = rawLog.length;
  await (await fetch(`${BASE}/api/mods`)).json();
  check(readFileSync(join(dataDir, 'audit.jsonl'), 'utf8').length === beforeLen,
    '只读的公网列表**不写审计**（不复读、不刷屏）');

  // ================================================================
  console.log('⑨ 零删除：跑完全部用例之后，记录与文件**只增不减**');
  const after = { records: countRecords(), files: listFiles().length };
  check(after.records >= before.records, '记录条数只增不减', `${before.records} → ${after.records}`);
  check(after.files > before.files, '文件数只增不减（新记录、候选、留档、审计都是新增）', `${before.files} → ${after.files}`);
  // 三条本该「被撤下」的记录，文件一个都没少。
  for (const [id, area] of [[idA, 'submissions'], [idB, 'submissions']]) {
    const d = join(dataDir, area, id);
    check(existsSync(join(d, 'meta.json')) && existsSync(join(d, 'mod.zip')),
      `${id} 的记录与包体都还在（自撤 = 状态下架，不是删文件）`);
    check(statSync(join(d, 'meta.json')).size > 0, `${id} 的 meta.json 非空`, statSync(join(d, 'meta.json')).size + ' B');
  }
  check(existsSync(join(dataDir, 'submissions', idA, promoteBody.archived)), '被换下来的旧包体改名留档，**没有被删**');
  const stray = listFiles().filter((rel) => !rel.includes('/') && rel !== 'audit.jsonl');
  check(stray.length === 0, '数据目录根下没有意外的散文件（只有有意的 audit.jsonl）', stray.join('、') || '（0 个）');

  // ================================================================
  console.log('⑩ 顺带回归：认领/自助这一路**没有**碰到既有能力的判定');
  const noTokAdmin = await fetch(`${BASE}/api/admin/list`);
  check(noTokAdmin.status === 401, '管理 API 仍然要令牌（发布者令牌在这里**没用**）', String(noTokAdmin.status));
  const pubTokAsAdmin = await fetch(`${BASE}/api/admin/list`, { headers: { 'x-admin-token': tokA } });
  check(pubTokAsAdmin.status === 401, '拿发布者令牌当管理令牌 → 401（两套互不替代）', String(pubTokAsAdmin.status));
  const badStatus = await fetch(`${BASE}/api/status/${idB}?t=nope`);
  check(badStatus.status === 403, '/api/status 仍然认回执令牌且错令牌 403', String(badStatus.status));
  const trav = await fetch(`${BASE}/api/file/..%2f..%2fserver.mjs`);
  check(trav.status === 400 || trav.status === 404, '一个没变：路径穿越照旧被挡', String(trav.status));
  const noEndpoint = await postJsonRead('/api/publisher/nope', {}, tokA);
  check(noEndpoint.status === 404, '不存在的发布者端点 → 404', String(noEndpoint.status));
  const issueGhost = await admin('/api/admin/issue-claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'ffffffffffff' }),
  });
  check(issueGhost.status === 404, '给不存在的编号发认领码 → 404', String(issueGhost.status));
  const issueBatch = await admin('/api/admin/issue-claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [idB] }),
  });
  check(issueBatch.status === 400, '发码端点**不收「一批」**（与全站同一条铁律）', String(issueBatch.status));

  // ================================================================
  console.log('⑪ 管理员手工发认领码（老记录 / 令牌丢失找回，裁定 ④ ⑨）');
  // 老记录 = 从没有过 publisherTokens 的那种。这里直接拿一条已上线记录来演示这条通路。
  const issued = await admin('/api/admin/issue-claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idC }),
  });
  const issuedBody = (await readRes(issued)).body;
  check(issued.status === 200 && /^[2-9A-HJ-NP-Z]{16}$/.test(issuedBody.claimCode || ''),
    '管理员发出认领码', String(issued.status));
  const metaC = readFileSync(join(dataDir, 'submissions', idC, 'meta.json'), 'utf8');
  check(!metaC.includes(issuedBody.claimCode), '发出去的码**盘上同样只有哈希**');
  const claimC = await postJsonRead('/api/publisher/claim', { id: idC, claimCode: issuedBody.claimCode });
  check(claimC.status === 200 && /^[0-9a-f]{32}$/.test(claimC.body?.publisherToken || ''),
    '老记录也能凭手工发的码认领成功（不需一次性回填）', String(claimC.status));
  const tokC = claimC.body.publisherToken;
  const mineC = await pubJson('/api/publisher/mine', {}, tokC);
  check((mineC.body?.mine || []).some((m) => m.id === idC) && !(mineC.body?.mine || []).some((m) => m.id === idA),
    'C 的令牌只看到 C 那一条（不串味）', JSON.stringify(mineC.body?.mine?.map((m) => m.id)));
  const stray2 = listFiles().filter((rel) => !rel.includes('/') && rel !== 'audit.jsonl');
  check(stray2.length === 0, '全程跑完，数据目录根下依旧干净', stray2.join('、') || '（0 个）');

  // ================================================================
  console.log('⑫ 发布者**自助删除**：一按即生效、不经管理员（三条牙 + 幂等 + 零删除）');
  // 业主硬要求：发布者凭自己的 publisherToken 一按即生效 —— 公开面立刻消失、下载立刻 403，
  // **不经过管理员那一次确认**。落库是**软删**：状态落既有的「已撤下」语义
  // （`decision=superseded` + `replacedBy: null` + `reason:"publisher-delete"`），记录与包体全保留。
  //
  // 这一节的三条断言（缺一条这条牙就是假的）：
  //   ① 发布者删**自己**的 ⇒ 立刻从公开面消失 + 下载 403 + 落库形状正确；
  //   ② 删**别人**的 ⇒ 403（且对方一个字节都没被写）；
  //   ③ **无令牌** ⇒ 401。
  // ⚠️ 另外用「去牙」跑一遍证明它真的会红：把 `isPublisher` 那道判据改成恒真，
  //    本节 ② 的那几条断言必然失败 —— 原始输出见交付报告（不靠嘴说）。
  const beforeDel = { records: countRecords(), files: listFiles().length };
  check((await publicIds()).includes(idC), '（基准）C 现在在公开面上', idC);

  // —— ① 删自己的
  const delNoTok = await postJsonRead('/api/publisher/delete', { id: idC });                       // 无令牌
  check(delNoTok.status === 401, '③ **无令牌** ⇒ 401（连记录都不读）', String(delNoTok.status));
  const delCross = await postJsonRead('/api/publisher/delete', { id: idB, reason: '删别人的' }, tokC);  // 别人的
  check(delCross.status === 403, '② 拿 C 的令牌删 B ⇒ **403**（只能删自己那条）', String(delCross.status));
  check((await publicIds()).includes(idB), '② 越权那一次对 B **没有任何影响**（B 照旧公开）');
  const metaBAfterDel = readFileSync(join(dataDir, 'submissions', idB, 'meta.json'), 'utf8');
  check(!metaBAfterDel.includes('删别人的') && !existsSync(join(dataDir, 'submissions', idB, 'decision.json.publisherDelete')),
    '② 越权那一次对 B 的 meta.json / 判定**一个字节都没写**');

  const delOwn = await postJsonRead('/api/publisher/delete', { id: idC }, tokC);                   // 自己的
  check(delOwn.status === 200 && delOwn.body?.changed === true, '① 发布者删自己的 ⇒ 200', String(delOwn.status));
  check(delOwn.body?.state === 'superseded' && delOwn.body?.replacedBy === null,
    '① 落 superseded 且 **replacedBy: null**（自撤/自助删除没有取代者）', JSON.stringify(delOwn.body?.state));
  check(delOwn.body?.reason === 'publisher-delete' && delOwn.body?.softDelete === true && delOwn.body?.recoverable === true,
    '① 理由是机器可读的 `publisher-delete`，且明确自报「软删 / 可恢复」', String(delOwn.body?.reason));
  check(delOwn.body?.publicVisible === false, '① 响应里明确写了 publicVisible=false');
  check(!(await publicIds()).includes(idC), '① **公开面立即不再列出**它（不需要管理员点任何东西）');
  const dlDeleted = await fetch(`${BASE}/api/file/${idC}`);
  check(dlDeleted.status === 403, '① 下载口也**立即 403**（「删了还能下」是假删除）', String(dlDeleted.status));
  const pageModsRes = await fetch(`${BASE}/mods`);
  const pageMods = await pageModsRes.text();
  check(pageModsRes.status === 200 && pageMods.includes('data-kinds=') && !pageMods.includes('__KINDS__'),
    '① 公开列表页照旧正常渲染（占位符已替换，没有因为这条删除而坏掉）', String(pageModsRes.status));

  // 落库形状：decision.json **逐字**核（不是只看响应）
  const decC = JSON.parse(readFileSync(join(dataDir, 'submissions', idC, 'decision.json'), 'utf8'));
  check(decC.decision === 'superseded' && decC.replacedBy === null && decC.reason === 'publisher-delete'
    && decC.by === 'publisher' && decC.publisherDelete && decC.publisherDelete.reason === 'publisher-delete',
    '① decision.json 逐字正确：superseded / replacedBy:null / reason:publisher-delete / by:publisher / publisherDelete 留痕块');
  const metaC2 = JSON.parse(readFileSync(join(dataDir, 'submissions', idC, 'meta.json'), 'utf8'));
  check(Array.isArray(metaC2.revisions) && metaC2.revisions.some((r) => r.by === 'publisher' && r.to
    && String(r.to.decision || '').includes('superseded')), '① meta.revisions 里留了一笔（谁删的、删成什么，翻记录就看得到）');
  check(metaC2.withdrawRequested === false, '① 收尾：待确认自撤标志位已清（与管理员确认那条路同一口径）');
  check(metaC2.publisherTokens.length === 1 && metaC2.withdrawHistory.some((h) => h.action === 'deleted'),
    '① withdrawHistory 里留了 action=deleted 一笔');

  // 幂等：再删一次不重复写盘
  const delAgain = await postJsonRead('/api/publisher/delete', { id: idC }, tokC);
  check(delAgain.status === 200 && delAgain.body?.changed === false,
    '① 重复点 ⇒ changed:false（幂等，不重复留痕）', String(delAgain.body?.changed));

  // 与全站同一条铁律：不收「一批」
  const delBatch = await postJsonRead('/api/publisher/delete', { ids: [idC], id: idC }, tokC);
  check(delBatch.status === 400, '「一批」的形状 ⇒ 400（一次只动一个明确 id）', String(delBatch.status));
  const delBadId = await postJsonRead('/api/publisher/delete', { id: '../../etc' }, tokC);
  check(delBadId.status === 400, 'id 形状不对 ⇒ 400', String(delBadId.status));
  const delGhost = await postJsonRead('/api/publisher/delete', { id: 'ffffffffffff' }, tokC);
  check(delGhost.status === 404, '不存在的编号 ⇒ 404（且照比一次哈希，不泄露存在性）', String(delGhost.status));

  // —— 零删除：删完这条，记录与文件**一个都没少**
  const afterDel = { records: countRecords(), files: listFiles().length };
  check(existsSync(join(dataDir, 'submissions', idC, 'meta.json')) && existsSync(join(dataDir, 'submissions', idC, 'mod.zip')),
    '① **零删除**：C 的 meta.json 与 mod.zip 原样都在（软删，不是物理删除）');
  check(afterDel.records >= beforeDel.records && afterDel.files >= beforeDel.files,
    '① 记录与文件数只增不减（自助删除**没有**删掉任何东西）', `${beforeDel.records}/${beforeDel.files} → ${afterDel.records}/${afterDel.files}`);
  const dlAdminStill = await admin(`/api/file/${idC}`);
  check(dlAdminStill.status === 200, '① 维护者照旧能下（删除挡的是公开面，不是把文件锁死）', String(dlAdminStill.status));
  const auditDel = auditLines().filter((l) => l.action === 'publisherDeleted');
  check(auditDel.length >= 1 && auditDel.every((l) => l.actor === 'publisher'), '① 审计里有 publisherDeleted 这一笔（actor=publisher）');
  check(!readFileSync(join(dataDir, 'audit.jsonl'), 'utf8').includes(tokC), '① 审计里**没有**发布者令牌明文');
} catch (e) {
  failures++;
  console.log(`  ✗ 自测自己抛了异常：${e.stack || e.message}`);
  console.log('  —— 服务端日志 ——\n' + serverLog.slice(-3000));
} finally {
  child.kill();
  await sleep(250);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('');
if (failures) {
  console.log(`✖ ${failures} 项没通过`);
  console.log('—— 服务端日志（尾部）——\n' + serverLog.slice(-2000));
  process.exit(1);
}
console.log('✔ 发布者自助（认领 / 改元数据 / 换包体 / 自撤 / 自助删除）＋ 管理员确认 ＋ 分类筛选 ＋ 审计日志：整条链通过');
