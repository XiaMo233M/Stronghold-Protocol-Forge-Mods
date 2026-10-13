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
//   ⑬  **功能类目**（6 类）：写入 / 闭枚举 / 一次一个 / 幂等 / 只动分类 / 两栏一致 / ?func= 筛选
//   ⑭  **档 2 恢复**：撤自己的软删 ⇒ 200 且重新公开；别人的 ⇒ 403；不是软删来的 ⇒ 409
//   ⑮  **档 3 硬删**（物理，全站唯一会删数据的路）：一次调用不删 · 凭据/包名少一个都不删 ·
//       有引用 ⇒ 409 先报人 · 二次确认后真删 + 墓碑在位 + 记录确实不在 + 再删/恢复 ⇒ 410
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
/**
 * 同上，但**包内 id 由调用方指定**。
 * 为什么需要它：硬删有「**有引用就拒绝**」这条纪律，而站点判「同 pack.json id」用的就是包内 id
 * （`signatureOf`）。上面那个 `goodPack` 所有记录共用 `mine-test` ⇒ 它们**互相引用**，
 * 硬删必然被拒 —— 要测「能删成功」就必须有一条**独有 id** 的记录。
 */
const goodPackWith = (packId, author, ver) => makeZip([{
  name: 'pack.json',
  data: JSON.stringify({ id: packId, name: '我的包', author, version: ver, api: 1, game: '0.16.0' }),
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

  // ================================================================
  console.log('⑬ 功能类目（6 类）：写入 / 闭枚举 / 一次一个 / 幂等 / 只动分类 / 两栏一致');
  // 业主 2026-10-14：「现在分类不对，要按功能分」—— 6 类：游戏玩法 / 拓展包 / 实用工具 /
  // 素材替换 / 说明文档 / 未分类。它与 `packKind`（技术维度）**是两个字段、两个维度**。
  const adminJson = (p, obj) => admin(p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj),
  });
  const pub1 = await (await fetch(`${BASE}/api/mods`)).json();
  const mB = pub1.mods.find((m) => m.id === idB);
  check(!!mB && mB.funcKind === 'uncategorized',
    '老记录**没有** funcKind ⇒ 读作「未分类」（**绝不猜**成某个真功能类）', String(mB && mB.funcKind));
  check(!!mB && mB.packKind === 'functional', '同一批次里技术维度照旧 functional（两个维度各说各的）');
  check(!!pub1.counts && pub1.counts.func && pub1.counts.func.uncategorized >= 1,
    '`/api/mods` 的 counts 里多了功能维度那套（counts.func），老 counts 字段一字未动');
  check(typeof mB.funcKindTitle === 'string' && mB.funcKindTitle === '未分类', '带中文名给页面用', String(mB.funcKindTitle));

  const badFk = await adminJson('/api/admin/funkind', { id: idB, funcKind: 'beautify' });
  check(badFk.status === 400, '拼错的类目 ⇒ 400（闭枚举，拼错的值不许落进记录）', String(badFk.status));
  const batchFk = await adminJson('/api/admin/funkind', { ids: [idB], funcKind: 'utility' });
  check(batchFk.status === 400, '「一批」的形状 ⇒ 400（一次一个明确 id）', String(batchFk.status));
  const noIdFk = await adminJson('/api/admin/funkind', { funcKind: 'utility' });
  check(noIdFk.status === 400, '没给 id ⇒ 400', String(noIdFk.status));
  const ghostFk = await adminJson('/api/admin/funkind', { id: 'ffffffffffff', funcKind: 'utility' });
  check(ghostFk.status === 404, '编号不存在 ⇒ 404（不瞎写）', String(ghostFk.status));

  const metaB0 = JSON.parse(readFileSync(join(dataDir, 'submissions', idB, 'meta.json'), 'utf8'));
  const fk1 = await adminJson('/api/admin/funkind', { id: idB, funcKind: 'utility' });
  const fk1b = await fk1.json();
  check(fk1.status === 200 && fk1b.changed === true && fk1b.funcKind === 'utility',
    '归类成功（utility = 实用工具）', String(fk1.status));
  check(fk1b.packKind === 'functional', '⭐ 两栏一致：真功能类目 ⇒ 技术维度自动归位 functional', String(fk1b.packKind));
  const metaB1 = JSON.parse(readFileSync(join(dataDir, 'submissions', idB, 'meta.json'), 'utf8'));
  check(metaB1.funcKind === 'utility' && metaB1.packKind === 'functional', '记录里两栏都落了');
  const stripFk = (o) => { const c = { ...o }; delete c.funcKind; delete c.packKind; delete c.revisions; return JSON.stringify(c); };
  check(stripFk(metaB0) === stripFk(metaB1), '**除 funcKind / packKind / revisions 外其余键值逐字未变**（只动分类）');
  check(Array.isArray(metaB1.revisions) && metaB1.revisions.some((r) => r.by === 'admin' && r.to && r.to.funcKind === 'utility'),
    '归类进 revisions（谁改的、从什么改成什么）');
  const fk2 = await (await adminJson('/api/admin/funkind', { id: idB, funcKind: 'utility' })).json();
  check(fk2.changed === false, '重复归同一个类 ⇒ changed:false（幂等，不重复写盘）', String(fk2.changed));
  const fkDoc = await (await adminJson('/api/admin/funkind', { id: idB, funcKind: 'documentation' })).json();
  check(fkDoc.packKind === 'documentation', '说明文档 ⇒ 技术维度归位 documentation（两栏不打架）', String(fkDoc.packKind));
  const fkUnc = await (await adminJson('/api/admin/funkind', { id: idB, funcKind: 'uncategorized' })).json();
  check(fkUnc.packKind === 'unknown', '未分类 ⇒ 技术维度归位 unknown（**不猜**成 functional）', String(fkUnc.packKind));
  const fkExpl = await (await adminJson('/api/admin/funkind', { id: idB, funcKind: 'gameplay', packKind: 'unknown' })).json();
  check(fkExpl.funcKind === 'gameplay' && fkExpl.packKind === 'unknown',
    '同一次报文里显式给的 packKind 优先（派生不覆盖显式）', `${fkExpl.funcKind}/${fkExpl.packKind}`);
  // 显式 packKind 在记录里也真的是那个值 —— 不是只有响应说说
  const metaBfk2 = JSON.parse(readFileSync(join(dataDir, 'submissions', idB, 'meta.json'), 'utf8'));
  check(metaBfk2.funcKind === 'gameplay' && metaBfk2.packKind === 'unknown', '显式值确实落盘（响应与磁盘一致）');

  // ---- 公开面的功能筛选
  await adminJson('/api/admin/funkind', { id: idB, funcKind: 'gameplay' });
  const fSel = await (await fetch(`${BASE}/api/mods?func=gameplay`)).json();
  check(fSel.mods.every((m) => m.funcKind === 'gameplay') && fSel.mods.some((m) => m.id === idB),
    '?func=gameplay ⇒ 只剩游戏玩法那几条', `${fSel.mods.length} 条`);
  const fMul = await (await fetch(`${BASE}/api/mods?func=gameplay,utility`)).json();
  check(fMul.mods.every((m) => m.funcKind === 'gameplay' || m.funcKind === 'utility'), '?func=a,b ⇒ 多选', `${fMul.mods.length} 条`);
  const fUnc2 = await (await fetch(`${BASE}/api/mods?func=uncategorized`)).json();
  check(fUnc2.mods.every((m) => m.funcKind === 'uncategorized'), '?func=uncategorized ⇒ 未分类自成一处（老记录落这里）', `${fUnc2.mods.length} 条`);
  const fBad = await fetch(`${BASE}/api/mods?func=beautify`);
  check(fBad.status === 400, '非法 ?func= ⇒ 400（不悄悄忽略）', String(fBad.status));
  const fEmpty = await (await fetch(`${BASE}/api/mods?func=`)).json();
  check(fEmpty.funcs === null, '空的 func= 按「不传」处理（等价现状）', JSON.stringify(fEmpty.funcs));
  // 两个维度**可以叠加**
  const fBoth = await (await fetch(`${BASE}/api/mods?kind=functional&func=gameplay`)).json();
  check(fBoth.mods.every((m) => m.packKind === 'functional' && m.funcKind === 'gameplay'),
    '?kind=…&func=… **叠加**（既装得上、又是游戏玩法）', `${fBoth.mods.length} 条`);
  // 老的那条筛选**一字未改**
  const kOld = await (await fetch(`${BASE}/api/mods?kind=functional`)).json();
  check(kOld.kinds && kOld.kinds[0] === 'functional' && kOld.mods.every((m) => m.packKind === 'functional'),
    '老判据 `?kind=functional` 行为一字未改（向后兼容）', `${kOld.mods.length} 条`);

  // ---- 列表页：两组占位符都注入、非法值 400
  const pgF = await (await fetch(`${BASE}/mods?func=utility`)).text();
  check(pgF.includes('data-funcs="utility"') && !pgF.includes('__FUNCS__'), '列表页注入了功能筛选值（占位符已替换）');
  const pgFBad = await fetch(`${BASE}/mods?func=nope`);
  check(pgFBad.status === 400, '列表页非法 func ⇒ 400', String(pgFBad.status));
  const pgBoth = await (await fetch(`${BASE}/mods?kind=documentation&func=assets%2Cutility`)).text();
  check(pgBoth.includes('data-kinds="documentation"') && pgBoth.includes('data-funcs="assets,utility"'),
    '两条筛选**各自保留**：kind 没被 func 顶掉、func 也没被 kind 顶掉');
  const pgNone = await (await fetch(`${BASE}/mods`)).text();
  check(pgNone.includes('data-kinds=""') && pgNone.includes('data-funcs=""'), '不筛时两个都是空（走现状那条路）');

  // ---- 发布者自己填功能类目（走 /api/publisher/update，改完回待审）
  const pubFk = await postJsonRead('/api/publisher/update', { id: idB, funcKind: 'expansion' }, tokB);
  check(pubFk.status === 200 && pubFk.body.forcedPending === true, '发布者能填自己的功能类目，且**强制回待审**', String(pubFk.status));
  const metaBfk3 = JSON.parse(readFileSync(join(dataDir, 'submissions', idB, 'meta.json'), 'utf8'));
  check(metaBfk3.funcKind === 'expansion' && metaBfk3.packKind === 'functional',
    '发布者填的那一栏落盘、技术维度跟着归位', `${metaBfk3.funcKind}/${metaBfk3.packKind}`);
  check(!(await publicIds()).includes(idB), '改分类也照旧「回待审 ⇒ 立刻不在公开面」（自助写不直改公开面）');
  const mineB = await pubJson('/api/publisher/mine', {}, tokB);
  check(!!mineB.body.mine.find((m) => m.id === idB)?.funcKind, '/mine 的响应里带 funcKind（页面才画得出那一栏）');
  const auditFk = auditLines().filter((l) => l.action === 'funcKind');
  check(auditFk.length >= 1 && auditFk.every((l) => l.actor === 'admin' && l.admin === true), '归类在审计里有 funcKind 这一笔（actor=admin）');

  // ================================================================
  console.log('⑭ 档 2 恢复：撤回自己那次软删（只对自己、只能撤软删）');
  const resCross = await postJsonRead('/api/publisher/restore', { id: idB }, tokC);
  check(resCross.status === 403, '② **恢复别人的 ⇒ 403**（只能恢复自己删掉的那条）', String(resCross.status));
  const resNoTok = await postJsonRead('/api/publisher/restore', { id: idC });
  check(resNoTok.status === 401, '③ 无令牌 ⇒ 401', String(resNoTok.status));
  const resOther = await postJsonRead('/api/publisher/restore', { id: idA }, tokA);
  check(resOther.status === 409, '① 那条 superseded **不是发布者软删来的**（管理员确认的自撤）⇒ 409，不在这条通道里', String(resOther.status));
  const resMine = await postJsonRead('/api/publisher/restore', { id: idC }, tokC);
  const resMineB = resMine.body || {};
  check(resMine.status === 200 && resMineB.state === 'approved', '① **恢复自己的软删 ⇒ 200 + 回到 approved**', String(resMine.status));
  check((await publicIds()).includes(idC), '① 恢复即**重新公开**（作者自己的东西）');
  check((await (await fetch(`${BASE}/api/file/${idC}`)).status) === 200, '① 下载口也回来了（200）');
  const decC2 = JSON.parse(readFileSync(join(dataDir, 'submissions', idC, 'decision.json'), 'utf8'));
  check(decC2.decision === 'approved' && decC2.publisherRestored && decC2.restoredFrom && decC2.restoredFrom.decision === 'superseded',
    '① 恢复留痕：`publisherRestored` + 原判定逐字留在 `restoredFrom` 里（零删除）');
  const metaC3 = JSON.parse(readFileSync(join(dataDir, 'submissions', idC, 'meta.json'), 'utf8'));
  check(metaC3.withdrawHistory.some((h) => h.action === 'restored') && metaC3.revisions.some((r) => r.to && String(r.to.decision).includes('approved')),
    '① withdrawHistory 与 revisions 各留一笔（可追溯）');
  check(existsSync(join(dataDir, 'submissions', idC, 'mod.zip')), '① 恢复全程没有动过文件（它本来就在）');
  const resAgain = await postJsonRead('/api/publisher/restore', { id: idC }, tokC);
  check(resAgain.status === 409, '① 已经公开了再点恢复 ⇒ 409（没有可恢复的东西，不瞎写）', String(resAgain.status));
  check(auditLines().some((l) => l.action === 'publisherRestored' && l.actor === 'publisher'), '① 审计里有 publisherRestored 这一笔');

  // ================================================================
  console.log('⑮ 档 3 硬删（物理）：一次调用不删 · 二次确认 · 先审计后删 · 墓碑在位 · 不可恢复');
  // ⚠️ 这是全站**唯一**会删数据的路（业主 2026-10-14 明确授权的例外，且只限作者删自己的 + 二次确认）。
  const H = await submit(goodPackWith('solo-hard-del', 'H君', '1.0.0'), { name: 'H 的独立包' });
  const idH = H.body.id;
  const tokH = (await postJsonRead('/api/publisher/claim', { id: idH, claimCode: H.body.claimCode })).body.publisherToken;
  await adminJson('/api/admin/decide', { id: idH, decision: 'approved' });
  check((await publicIds()).includes(idH), '（基准）H 已上线、包内 id 独有');

  const hardNoTok = await postJsonRead('/api/publisher/delete-hard', { id: idH });
  check(hardNoTok.status === 401, '③ 无令牌 ⇒ 401', String(hardNoTok.status));
  const hardCross = await postJsonRead('/api/publisher/delete-hard', { id: idH }, tokA);
  check(hardCross.status === 403, '② **硬删别人的 ⇒ 403**', String(hardCross.status));
  check(existsSync(join(dataDir, 'submissions', idH, 'mod.zip')), '② 越权那一次**一个字节都没删**');
  const hardBatch = await postJsonRead('/api/publisher/delete-hard', { ids: [idH], id: idH }, tokH);
  check(hardBatch.status === 400, '「一批」的形状 ⇒ 400（一次一个明确 id）', String(hardBatch.status));
  // 有引用 ⇒ 409 先报人（idB 与别的记录共用包内 id `mine-test`）
  const hardRef = await postJsonRead('/api/publisher/delete-hard', { id: idB }, tokB);
  check(hardRef.status === 409 && Array.isArray(hardRef.body?.refs) && hardRef.body.refs.length > 0,
    '④ **有引用 ⇒ 409 不删**（把引用清单交给人看，不擅自动手）', `${(hardRef.body?.refs || []).length} 条引用`);
  check(existsSync(join(dataDir, 'submissions', idB, 'meta.json')), '④ 有引用那一次同样一个字节都没删');

  // ---- 第一步：只预检 + 发一次性凭据
  const step1 = await postJsonRead('/api/publisher/delete-hard', { id: idH }, tokH);
  check(step1.status === 200 && step1.body?.needsConfirm === true && step1.body?.hardDeleted === false,
    '① 第一次调用：needsConfirm=true、hardDeleted=false', String(step1.status));
  check(typeof step1.body?.confirmToken === 'string' && step1.body.confirmToken.length >= 16,
    '① 返回一枚一次性 confirmToken（明文只出现这一次）');
  check(step1.body?.expect?.name === 'H 的独立包', '① 同时返回要核对的包名（expect.name）', String(step1.body?.expect?.name));
  check(existsSync(join(dataDir, 'submissions', idH, 'meta.json')) && existsSync(join(dataDir, 'submissions', idH, 'mod.zip')),
    '⭐ **一次调用绝不物理删**：记录与包体都还在（这就是那条牙）');
  check(!existsSync(join(dataDir, 'tombstones', `${idH}.json`)), '① 此时**还没有墓碑**（先审计后删：动手之前才写）');
  const metaH1 = JSON.parse(readFileSync(join(dataDir, 'submissions', idH, 'meta.json'), 'utf8'));
  check(typeof metaH1.pendingHardDelete?.h === 'string' && !metaH1.pendingHardDelete.h.includes(step1.body.confirmToken),
    '① 盘上只存凭据的**哈希**（明文不进记录，与认领码同一套纪律）');

  // ---- 第二步的三种「不合格」：一律不删
  const hardBadToken = await postJsonRead('/api/publisher/delete-hard',
    { id: idH, confirmToken: '0'.repeat(32), confirmName: 'H 的独立包' }, tokH);
  check(hardBadToken.status === 409, '② 凭据不对 ⇒ 409', String(hardBadToken.status));
  const hardBadName = await postJsonRead('/api/publisher/delete-hard',
    { id: idH, confirmToken: step1.body.confirmToken, confirmName: '乱写的名字' }, tokH);
  check(hardBadName.status === 409, '② 包名不是逐字相同 ⇒ 409', String(hardBadName.status));
  check(existsSync(join(dataDir, 'submissions', idH, 'mod.zip')), '② 这两次不合格的尝试后，包体照旧在（一个字节都没删）');
  const hardNameMissing = await postJsonRead('/api/publisher/delete-hard', { id: idH, confirmToken: step1.body.confirmToken }, tokH);
  check(hardNameMissing.status === 409, '② 只给凭据、不给包名 ⇒ 409（少一个都不删）', String(hardNameMissing.status));

  // ---- 第二步（合格）：真删
  const step2 = await postJsonRead('/api/publisher/delete-hard',
    { id: idH, confirmToken: step1.body.confirmToken, confirmName: 'H 的独立包', reason: '作者不想要了' }, tokH);
  check(step2.status === 200 && step2.body?.hardDeleted === true && step2.body?.recoverable === false,
    '① 二次确认后 ⇒ **物理删成功**、recoverable:false', String(step2.status));
  check(!existsSync(join(dataDir, 'submissions', idH)), '① 记录目录**确实不在了**');
  check(!(await publicIds()).includes(idH), '① 公开面也不再列出它');
  const tombPathH = join(dataDir, 'tombstones', `${idH}.json`);
  check(existsSync(tombPathH), '⭐ **墓碑在位**（先审计后删，且落独立目录）', `tombstones/${idH}.json`);
  const tomb = JSON.parse(readFileSync(tombPathH, 'utf8'));
  check(tomb.id === idH && tomb.actor === 'publisher' && tomb.packId === 'solo-hard-del'
    && /^[0-9a-f]{64}$/.test(String(tomb.sha256 || '')) && Array.isArray(tomb.files) && tomb.files.length >= 2
    && !!tomb.deletedAt && tomb.reason === '作者不想要了',
    '① 墓碑内容齐：id / 包内 id / sha256 / 文件清单 / 时间 / actor / 理由',
    `${tomb.files.length} 个文件 · ${tomb.sha256?.slice(0, 8)}…`);
  check((tomb.files || []).includes('mod.zip') && (tomb.files || []).includes('meta.json'), '① 墓碑里逐条记下了删掉的文件名');
  const hardAgain = await postJsonRead('/api/publisher/delete-hard', { id: idH }, tokH);
  check(hardAgain.status === 410, '① 已被硬删的再删 ⇒ 410（有墓碑，分得清「删过」与「没有」）', String(hardAgain.status));
  const resHard = await postJsonRead('/api/publisher/restore', { id: idH }, tokH);
  check(resHard.status === 410 && resHard.body?.hardDeleted === true && resHard.body?.recoverable === false,
    '① ⭐ **硬删过的恢复不了** ⇒ 明确 410 + recoverable:false', String(resHard.status));
  check(auditLines().some((l) => l.action === 'publisherHardDeleted' && l.actor === 'publisher'),
    '① 审计里有 publisherHardDeleted 这一笔');
  check(auditLines().some((l) => l.action === 'publisherHardDeleteRequested'), '① 第一步也留了一笔（预检也要可追溯）');
  // ---- 零删除的**边界**：只有硬删那一条会删东西，别的记录一个都没少
  const leftover = listFiles().filter((rel) => rel.startsWith('tombstones/'));
  check(leftover.length === 1, '⭐ 全站墓碑只有硬删留下的那一份（零删除边界没被放宽）', leftover.join('、'));
  check(existsSync(join(dataDir, 'submissions', idB, 'meta.json')) && existsSync(join(dataDir, 'submissions', idC, 'meta.json'))
    && existsSync(join(dataDir, 'submissions', idA, 'meta.json')),
    '⭐ 别的记录（含刚恢复过的 C）**一条都没少** —— 硬删只动了它自己那一条');
  const stray3 = listFiles().filter((rel) => !rel.includes('/') && rel !== 'audit.jsonl');
  check(stray3.length === 0, '数据目录根下依旧干净（墓碑在子目录里，不是散文件）', stray3.join('、') || '（0 个）');
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
console.log('✔ 发布者自助（认领 / 改元数据 / 换包体 / 自撤 / 三档删除：软删·恢复·硬删）＋ 功能类目（6 类）＋ 技术维度筛选 ＋ 审计日志：整条链通过');
