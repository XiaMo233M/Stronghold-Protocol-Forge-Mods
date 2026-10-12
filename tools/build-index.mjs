#!/usr/bin/env node
// 从站侧导出（staging）生成 `mods/index.json` —— 本仓库作为 **mod 仓库**的唯一真相。
//
//   node tools/build-index.mjs --stage <staging 目录> --engine <引擎检出>            # 只报，不写盘（默认）
//   node tools/build-index.mjs --stage <staging 目录> --engine <引擎检出> --write    # 真写
//   node tools/build-index.mjs --stage <staging 目录> --engine <引擎检出> --json     # 机器可读
//   node tools/build-index.mjs --stage <…> --engine <…> --write --prune-stale        # 真写 + 清旧版本目录
//   node tools/build-index.mjs --stage <…> --engine <…> --assert-only               # 只核 live 一条没掉
//
// `--mods-root <目录>`：把写盘目标从 `<仓库>/mods` 换成别处（校验 / 演练用），默认仍是 `<仓库>/mods`。
//
// **旧版本目录清理（带守卫，`--prune-stale` 开启）**
//   背景：`mods/<packId>/<version>/` 按导出清单收件 ⇒ 同 id 换了新版本后，旧版本目录**不会自己消失**，
//   每次都要人工确认（2026-10-12 就手删过一次 `mods/duel-mode/0.1.0/`）。
//   规则（只删**站上对应记录已不 live**的旧版本目录）：
//     ① 候选 = `mods/<packId>/<version>/` 中**不在本次入选集**里的目录；
//     ② 候选目录的 `meta.json.id` 在 `_selection.json` 里的站点状态必须是 `superseded` / `rejected`
//        / `pending`（即**已不在接受集**）；状态**核不到**的**一律不删**，只报出来；
//     ③ 删之前**先打印将要删的清单**（路径 + 站上状态 + 依据），机器可读那一份进 `index.json` 的 `prune` 段；
//     ④ 删完**脚本断言**：应 live 的每条 `<packId>/<version>/mod.zip` **一个没少**，否则非 0 退出（3）。
//   四道入库闸门不受影响（本段在闸门之后，只动**没入选**的目录）。
//
// 输入：`<stage>/manifest.json` + `<stage>/mods/<站点编号>/{mod.zip,meta.json,decision.json}`
// 输出：`mods/<packId>/<version>/{mod.zip,meta.json,decision.json,PROVENANCE.md}` + `mods/index.json`
//
// **为什么要这个工具**：本仓库是 mod 的存放处，**不是规则的定义处**。包的格式、能不能装、
// 装成哪一层，全部由**引擎自己的装载器**决定 —— 所以这里一律调用引擎那一份（`loadWorkshop`），
// 不在本仓库重写校验（AGENTS.md §3「不抄规则」）。索引里每个字段都**实测**得来，抄来的值一律核过。
//
// 四道硬闸门（不满足就不入库，**报出来等人判**，绝不自己挑）：
//   1. 装得上       引擎装载器：`packsLoaded` 恰好 `[packId]` 且 `errors=0`
//   2. 字节没走样   `mod.zip` 重算的 sha256 == manifest 里的值
//   3. 不是说明包   `category !== 'documentation'`（业主口径：只收非说明文档）
//   4. 元数据齐     `pack.json` 能读出来、`id` 与包内目录名一致
//
// **素材不再拦，改为如实标注**（业主 2026-10-12：「以后不用打回所有有敏感素材的 mod，
// 如实上传并做到标注好含官方素材就行」）⇒ 工具按扩展名清点 zip 内**与 `.spresources`
// 容器内部**的图片 / 音频 / 字体 / Spine，把结果写进 `index.json` 与 `PROVENANCE.md`，
// 由下载者与审核者自己看见。挡不挡是业主的事，工具只负责**说出来**。
//
// ⚠️ 为什么要连容器一起看：`.spresources` 是**不透明容器**，从 zip 层只看得到一个条目，
// 里面可能装着 218 个素材文件 —— 只看 zip 条目名会**整批漏过**。所以这里解析容器头
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
const pruneStale = argv.includes('--prune-stale');   // 旧版本目录清理（带守卫）；不开则只报，不删
// 写盘目标：默认 `<仓库>/mods`；`--mods-root` 只换目标目录，不改任何判断规则（校验 / 演练用）。
const modsRoot = resolve(String(flag('--mods-root', join(ROOT, 'mods'))));

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

