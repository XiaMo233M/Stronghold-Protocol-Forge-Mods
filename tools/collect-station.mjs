#!/usr/bin/env node
// 从站上**只读**导出一份 staging，供 `tools/build-index.mjs` 生成 `mods/` 镜像。
//
//   （在站点主机上跑，tar 流走 stdout，诊断走 stderr）
//   node tools/collect-station.mjs --out /tmp/modrepo-stage > stage.tar
//
//   （在本机、经 SSH 隧道或直连时）
//   ssh <host> 'node /path/tools/collect-station.mjs --out /tmp/modrepo-stage' > stage.tar
//   mkdir -p _up/modrepo-stage && tar -xf stage.tar -C _up/modrepo-stage
//
// 为什么要有这个脚本（业主 2026-10-12 裁定）：**「重新导出」是每次发版的必做步骤** ——
// 必做步骤没有一个版本化的脚本，就等于不可复现；README 写了流程而真源活在某个 `_up/`
// 临时目录里，正是我们那条铁律要消灭的形态（「抄一份就是第二个会漂移的真相」）。
// 它**不是临时产物，是发布工具**，所以收在 `tools/` 里。
//
// ⚠️ 它**只读站点**：只 `readFileSync` 站点文件并复制到 staging；**一个字节都不写回站点**。
//
// 输出（staging）：`manifest.json` + `_selection.json` + `mods/<站点编号>/{mod.zip,meta.json,decision.json}`
//   · `manifest.json.mods[]` = **入选清单**（下面那条选择口径 + 去重之后的）
//   · `_selection.json`      = **采集时刻的全部记录**（含未入选的）—— 两者不是一回事，
//                              判「缺了哪个包」请按 manifest / index，别按它。
//
// 选择口径（确定性、可复现）：
//   ① `decision.json.decision === 'approved'` 且 `meta.json.packKind === 'functional'`
//      （业主口径：只收非说明文档 —— 与 `build-index.mjs` 的第 3 道闸门同源）
//   ② **同一 `pack.json.id` 只能留一条**（引擎不允许同 id 并存：同一 workshop 根里放两份
//      id 相同的包 ⇒ 只装载 1 条、后者静默覆盖前者）。判定顺序：
//        a. **上传时间晚者优先** —— 两条常常是**同一批一起 approved** 的，批准时间分不出新旧
//        b. 批准时间晚者优先
//        c. 站点编号大者优先
//      被排除的那条**逐字段记进 `manifest.source.excludedSamePackId`**（含理由与谁被留下），
//      再由 `build-index.mjs` 原样带进 `mods/index.json` —— 免得那条决定只活在 staging 里、
//      仓库读者看不到。
//   ③ 读不到包内 `pack.json` 的记录**绝不静默丢件**：它会被带进 manifest（packId 为 null），
//      由 build-index 的闸门如实退件并报出来。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? true) : fallback; };

const DATA = resolve(String(flag('--data', process.env.SP_DATA_DIR || '/var/lib/sp-modsite')));
const STAGE = resolve(String(flag('--out', '/tmp/modrepo-stage')));
const SITE = flag('--site', 'http://47.103.14.217:25570/ (sp-modsite 上传站)');
const AREAS = ['submissions', 'flagged', 'compat'];

const rj = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 读 zip 里的 pack.json（引擎认的是**包内**那一份，不是记录里那一栏）。读不到返回 {}。 */
function packJsonOf(zipPath) {
  try {
    const buf = readFileSync(zipPath);
    const read = readZip(buf);
    if (!read) return {};
    const norm = (n) => n.split('\\').join('/').replace(/^\.\//, '');
    const hit = read.find((e) => norm(e.name) === 'pack.json');
    if (!hit) return {};
    return JSON.parse(hit.data.toString('utf8').replace(/^\uFEFF/, ''));
  } catch { return {}; }
}

/** 极简 zip 读取（只认 store / deflate；staging 里都是标准 zip）。 */
function readZip(buf) {
  try {
    // 找 End Of Central Directory
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66560; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const out = [];
    for (let n = 0; n < count && off + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const method = buf.readUInt16LE(off + 10);
      const compSize = buf.readUInt32LE(off + 20);
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      const localOff = buf.readUInt32LE(off + 42);
      const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
      // local header
      if (buf.readUInt32LE(localOff) !== 0x04034b50) break;
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = raw;
      else { try { data = inflateRawSync(raw); } catch { try { data = inflateSync(raw); } catch { data = Buffer.alloc(0); } } }
      out.push({ name, data });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } catch { return null; }
}

// ── 采集 ──
const recs = [];
for (const area of AREAS) {
  const dir = join(DATA, area);
  if (!existsSync(dir)) continue;
  for (const rid of readdirSync(dir).sort()) {
    const rd = join(dir, rid);
    try { if (!statSync(rd).isDirectory()) continue; } catch { continue; }
    const meta = rj(join(rd, 'meta.json'));
    if (!meta) continue;
    const dec = rj(join(rd, 'decision.json')) || {};
    recs.push({ area, dir: rd, meta, dec, state: dec.decision || 'pending' });
  }
}

const elig = recs.filter((r) => r.state === 'approved' && r.meta.packKind === 'functional');
const sortKey = (r) => [r.meta.uploadedAt || '', r.dec.at || '', r.meta.id];
const keyOf = (r) => sortKey(r).join('\u0000');

const chosen = new Map();
const excluded = [];
for (const r of [...elig].sort((a, b) => (keyOf(a) < keyOf(b) ? 1 : -1))) {
  const zid = packJsonOf(join(r.dir, 'mod.zip'));
  const pid = typeof zid.id === 'string' && zid.id.trim() ? zid.id.trim() : null;
  if (!pid) { chosen.set('__noid__' + r.meta.id, { r, zid }); continue; }
  if (chosen.has(pid)) {
    const { r: keep } = chosen.get(pid);
    excluded.push({
      id: r.meta.id, packId: pid, version: zid.version ?? null,
      uploadedAt: r.meta.uploadedAt ?? null, decisionAt: r.dec.at ?? null,
      reason: '同 pack id 只能一条（引擎不允许并存）',
      keptId: keep.meta.id, keptDecisionAt: keep.dec.at ?? null, keptUploadedAt: keep.meta.uploadedAt ?? null,
    });
    continue;
  }
  chosen.set(pid, { r, zid });
}

const picked = [...chosen.values()].map((v) => v.r).sort((a, b) => (a.meta.id < b.meta.id ? -1 : 1));

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'mods'), { recursive: true });

