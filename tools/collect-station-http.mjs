#!/usr/bin/env node
// 从站点的公开 API **只读**导出一份 staging（与 tools/collect-station.mjs 同格式），
// 供 `tools/build-index.mjs` 生成 `mods/` 镜像。
//
//   node tools/collect-station-http.mjs --out _up/modrepo-stage [--site http://47.103.14.217:25570]
//
// 与 `collect-station.mjs` 的分工：
//   · `collect-station.mjs` 在**站点主机上**跑，直接读 `/var/lib/sp-modsite` 下的记录目录；
//   · 这个脚本在**任何地方**跑，只走站点自己的公开接口（`/api/mods` 取清单、`/api/file/<id>` 取 zip），
//     一个字节都不写回站点。
// 两者产出同一套 staging（`manifest.json` + `_selection.json` + `mods/<站点编号>/{mod.zip,meta.json,decision.json}`），
// 所以 `build-index.mjs` 不需要知道件是从哪条路径来的。
//
// 选择口径与 collect-station 逐条相同（业主 2026-10-12）：
//   ① `decision=approved` 且 `packKind=functional` —— 本站的 `/api/mods` 只列公开记录，
//      所以「能读到」就等于「已上线（approved）」；`packKind` 仍按记录里的值判。
//   ② 同一 `pack.json.id` 只能留一条：上传时间晚者 → 批准时间晚者 → 站点编号大者。
//   ③ 读不到 `pack.json` 的记录绝不静默丢件：带进 manifest（packId 为 null），由 build-index 的闸门退件并报出来。
//
// ⚠️ `decision.json` 与 `meta.json` 是我们**按 API 字段重建**的（站点不公开这两个文件的原文）：
//    字段名照 collect-station 读的那些（id / packKind / uploadedAt / size / sha256 / author / kind / compat*），
//    值一律来自 API，不编造；`decision.at` 取上传时间。
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const SITE = arg('--site', 'http://47.103.14.217:25570').replace(/\/+$/, '');
const STAGE = resolve(arg('--out', '_up/modrepo-stage'));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 从一个 zip 的字节里取出包根 pack.json（不依赖 unzip 命令）。 */
function packJsonOf(buf) {
  try {
    let off = 0;
    while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) { // local file header
      const method = buf.readUInt16LE(off + 8);
      const compSize = buf.readUInt32LE(off + 18);
      const nameLen = buf.readUInt16LE(off + 26);
      const extraLen = buf.readUInt16LE(off + 28);
      const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
      const dataOff = off + 30 + nameLen + extraLen;
      const raw = buf.slice(dataOff, dataOff + compSize);
      if (compSize > 0 && /(^|\/)pack\.json$/.test(name) && name.split('/').length <= 3) {
        const data = method === 0 ? raw : (() => { try { return inflateRawSync(raw); } catch { return inflateSync(raw); } })();
        return JSON.parse(data.toString('utf8'));
      }
      off = dataOff + compSize;
    }
    return null;
  } catch { return null; }
}

const get = async (url, asBuffer = false) => {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.text();
};

console.log(`  [station] ${SITE}`);
const list = JSON.parse(await get(`${SITE}/api/mods`));
// ⚠️ `/api/mods` 把公开记录分成两栏：`mods`（不含官方素材）与 `flagged`（含官方素材、需确认）。
// 两栏都是**已批准**的记录，缺了 `flagged` 就会漏掉所有带素材的包（2026-10-21 实测漏掉 dongShip
// 与 srv-notice）。口径与 `collect-station.mjs` 一致：approved + functional，不看它落在哪一栏。
const PUBLIC = [...(list.mods || []), ...(list.flagged || [])];
console.log(`  [station] 公开记录 mods ${(list.mods || []).length} + flagged ${(list.flagged || []).length} = ${PUBLIC.length}`);
const recs = PUBLIC.map((r) => ({
  api: r,
  meta: {
    id: r.id,
    name: r.name ?? null,
    packId: r.packId ?? null,
    packKind: r.packKind ?? null,
    kind: r.kind ?? null,
    uploadedAt: r.uploadedAt ?? null,
    size: r.size ?? null,
    sha256: r.sha256 ?? null,
    author: r.author ?? null,
    authorSource: r.authorSource ?? null,
    homepage: r.homepage ?? null,
    compatAuthor: r.compatAuthor ?? null,
    compatAuthorSource: r.compatAuthorSource ?? null,
    compatOf: r.compatOf ?? null,
    compatNote: r.compatNote ?? null,
    note: r.note ?? null,
    funcKind: r.funcKind ?? null,
  },
  dec: { decision: 'approved', at: r.uploadedAt ?? null, source: 'site /api/mods（公开记录即已上线）' },
}));
console.log(`  [station] 记录 ${recs.length} 条（functional ${recs.filter((r) => r.meta.packKind === 'functional').length}）`);