// ── 旧版本目录清理：候选与判据（守卫；详见文件头）────────────────────────────────
// 判据全部来自**站侧导出的事实**，一处不外推：
//   · 本次入选集  = `mods/<packId>/<version>/`（闸门过完的 accepted，索引的唯一真相）
//   · 站侧状态    = `_selection.json`（**采集时刻的全部记录**，含 superseded / rejected / pending），
//                   按候选目录 `meta.json` 里的 `id` 关联到它那一刻在站上的状态
/** 读 `_selection.json`：是否可用、以及按站点编号索引的记录。 */
function readSelection() {
  const p = join(stage, '_selection.json');
  if (!existsSync(p)) return { ok: false, why: `缺 ${p}（没有它就无法确认候选目录在站上的状态）`, byId: new Map() };
  try {
    const arr = JSON.parse(readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) return { ok: false, why: `_selection.json 不是数组：${p}`, byId: new Map() };
    return { ok: true, why: `读自 ${p}（${arr.length} 条记录）`, byId: new Map(arr.map((r) => [r.id, r])) };
  } catch (e) { return { ok: false, why: `_selection.json 读不动：${e.message}`, byId: new Map() }; }
}
const selection = readSelection();
const STALE_STATES = new Set(['superseded', 'rejected', 'pending']);

/**
 * 候选 = `mods/<packId>/<version>/` 里**没进本次入选集**的目录。
 * 每条给出 keep / prune / hold 与**依据**（站上状态、哪条记录、为什么）。
 */
function collectPruneCandidates(acceptedList) {
  const live = new Set(acceptedList.map((r) => `${r.packId}\u0000${r.version ?? '0.0.0'}`));
  const out = [];
  if (!existsSync(modsRoot)) return out;
  for (const packEnt of readdirSync(modsRoot)) {
    const packDir = join(modsRoot, packEnt);
    try { if (!statSync(packDir).isDirectory()) continue; } catch { continue; }
    for (const verEnt of readdirSync(packDir)) {
      const verDir = join(packDir, verEnt);
      try { if (!statSync(verDir).isDirectory()) continue; } catch { continue; }
      const rel = `mods/${packEnt}/${verEnt}`;
      if (live.has(`${packEnt}\u0000${verEnt}`)) { out.push({ rel, verDir, verdict: 'keep' }); continue; }
      const rec = (() => { try { return JSON.parse(readFileSync(join(verDir, 'meta.json'), 'utf8')); } catch { return null; } })();
      const sid = rec?.id ?? null;
      if (!selection.ok) { out.push({ rel, verDir, verdict: 'hold', sid, basis: selection.why }); continue; }
      if (!sid) { out.push({ rel, verDir, verdict: 'hold', sid: null, basis: '目录里没有可读的 meta.json.id ⇒ 认不出它对应站上哪条记录，不删' }); continue; }
      const sel = selection.byId.get(sid);
      if (!sel) { out.push({ rel, verDir, verdict: 'hold', sid, basis: `站侧采集清单（_selection.json）里**没有** ${sid} 这条 ⇒ 状态核不到，不删` }); continue; }
      if (!STALE_STATES.has(sel.state)) { out.push({ rel, verDir, verdict: 'hold', sid, state: sel.state, basis: `站侧 ${sid} 状态是 ${sel.state} ⇒ 既不在入选集、也不在已不接受集，交人判，不删` }); continue; }
      out.push({
        rel, verDir, verdict: 'prune', sid, state: sel.state,
        basis: `站侧记录 ${sid} 状态 ${sel.state}（已不在接受集），且本次入选集里没有 ${packEnt}/${verEnt}`,
      });
    }
  }
  return out;
}

/** 那条**脚本断言**要核的清单：优先读**已写出的 `index.json`**（唯一真相）。
 *  ⚠️ 为什么按索引核、不按内存里的 accepted 核：`--write` 会把入选集**重新拷**进 `mods/`，
 *  所以「少了一条 live」只有拿索引去对才看得见 —— 拿内存核等于没核。 */
function expectedLive(acceptedList) {
  const idxPath = join(modsRoot, 'index.json');
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      if (Array.isArray(idx.mods) && idx.mods.length) {
        return { list: idx.mods.map((m) => ({ packId: m.id, version: m.version })), from: 'index.json（已写出的索引）', fromIndex: true };
      }
    } catch { /* 落到 accepted */ }
  }
  return { list: acceptedList.map((r) => ({ packId: r.packId, version: r.version })), from: '本次入选集（内存，索引不可读）', fromIndex: false };
}
function assertLiveIntact(acceptedList) {
  const { list, from, fromIndex } = expectedLive(acceptedList);
  const missing = list.filter((x) => !existsSync(join(modsRoot, x.packId, x.version ?? '0.0.0', 'mod.zip')));
  return { checked: list.length, from, fromIndex, missing: missing.map((x) => `${x.packId}/${x.version ?? '0.0.0'}`) };
}

