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
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, createReadStream, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries, looksLikeZip } from './zip.mjs';
import { reviewName, reviewEntries, hasBlocker } from './review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, 'pages');

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = resolve(process.env.DATA_DIR || join(HERE, 'data'));
const SUBS = join(DATA_DIR, 'submissions');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_BYTES = Number(process.env.MAX_MB || 100) * 1024 * 1024;
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;

if (!ADMIN_TOKEN || ADMIN_TOKEN.length < 16) {
  console.error('✖ 必须设置 ADMIN_TOKEN（至少 16 位），否则谁都能通过审核。例如：');
  console.error('    ADMIN_TOKEN=' + randomBytes(24).toString('hex') + ' node site/server.mjs');
  process.exit(2);
}
mkdirSync(SUBS, { recursive: true });

const ID_RE = /^[a-z0-9]{6,32}$/;
const nowIso = () => new Date().toISOString();
const idOf = () => randomBytes(6).toString('hex');            // 12 位十六进制
const tokenOf = () => randomBytes(16).toString('hex');        // 给投稿人的回执令牌

const subDir = (id) => join(SUBS, id);
const metaPath = (id) => join(subDir(id), 'meta.json');
const blobPath = (id) => join(subDir(id), 'mod.zip');
const decisionPath = (id) => join(subDir(id), 'decision.json');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2), 'utf8');

const allSubs = () => {
  if (!existsSync(SUBS)) return [];
  return readdirSync(SUBS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && ID_RE.test(e.name))
    .map((e) => {
      const meta = readJson(metaPath(e.name)) || {};
      const decision = readJson(decisionPath(e.name)) || null;
      return { id: e.name, ...meta, decision, state: decision ? decision.decision : 'pending' };
    })
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
};

// ---------------------------------------------------------------- HTTP 小工具

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'cache-control': 'no-store', ...headers });
  res.end(body);
};
const sendJson = (res, code, obj) =>
  send(res, code, JSON.stringify(obj, null, 2), { 'content-type': 'application/json; charset=utf-8' });
