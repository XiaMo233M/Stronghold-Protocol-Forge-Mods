// 「UI 包形态」的**装机前判据**（零依赖，只用 node 内置）。
//
// 业主 2026-10-15 裁定：站点**收**这一形态。收件的判据就是**这一份**，不许在别处再写一遍：
//   · 形态识别 `looksLikeUiPack()` 从 `./review.mjs` **import**（与审核台的 flag 同源，只有一份实现）；
//   · 本文件只管**内容自证**：清单与实物对不对得上、有没有越过红线。
//
// 用法（zip 或已解开的目录都行）：
//   node site/uiform-verify.mjs <包.zip | 目录>          # 人读
//   node site/uiform-verify.mjs <包.zip | 目录> --json   # 机器读
//   node site/uiform-verify.mjs --selftest               # 判据自检（判据跟代码一起跑）
//
// 退出码：0 = 全过；1 = 有 FAIL；2 = 用法/读不了。
//
// ⚠️ **它判什么、不判什么**（写清楚，免得被当成万能的）：
//   · 判：形态、`MANIFEST.json` 里**每个文件的 sha256 与实物相符**、`payload/` 文件集与清单**逐条一致**、
//     交接文档在、条目名无 `..` / 绝对路径、**无可执行物**（安装器 `tools/install.mjs` 是唯一白名单）、
//     没有覆盖引擎那三处（`server/` `shared/` `data/`，红线 ①）、`required-assets.txt` 形状对；
//   · **不判**：这份补丁能不能 apply（那是维护者直装那条线上 `git apply --check` 的事）、
//     UI 好不好看、资源文件本身在不在目标环境里（`required-assets.txt` 只列路径，站点看不到目标环境）。
//     也就是说：**核过 ≠ 已安装**。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readZipEntries, readZipFile } from './zip.mjs';
import { looksLikeUiPack, reviewEntries, UIFORM_DOCS, UIFORM_INSTALLER } from './review.mjs';

/** 一律不许出现在包里的可执行 / 脚本后缀（与 `review.mjs` 的 `DANGEROUS_EXT` 同一族，这里更严）。 */
const BANNED_EXT = /\.(exe|dll|so|dylib|bat|cmd|ps1|sh|com|scr|msi|jar|vbs|wsf|hta|apk|dmg)$/i;
/** 引擎那三处**不许整份覆盖**（AGENTS.md §3 红线 ①：`data/**`、`server/**`；`shared/**` 同族）。 */
const ENGINE_DIRS = Object.freeze(['server/', 'shared/', 'data/']);
/** 清单里 `files[].path` 的基准目录。 */
const PAYLOAD = 'payload/';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 把一个目录读成 Map<POSIX 相对名, Buffer>（与 zip 那一路同形）。 */
function readDirEntries(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const nm of readdirSync(dir)) {
      const p = join(dir, nm);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      out.set(relative(root, p).split(sep).join('/'), readFileSync(p));
    }
  };
  walk(root);
  return out;
}

/**
 * 把一个 zip 读成 Map<名字, Buffer>。**只读判据要碰的那几条**（清单 + payload/** + 几个形态文件），
 * 不把整包装进内存 —— 与 `zip.mjs` 的纪律一致。
 */
async function readZipAll(file) {
  const entries = await readZipEntries(file);
  const want = entries.filter((e) => !e.dir).map((e) => e.name)
    .filter((n) => n === 'MANIFEST.json' || n === 'required-assets.txt' || n.startsWith(PAYLOAD)
      || n === UIFORM_INSTALLER || n.startsWith('patches/') || UIFORM_DOCS.includes(n));
  const map = await readZipFile(file, want);
  return { entries, map };
}

/**
 * 核一份 UI 包。
 * @returns {{ok:boolean, form:boolean, checks:Array<{id:string,level:'pass'|'fail'|'info',text:string}>, manifest:any}}
 */