const manMods = [];
let totalBytes = 0;
for (const r of picked) {
  const m = r.meta; const sid = m.id;
  const srcZip = join(r.dir, 'mod.zip');
  const dst = join(STAGE, 'mods', sid);
  mkdirSync(dst, { recursive: true });
  for (const f of ['mod.zip', 'meta.json', 'decision.json']) {
    const s = join(r.dir, f);
    if (existsSync(s)) copyFileSync(s, join(dst, f));
  }
  const zi = packJsonOf(srcZip);
  const zipBuf = existsSync(srcZip) ? readFileSync(srcZip) : null;
  const real = zipBuf ? sha256(zipBuf) : null;
  const recPack = m.pack && typeof m.pack === 'object' ? m.pack : {};
  // 原作者三级取一：站侧那一栏 → 记录自带的 pack 快照 → **包内 pack.json 自己那一栏**。
  // 三级都是同一个事实来源；都读不到就 null（build-index 会写成「**未声明**」，不编造）。
  const author = m.author || recPack.author || zi.author || null;
  const authorSource = m.authorSource || (author ? 'pack.json' : null);
  manMods.push({
    id: sid,
    packId: zi.id ?? null,
    name: zi.name || m.name || null,
    version: zi.version ?? null,
    apiRange: zi.api ?? null,
    gameVersion: zi.game ?? zi.gameVersion ?? null,
    sha256: real,
    sha256MatchesRecord: real === m.sha256,
    packHash: null,                     // 由 build-index 的引擎装载算出；这里不编
    packHashAlgorithm: 'Stronghold-Protocol server/workshop.js identifyPack() → shared/modIdentity.modManifestDigest(manifest)（逐文件 canonical 哈希）',
    category: 'functional',
    recordKind: m.kind || 'submission',
    author, authorSource,
    license: zi.license ?? null,
    compatAuthor: m.kind === 'compat' ? (m.compatAuthor ?? null) : null,
    compatOf: m.compatOf ?? null,
    source: m.homepage ?? null,
    path: `mods/${sid}/mod.zip`,
    sizeBytes: m.size ?? null,
    files: { entries: m.entries ?? null, unpackedBytes: m.unpackedBytes ?? null },
    recordMetaFiles: ['meta.json', 'decision.json'],
  });
  totalBytes += m.size || 0;
}

const manifest = {
  generatedAt: new Date().toISOString(),
  source: {
    site: SITE,
    dataDir: DATA,
    selection: 'state=approved 且 packKind=functional',
    collected: manMods.length,
    excludedSamePackId: excluded,
    note: '件由站侧导出：只复制 mod.zip + meta.json + decision.json，站点文件一个字节未改；orig.zip（留档原件）不入库。',
    selectionArtifact: '_selection.json = 采集时刻的**全部记录**清单（含未入选的）；**入选清单是本 manifest.mods**，两者不是一回事。',
  },
  totals: {
    count: manMods.length,
    sizeBytes: totalBytes,
    sizeMB: Math.round((totalBytes / 1048576) * 10) / 10,
  },
  mods: manMods,
};
writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

const selection = recs
  .map((r) => ({ id: r.meta.id, area: r.area, state: r.state, packKind: r.meta.packKind ?? null, packId: r.meta.packId ?? null, name: r.meta.name ?? null, size: r.meta.size ?? null, sha256: r.meta.sha256 ?? null }))
  .sort((a, b) => (a.id < b.id ? -1 : 1));
writeFileSync(join(STAGE, '_selection.json'), JSON.stringify(selection, null, 1), 'utf8');

process.stderr.write(`dataDir=${DATA}\nstaging=${STAGE}\n收件（入选清单）=${manMods.length}  全部记录=${recs.length}\n`);
for (const e of excluded) process.stderr.write(`  排除（同 pack id）${e.id} packId=${e.packId} 留下=${e.keptId}\n`);

// ── tar 到 stdout（stdout 只承载 tar；一切散文走 stderr）──
const tarPath = STAGE + '.tar';
execFileSync('tar', ['-cf', tarPath, '-C', dirname(STAGE), STAGE.split(/[\\/]/).pop()], { stdio: ['ignore', 'inherit', 'inherit'] });
process.stdout.write(readFileSync(tarPath));
process.stderr.write(`tar=${tarPath}\n`);
rmSync(tarPath, { force: true });