// ── `--assert-only`：只做那条断言，不装载、不写盘、不删 ─────────────────────────
// 清理之后单独复核用：核对「应 live 的每条 `<包 id>/<版本>/mod.zip` 都还在」。
if (argv.includes('--assert-only')) {
  const chk = assertLiveIntact([]);
  console.log(`── 断言（--assert-only，只读，不动盘）：判据 = ${chk.from}`);
  console.log(`   目标：${modsRoot}`);
  if (!chk.fromIndex) {
    console.log(`   ❌ 核不到：${modsRoot} 下没有可读的 index.json ⇒ 没有「应 live 的清单」可比，不假装通过`);
    process.exit(3);
  }
  console.log(chk.missing.length
    ? `   ❌ 少了 ${chk.missing.length} 条：${chk.missing.join(' · ')}`
    : `   ✅ 应 live 的 ${chk.checked} 条一条没掉`);
  process.exit(chk.missing.length ? 3 : 0);
}

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
  const rec = { stationId, packId: m.packId ?? null, name: m.name ?? null, gates: [], notes: [], ok: false };
  if (!existsSync(zipPath)) { rec.gates.push({ gate: 'zip', ok: false, why: `缺 ${zipPath}` }); rejected.push(rec); continue; }

  const buf = readFileSync(zipPath);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const shaOk = sha256 === m.sha256;
  rec.sha256 = sha256;
  rec.gates.push({ gate: 'sha256', ok: shaOk, why: shaOk ? '与 manifest 一致' : `manifest=${m.sha256} 实测=${sha256}` });
  if (!shaOk) { rejected.push(rec); continue; }

  // 解 zip（引擎那一份读取器）。
  // ⚠️ 这里**放宽读取上限**（引擎默认 `ZIP_MAX_FILE_BYTES = 32 MB`）：那是引擎给**运行时导入**设的
  // zip 炸弹防线，而本工具读的是**站上已经过审**的那一份，且只读不执行。放宽的后果要如实记下来 ——
  // 单条目超过引擎默认上限的包，**引擎自带的包导入路径会拒收它**（编辑器「包管理」/
  // `tools/workshop-pack.mjs import`），而站点侧读取器没有这个上限 ⇒ 两条路结论不同。这一条进 `notes`。
  const READ_LIMITS = { maxEntries: 8192, maxTotalBytes: 512 * 1024 * 1024, maxFileBytes: 256 * 1024 * 1024 };
  let entries;
  try {
    const read = engineZip.zipRead(buf, READ_LIMITS);
    if (!read?.ok) { rec.gates.push({ gate: 'unzip', ok: false, why: `${read?.error ?? 'zipRead 失败'}：${read?.detail ?? ''}` }); rejected.push(rec); continue; }
    entries = read.entries;
  } catch (e) { rec.gates.push({ gate: 'unzip', ok: false, why: e.message }); rejected.push(rec); continue; }
  const overEngineCap = entries.filter((e) => (e.data?.length ?? 0) > 32 * 1024 * 1024).map((e) => `${String(e.name).split('\\').join('/')} ${e.data.length} B`);
  if (overEngineCap.length) rec.notes.push(`单条目超过引擎默认 zip 读取上限（32 MB）⇒ **引擎自带的包导入路径会拒收**（站点侧读取器无此上限，两条路结论不同）：${overEngineCap.join(' · ')}`);

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
  // ── 素材清点：**不再拦，改为如实标注**（业主 2026-10-12 口径：「以后不用打回所有有敏感素材的
  //    mod，如实上传并做到标注好含官方素材就行」）。清点结果进索引与 PROVENANCE.md，
  //    由下载者与审核者自己看见 —— 挡不挡是业主的事，工具只负责**说出来**。
  const assetFree = assetBytes === 0 && assetCount === 0;
  rec.assets = { assetFree, zip: zipTally, containers, assetCount, assetBytes };
  rec.notes.push(assetFree
    ? '素材清点：zip 内与容器内部都没有图片 / 音频 / 字体 / Spine。'
    : `⚠️ **含素材**：${assetCount} 个文件 / ${assetBytes} B（${JSON.stringify(zipTally.byKind)}${containers.filter((c) => c.ok).map((c) => `；容器 ${c.name} 内部 ${Object.values(c.byKind).reduce((a, b) => a + b, 0)} 个`).join('')}）⇒ 须在页面上标注来源与授权。`);

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