export function verifyUiPack({ entries, map }) {
  const checks = [];
  const add = (id, ok, text) => checks.push({ id, level: ok ? 'pass' : 'fail', text });
  const info = (id, text) => checks.push({ id, level: 'info', text });
  const files = (entries || []).filter((e) => !e.dir);

  // ① 形态（判据只有 review.mjs 那一份）
  const form = looksLikeUiPack(entries);
  add('FORM', form, form
    ? '形状是 UI 包形态（MANIFEST.json + 交接文档 + payload/ + 安装路径，根无 pack.json）'
    : '形状**不是** UI 包形态（缺 MANIFEST.json / 交接文档 / payload/ / 安装路径之一，或根有 pack.json）');

  // ② 条目名：不许 `..`、不许绝对路径（zip 滑窗 / 解压到包外）
  const evil = files.filter((e) => e.name.includes('..') || /^([a-z]:)?[\\/]/i.test(e.name));
  add('PATH', evil.length === 0, evil.length === 0
    ? '条目名没有 `..`、没有绝对路径'
    : `条目名里有 .. 或绝对路径 ${evil.length} 条：${evil.slice(0, 3).map((e) => e.name).join('、')}`);

  // ③ 不许夹带可执行物；安装器是**唯一**白名单
  const banned = files.filter((e) => BANNED_EXT.test(e.name));
  add('EXEC', banned.length === 0, banned.length === 0
    ? '没有可执行 / 脚本后缀的文件'
    : `含可执行 / 脚本 ${banned.length} 个：${banned.slice(0, 3).map((e) => e.name).join('、')}`);
  const otherScripts = files.map((e) => e.name).filter((n) => /\.mjs$|\.js$/.test(n))
    .filter((n) => n !== UIFORM_INSTALLER && !n.startsWith(PAYLOAD));
  add('SCRIPT_WHITELIST', otherScripts.length === 0, otherScripts.length === 0
    ? `脚本只有安装器 ${UIFORM_INSTALLER}（白名单）；payload/ 下的客户端 js 不算新增脚本`
    : `顶层出现了白名单外的脚本：${otherScripts.join('、')}（安装器之外一律不允许）`);

  // ④ 红线 ①：不许整份覆盖引擎那三处
  const eng = [...files.map((e) => e.name)].filter((n) => ENGINE_DIRS.some((d) => n.startsWith(PAYLOAD + d)));
  add('ENGINE_OVERWRITE', eng.length === 0, eng.length === 0
    ? `payload/ 下没有 ${ENGINE_DIRS.join(' / ')}（没有整份覆盖引擎文件）`
    : `payload/ 下有引擎目录 ${eng.length} 条：${eng.slice(0, 3).join('、')} —— 红线 ①，整份覆盖引擎判非标准`);

  // ⑤ 交接文档（规范化件要求 `AGENTS.md` 在）
  const hasAgents = files.some((e) => e.name === 'AGENTS.md');
  const hasAnyDoc = UIFORM_DOCS.some((d) => files.some((e) => e.name === d));
  add('AGENTS_MD', hasAgents, hasAgents
    ? 'AGENTS.md 在（站侧口径与校验说明）'
    : (hasAnyDoc ? '只有原作者的交接文档，没有规范化要求的 AGENTS.md' : '交接文档一个都没有'));

  // ⑥ 清单本身能读、形状对
  const mfBuf = map.get('MANIFEST.json');
  let mf = null;
  if (!mfBuf) {
    add('MANIFEST', false, 'MAP 里没有 MANIFEST.json（读不到清单）');
  } else {
    try { mf = JSON.parse(mfBuf.toString('utf8')); } catch (e) { add('MANIFEST', false, `MANIFEST.json 不是合法 JSON：${e.message}`); }
    if (mf) {
      const list = Array.isArray(mf.files) ? mf.files : null;
      const bad = !list || !list.length || list.find((f) => !f || typeof f.path !== 'string' || !/^[0-9a-f]{64}$/.test(String(f.sha256 || '')) || !Number.isFinite(f.bytes));
      add('MANIFEST', !bad, bad
        ? 'MANIFEST.json 的 files[] 形状不对（要有非空的 {path, sha256(64 位小写 hex), bytes}）'
        : `MANIFEST.json 可读：${list.length} 条（每条形如 {path, sha256, bytes}）`);
    }
  }

  if (mf && Array.isArray(mf.files)) {
    const list = mf.files;

    // ⑦ 清单不许有重复路径（重复会让一个文件被数两次）
    const seen = new Set(); const dups = [];
    for (const f of list) { const k = String(f.path); if (seen.has(k)) dups.push(k); seen.add(k); }
    add('MANIFEST_DUP', dups.length === 0, dups.length === 0 ? '清单没有重复路径' : `清单里有重复路径：${dups.slice(0, 3).join('、')}`);

    // ⑧ 基线：清单 path 一律相对 payload/（写成 payload/... 也认）
    const baseOf = (p) => (String(p).startsWith(PAYLOAD) ? String(p) : PAYLOAD + String(p));
    const wantNames = list.map((f) => baseOf(f.path));

    // ⑨ 逐文件：sha256 与实物相符、bytes 相符
    let mismatch = 0; const sample = [];
    for (const [i, f] of list.entries()) {
      const name = wantNames[i];
      const buf = map.get(name);
      if (!buf) { mismatch++; if (sample.length < 3) sample.push(`${name}: 实物不在包里`); continue; }
      const got = sha256(buf);
      if (got !== String(f.sha256).toLowerCase()) { mismatch++; if (sample.length < 3) sample.push(`${name}: 清单 ${String(f.sha256).slice(0, 12)}… ≠ 实物 ${got.slice(0, 12)}…`); }
      else if (Number.isFinite(f.bytes) && buf.length !== f.bytes) { mismatch++; if (sample.length < 3) sample.push(`${name}: 清单 ${f.bytes} 字节 ≠ 实物 ${buf.length} 字节`); }
    }
    add('SHA256', mismatch === 0, mismatch === 0
      ? `清单里 ${list.length} 个文件的 sha256 与实物**逐条相符**（bytes 也相符）`
      : `${mismatch} 条对不上：${sample.join('；')}`);

    // ⑩ 清单之外不许有文件（payload/ 文件集与清单一致）
    const inPayload = files.map((e) => e.name).filter((n) => n.startsWith(PAYLOAD));
    const declared = new Set(wantNames);
    const extra = inPayload.filter((n) => !declared.has(n));
    add('PAYLOAD_SET', extra.length === 0, extra.length === 0
      ? `payload/ 里 ${inPayload.length} 个文件与清单**一一对应**（不多不少）`
      : `payload/ 里有清单外的文件 ${extra.length} 个：${extra.slice(0, 3).join('、')}`);

    // ⑪ 清单也不许指向引擎那三处（同红线 ①）
    const engInMf = wantNames.filter((n) => ENGINE_DIRS.some((d) => n.startsWith(PAYLOAD + d)));
    add('MANIFEST_ENGINE', engInMf.length === 0, engInMf.length === 0
      ? '清单没有指向 server / shared / data'
      : `清单指向了引擎目录：${engInMf.slice(0, 3).join('、')}`);

    if (mf.scope) info('SCOPE', `包自述 scope=${mf.scope}${mf.baseCommit ? ` baseCommit=${mf.baseCommit}` : ''}${mf.sourceCommit ? ` sourceCommit=${String(mf.sourceCommit).slice(0, 8)}` : ''}`);
  }

  // ⑫ patches/：有就得非空
  const patches = files.map((e) => e.name).filter((n) => n.startsWith('patches/'));
  if (patches.length) {
    const empty = patches.filter((n) => (map.get(n) || Buffer.alloc(0)).length === 0);
    add('PATCHES', empty.length === 0, empty.length === 0
      ? `patches/ 有 ${patches.length} 份补丁，都不是空文件`
      : `patches/ 里有空补丁：${empty.join('、')}`);
  } else {
    add('PATCHES', files.some((e) => e.name === UIFORM_INSTALLER), `没有 patches/ —— 只认安装器 ${UIFORM_INSTALLER} 那条路（它在就够）`);
  }

  // ⑬ required-assets.txt：每行要么 `/` 绝对运行时路径，要么 `<标识>: <说明>`
  const ra = map.get('required-assets.txt');
  if (!ra) {
    add('REQUIRED_ASSETS', false, '没有 required-assets.txt（资源回核清单 —— 少了它没人知道装机缺什么）');
  } else {
    const lines = ra.toString('utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const bad = lines.filter((l) => !(l.startsWith('/') || /^[A-Za-z0-9_.\-\/]+:\s+\S/.test(l)));
    add('REQUIRED_ASSETS', lines.length > 0 && bad.length === 0,
      lines.length === 0 ? 'required-assets.txt 是空的'
        : (bad.length === 0 ? `required-assets.txt 可读：${lines.length} 行（运行时路径 / 说明行）`
          : `required-assets.txt 有 ${bad.length} 行形状不对：${bad.slice(0, 2).join(' | ')}`));
  }

  return { ok: checks.every((c) => c.level !== 'fail'), form, checks, manifest: mf };
}

// ---------------------------------------------------------------- 入口
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const positional = argv.filter((a) => !a.startsWith('--'));

if (argv.includes('--selftest')) {
  runSelftest();
} else if (positional.length === 1) {
  const target = positional[0];
  let payload;
  try {
    if (statSync(target).isDirectory()) {
      const map = readDirEntries(target);
      const entries = [...map.keys()].map((name) => ({ name, dir: false, uncompSize: map.get(name).length }));
      payload = { entries, map };
    } else {
      payload = await readZipAll(target);
    }
  } catch (e) {
    console.error(`✖ 读不了 ${target}：${e.message}`);
    process.exit(2);
  }
  const r = verifyUiPack(payload);
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    for (const c of r.checks) console.log(`${c.level === 'pass' ? '✔' : c.level === 'fail' ? '✖' : '·'} [${c.id}] ${c.text}`);
    console.log(`\n${r.ok ? '✔ 全过' : '✖ 有 FAIL'} —— ${r.checks.filter((c) => c.level === 'fail').length} 条不过`);
  }
  process.exit(r.ok ? 0 : 1);
} else {
  console.error('用法：node site/uiform-verify.mjs <包.zip | 目录> [--json]  |  --selftest');
  process.exit(2);
}

