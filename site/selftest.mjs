// 上传站自测：起一个自己的服务实例，把「上传 → 下载跑测试 → 审核 → 上线」整条链走一遍。
//
//   node site/selftest.mjs                 用临时数据目录，自造一个合成包
//   node site/selftest.mjs --pack <zip>    额外把一个真实 zip 也传上去验一遍
//
// 只用 node 内置：不依赖 zip 命令、不依赖网络。自带一个 **store 模式的极小 zip 写入器**，
// 这样连「故意夹带游戏素材的包」这种用例也能造出来。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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
  check(mods.flagged.length === 1 && mods.flagged[0].id === idEvil, '疑似素材单独一组，没混进正常那一组');
  check(mods.flagged[0].suspected === true && (mods.flagged[0].suspectedReasons || []).length > 0,
    '公开数据里带着疑似标记与命中的原因', JSON.stringify(mods.flagged[0].suspectedReasons));
  check(mods.mods[0].suspected === false, '正常那一组里没带疑似标记');

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

  if (packArg) {
    console.log('⑭ 额外：传一个真实包');
    const real = readFileSync(resolve(packArg));
    const r7 = await submit(real, { name: '真实包（自测）', note: '来自 ' + packArg, file: 'real.zip' });
    check(r7.status === 201, '真实包被受理', `id=${r7.body?.id} 条目 ${r7.body?.entries}`);
    check(r7.body?.suspected === false, '真实包没有被标疑似', JSON.stringify(r7.body?.suspectedReasons || []));
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
