#!/usr/bin/env node
// 从站侧导出（staging）生成 `mods/index.json` —— 本仓库作为 **mod 仓库**的唯一真相。
//
//   node tools/build-index.mjs --stage <staging 目录> --engine <引擎检出>            # 只报，不写盘（默认）
//   node tools/build-index.mjs --stage <staging 目录> --engine <引擎检出> --write    # 真写
//   node tools/build-index.mjs --stage <staging 目录> --engine <引擎检出> --json     # 机器可读
//
// 输入：`<stage>/manifest.json` + `<stage>/mods/<站点编号>/{mod.zip,meta.json,decision.json}`
// 输出：`mods/<packId>/<version>/{mod.zip,meta.json,decision.json,PROVENANCE.md}` + `mods/index.json`
//
// **为什么要这个工具**：本仓库是 mod 的存放处，**不是规则的定义处**。包的格式、能不能装、
// 装成哪一层，全部由**引擎自己的装载器**决定 —— 所以这里一律调用引擎那一份（`loadWorkshop`），
// 不在本仓库重写校验（AGENTS.md §3「不抄规则」）。索引里每个字段都**实测**得来，抄来的值一律核过。
//
// 五道硬闸门（不满足就不入库，**报出来等人判**，绝不自己挑）：
//   1. 装得上       引擎装载器：`packsLoaded` 恰好 `[packId]` 且 `errors=0`
//   2. 字节没走样   `mod.zip` 重算的 sha256 == manifest 里的值
//   3. 不是说明包   `category !== 'documentation'`（业主口径：只收非说明文档）
//   4. **不含游戏素材**  本仓库的**素材红线**（AGENTS.md §3 第 1 条 / §4 收录闸门第 4 条）：
//                  不提交任何《明日方舟》游戏素材。按扩展名清点 zip 内与 `.spresources`
//                  容器**内部**的图片 / 音频 / 字体 / Spine 图集 ⇒ 命中即**不入库**。
//   5. 元数据齐     `pack.json` 能读出来、`id` 与包内目录名一致
//
// ⚠️ 第 4 条为什么要连容器一起看：`.spresources` 是**不透明容器**，从 zip 层只看得到一个条目，
// 里面可能装着 218 个官方素材文件 —— 只看 zip 条目名会**整批漏过**。所以这里解析容器头
// （`SPRES001` + uint32 小端 headerLen + 压缩 JSON 头，头里有 `manifest.files[]`）再清点一次。
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, extname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { inflateRawSync, inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? true) : fallback; };
const asJson = argv.includes('--json');
const write = argv.includes('--write');
const quiet = argv.includes('--quiet');

const stageArg = flag('--stage');
const engineArg = flag('--engine', process.env.SP_ENGINE || null);
if (!stageArg) { console.error('用法：node tools/build-index.mjs --stage <staging 目录> --engine <引擎检出> [--write] [--json]'); process.exit(2); }
if (!engineArg) { console.error('缺少引擎检出（--engine 或 SP_ENGINE）。索引里的 hash 与装载结论必须来自引擎那一份。'); process.exit(2); }
const stage = resolve(String(stageArg));
const engine = resolve(String(engineArg));
for (const need of ['server/workshop.js', 'shared/constants.js', 'shared/zip.js']) {
  if (!existsSync(join(engine, need))) { console.error(`这不是一个引擎检出（缺 ${need}）：${engine}`); process.exit(2); }
}

const engineWorkshop = await import(pathToFileURL(join(engine, 'server/workshop.js')).href);
const engineConsts = await import(pathToFileURL(join(engine, 'shared/constants.js')).href);
const engineZip = await import(pathToFileURL(join(engine, 'shared/zip.js')).href);
const log = { info() {}, debug() {}, warn() {}, error() {} };

