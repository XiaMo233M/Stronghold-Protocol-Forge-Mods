// 上传站自测：起一个自己的服务实例，把「上传 → 下载跑测试 → 审核 → 上线」整条链走一遍。
//
//   node site/selftest.mjs                 用临时数据目录，自造一个合成包
//   node site/selftest.mjs --pack <zip>    额外把一个真实 zip 也传上去验一遍
//
// 只用 node 内置：不依赖 zip 命令、不依赖网络。自带一个 **store 模式的极小 zip 写入器**，
// 这样连「故意夹带游戏素材的包」这种用例也能造出来。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'selftest-token-0123456789';
const args = process.argv.slice(2);
const packArg = args.indexOf('--pack') >= 0 ? args[args.indexOf('--pack') + 1] : null;

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

/** files: [{name, data:Buffer}] → zip 的 Buffer（store，不压缩）。 */
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
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(0x800, 6);       // UTF-8 名字
    lh.writeUInt16LE(0, 8);           // store
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

// ---------------------------------------------------------------- 起服务
const dataDir = mkdtempSync(join(tmpdir(), 'sp-upsite-'));
const child = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN, MAX_MB: '4' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUp = async () => {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return true; } catch { /* 还没起 */ }
    await sleep(120);
  }
  return false;
};
const submit = async (buf, { name, note = '', file = 'x.zip' } = {}) => {
  const q = new URLSearchParams({ name, note });
  const r = await fetch(`${BASE}/api/submit?${q}`, {
    method: 'POST', headers: { 'content-type': 'application/zip', 'x-filename': file }, body: buf,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const admin = (p, opt = {}) => fetch(`${BASE}${p}`, { ...opt, headers: { 'x-admin-token': TOKEN, ...(opt.headers || {}) } });

try {
  if (!(await waitUp())) { console.error('服务没起来：\n' + serverLog); process.exit(1); }
  console.log(`临时数据目录：${dataDir}\n`);

  console.log('① 上传一个正常的包');
  const good = makeZip([
    { name: 'pack.json', data: JSON.stringify({ id: 'selftest-pack', name: '自测包', version: '1.0.0', author: 'selftest', license: 'CC0-1.0', description: '自测', api: '>=1 <2', game: '0.2.x' }, null, 2) },
    { name: 'bonds.json', data: '{}' },
    { name: 'ui/panel.js', data: 'export const x = 1;\n' },
  ]);
  const r1 = await submit(good, { name: '自测包', note: '来源：自测脚本\n原作者：无' });
  check(r1.status === 201 && r1.body?.id, '上传成功并返回编号', `id=${r1.body?.id}`);
  check(typeof r1.body?.receipt === 'string' && r1.body.receipt.length >= 16, '返回回执令牌');
  check(r1.body?.suspected === false && r1.body?.area === 'normal', '没被标疑似，进 submissions/');
  const idGood = r1.body.id;
  const goodSha = createHash('sha256').update(good).digest('hex');
  check(r1.body.sha256 === goodSha, '记录下来的 sha256 与本地一致');

  console.log('② 不是 zip / 没名字：都该被拒');
  const r2 = await submit(Buffer.from('这不是 zip'), { name: '假包' });
  check(r2.status === 400, '非 zip 被拒', r2.body?.error);
  const r3 = await submit(good, { name: '   ' });
  check(r3.status === 400, '名称为空被拒', r3.body?.error);

  console.log('③ 故意夹带游戏素材的包：该被标 blocker');
  const evil = makeZip([
    { name: 'pack.json', data: '{"id":"evil"}' },
    { name: 'spine/op/char_003_kalts/front/char_003_kalts.skel', data: 'FAKE' },
    { name: 'audio/voice/cn/char_003_kalts/cn_001.mp3', data: 'FAKE' },
  ]);
  const r4 = await submit(evil, { name: '夹带素材的包' });
  check(r4.status === 201, '上传被受理（疑似也照收）');
  check(r4.body?.suspected === true, '被标记 suspected', JSON.stringify(r4.body?.suspectedReasons));
  check(r4.body?.area === 'flagged', '单独存放在 flagged/', String(r4.body?.area));
  const idEvil = r4.body.id;
  check(existsSync(join(dataDir, 'flagged', idEvil, 'mod.zip'))
    && !existsSync(join(dataDir, 'submissions', idEvil)), '磁盘上确实落在 flagged/ 而不是 submissions/');

  console.log('④ 顶层套了一层文件夹：该提醒');
  const wrapped = makeZip([{ name: 'mypack/pack.json', data: '{"id":"mypack"}' }]);
  const r5 = await submit(wrapped, { name: '套了一层的包' });
  const idWrapped = r5.body?.id;
  check((r5.body?.flags || []).some((f) => f.code === 'WRAPPED'), '提示 WRAPPED');
  check(r5.body?.area === 'normal', '它进 submissions/（不是疑似）', String(r5.body?.area));

  console.log('⑤ 后台接口要令牌');
  const noTok = await fetch(`${BASE}/api/admin/list`);
  check(noTok.status === 401, '不带令牌 → 401');
  const badTok = await fetch(`${BASE}/api/admin/list`, { headers: { 'x-admin-token': 'wrong-wrong-wrong' } });
  check(badTok.status === 401, '错令牌 → 401');
  const okTok = await admin('/api/admin/list');
  const list = await okTok.json();
  check(okTok.status === 200 && list.submissions.length === 3, `带令牌看到 ${list.submissions.length} 条投稿`);
  check(list.submissions.some((s) => s.id === idEvil && s.area === 'flagged'), '列表里能看出哪条在 flagged/');

  console.log('⑥ 待审的包：外人下不到，维护者能下');
  const outsider = await fetch(`${BASE}/api/file/${idGood}`);
  check(outsider.status === 403, '待审包对外 403');
  // 报错必须自己说清怎么取得维护者身份 —— 否则维护者本人看到「只有维护者能下载」
  // 只会更困惑（业主实际就撞上过这条），而审核页那个下载按钮又只在 Basic 登录下才带得上凭据。
  const outsiderMsg = (await outsider.json()).error || '';
  check(/审核页|x-admin-token/.test(outsiderMsg), '403 的报错里写清了怎么取得维护者身份', outsiderMsg);
  const insider = await admin(`/api/file/${idGood}`);
  const got = Buffer.from(await insider.arrayBuffer());
  check(insider.status === 200 && createHash('sha256').update(got).digest('hex') === goodSha, '维护者下载下来与上传的逐字节相同');
  const evilDl = await admin(`/api/file/${idEvil}`);
  check(evilDl.status === 200, '疑似素材的包，维护者也能下载下来人工看');

  // 审核页详情里的 download 也必须是相对路径 —— 审核页就在隧道里打开，绝对地址必然跨域
  const detail = await (await admin(`/api/admin/detail/${idGood}`)).json();
  check(detail.download.startsWith('/api/file/'), '审核页详情里的 download 是同源相对路径', detail.download);
  const viaRel = await admin(detail.download);
  check(viaRel.status === 200, '照这个相对路径真去下，下得到', String(viaRel.status));

  console.log('⑦ 疑似素材：不勾确认不许上线，勾了就能上线');
  const approveNoAck = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idEvil, decision: 'approved' }),
  });
  check(approveNoAck.status === 409, '没确认 → 409', (await approveNoAck.json()).needsAcknowledge ? 'needsAcknowledge=true' : '');
  const approveAck = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idEvil, decision: 'approved', acknowledge: true, reason: '已人工看过：确实是官方 Spine，标注后放行' }),
  });
  check(approveAck.status === 200, '勾了确认 → 上线成功');

  console.log('⑧ 打回');
  const reject = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idWrapped, decision: 'rejected', reason: '包内文件套了一层文件夹，装包器读不到 pack.json' }),
  });
  check(reject.status === 200, '打回成功');
  const stateWrapped = await (await fetch(`${BASE}/api/status/${idWrapped}?t=${r5.body.receipt}`)).json();
  check(stateWrapped.state === 'rejected', '状态变成 rejected', stateWrapped.state);
  check(typeof stateWrapped.reason === 'string' && stateWrapped.reason.length > 0, '投稿人凭回执能看到打回理由', stateWrapped.reason?.slice(0, 24));

  console.log('⑨ 通过 → 上线');
  const approve = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idGood, decision: 'approved', displayName: '自测包（上线名）' }),
  });
  check(approve.status === 200, '通过成功');
  const mods = await (await fetch(`${BASE}/api/mods`)).json();
  check(mods.mods.length === 1 && mods.mods[0].id === idGood, '公开列表「正常」那一组里有它，且只有它');
  check(mods.mods[0].name === '自测包（上线名）', '上线显示名用的是决定时填的那个', mods.mods[0].name);
  // 【2026-10-11 补：普通投稿也要照包内 pack.json 读原作者】
  // 普通投稿的记录里**没有** author 这一栏（`/api/submit` 写的 meta 就没有它），
  // 所以站点在上公网列表时**现读包内的 pack.json** —— 推导，绝不回写记录。
  // 上面那个包里 pack.json 写着 author: 'selftest'，所以这一条必须带上它，并标出来源。
  check(mods.mods[0].author === 'selftest',
    '普通投稿的「原作者」来自**包内 pack.json**（不再恒为 null）', JSON.stringify(mods.mods[0].author));
  check(mods.mods[0].authorSource === 'pack.json',
    '并且标出来源是包内那一栏（与兼容包预填时同一个口径，不造第二套）', String(mods.mods[0].authorSource));
  check(mods.flagged.length === 1 && mods.flagged[0].id === idEvil, '疑似素材单独一组，没混进正常那一组');
  check(mods.flagged[0].suspected === true && (mods.flagged[0].suspectedReasons || []).length > 0,
    '公开数据里带着疑似标记与命中的原因', JSON.stringify(mods.flagged[0].suspectedReasons));
  check(mods.mods[0].suspected === false, '正常那一组里没带疑似标记');

  // 下载链接必须是**同源相对路径**：审核页常通过 SSH 隧道在 127.0.0.1 上打开，
  // 若用 BASE_URL 拼成公开 IP 的绝对地址，页面一 fetch 就跨域（浏览器只报 Failed to fetch），
  // 早先的 <a href> 版本则是跳到公网 IP、被 ADMIN_IPS 挡成 403。
  check(mods.mods[0].download.startsWith('/api/file/'), '公开列表的 download 是同源相对路径', mods.mods[0].download);
  check(mods.flagged[0].download.startsWith('/api/file/'), '疑似组的 download 也是相对路径', mods.flagged[0].download);

  console.log('⑩ 上线后人人可下');
  const pub = await fetch(`${BASE}/api/file/${idGood}`);
  const pubBuf = Buffer.from(await pub.arrayBuffer());
  check(pub.status === 200 && createHash('sha256').update(pubBuf).digest('hex') === goodSha, '公开下载与上传一致');

  console.log('⑪ 投稿人查状态要回执');
  const wrong = await fetch(`${BASE}/api/status/${idGood}?t=deadbeef`);
  check(wrong.status === 403, '错回执 → 403');
  const right = await (await fetch(`${BASE}/api/status/${idGood}?t=${r1.body.receipt}`)).json();
  check(right.state === 'approved', '对回执能看到 approved');

  console.log('⑫ 坏 id 不许穿路径');
  const trav = await fetch(`${BASE}/api/file/..%2f..%2fserver.mjs`);
  check(trav.status === 400 || trav.status === 404, '路径穿越被挡', String(trav.status));

  console.log('⑬ 大小上限');
  const big = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(5 * 1024 * 1024, 1)]);
  const r6 = await submit(big, { name: '太大的包' });
  check(r6.status === 413, '超过 MAX_MB 被拒（413）', r6.body?.error);

  // ---------------------------------------------------------------- ⑰ 「不再显示」勾选框
  // 业主 2026-10-11：「有可能 mod 名字和兼容后的名字不一样，导致依旧存在两个 mod（一个在兼容，
  // 一个在上传待定），所以给我一个勾选框，选后就不显示这个 mod 了」。
  // 落到端点上就四条不许松的边界（与 /compat/note 顶上那条铁律同源）：
  //   ① **一次只认一个 id，绝不批量** —— 任何「一批」的形状一律 400；
  //   ② **可逆** —— 取消勾选写回 hidden:false，记录又回来；
  //   ③ **只动那一个标志位** —— mod.zip / decision.json 的 sha256 前后一致，判定不变；
  //   ④ **公开面不动** —— /api/mods 与 /mods 一个字节都不变（隐藏 ≠ 下架，下架用「打回」）。
  console.log('⑰ 「不再显示」勾选框的端点：一次一个 id · 幂等 · 可逆 · 只改标志位 · 公开面不动');
  const hidePost = (body) => admin('/api/admin/hide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const dirGood = join(dataDir, 'submissions', idGood);
  const fMeta = join(dirGood, 'meta.json'), fDec = join(dirGood, 'decision.json'), fZip = join(dirGood, 'mod.zip');
  const shaOf = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const otherMeta = join(dataDir, 'flagged', idEvil, 'meta.json');
  const zip0 = shaOf(fZip), dec0 = shaOf(fDec), meta0 = shaOf(fMeta), otherMeta0 = shaOf(otherMeta);
  const pub0 = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const modsPage0 = await (await fetch(`${BASE}/mods`)).text();
  const dl0 = createHash('sha256').update(Buffer.from(await (await fetch(`${BASE}/api/file/${idGood}`)).arrayBuffer())).digest('hex');
  const healthBefore = await (await fetch(`${BASE}/healthz`)).json();

  const h1 = await hidePost({ id: idGood, hidden: true });
  const h1b = await h1.json();
  check(h1.status === 200 && h1b.changed === true && h1b.hidden === true,
    '勾上：一次一个 id，写盘成功', `HTTP ${h1.status} · ${JSON.stringify({ changed: h1b.changed, hidden: h1b.hidden })}`);
  const metaHid = JSON.parse(readFileSync(fMeta, 'utf8'));
  check(metaHid.hidden === true && metaHid.hiddenBy === 'admin' && typeof metaHid.hiddenAt === 'string',
    '标志位**落在记录自己的 meta.json 上**（hidden + hiddenBy + hiddenAt）',
    `hidden=${metaHid.hidden} · hiddenBy=${metaHid.hiddenBy} · hiddenAt=${metaHid.hiddenAt}`);
  const listHid = await (await admin('/api/admin/list')).json();
  check(listHid.submissions.find((s) => s.id === idGood)?.hidden === true,
    '/list 原样带出 hidden:true（页面据此不显示它）');
  check(shaOf(fZip) === zip0 && shaOf(fDec) === dec0,
    '**只改标志位**：mod.zip 与 decision.json 的 sha256 前后一字不变',
    `mod.zip ${zip0.slice(0, 12)}→${shaOf(fZip).slice(0, 12)} · decision.json ${dec0.slice(0, 12)}→${shaOf(fDec).slice(0, 12)}`);
  check(JSON.parse(readFileSync(fDec, 'utf8')).decision === 'approved',
    'decision.json 的**判定**照旧是 approved（隐藏不改判定 —— 它只是审核页的显示开关）');
  check(shaOf(fMeta) !== meta0, 'meta.json 确实动了（动的只有那个标志位）');
  check(shaOf(otherMeta) === otherMeta0, '同一个请求**绝不顺带改别的记录**（只认这一个 id）');
  const metaAfterHide = shaOf(fMeta);
  const pub1 = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const dl1 = createHash('sha256').update(Buffer.from(await (await fetch(`${BASE}/api/file/${idGood}`)).arrayBuffer())).digest('hex');
  check(pub1 === pub0, '**公网 /api/mods 一个字节都没变**（隐藏期间它照旧在公开列表里）',
    `条数 ${JSON.parse(pub0).mods.length}/${JSON.parse(pub0).flagged.length} 未变`);
  check(!pub1.includes('"hidden"'), '公开数据里根本不暴露 hidden 这一栏（公开面不知道有这回事）');
  check(dl1 === dl0 && dl1 === goodSha, '公开下载照旧可下、字节不变', dl1.slice(0, 16));

  const h2 = await hidePost({ id: idGood, hidden: true });
  const h2b = await h2.json();
  check(h2.status === 200 && h2b.changed === false && shaOf(fMeta) === metaAfterHide,
    '**幂等**：再勾一次 → changed:false，meta.json 一个字节都没动（没有第二笔留痕）',
    `${JSON.stringify(h2b.changed)} · sha 未变 ${shaOf(fMeta) === metaAfterHide}`);

  // 形状：**一次一个 id、绝不批量**（这些一律 400/404，磁盘上什么都不许改）
  const shapeCases = [
    [{ ids: [idGood], hidden: true }, 400, '「ids」数组（一批）'],
    [{ id: [idGood], hidden: true }, 400, 'id 给了数组'],
    [{ batch: [idGood], hidden: true }, 400, '「batch」键'],
    [{ items: [{ id: idGood }], hidden: true }, 400, '「items」键'],
    [{ list: [idGood], hidden: true }, 400, '「list」键'],
    [{ id: idGood, ids: [idEvil], hidden: true }, 400, '夹带「ids」（哪怕 id 也在）'],
    [{ id: idGood, hidden: 'true' }, 400, 'hidden 是字符串 "true"'],
    [{ id: idGood, hidden: 1 }, 400, 'hidden 是数字 1'],
    [{ id: idGood }, 400, '缺 hidden 字段'],
    [{ id: '短', hidden: true }, 400, 'id 形状不对'],
    [{ id: 'ffffffffffff', hidden: true }, 404, '不存在的 id → 404'],
  ];
  for (const [body, want, label] of shapeCases) {
    const r = await hidePost(body);
    const err = (await r.json().catch(() => ({}))).error || '';
    check(r.status === want, `${label} → ${want}`, `HTTP ${r.status} · ${String(err).slice(0, 46)}`);
  }
  const notObj = await hidePost('["aaaaaaaaaaaa"]');
  check(notObj.status === 400, '报文是数组（不是对象）→ 400', `HTTP ${notObj.status}`);
  const noTokHide = await fetch(`${BASE}/api/admin/hide`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: idGood, hidden: true }),
  });
  check(noTokHide.status === 401, '不带令牌 → 401（勾选框也走那两道防线）', `HTTP ${noTokHide.status}`);
  check(shaOf(fMeta) === metaAfterHide, '这一串坏形状**一条都没写盘**（校验先算不写）',
    `sha 仍是勾上之后那一份 ${shaOf(fMeta) === metaAfterHide}`);

  const h3 = await hidePost({ id: idGood, hidden: false });
  const h3b = await h3.json();
  check(h3.status === 200 && h3b.changed === true && h3b.hidden === false, '取消勾选：写回 hidden:false（**可逆**）');
  const metaBack = JSON.parse(readFileSync(fMeta, 'utf8'));
  check(metaBack.hidden === false, '标志位是**显式的 false**（不是把键删掉 —— 取消勾选也要看得见）', String(metaBack.hidden));
  const listBack = await (await admin('/api/admin/list')).json();
  check(listBack.submissions.find((s) => s.id === idGood)?.hidden === false, '取消之后 /list 给 false —— 它又显示出来了');
  check((metaBack.revisions || []).length === 2,
    '两笔留痕（勾上 + 取消），一笔不多一笔不少（幂等那次没留）', `revisions=${(metaBack.revisions || []).length}`);
  check(shaOf(fZip) === zip0 && shaOf(fDec) === dec0, '这一来一回之后，mod.zip 与 decision.json 的 sha256 仍与最初一致');
  const pub2 = JSON.stringify(await (await fetch(`${BASE}/api/mods`)).json());
  const modsPage1 = await (await fetch(`${BASE}/mods`)).text();
  check(pub2 === pub0 && modsPage1 === modsPage0, '全程**公开面一个字都没变**（/api/mods 与 /mods 都是基准字节）');
  const healthAfter = await (await fetch(`${BASE}/healthz`)).json();
  check(healthAfter.submissions === healthBefore.submissions,
    '**记录条数只增不减**：隐藏没有删掉任何记录', `${healthBefore.submissions} → ${healthAfter.submissions}`);

  // ---------------------------------------------------------------- ⑱ 普通投稿的作者：现读包内 pack.json，读不到就 null
  // 三条边界一次验完：
  //   ① 包内**没有** author ⇒ 公网这一栏是 null（**不代填、不编名字**），来源也是 null；
  //   ② 包内**有** author ⇒ 读得出来（⑨ 已经验过一条，这里顺手再验一次同一次响应里的那条）；
  //   ③ **绝不回写记录** —— 读一次 `/api/mods` 前后，整个数据目录里每个文件的 sha256 逐字节相同。
  console.log('⑱ 普通投稿的作者：读包内 pack.json · 没有就是 null · 读它一次不动任何记录');
  const noAuthor = makeZip([
    { name: 'pack.json', data: JSON.stringify({ id: 'selftest-noauthor', name: '没有作者栏的包', version: '1.0.0', license: 'CC0-1.0', description: '自测', api: '>=1 <2', game: '0.2.x' }, null, 2) },
    { name: 'bonds.json', data: '{}' },
  ]);
  const r8 = await submit(noAuthor, { name: '没有作者栏的包（自测）' });
  check(r8.status === 201 && r8.body?.id, '包内没写 author 的包照样能上传', `id=${r8.body?.id}`);
  const idNoAuthor = r8.body.id;
  const approve2 = await admin('/api/admin/decide', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: idNoAuthor, decision: 'approved' }),
  });
  check(approve2.status === 200, '它也能通过（站点**不会**为它编一个作者出来）');
  // 递归列出数据目录里的每个文件（相对路径，'/' 分隔）——记录是 <区>/<编号>/<文件> 三层，
  // 只扫一层会扫到「0 个文件」，那种断言等于没断。
  const listFiles = (dir = dataDir, prefix = '') => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`])).sort();
  const snapAll = () => listFiles().map((rel) => `${rel} ${shaOf(join(dataDir, rel))}`);
  const filesBefore = snapAll();
  check(filesBefore.length >= 10, '先钉住清单本身不是空的（否则下面那次比对等于没比）',
    `${filesBefore.length} 个文件：${listFiles().slice(0, 3).join('、')}…`);
  const mods2 = await (await fetch(`${BASE}/api/mods`)).json();
  const mods3 = await (await fetch(`${BASE}/api/mods`)).json();     // 第二遍走缓存，结果必须一模一样
  const filesAfter = snapAll();
  check(JSON.stringify(mods2) === JSON.stringify(mods3),
    '同一个响应连读两遍逐字节相同（缓存只省事，不改结果）');
  check(JSON.stringify(filesBefore) === JSON.stringify(filesAfter),
    '**读公网列表一次，记录一个字节都没动**（全目录 sha256 清单前后相同 —— 这是推导，不是补数据）',
    `${filesBefore.length} 个文件逐条比对`);
  // 【2026-10-12 唯一一处既有断言的改动 —— **不是放宽**，是把一个**新增的、有意的**顶层文件
  //   加进白名单】：本条断言原本要求「DATA_DIR 根下一个散文件都没有」，防的是失败路径留下
  //   `.part` 垃圾（上传被拒、例外早退等等）。本次新增了**极简追加式审计日志**
  //   `<DATA_DIR>/audit.jsonl`（裁定 ⑧ ①：落点就在数据目录，只追加、从不改写），
  //   它是一个**有意的、必须存在的**顶层文件，不是散落垃圾。
  //   所以白名单里只多它**一个**：其余任何顶层文件（`.part`、临时件、别的什么）
  //   照旧会让这一条失败 —— 断言的严格程度对「意外文件」一点没降。
  const ROOT_OK = ['audit.jsonl'];
  const stray = listFiles().filter((rel) => !rel.includes('/') && !ROOT_OK.includes(rel));
  check(stray.length === 0,
    'DATA_DIR 根下依旧没有散文件（白名单只有一份有意的顶层文件 audit.jsonl）',
    `${stray.join('、') || '（0 个意外文件）'} · 顶层允许清单 ${ROOT_OK.join('、')}`);
  const pubNoAuthor = mods2.mods.find((m) => m.id === idNoAuthor);
  check(!!pubNoAuthor, '包内没写作者的那条也上了公网列表');
  check(pubNoAuthor?.author === null, '包内**没有** author ⇒ 公网这一栏就是 null（不代填、不编名字）',
    JSON.stringify(pubNoAuthor?.author));
  check(pubNoAuthor?.authorSource === null, '来源也是 null（没有名字就没有来源）',
    JSON.stringify(pubNoAuthor?.authorSource));
  const pubGood = mods2.mods.find((m) => m.id === idGood);
  check(pubGood?.author === 'selftest' && pubGood?.authorSource === 'pack.json',
    '同一份响应里，包内写了 author 的那条照旧读得出来',
    `${JSON.stringify(pubGood?.author)} / ${JSON.stringify(pubGood?.authorSource)}`);

  if (packArg) {
    console.log('⑭ 额外：传一个真实包');
    const real = readFileSync(resolve(packArg));
    const r7 = await submit(real, { name: '真实包（自测）', note: '来自 ' + packArg, file: 'real.zip' });
    check(r7.status === 201, '真实包被受理', `id=${r7.body?.id} 条目 ${r7.body?.entries}`);
    check(r7.body?.suspected === false, '真实包没有被标疑似', JSON.stringify(r7.body?.suspectedReasons || []));
  }

  // ---------------------------------------------------------------- ⑲ 上传断连修复：超时显式写死 + 上传页按真实状态码分类
  // 背景（2026-10-14）：服务端**从不设** `server.requestTimeout` ⇒ 吃 Node v22 默认的 300000 ms，
  // 而它判的是「整个请求的总时长」⇒「上传总耗时 > 300 秒」的请求在第 300 秒被掐
  // （回 408 + 断连，只传上去一部分）。25 MB @50 KB/s ≈ 500 秒，所以必断；@200 KB/s ≈ 128 秒，能过。
  // ⚠️ 这一组判据是**静态读文件**，所以它能在「改前的文件」上直接跑红 —— 有牙齿，不是只跟着代码走。
  console.log('⑲ 上传断连修复：三个超时显式写死 + 上传页按真实状态码分类');
  {
    const serverSrc = readFileSync(join(HERE, 'server.mjs'), 'utf8');
    // 只认 `server.<名字> = <数字>` 这种**显式赋值**，且 `server` 前面不能是标识符字符
    // （免得 `myserver.requestTimeout = 1` 也被算成设置过）。
    const timeoutOf = (n) => {
      const m = serverSrc.match(new RegExp(`(?:^|[^\\w.])server\\.${n}\\s*=\\s*([0-9][0-9_]*)`, 'm'));
      return m ? Number(m[1].replace(/_/g, '')) : null;
    };
    const rt = timeoutOf('requestTimeout');
    const ht = timeoutOf('headersTimeout');
    const kt = timeoutOf('keepAliveTimeout');
    check(rt !== null && ht !== null && kt !== null,
      'server.mjs 显式写死了三个超时（requestTimeout / headersTimeout / keepAliveTimeout 三处都有 `server.x = 数字`）',
      `requestTimeout=${rt} headersTimeout=${ht} keepAliveTimeout=${kt}`);
    check(rt !== null && rt >= 600000,
      'requestTimeout ≥ 600000 ms（Node 默认的 300 秒会掐掉慢速大包：25 MB @50 KB/s ≈ 500 秒）',
      `${rt} ms`);
    check(rt !== null && rt > 0,
      'requestTimeout **不是 0**（0 = 关掉这道保护、慢连接能永远挂着；要大而有限的值）', `${rt} ms`);
    check(ht !== null && kt !== null && ht > kt,
      'headersTimeout > keepAliveTimeout（Node 的建议；否则长连接复用会莫名超时）', `${ht} > ${kt}`);

    // 上传页：**同一份判据**逐页扫，别只扫 index（业主 2026-10-14 裁定 ③：
    // 「换包体」那个上传同属一条毛病，判据要跟着覆盖过去）。加新上传页就往这张表里加一行。
    // ⚠️ `region` 是**上传那一段的窗口**：不限定窗口的话，「没成：<原话>」这种折叠写法会命中
    //    同一页里**非上传**的小报文处理器（实测踩过：mine.html 的 /update 正好也是那种一行写法），
    //    判据就变成「只要这一页还有别的地方这么写就红」—— 那不是我们要防的东西。
    const UPLOAD_PAGES = [
      {
        f: 'index.html',                                   // 投稿页：XMLHttpRequest
        clientTimeout: /xhr\.timeout\s*=/,
        timeoutLabel: 'xhr.timeout（兜底时限）',
        region: null,                                      // 整页
        classify: /showFail\(xhr\.status, r\)/,
        classifyLabel: '失败路径走 showFail(xhr.status, r) 分类',
        gone: /xhr\.onerror\s*=\s*\(\)\s*=>\s*\{[^\n]*out\.textContent\s*=\s*'网络断了/,
        goneLabel: '`xhr.onerror` 不再把「网络断了」**无条件**写死成唯一文案（那一句现在只在「真没拿到任何响应」那一支里）',
      },
      {
        f: 'mine.html',                                    // 「我的投稿」页的换包体：fetch
        clientTimeout: /new AbortController\(\)/,
        timeoutLabel: 'AbortController（兜底时限）',
        region: /\/api\/publisher\/blob\?id=[\s\S]{0,700}/,
        classify: /failText\(r\.status, r\.body\)/,
        classifyLabel: '失败路径走 failText(r.status, r.body) 分类',
        gone: /没成：' \+ \(r\.body\?\.error \|\| r\.status\)/,
        goneLabel: '`mine.html` 的换包体失败不再只拼接「没成：<原话或状态码>」—— 按状态码分类说人话',
      },
    ];
    for (const P of UPLOAD_PAGES) {
      const src = readFileSync(join(HERE, 'pages', P.f), 'utf8');
      // ⚠️ 只认**真代码**：把整行的 `//` 注释剥掉再匹配。为什么必须有这一步 ——
      // 页面里那段「改之前写的是 `xhr.onerror = () => { … out.textContent = '网络断了…' }`」的
      // 解释性注释本身就会被下面的正则命中，于是**改后的文件反而红**（实测踩过一次）。
      // 判据要防的是「代码里还有这句话」，不是「注释里提过这句话」。
      const code = src.replace(/^\s*\/\/.*$/gm, '');
      const region = P.region ? ((code.match(P.region) || [''])[0]) : code;
      check(/408/.test(code) && /413/.test(code) && /429/.test(code),
        `pages/${P.f} 的**代码**里有 408 / 413 / 429 三个真实状态码（上传失败按状态分类说人话）`,
        ['408', '413', '429'].map((c) => `${c}:${code.includes(c) ? '有' : '无'}`).join(' '));
      check(/status\s*===\s*408/.test(code) && /status\s*===\s*413/.test(code) && /status\s*===\s*429/.test(code),
        `pages/${P.f} 按状态分类是**真的分支**（408 / 413 / 429 各有一条「status === N」比较），不是只把数字写进注释`);
      check(/__MAX_MB__/.test(code),
        `pages/${P.f} 用服务端注入的 __MAX_MB__ 当上限（本地体积预检与 413 提示不会跟 MAX_MB 漂移）`);
      check(/\.size\s*>\s*MAX_BYTES/.test(code),
        `pages/${P.f} 在**发请求之前**本地判体积（超过上限就不发请求、不白等一次）`);
      check(P.clientTimeout.test(code),
        `pages/${P.f} 有客户端兜底时限：${P.timeoutLabel}（链路整个挂住时给出「超时」，而不是一直转圈）`);
      check(region.length > 0 && P.classify.test(region),
        `pages/${P.f} 的上传那一段：${P.classifyLabel}`);
      check(!P.gone.test(region), P.goneLabel);
    }

    // 服务端真的把占位符换掉了 —— 原样漏到浏览器里就等于「本地体积预检」失效。
    for (const u of ['/', '/mine']) {
      const served = await (await fetch(`${BASE}${u}`)).text();
      check(!served.includes('__MAX_MB__') && /const MAX_MB = Number\('\d+'\)/.test(served),
        `服务端发出来的 ${u} 已把 __MAX_MB__ 换成真实数字（占位符没漏到浏览器里）`,
        (served.match(/const MAX_MB = Number\('[^']*'\)/) || ['(没找到那一行)'])[0]);
    }
  }

  // 管理白名单：只有 HTTP 时这是保护令牌的主要手段。用第二个实例测，顺带证明
  // 「默认不信 x-forwarded-for」这件事 —— 只有 TRUST_PROXY=1 时它才被当真。
  console.log('⑯ HTTP Basic 登录（浏览器弹框那种）');
  {
    const basic = 'Basic ' + Buffer.from('admin:' + TOKEN).toString('base64');
    const noAuthPage = await fetch(`${BASE}/admin`, { redirect: 'manual' });
    check(noAuthPage.status === 401, '裸访问 /admin → 401（浏览器据此弹登录框）', String(noAuthPage.status));
    check(/basic/i.test(noAuthPage.headers.get('www-authenticate') || ''), '401 带 WWW-Authenticate: Basic',
      noAuthPage.headers.get('www-authenticate') || '(没有)');
    const okPage = await fetch(`${BASE}/admin`, { headers: { authorization: basic } });
    check(okPage.status === 200 && (await okPage.text()).includes('<title>审核'), '带 Basic 凭据 → 200 且拿到审核页');
    const wrongPage = await fetch(`${BASE}/admin`, { headers: { authorization: 'Basic ' + Buffer.from('admin:nope').toString('base64') } });
    check(wrongPage.status === 401, 'Basic 密码错 → 401', String(wrongPage.status));
    const basicApi = await fetch(`${BASE}/api/admin/list`, { headers: { authorization: basic } });
    check(basicApi.status === 200, 'Basic 凭据也能过 API', String(basicApi.status));
    const headerApi = await fetch(`${BASE}/api/admin/list`, { headers: { 'x-admin-token': TOKEN } });
    check(headerApi.status === 200, '原来的 x-admin-token 头仍然可用（后路没断）', String(headerApi.status));
  }

  console.log('⑮ 管理白名单 ADMIN_IPS + 自定义审核路径 ADMIN_PATH（另起一个实例）');
  const PORT2 = 8801;
  const ALT = 'review-x9';
  const child2 = spawn(process.execPath, [join(HERE, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT2), DATA_DIR: dataDir, ADMIN_TOKEN: TOKEN,
      HOST: '127.0.0.1', ADMIN_IPS: '203.0.113.9', TRUST_PROXY: '1', ADMIN_PATH: ALT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    let up2 = false;
    for (let i = 0; i < 60 && !up2; i++) {
      try { up2 = (await fetch(`http://127.0.0.1:${PORT2}/healthz`)).ok; } catch { /* 等 */ }
      if (!up2) await sleep(120);
    }
    check(up2, '带白名单与自定义路径的实例起来了');
    const B2 = `http://127.0.0.1:${PORT2}`;
    const other = await fetch(`${B2}/api/${ALT}/list`, { headers: { 'x-admin-token': TOKEN, 'x-forwarded-for': '198.51.100.7' } });
    check(other.status === 403, '不在白名单的来源 → 403（哪怕令牌是对的）', String(other.status));
    const inList = await fetch(`${B2}/api/${ALT}/list`, { headers: { 'x-admin-token': TOKEN, 'x-forwarded-for': '203.0.113.9' } });
    check(inList.status === 200, '白名单里的来源 → 200', String(inList.status));
    const loop = await fetch(`${B2}/api/${ALT}/list`, { headers: { 'x-admin-token': TOKEN } });
    check(loop.status === 200, '本机回环永远放行（SSH 隧道就是这么进来的）', String(loop.status));
    const noTok = await fetch(`${B2}/api/${ALT}/list`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    check(noTok.status === 401, '白名单内但没令牌 → 401（两道都要过）', String(noTok.status));

    // 自定义路径生效后，默认名应当**彻底不存在**（否则「换名字」就是白换）
    const oldApi = await fetch(`${B2}/api/admin/list`, { headers: { 'x-admin-token': TOKEN } });
    check(oldApi.status === 404, '默认的 /api/admin/* 已不存在 → 404', String(oldApi.status));
    const oldPage = await fetch(`${B2}/admin`, { headers: { 'x-admin-token': TOKEN } });
    check(oldPage.status === 404, '默认的 /admin 已不存在 → 404', String(oldPage.status));
    const altPage = await fetch(`${B2}/${ALT}`, { headers: { 'x-admin-token': TOKEN } });
    const altHtml = await altPage.text();
    check(altPage.status === 200 && altHtml.includes(`/api/${ALT}`) && !altHtml.includes('__ADMIN_API__'),
      `新的 /${ALT} 能打开，且页面里注入的 API 前缀是对的、占位符已替换`,
      `HTTP ${altPage.status} · 含前缀 ${altHtml.includes(`/api/${ALT}`)} · 残留占位符 ${altHtml.includes('__ADMIN_API__')}`);
    // 皮肤：自带样式表由服务自己发（不引 CDN、不引外部字体）。
    const css = await fetch(`${B2}/theme.css`);
    const cssText = await css.text();
    check(css.status === 200 && /text\/css/.test(css.headers.get('content-type') || ''),
      'GET /theme.css 由服务自己发出（零依赖，不外链）', `${css.status} · ${css.headers.get('content-type')}`);
    check(!/https?:\/\//.test(cssText.replace(/\/\*[\s\S]*?\*\//g, '')),
      '样式表里没有任何 http(s) 外链（离线/内网也能用，不拉 CDN 与外部字体）');
    check(altHtml.includes('/theme.css') && !altHtml.includes('__CSS__'),
      '页面挂上了同源样式表，且 __CSS__ 占位符已替换');
    const pub2 = await (await fetch(`${B2}/`)).text();
    const pubMods2 = await (await fetch(`${B2}/mods`)).text();
    check(pub2.includes('/theme.css') && pubMods2.includes('/theme.css'),
      '上传页与公开列表页也挂上了同一份样式表（三页一个皮肤）');
  } finally {
    child2.kill();
  }
} finally {
  child.kill();
  await sleep(200);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('');
if (failures) { console.log(`✖ ${failures} 项没通过`); process.exit(1); }
console.log('✔ 上传 → 下载 → 审核 → 上线，整条链通过');