// ── 旧版本目录清理（带守卫）────────────────────────────────────────────────────
// ⚠️ 这段在四道闸门**之后**、**写 `index.json` 之前**跑：只可能动**没入选**的目录，且结论要落进索引。
// 顺序是硬要求：选候选 → 打印将要删的清单 → 删 → （写盘后）脚本断言应 live 的一条没掉。
const pruneWork = collectPruneCandidates(accepted);            // 候选（含 keep / prune / hold 与依据）
const pruneList = pruneWork.filter((x) => x.verdict === 'prune');
const heldList = pruneWork.filter((x) => x.verdict === 'hold');
const liveCount = pruneWork.filter((x) => x.verdict === 'keep').length;
const pruneDeleted = [];
if (pruneStale && write) {
  for (const c of pruneList) { rmSync(c.verDir, { recursive: true, force: true }); pruneDeleted.push(c.rel); }
  pruneDeleted.sort();
}

// ── 索引 ──
const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: {
    stage, host: manifest.source?.host ?? null, dataDir: manifest.source?.dataDir ?? null,
    readAt: manifest.source?.readAt ?? null, manifestGeneratedAt: manifest.generatedAt ?? null,
    // 采集侧给的选择口径与**同 pack id 去重**决定：原样带进索引，免得那条决定只活在
    // staging 里、仓库读者看不到（为什么两条公开件只镜像一条）。
    selection: manifest.source?.selection ?? null,
    excludedSamePackId: manifest.source?.excludedSamePackId ?? [],
  },
  engine: { path: engine, appVersion: engineConsts.APP_VERSION ?? null, modApiVersion: engineConsts.MOD_API_VERSION ?? null },
  note: '本索引是 mod 仓库的唯一真相；每条字段都实测（sha256 重算、装载调用引擎那一份）。`fileCount` 是 ZIP 条目数，不等于包内实际文件数（`.spresources` 容器内部另有若干文件）。',
  mods: accepted.map((r) => ({
    id: r.packId, name: r.name, version: r.version,
    sha256: r.sha256, packHash: r.packHash,
    category: r.category, categoryWhy: r.categoryWhy,
    stationId: r.stationId, path: r.path,
    sizeBytes: r.sizeBytes, fileCount: r.fileCount, unpackedBytes: r.unpackedBytes,
    assets: {
      assetFree: r.assets.assetFree,
      count: r.assets.assetCount,
      bytes: r.assets.assetBytes,
      byKind: r.assets.zip.byKind,
      containers: r.assets.containers.map((c) => ({ name: c.name, ok: c.ok, fileCount: c.fileCount ?? null, byKind: c.byKind ?? null })),
    },
    notes: r.notes,
    engineLoad: r.load,
  })).sort((a, b) => a.id.localeCompare(b.id)),
  rejected: rejected.map((r) => ({ stationId: r.stationId, packId: r.packId, name: r.name, gates: r.gates.filter((g) => !g.ok), notes: r.notes })),
  // 旧版本目录清理的结论（机器可读那一份）：要删什么、依据是什么、删了什么、拒不删什么。
  prune: {
    enabled: pruneStale && write,
    candidates: pruneWork.length,
    live: liveCount,
    wouldDelete: pruneList.map((c) => ({ path: `${c.rel}/`, stationId: c.sid, stationState: c.state, basis: c.basis })),
    deleted: pruneDeleted,
    held: heldList.map((c) => ({ path: `${c.rel}/`, stationId: c.sid ?? null, basis: c.basis })),
  },
};