const elig = recs.filter((r) => r.meta.packKind === 'functional');
const sortKey = (r) => [r.meta.uploadedAt || '', r.dec.at || '', r.meta.id];
const chosen = new Map();
const excluded = [];

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'mods'), { recursive: true });

for (const r of [...elig].sort((a, b) => (sortKey(a).join('\u0000') < sortKey(b).join('\u0000') ? 1 : -1))) {
  const sid = r.meta.id;
  const url = `${SITE}/api/file/${sid}`;
  let buf;
  try { buf = await get(url, true); } catch (e) { console.log(`    ! ${sid}: ${e.message}`); continue; }
  const zid = packJsonOf(buf);
  const pid = zid && typeof zid.id === 'string' && zid.id.trim() ? zid.id.trim() : null;
  if (pid && chosen.has(pid)) {
    const keep = chosen.get(pid);
    excluded.push({
      id: sid, packId: pid, version: zid.version ?? null,
      uploadedAt: r.meta.uploadedAt ?? null, decisionAt: r.dec.at ?? null,
      reason: '同 pack id 只能一条（引擎不允许并存）',
      keptId: keep.meta.id, keptDecisionAt: keep.dec.at ?? null, keptUploadedAt: keep.meta.uploadedAt ?? null,
    });
    continue;
  }
  const dir = join(STAGE, 'mods', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'mod.zip'), buf);
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(r.meta, null, 2), 'utf8');
  writeFileSync(join(dir, 'decision.json'), JSON.stringify(r.dec, null, 2), 'utf8');
  chosen.set(pid || `__noid__${sid}`, { ...r, zid, buf });
  console.log(`    ✓ ${sid} · ${pid ?? '(无 pack.json)'} · ${(buf.length / 1048576).toFixed(2)} MB`);
}

const picked = [...chosen.values()].sort((a, b) => (a.meta.id < b.meta.id ? -1 : 1));
const manMods = picked.map((r) => ({
  id: r.meta.id,
  packId: r.zid?.id ?? null,
  name: r.zid?.name || r.meta.name || null,
  version: r.zid?.version ?? null,
  apiRange: r.zid?.api ?? null,
  gameVersion: r.zid?.game ?? r.zid?.gameVersion ?? null,
  sha256: sha256(r.buf),
  packHash: null,   // build-index 用引擎装载算出
  category: 'functional',
  recordKind: r.meta.kind || 'submission',
  author: r.meta.author || r.zid?.author || null,
  compatAuthor: r.meta.kind === 'compat' ? (r.meta.compatAuthor ?? null) : null,
  compatOf: r.meta.compatOf ?? null,
  source: r.meta.homepage ?? null,
  path: `mods/${r.meta.id}/mod.zip`,
  sizeBytes: r.buf.length,
  files: { entries: null, unpackedBytes: null },
  recordMetaFiles: ['meta.json', 'decision.json'],
}));

const manifest = {
  generatedAt: new Date().toISOString(),
  source: {
    site: SITE,
    api: '/api/mods + /api/file/<id>',
    dataDir: null,
    selection: 'state=approved 且 packKind=functional（公开记录即已上线）',
    collected: manMods.length,
    excludedSamePackId: excluded,
    note: '件由站点公开接口只读导出：只取 mod.zip 并**按 API 字段重建** meta.json / decision.json（站点不公开这两个文件的原文）；一个字节都不写回站点。',
    selectionArtifact: '_selection.json = 采集时刻的全部记录（含未入选的）；入选清单是本 manifest.mods。',
  },
  totals: { count: manMods.length, sizeBytes: manMods.reduce((a, m) => a + m.sizeBytes, 0) },
  mods: manMods,
};
writeFileSync(join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
writeFileSync(join(STAGE, '_selection.json'), JSON.stringify(recs.map((r) => ({
  id: r.meta.id, state: 'approved', packKind: r.meta.packKind ?? null, packId: r.meta.packId ?? null,
  name: r.meta.name ?? null, size: r.meta.size ?? null, kind: r.meta.kind ?? null,
})).sort((a, b) => (a.id < b.id ? -1 : 1)), null, 1), 'utf8');

console.log(`  [stage] ${STAGE}`);
console.log(`  [stage] 入选 ${manMods.length} 条 · ${(manifest.totals.sizeBytes / 1048576).toFixed(1)} MB · 同 id 剔除 ${excluded.length} 条`);