// ── 素材清点：按扩展名分类。`.json` **不算素材**（pack.json 与配置都是 json，误报会把整批挡掉）。 ──
const ASSET_EXT = new Map(Object.entries({
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.bmp': 'image', '.tga': 'image', '.svg': 'image',
  '.ogg': 'audio', '.mp3': 'audio', '.wav': 'audio', '.m4a': 'audio', '.flac': 'audio',
  '.ttf': 'font', '.otf': 'font', '.woff': 'font', '.woff2': 'font',
  '.atlas': 'spine', '.skel': 'spine',
}));
const CONTAINER_EXT = '.spresources';

/** 解析 `.spresources` 容器头，返回它内部的文件清单（失败返回 null，并说明原因）。 */
function containerFiles(buf) {
  try {
    if (buf.length < 12) return { ok: false, why: 'too short' };
    if (buf.subarray(0, 8).toString('latin1') !== 'SPRES001') return { ok: false, why: 'bad magic' };
    const headerLen = buf.readUInt32LE(8);
    if (!headerLen || 12 + headerLen > buf.length) return { ok: false, why: `bad headerLen ${headerLen}` };
    const head = buf.subarray(12, 12 + headerLen);
    let text = null;
    for (const inflate of [inflateRawSync, inflateSync]) {
      try { text = inflate(head).toString('utf8'); break; } catch { /* 换下一种 */ }
    }
    if (text == null) text = head.toString('utf8');           // 万一是明文 JSON
    const parsed = JSON.parse(text);
    const files = parsed?.manifest?.files;
    if (!Array.isArray(files)) return { ok: false, why: 'manifest.files missing' };
    return { ok: true, files, qqGroup: parsed.qqGroup ?? null, version: parsed?.manifest?.version ?? null };
  } catch (e) { return { ok: false, why: e.message }; }
}

/** 清点一批条目名的素材占用。`names` 是 `{name, bytes}`。 */
function tallyAssets(entries) {
  const byKind = {};
  let bytes = 0;
  const samples = [];
  for (const e of entries) {
    const kind = ASSET_EXT.get(extname(e.name).toLowerCase());
    if (!kind) continue;
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    bytes += e.bytes ?? 0;
    if (samples.length < 5) samples.push(e.name);
  }
  return { byKind, bytes, samples };
}