// ---------------------------------------------------------------- 判据自检
//
// 纪律：**判据跟代码一起搬、并且真跑**。这一段就是「跑」的那一半 —— 每条判据都有正例与反例，
// 反例必须真的被判红（否则判据只是装饰）。
function runSelftest() {
  let n = 0, bad = 0;
  const check = (ok, label, detail = '') => {
    n++; if (!ok) bad++;
    console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` · ${detail}` : ''}`);
  };
  const E = (names) => names.map((name) => ({ name, dir: false, uncompSize: 1 }));
  const D = (names) => names.map((name) => ({ name, dir: true, uncompSize: 0 }));

  // ---- ① 形态识别（判据只有 review.mjs 那一份）
  const full = [...E(['MANIFEST.json', 'AGENTS.md', 'tools/install.mjs']), ...D(['payload/', 'patches/']), ...E(['payload/public/js/a.js', 'patches/x.patch'])];
  check(looksLikeUiPack(full) === true, '正例：MANIFEST.json + AGENTS.md + payload/ + 安装路径 ⇒ UI 包形态');
  check(looksLikeUiPack(E(['MANIFEST.json', 'payload/public/js/a.js'])) === false, '反例：没有交接文档 / 安装路径 ⇒ 不是');
  check(looksLikeUiPack([...E(['pack.json', 'MANIFEST.json', 'AGENTS.md', 'tools/install.mjs']), ...E(['payload/public/js/a.js'])]) === false, '反例：根有 pack.json ⇒ 工坊包优先，不算 UI 形态');
  check(looksLikeUiPack(E(['payload/public/js/a.js'])) === false, '反例：普通原件 ⇒ 不是 UI 形态');

  // ---- ② 审核台的 flag 真的换了（改前这里是 NO_PACK_JSON ⇒ 这一条会红）
  const codeOf = (entries) => reviewEntries(entries, {}).map((f) => f.code);
  const c1 = codeOf(full);
  check(c1.includes('UI_PACK_FORM') && !c1.includes('NO_PACK_JSON'), 'UI 形态出 UI_PACK_FORM、且不再出 NO_PACK_JSON', c1.join(','));
  const c2 = codeOf(E(['payload/public/js/a.js']));
  check(c2.includes('NO_PACK_JSON') && !c2.includes('UI_PACK_FORM'), '非 UI 形态的"原件"文案一个字没改', c2.join(','));
  const c3 = codeOf(E(['pack.json', 'meta.json']));
  check(c3.includes('HAS_PACK_JSON') && !c3.includes('UI_PACK_FORM'), '工坊包判据优先、既有逻辑未动', c3.join(','));
  check(reviewEntries(full, {}).find((f) => f.code === 'UI_PACK_FORM').level === 'info', 'UI_PACK_FORM 是 info 档（挑重点、不下结论）');

  // ---- ③ 校验器：正例全过
  const mk = (over = {}) => {
    const body = Buffer.from('body-a', 'utf8');
    const mf = { package: 'demo', scope: 'client-ui-only', files: [{ path: 'public/js/a.js', sha256: sha256(body), bytes: body.length }] };
    const map = new Map(Object.entries({
      'MANIFEST.json': Buffer.from(JSON.stringify(over.manifest ? over.manifest(mf) : mf), 'utf8'),
      'AGENTS.md': Buffer.from('# 口径', 'utf8'),
      'required-assets.txt': Buffer.from('/assets/ui/x.png\nassets.json: smoke 纹理\n', 'utf8'),
      'tools/install.mjs': Buffer.from('// installer', 'utf8'),
      'patches/x.patch': Buffer.from('diff --git a/x b/x', 'utf8'),
      'payload/public/js/a.js': over.body || body,
      ...(over.extra || {}),
    }));
    const entries = [...map.keys()].map((name) => ({ name, dir: false, uncompSize: map.get(name).length }));
    return { entries, map };
  };
  const r1 = verifyUiPack(mk());
  check(r1.ok === true, '校验器正例：一份齐全的 UI 包全过', r1.checks.filter((c) => c.level === 'fail').map((c) => c.id).join(',') || '无 FAIL');

  const r2 = verifyUiPack(mk({ body: Buffer.from('body-B', 'utf8') }));
  check(r2.ok === false && r2.checks.find((c) => c.id === 'SHA256').level === 'fail', '反例：实物被改一个字节 ⇒ SHA256 判红');

  const r3 = verifyUiPack(mk({ extra: { 'payload/public/js/undeclared.js': Buffer.from('x') } }));
  check(r3.ok === false && r3.checks.find((c) => c.id === 'PAYLOAD_SET').level === 'fail', '反例：payload/ 有清单外文件 ⇒ PAYLOAD_SET 判红');

  const r4 = verifyUiPack(mk({ extra: { 'payload/data/units.json': Buffer.from('{}') } }));
  check(r4.ok === false && r4.checks.find((c) => c.id === 'ENGINE_OVERWRITE').level === 'fail', '反例：payload/ 下有 data/ ⇒ 红线 ① 判红');

  const r5 = verifyUiPack(mk({ extra: { 'tools/evil.sh': Buffer.from('rm -rf /') } }));
  check(r5.ok === false && r5.checks.find((c) => c.id === 'EXEC').level === 'fail', '反例：夹带 .sh ⇒ EXEC 判红');

  const r6 = verifyUiPack(mk({ extra: { 'tools/other.mjs': Buffer.from('// x') } }));
  check(r6.ok === false && r6.checks.find((c) => c.id === 'SCRIPT_WHITELIST').level === 'fail', '反例：安装器之外的顶层脚本 ⇒ SCRIPT_WHITELIST 判红');

  const r7 = verifyUiPack(mk({ manifest: (m) => ({ ...m, files: [...m.files, ...m.files] }) }));
  check(r7.ok === false && r7.checks.find((c) => c.id === 'MANIFEST_DUP').level === 'fail', '反例：清单重复路径 ⇒ MANIFEST_DUP 判红');

  console.log(`\n${bad === 0 ? '✔' : '✖'} 自检 ${n} 条 · 红 ${bad} 条`);
  process.exit(bad === 0 ? 0 : 1);
}