if (write) {
  mkdirSync(modsRoot, { recursive: true });
  for (const r of accepted) {
    const destDir = join(modsRoot, r.packId, r.version ?? '0.0.0');
    mkdirSync(destDir, { recursive: true });
    copyFileSync(join(stage, 'mods', r.stationId, 'mod.zip'), join(destDir, 'mod.zip'));
    for (const f of ['meta.json', 'decision.json']) {
      const src = join(stage, 'mods', r.stationId, f);
      if (existsSync(src)) copyFileSync(src, join(destDir, f));
    }
    writeFileSync(join(destDir, 'PROVENANCE.md'), provenanceOf(r), 'utf8');
  }
  writeFileSync(join(modsRoot, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
}

// ── 删完的**脚本断言**（不是人工核对）──────────────────────────────────────────
const liveCheck = assertLiveIntact(accepted);
const liveMissing = liveCheck.missing;

/** 清理段与断言的人读报告（机器可读那一份在 `index.prune`）。 */
function pruneReport() {
  const L = [];
  L.push(`── 旧版本目录清理（守卫）：候选 ${pruneWork.length} = 保留 ${liveCount}（= 入选集） + 待删 ${pruneList.length} + 拒不删 ${heldList.length}`);
  L.push(`   判据：本次入选集 = mods/<包 id>/<版本>/（索引的真相）；站上状态 ${selection.why}`);
  if (pruneList.length) {
    L.push(`   将要删（${pruneList.length} 条）—— 站上对应记录**已不在接受集**，且本次入选集里没有它：`);
    for (const c of pruneList) L.push(`     [删] ${c.rel}/  站上 ${c.sid} = ${c.state}  依据：${c.basis}`);
  } else {
    L.push('   将要删：**0 条**（没有「站上已不接受、本地还在」的旧版本目录）');
  }
  if (heldList.length) {
    L.push(`   拒不删（${heldList.length} 条，状态核不到 ⇒ 一律不删，报人判）：`);
    for (const c of heldList) L.push(`     [留] ${c.rel}/  依据：${c.basis}`);
  }
  L.push(pruneStale && write
    ? `   ✅ 已删 ${pruneDeleted.length} 条${pruneDeleted.length ? `：${pruneDeleted.join(' · ')}` : ''}`
    : (pruneStale ? '   （只报不删 —— 加 --write 才真删）' : '   （未删 —— 本工具默认只报；要删须显式加 --prune-stale --write）'));
  L.push(liveMissing.length
    ? `   ❌ 断言失败：应 live 的 ${liveMissing.length} 条在 ${modsRoot} 里不见了 ${liveMissing.join(' · ')}`
    : `   ✅ 断言：应 live 的 ${liveCheck.checked} 条 <包 id>/<版本>/mod.zip **一条没掉**（脚本核对，非人工；判据 = ${liveCheck.from}）`);
  return L;
}
const pruneLines = pruneReport();

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

## 素材与授权（实测清点，业主 2026-10-12 口径：**如实标注**，不因此拦包）

${r.assets.assetFree
    ? '- 本包**不含**图片 / 音频 / 字体 / Spine 素材（zip 内与 `.spresources` 容器内部都清点过）。'
    : `- ⚠️ **本包含素材**：共 **${r.assets.assetCount}** 个文件 / **${r.assets.assetBytes}** B。
- 分类：\`${JSON.stringify(r.assets.zip.byKind)}\`${r.assets.containers.filter((c) => c.ok).length ? `\n- 容器内部：${r.assets.containers.filter((c) => c.ok).map((c) => `\`${c.name}\` ${c.fileCount} 个文件 / \`${JSON.stringify(c.byKind)}\``).join('；')}` : ''}
- ⚠️ **授权与用途以原件声明为准**；若其中含**从《明日方舟》客户端导出的官方素材**，其版权归**鹰角网络 / Yostar**，
  **仅供非商业的学习与个人娱乐使用，请勿用于任何商业场景**。本仓库与发布者**不主张**这些素材的任何权利。`}

${r.notes.filter((n) => !n.startsWith('素材清点')).length ? `## 其他须知\n\n${r.notes.filter((n) => !n.startsWith('素材清点')).map((n) => `- ${n}`).join('\n')}\n` : ''}
- 收录闸门见 [AGENTS.md](../AGENTS.md) §4；本文件由 \`tools/build-index.mjs\` 机械生成。
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
    const tag = r.assets.assetFree ? '' : `  ⚠️含素材 ${r.assets.assetCount} 个/${r.assets.assetBytes} B`;
    console.log(`   ✓ ${r.packId} ${r.version}  ${r.category}  层 ${r.load.layer ?? '?'}${r.load.combat ? ' · 会改战斗结果' : ''}  ${r.sizeBytes} B${tag}  ${r.name ?? ''}`);
  }
  for (const r of rejected) {
    console.log(`   ✗ ${r.packId ?? r.stationId}（${r.name ?? ''}）`);
    for (const g of r.gates.filter((x) => !x.ok)) console.log(`       [${g.gate}] ${g.why}`);
  }
  console.log('');
  for (const line of pruneLines) console.log(line);
  console.log('');
  console.log(write ? `已写：${modsRoot}${sep}index.json + <包 id>/<版本>/` : '（未写盘 —— 加 --write 才真写）');
}
// 退出码：1 = 有退件（等人判）；3 = 断言失败（应 live 的掉了，必须查）
process.exit(rejected.length ? 1 : (liveMissing.length ? 3 : 0));