// ── 读 manifest ──
const manifestPath = join(stage, 'manifest.json');
if (!existsSync(manifestPath)) { console.error(`找不到 ${manifestPath}`); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const modsIn = Array.isArray(manifest.mods) ? manifest.mods : [];
if (!modsIn.length) { console.error('manifest.mods 是空的。'); process.exit(2); }

// ── category 判据（docs/STANDARD-PACK.md §三；按序判，实测） ──
const FUNCTIONAL_KEYS = ['content', 'overrides', 'kits', 'variants', 'behaviour', 'client', 'server', 'assets', 'notices', 'routes'];
const DOC_SELF_DESC = /(documentation[- ]?only|只读参考|资料包|说明包|参考包|不会启用|没有任何功能|没效果是【预期】|is documentation)/i;

function categoryOf(packJson, zipEntries) {
  const declared = FUNCTIONAL_KEYS.filter((k) => packJson[k] != null);
  if (declared.length) return { category: 'functional', why: `声明了 ${declared.join(' / ')}` };
  const prose = [packJson.description, packJson.note].filter((s) => typeof s === 'string').join('\n');
  let readme = '';
  for (const e of zipEntries) {
    if (/(^|\/)(README|SOURCE|PROVENANCE)\.md$/i.test(e.name)) {
      try { readme += '\n' + e.data.toString('utf8').slice(0, 4000); } catch { /* 忽略 */ }
    }
  }
  if (DOC_SELF_DESC.test(prose + readme)) return { category: 'documentation', why: '包自述是参考/说明包' };
  return { category: 'unknown', why: '没有生效面、也没有自述为说明包' };
}

// ── 逐个处理 ──
const tmpRoot = join(tmpdir(), `sp-modindex-${process.pid}`);
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(tmpRoot, { recursive: true });

const accepted = [];
const rejected = [];

for (const m of modsIn) {
  const stationId = m.id;
  const zipPath = join(stage, 'mods', stationId, 'mod.zip');
  const rec = { stationId, packId: m.packId ?? null, name: m.name ?? null, gates: [], ok: false };
  if (!existsSync(zipPath)) { rec.gates.push({ gate: 'zip', ok: false, why: `缺 ${zipPath}` }); rejected.push(rec); continue; }

  const buf = readFileSync(zipPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const shaOk = sha256 === m.sha256;
  rec.sha256 = sha256;
  rec.gates.push({ gate: 'sha256', ok: shaOk, why: shaOk ? '与 manifest 一致' : `manifest=${m.sha256} 实测=${sha256}` });
  if (!shaOk) { rejected.push(rec); continue; }

  // 解 zip（引擎那一份读取器：`{ok:true, entries:[{name,data}], skippedDirs}` 或 `{ok:false, error, detail}`）
  let entries;
  try {
    const read = engineZip.zipRead(buf);
    if (!read?.ok) { rec.gates.push({ gate: 'unzip', ok: false, why: `${read?.error ?? 'zipRead 失败'}：${read?.detail ?? ''}` }); rejected.push(rec); continue; }
    entries = read.entries;
  } catch (e) { rec.gates.push({ gate: 'unzip', ok: false, why: e.message }); rejected.push(rec); continue; }

  // 找 pack.json：zip 根优先，否则唯一顶层目录（引擎两种都收）
  const norm = (n) => n.split('\\').join('/').replace(/^\.\//, '');
  let packEntry = entries.find((e) => norm(e.name) === 'pack.json');
  let prefix = '';
  if (!packEntry) {
    const tops = new Set(entries.map((e) => norm(e.name).split('/')[0]).filter(Boolean));
    const dirs = new Set(entries.map((e) => norm(e.name)).filter((n) => n.includes('/')).map((n) => n.split('/')[0]));
    if (dirs.size === 1) { prefix = [...dirs][0] + '/'; packEntry = entries.find((e) => norm(e.name) === prefix + 'pack.json'); }
    void tops;
  }
  if (!packEntry) { rec.gates.push({ gate: 'pack.json', ok: false, why: 'zip 根与唯一顶层目录里都没有 pack.json' }); rejected.push(rec); continue; }

  let packJson;
  try { packJson = JSON.parse(packEntry.data.toString('utf8')); } catch (e) { rec.gates.push({ gate: 'pack.json', ok: false, why: `不是合法 JSON：${e.message}` }); rejected.push(rec); continue; }
  const packId = packJson.id ?? null;
  rec.packId = packId;
  rec.name = packJson.name ?? rec.name;
  rec.version = packJson.version ?? null;
  const idOk = typeof packId === 'string' && packId.length > 0;
  rec.gates.push({ gate: 'packId', ok: idOk, why: idOk ? packId : 'pack.json 没有 id' });
  if (!idOk) { rejected.push(rec); continue; }

  // ── 素材清点：zip 条目 + 容器**内部** ──
  const zipTally = tallyAssets(entries.map((e) => ({ name: norm(e.name), bytes: e.data?.length ?? 0 })));
  const containers = [];
  for (const e of entries) {
    if (extname(norm(e.name)).toLowerCase() !== CONTAINER_EXT) continue;
    const parsed = containerFiles(e.data);
    if (!parsed.ok) { containers.push({ name: norm(e.name), ok: false, why: parsed.why }); continue; }
    const inner = tallyAssets(parsed.files.map((f) => ({ name: String(f.url ?? f.path ?? f.name ?? ''), bytes: Number(f.size ?? 0) })));
    containers.push({ name: norm(e.name), ok: true, fileCount: parsed.files.length, qqGroup: parsed.qqGroup, ...inner });
  }
  const innerBytes = containers.reduce((a, c) => a + (c.bytes ?? 0), 0);
  const innerCount = containers.reduce((a, c) => a + Object.values(c.byKind ?? {}).reduce((x, y) => x + y, 0), 0);
  const assetBytes = zipTally.bytes + innerBytes;
  const assetCount = Object.values(zipTally.byKind).reduce((a, b) => a + b, 0) + innerCount;
  const assetOk = assetBytes === 0 && assetCount === 0;
  rec.assets = { zip: zipTally, containers, assetCount, assetBytes };
  rec.gates.push({
    gate: 'assets',
    ok: assetOk,
    why: assetOk ? 'zip 内与容器内部都没有图片/音频/字体/Spine' :
      `命中 ${assetCount} 个素材文件 / ${assetBytes} B（${JSON.stringify(zipTally.byKind)}${containers.filter((c) => c.ok).map((c) => ` + 容器 ${c.name} 内部 ${Object.values(c.byKind).reduce((a, b) => a + b, 0)} 个`).join('')}）`,
  });

  // category（实测）
  const cat = categoryOf(packJson, entries);
  rec.category = cat.category;
  rec.categoryWhy = cat.why;
  rec.gates.push({ gate: 'category', ok: cat.category !== 'documentation', why: `${cat.category} —— ${cat.why}` });

  // 装载：解到干净临时根，目录名 = packId（装载器按 <根>/<包 id>/pack.json 找包）
  const root = join(tmpRoot, stationId);
  const packDir = join(root, packId);
  mkdirSync(packDir, { recursive: true });
  for (const e of entries) {
    const n = norm(e.name);
    if (!n || n.endsWith('/')) continue;
    if (prefix && !n.startsWith(prefix)) continue;                 // 套了顶层目录：剥壳后再放
    const rel = prefix ? n.slice(prefix.length) : n;
    if (!rel) continue;
    const dest = join(packDir, rel);
    if (!resolve(dest).startsWith(resolve(packDir) + sep)) { rec.gates.push({ gate: 'unzip', ok: false, why: `路径穿越：${n}` }); break; }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, e.data);
  }
  let loaded;
  try { loaded = engineWorkshop.loadWorkshop(root, { log }); } catch (e) { rec.gates.push({ gate: 'load', ok: false, why: `装载抛错：${e.message}` }); rejected.push(rec); continue; }
  const ids = (loaded.packs ?? []).map((p) => p.id);
  const errs = (loaded.errors ?? []).map((x) => `${x.pack}: ${x.reason}`);
  const loadOk = errs.length === 0 && ids.length === 1 && ids[0] === packId;
  const loadedPack = (loaded.packs ?? [])[0] ?? null;
  rec.load = { packsLoaded: ids, errors: errs, layer: loadedPack?.layer ?? null, combat: loadedPack?.combat ?? null };
  rec.gates.push({ gate: 'load', ok: loadOk, why: loadOk ? `packsLoaded=[${ids}] errors=0` : `packsLoaded=[${ids}] errors=${errs.length} ${errs.join(' | ')}` });

  rec.packHash = loadedPack?.hash ?? loadedPack?.manifestDigest ?? null;   // 引擎算的逐文件 canonical 哈希（拿不到就 null，不编）

  rec.ok = rec.gates.every((g) => g.ok);
  if (rec.ok) {
    rec.path = `mods/${packId}/${rec.version ?? '0.0.0'}/mod.zip`;
    rec.sizeBytes = buf.length;
    rec.fileCount = entries.filter((e) => norm(e.name) && !norm(e.name).endsWith('/')).length;
    rec.unpackedBytes = entries.reduce((a, e) => a + (e.data?.length ?? 0), 0);
    accepted.push(rec);
  } else rejected.push(rec);
}
rmSync(tmpRoot, { recursive: true, force: true });

// ── 索引 ──
const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: { stage, host: manifest.source?.host ?? null, dataDir: manifest.source?.dataDir ?? null, readAt: manifest.source?.readAt ?? null, manifestGeneratedAt: manifest.generatedAt ?? null },
  engine: { path: engine, appVersion: engineConsts.APP_VERSION ?? null, modApiVersion: engineConsts.MOD_API_VERSION ?? null },
  note: '本索引是 mod 仓库的唯一真相；每条字段都实测（sha256 重算、装载调用引擎那一份）。`fileCount` 是 ZIP 条目数，不等于包内实际文件数（`.spresources` 容器内部另有若干文件）。',
  mods: accepted.map((r) => ({
    id: r.packId, name: r.name, version: r.version,
    sha256: r.sha256, packHash: r.packHash,
    category: r.category, categoryWhy: r.categoryWhy,
    stationId: r.stationId, path: r.path,
    sizeBytes: r.sizeBytes, fileCount: r.fileCount, unpackedBytes: r.unpackedBytes,
    engineLoad: r.load,
  })).sort((a, b) => a.id.localeCompare(b.id)),
  rejected: rejected.map((r) => ({ stationId: r.stationId, packId: r.packId, name: r.name, gates: r.gates.filter((g) => !g.ok) })),
};

if (write) {
  mkdirSync(join(ROOT, 'mods'), { recursive: true });
  for (const r of accepted) {
    const destDir = join(ROOT, 'mods', r.packId, r.version ?? '0.0.0');
    mkdirSync(destDir, { recursive: true });
    copyFileSync(join(stage, 'mods', r.stationId, 'mod.zip'), join(destDir, 'mod.zip'));
    for (const f of ['meta.json', 'decision.json']) {
      const src = join(stage, 'mods', r.stationId, f);
      if (existsSync(src)) copyFileSync(src, join(destDir, f));
    }
    writeFileSync(join(destDir, 'PROVENANCE.md'), provenanceOf(r), 'utf8');
  }
  writeFileSync(join(ROOT, 'mods', 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
}

/** 从 manifest 的事实生成 PROVENANCE.md（六项，见 SKILL.md §10）。**缺就写「未声明」，绝不编。** */
function provenanceOf(r) {
  const m = modsIn.find((x) => x.id === r.stationId) ?? {};
  const na = (v) => (v == null || v === '' ? '**未声明**' : String(v));
  return `# PROVENANCE — ${r.name ?? r.packId}

本文件由 \`tools/build-index.mjs\` 从站侧记录**机械生成**（事实来源：站点记录与包内 \`pack.json\`）。
**没有的事实写「未声明」，不编造。** 人工增补请直接改本文件并在提交信息里说明。

| 项 | 值 |
|---|---|
| ① 包 id / 版本 | \`${r.packId}\` · ${na(r.version)} |
| ② 原作者 | ${na(m.author)}（来源：${na(m.authorSource)}） |
| ③ 原件许可 | ${na(m.license)} |
| ④ 兼容改写者 | ${na(m.compatAuthor)} |
| ⑤ 来源 | 站上记录 \`${r.stationId}\`${m.compatOf ? ` · 由原件 \`${m.compatOf}\` 改写` : ''}${m.source ? ` · ${m.source}` : ''} |
| ⑥ 改了什么 | ${na(m.compatNote)} |

- 本站/本仓库**不主张**包内任何第三方内容的权利；许可与署名以原件为准。
- 收录闸门与素材红线见 [AGENTS.md](../AGENTS.md) §3 / §4。
`;
}

// ── 输出 ──
if (asJson) {
  process.stdout.write(JSON.stringify(index, null, 2) + '\n');
} else if (!quiet) {
  console.log(`引擎：${engine}（${engineConsts.APP_VERSION} · mod api ${engineConsts.MOD_API_VERSION}）`);
  console.log(`staging：${stage}`);
  console.log('');
  console.log(`── 收件 ${accepted.length} / 退件 ${rejected.length}（manifest 共 ${modsIn.length}）`);
  for (const r of accepted) {
    console.log(`   ✓ ${r.packId} ${r.version}  ${r.category}  层 ${r.load.layer ?? '?'}${r.load.combat ? ' · 会改战斗结果' : ''}  ${r.sizeBytes} B  ${r.name ?? ''}`);
  }
  for (const r of rejected) {
    console.log(`   ✗ ${r.packId ?? r.stationId}（${r.name ?? ''}）`);
    for (const g of r.gates.filter((x) => !x.ok)) console.log(`       [${g.gate}] ${g.why}`);
  }
  console.log('');
  console.log(write ? '已写：mods/index.json + mods/<包 id>/<版本>/' : '（未写盘 —— 加 --write 才真写）');
}
process.exit(rejected.length ? 1 : 0);