const sendPage = (res, name) => {
  const p = join(PAGES, name);
  if (!existsSync(p)) return send(res, 404, '页面不存在', { 'content-type': 'text/plain; charset=utf-8' });
  send(res, 200, readFileSync(p), { 'content-type': 'text/html; charset=utf-8' });
};
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
const isAdmin = (req) => tokenOk(req.headers['x-admin-token']);

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
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';

  try {
    // ---- 页面
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return sendPage(res, 'index.html');
    if (req.method === 'GET' && (p === '/mods' || p === '/mods.html')) return sendPage(res, 'mods.html');
    if (req.method === 'GET' && (p === '/admin' || p === '/admin.html')) return sendPage(res, 'admin.html');
    if (req.method === 'GET' && p === '/healthz') {
      return sendJson(res, 200, { ok: true, at: nowIso(), submissions: allSubs().length });
    }

    // ---- 公开：已上线的 mod
    if (req.method === 'GET' && p === '/api/mods') {
      const mods = allSubs()
        .filter((s) => s.state === 'approved')
        .map((s) => ({ id: s.id, name: s.name, note: s.note, uploadedAt: s.uploadedAt, size: s.size,
          homepage: s.homepage || null, download: `${BASE_URL}/api/file/${s.id}` }));
      return sendJson(res, 200, { mods });
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
    if (req.method === 'GET' && p.startsWith('/api/file/')) {
      const id = p.slice('/api/file/'.length);
      if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对' });
      if (!existsSync(blobPath(id))) return sendJson(res, 404, { error: '文件不在' });
      const d = readJson(decisionPath(id));
      if (d?.decision !== 'approved' && !isAdmin(req)) {
        return sendJson(res, 403, { error: '这个还没通过审核，只有维护者能下载' });
      }
      const meta = readJson(metaPath(id)) || {};
      return sendFile(res, blobPath(id), `${id}-${(meta.name || 'mod').replace(/[\\/:*?"<>|]/g, '_')}.zip`);
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
      mkdirSync(subDir(id), { recursive: true });
      writeFileSync(blobPath(id), body);

      let entries = [];
      let contentFlags = [];
      try {
        entries = await readZipEntries(blobPath(id));
        contentFlags = reviewEntries(entries, { packIdHint: name });
      } catch (e) {
        contentFlags = [{ level: 'blocker', code: 'BAD_ZIP', text: `zip 读不了：${e.message}` }];
      }

      const meta = {
        id, name, note, homepage: homepage || null,
        size: body.length, sha256: createHash('sha256').update(body).digest('hex'),
        uploadedAt: nowIso(), ip, receipt: tokenOf(),
        entries: entries.filter((e) => !e.dir).length,
        unpackedBytes: entries.reduce((n, e) => n + e.uncompSize, 0),
        flags: [...nameFlags, ...contentFlags],
        blocked: hasBlocker(contentFlags),
      };
      writeJson(metaPath(id), meta);

      return sendJson(res, 201, {
        ok: true, id, receipt: meta.receipt,
        state: 'pending', blocked: meta.blocked,
        size: meta.size, sha256: meta.sha256, entries: meta.entries,
        statusUrl: `${BASE_URL}/api/status/${id}?t=${meta.receipt}`,
        flags: meta.flags,
        message: meta.blocked
          ? '已收到，但里面有需要维护者确认的东西（见 flags），已标记待查。'
          : '已收到。维护者会下载下来跑测试，通过后再上线。',
      });
    }

    // ---- 维护者：列表 / 详情 / 决定
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: '需要 x-admin-token' });

      if (req.method === 'GET' && p === '/api/admin/list') return sendJson(res, 200, { submissions: allSubs() });

      if (req.method === 'GET' && p.startsWith('/api/admin/detail/')) {
        const id = p.slice('/api/admin/detail/'.length);
        if (!ID_RE.test(id)) return sendJson(res, 400, { error: 'id 形状不对' });
        const meta = readJson(metaPath(id));
        if (!meta) return sendJson(res, 404, { error: '没有这条投稿' });
        let entries = [];
        try { entries = await readZipEntries(blobPath(id)); } catch { /* 读不了就只给 meta */ }
        const top = {};
        for (const e of entries) {
          if (e.dir) continue;
          const seg = e.name.split('/');
          const k = seg.length > 1 ? seg[0] + '/' : '(根)';
          top[k] = (top[k] || 0) + (e.uncompSize || 0);
        }
        return sendJson(res, 200, { meta, entries: entries.filter((e) => !e.dir).slice(0, 400), topLevel: top,
          download: `${BASE_URL}/api/file/${id}` });
      }

      if (req.method === 'POST' && p === '/api/admin/decide') {
        const raw = await readBody(req, 64 * 1024);
        let inObj = {};
        try { inObj = JSON.parse(raw.toString('utf8') || '{}'); } catch { return sendJson(res, 400, { error: 'JSON 读不了' }); }
        const { id, decision, reason, displayName } = inObj;
        if (!ID_RE.test(String(id || ''))) return sendJson(res, 400, { error: 'id 形状不对' });
        if (!['approved', 'rejected'].includes(decision)) return sendJson(res, 400, { error: 'decision 只能是 approved / rejected' });
        if (!existsSync(blobPath(id))) return sendJson(res, 404, { error: '没有这条投稿' });
        const meta = readJson(metaPath(id)) || {};
        if (decision === 'approved' && meta.blocked) {
          return sendJson(res, 409, { error: '这条带着 blocker 标记（多半是疑似游戏素材）。确认无误的话先改 meta.json 里的 blocked，或者用 --force 语义：把 blocked 置 false 后再通过。' });
        }
        writeJson(decisionPath(id), { decision, reason: reason || null, at: nowIso(), by: 'admin',
          displayName: displayName || meta.name });
        if (displayName && displayName !== meta.name) writeJson(metaPath(id), { ...meta, name: displayName });
        return sendJson(res, 200, { ok: true, id, state: decision });
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
  }
});

server.listen(PORT, () => {
  console.log(`工坊包上传站已起：${BASE_URL}`);
  console.log(`  上传页   ${BASE_URL}/`);
  console.log(`  已上线   ${BASE_URL}/mods`);
  console.log(`  审核页   ${BASE_URL}/admin   （页面里填 ADMIN_TOKEN；服务端只认 x-admin-token）`);
  console.log(`  数据目录 ${DATA_DIR}`);
  console.log(`  上传上限 ${(MAX_BYTES / 1048576).toFixed(0)} MB`);
});
