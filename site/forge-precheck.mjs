#!/usr/bin/env node
// site/forge-precheck.mjs — 站侧导入预检：一个包在「上游导入器」与「我们的引擎装载器」两边各会怎样。
//
//   node site/forge-precheck.mjs <包> [--upstream <上游精简包根>] [--engine <引擎检出>] [--json] [--out <文件>]
//
// <包> 是目录或 zip，必填。--out 把 stdout 的那一份内容同时写进文件（tee 语义）。
//
// 为什么要有这个工具 —— 下面三条都是**实测撞出来的**，不是设想：
//
// ① 上游导入器的 `ok` **只等于 `issues.length === 0`**（server/plugins/forgeImport.js:2183）。
//    `skipped` 非空时 `ok` 照样是 `true`。实测 mods/boss-fixed-pool/1.0.0/mod.zip：
//    `ok:true` 而 `skipped` 有 4 条。所以摘要里**「丢了什么」必须单列**，只看 `ok` 会漏。
//
// ② 我们的引擎装载器拒包时，`tools/workshop-validate.mjs` **退出码 2 且 stdout 一个字节都没有**，
//    只有 stderr 一句话（「no loadable pack named …」）。实测三种拒法都是这个形状：
//    目录名 ≠ 包 id、pack.json 不是合法 JSON、pack.json 带一个引擎不认识的键
//    （多写一个键整包被拒 —— 见本仓 AGENTS.md §3「只写 pack.json 认识的字段」）。
//    **这不是崩溃，是有效数据** —— 它就是「我们这侧能给红」的落点。
//    反过来：退出码 1 + 有 JSON = 装载上了但有校验错误；退出码 0 + JSON = 干净。
//
// ③ 把 zip 路径**直接**交给 `workshop-validate` 会得到**静默的假绿**：实测退出码 0、
//    `errors:0`、`packs:[]` —— 因为它把 zip 当成「工坊根目录」扫了一遍，一个包都没找到也算通过。
//    所以 zip 必须**先解到临时目录**，且目录名 = 包 id（装载器按 `<根>/<包 id>/pack.json` 找包）。
//
// ④ 「文件在包里，但 pack.json 没有引用它」是上游**最大的一块文件级丢弃**（实测口径 A 类 128 条）。
//    上游原文见 `server/plugins/forgeImport.js:1899`；判定处是 `:1879-1900` 的
//    `for (const [rel] of files) if (used.has(rel)) continue;` —— `used` 是**上游自己攒的引用集**。
//    ⇒ 这里**只读上游的结果，不重算引用集**（AGENTS.md §3「不抄规则」；重算=第二套口径）。
//    但只照抄上游那一句也不够：有两类文件落进 A 类是**必然**，不是问题 ——
//    ① 随包说明（`PROVENANCE.md` / `README.md` / `NOTICE-*`）：`pack.json` 没有任何字段能引用 `.md`；
//    ② **包描述文件本身**（包内嵌套的另一份 `pack.json`）：它永远不可能被自己引用。
//    实测 27 个真包（<5 MB）：**每个包**都有说明文件 ⇒ 无脑全开就是 27/27 都报 ⇒ 提示不再是信号。
//    所以**再分一层**（只有这两类，见 `isNeverReferencable()`）：压掉它们、其余算「可行动」；
//    压完之后 22/27 个包仍有可行动项、共 26 条（`boss-fixed-pool` 的 3 条**全是** `.md` ⇒ 一条都不报）。
//    并且**只做提示、不进 blockers**（提示 ≠ 错误）。
//
// 只读：不写被检包；上游一律加 `--dry-run`；临时目录落在 os.tmpdir()，跑完就删。
// 不 vendor 上游代码 —— 只按路径引用（本仓 AGENTS.md §3「不抄规则」）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeZip, readZipEntries, readZipFile } from './zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const MAX_BUF = 64 * 1024 * 1024;

const USAGE = 'usage: node site/forge-precheck.mjs <包> [--upstream <上游精简包根>] [--engine <引擎检出>] [--json] [--out <文件>]';

const usageErr = (m) => Object.assign(new Error(m), { usage: true });
const need = (v, flag) => {
  if (v === undefined || v.startsWith('--')) throw usageErr(`${flag} 需要一个值`);
  return v;
};

function parseArgs(argv) {
  const out = { pkg: null, upstream: null, engine: null, json: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--upstream') out.upstream = need(argv[++i], a);
    else if (a === '--engine') out.engine = need(argv[++i], a);
    else if (a === '--out') out.out = need(argv[++i], a);
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('-')) throw usageErr(`不认识的选项 ${a}`);
    else if (out.pkg === null) out.pkg = a;
    else throw usageErr(`多了一个参数 ${a}`);
  }
  return out;
}

const norm = (n) => String(n).replace(/\\/g, '/');
/** 临时目录的名字要能当目录名用，也要挡掉 `..` 这类东西。 */
const safeName = (s) => (String(s).replace(/[\\/]/g, '_').replace(/^\.+/, '').trim() || 'pack');

// ---------------------------------------------------------------- A 类（文件未被引用）
// 上游那一句的中英文各一份（`forgeImport.js:1899`）—— 认哪一份都行，措辞变了不会静默失效。
const UNREF_MARK = /没有引用它|does not reference it/;

/**
 * 「**本来就不走导入**」的文件 —— 落进 A 类是**必然**，不是问题。两类，**只有这两类**：
 *
 * ① 纯文档（`.md` / `.txt`）：`pack.json` **没有任何字段**能引用它们
 *    （`notices` 指向 `.json`、`content` 指向固定名单的 json、`art` 指向素材）。
 * ② **包描述文件本身**（`basename === 'pack.json'`）：`pack.json` **永远不可能被自己引用**。
 *    实测真包 `srv-notice` 里有 `stardust/pack.json`（包内嵌套的另一份描述文件）——
 *    把它算进「可行动」就是**噪音**，而噪音会让这条提示失效（提示一旦每个包都报就不再是信号）。
 *
 * ⚠️ **只压这两格**。不按目录名 / 别的形态去猜 —— 那等于发明第二套判断
 *    （AGENTS.md §3「不抄规则」：格式与层级的判据只有上游那一份）。后人若觉得这里"漏了什么"，
 *    先看这条注释：不是漏，是刻意压掉的。
 */
const isNeverReferencable = (p) => {
  const s = String(p);
  if (/\.(md|txt)$/i.test(s)) return true;
  return s.split('/').pop() === 'pack.json';
};

/**
 * 把上游的 `dropped` 里的 A 类拆成两栏。**只读上游结果，不重算引用集**（文件头 ④）。
 * 返回 `unreferenced`（本该生效却没被引用 —— 提示的对象）与
 * `unreferencedExcluded`（本来就不走导入，排除 —— 见 `isNeverReferencable`）。
 */
function splitUnreferenced(dropped) {
  const unreferenced = [];
  const unreferencedExcluded = [];
  for (const d of dropped ?? []) {
    if (!UNREF_MARK.test(d?.zh ?? '') && !UNREF_MARK.test(d?.en ?? '')) continue;
    (isNeverReferencable(d.path) ? unreferencedExcluded : unreferenced).push(d.path);
  }
  return { unreferenced, unreferencedExcluded };
}

// ---------------------------------------------------------------- 路径来源
// 上游：--upstream > SP_UPSTREAM > 无（**不报错**，记 configured=false，摘要写「跳过该项」）。
function resolveUpstream(flag) {
  if (flag) return { root: path.resolve(flag), source: '--upstream' };
  if (process.env.SP_UPSTREAM) return { root: path.resolve(process.env.SP_UPSTREAM), source: 'SP_UPSTREAM' };
  return { root: null, source: null };
}

// 引擎：--engine > SP_ENGINE > 兄弟目录 ../Stronghold-Protocol。
function resolveEngine(flag) {
  if (flag) return { root: path.resolve(flag), source: '--engine' };
  if (process.env.SP_ENGINE) return { root: path.resolve(process.env.SP_ENGINE), source: 'SP_ENGINE' };
  return { root: path.resolve(REPO, '..', 'Stronghold-Protocol'), source: '兄弟目录 ../Stronghold-Protocol' };
}

/**
 * 上游版本号取**可核字段**：先 `<根>/MANIFEST.json` 的 `app`（实测 {"format":1,"app":"0.3.0"}），
 * 读不到退 `<根>/package.json` 的 `version`。**并报出来源字段名** —— 不硬编码、不猜。
 */
function upstreamVersion(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'));
    if (typeof j?.app === 'string' && j.app) return { version: j.app, source: 'MANIFEST.json:app' };
  } catch { /* 读不到就往下退 */ }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof j?.version === 'string' && j.version) return { version: j.version, source: 'package.json:version' };
  } catch { /* 两个都没有 */ }
  return { version: null, source: null };
}

// ---------------------------------------------------------------- 跑上游导入器
function runUpstream(root, pkg) {
  const base = { root, source: null, skipped: null, error: null, exitCode: null,
    version: null, versionSource: null, ok: null, imported: [], dropped: [], rejected: [], assumed: [], check: null };

  const entry = path.join(root, 'tools', 'plugin.mjs');
  if (!fs.existsSync(entry)) return { ...base, skipped: `没有 ${entry}` };
  const v = upstreamVersion(root);

  // `--dry-run` 是关键：上游不写任何文件（只读）。退出码 1 = 被拒，**当数据不当崩溃**。
  const r = spawnSync(process.execPath, [entry, 'import-forge', pkg, '--dry-run', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUF });
  const stdout = r.stdout ?? '';
  const stderr = (r.stderr ?? '').trim();

  if (r.error) return { ...base, ...v, versionSource: v.source, error: `跑不起来：${r.error.message}` };

  let rep = null;
  try { rep = JSON.parse(stdout); } catch { /* 下面统一记 error */ }
  if (!rep) {
    return { ...base, ...v, versionSource: v.source, exitCode: r.status, error:
      `stdout 不是 JSON（退出码 ${r.status}）${stderr ? `；stderr：${stderr.split('\n')[0]}` : ''}` };
  }

  // 字段映射（对齐 forgeImport.js:2180-2193 的 publicReport）：
  //   dropped = skipped[] · rejected = issues[]{code,detail} · imported = products[].imported 展平 · check = check
  return {
    root, source: null, skipped: null, error: null,
    exitCode: r.status,
    version: v.version, versionSource: v.source,
    ok: rep.ok === true,
    imported: (rep.products ?? []).flatMap((p) => p.imported ?? []),
    dropped: rep.skipped ?? [],
    rejected: (rep.issues ?? []).map((i) => ({ code: i.code, detail: i.detail })),
    assumed: rep.assumed ?? [],
    check: typeof rep.check === 'string' ? rep.check : null,
  };
}

// ---------------------------------------------------------------- 跑我们自己的
function runEngine(root, dir) {
  const base = { root, source: null, skipped: null, error: null, exitCode: null, refused: false,
    stdoutBytes: 0, stderr: '', errors: 0, warnings: 0, packs: 0, issues: [] };

  const entry = path.join(root, 'tools', 'workshop-validate.mjs');
  if (!fs.existsSync(entry)) return { ...base, skipped: `没有 ${entry}` };

  const r = spawnSync(process.execPath, [entry, dir, '--json'], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUF });
  const stdout = r.stdout ?? '';
  const stderr = (r.stderr ?? '').trim();
  const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
  const exitCode = r.status;

  if (r.error) return { ...base, error: `跑不起来：${r.error.message}`, exitCode, stdoutBytes, stderr };

  // 退出码不是 0/1（实测是 2）**或**一个字节都没输出 ⇒ 装载器拒包。这是有效数据，不是崩溃。
  const refused = (exitCode !== 0 && exitCode !== 1) || (stdoutBytes === 0 && exitCode !== 0);
  if (refused) {
    return { ...base, exitCode, refused: true, stdoutBytes, stderr: stderr.split('\n')[0] ?? '' };
  }

  let rep = null;
  try { rep = JSON.parse(stdout); } catch { /* 下面记 error */ }
  if (!rep) {
    return { ...base, exitCode, stdoutBytes, stderr: stderr.split('\n')[0] ?? '',
      error: `stdout 不是 JSON（退出码 ${exitCode}，${stdoutBytes} 字节）` };
  }

  const issues = [];
  for (const p of rep.packs ?? []) for (const it of p.issues ?? []) issues.push({ pack: p.pack, ...it });
  return {
    root, source: null, skipped: null, error: null,
    exitCode, refused: false, stdoutBytes, stderr: stderr.split('\n')[0] ?? '',
    errors: rep.errors ?? rep.errorCount ?? 0,
    warnings: rep.warnings ?? rep.warningCount ?? 0,
    packs: (rep.packs ?? []).length,
    issues,
  };
}

// ---------------------------------------------------------------- 解 zip
/**
 * 解到 `<临时根>/<包 id>/` —— 目录名**必须**等于包 id，否则装载器找不到包（会以退出码 2 + 空 stdout 拒）。
 * 顶层目录形状（`<X>/pack.json`）与扁平形状（`pack.json` 在根）都收（引擎 tools/workshop-pack.mjs:191-200）。
 */
async function extractZip(zipPath, tmpRoot) {
  const entries = await readZipEntries(zipPath);
  const rawNames = entries.filter((e) => !e.dir).map((e) => e.name);
  const got = await readZipFile(zipPath, rawNames);
  const files = new Map();
  for (const [raw, buf] of got) files.set(norm(raw), buf);

  let prefix = '';
  if (!files.has('pack.json')) {
    const tops = new Set([...files.keys()].filter((n) => n.includes('/')).map((n) => n.split('/')[0]));
    if (tops.size === 1) {
      const t = [...tops][0];
      if (files.has(`${t}/pack.json`)) prefix = `${t}/`;
    }
  }

  let packId = null;
  const pj = files.get(`${prefix}pack.json`);
  if (pj) {
    try {
      const j = JSON.parse(pj.toString('utf8'));
      if (typeof j?.id === 'string' && j.id) packId = j.id;
    } catch { /* pack.json 读不出来 —— 目录名就退回 zip 名，装载器会照实拒 */ }
  }

  const fallback = path.basename(zipPath).replace(/\.zip$/i, '');
  const dir = path.join(tmpRoot, safeName(packId ?? fallback));
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, buf] of files) {
    const rel = prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n;
    if (!rel) continue;
    if (rel.split('/').some((s) => !s || s === '.' || s === '..')) continue; // 不许穿出去
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
  return { dir, packId, layout: prefix ? 'nested' : 'flat' };
}

// ---------------------------------------------------------------- 中文摘要
function buildSummary(rep) {
  const L = [];
  const inp = rep.input;
  L.push(`站侧导入预检 · ${inp.path}`);
  const kindZh = inp.kind === 'dir' ? '目录' : inp.kind === 'zip' ? 'zip' : '非 zip 文件';
  let l1 = inp.kind === 'dir' ? '  输入        目录' : `  输入        ${kindZh} · ${inp.bytes} B`;
  if (inp.extractedTo) {
    l1 += ` · 已解到临时目录（${inp.layout === 'nested' ? '顶层目录' : '扁平'}形状 · 包 id ${inp.packId ?? '读不到'}）`;
  }
  L.push(l1);

  const up = rep.upstream;
  if (!up.configured) {
    L.push('  上游导入器  未配置上游导入器，跳过该项');
  } else if (up.skipped) {
    L.push(`  上游导入器  ${up.root}（来源：${up.source}）`);
    L.push(`    ⚠ 跳过：${up.skipped}`);
  } else if (up.error) {
    L.push(`  上游导入器  ${up.root}（来源：${up.source}）`);
    L.push(`    ✗ ${up.error}`);
  } else {
    L.push(`  上游导入器  ${up.root}（来源：${up.source}）`);
    L.push(`    版本        ${up.version ?? '核不到'}` +
      (up.versionSource ? `（来源字段 ${up.versionSource}）` : '（MANIFEST.json:app 与 package.json:version 都读不到）'));
    L.push(`    ${up.ok ? '✓' : '✗'} ok=${up.ok} · 退出码 ${up.exitCode} · 导入 ${up.imported.length} 条 · 检查「${up.check ?? '（空）'}」`);
    for (const s of up.imported) L.push(`       · ${s}`);
    if (up.dropped.length) {
      L.push(`    ⚠ 没有导入 ${up.dropped.length} 条（上游的 ok 只看 issues，skipped 非空时 ok 照样是 true）`);
      for (const d of up.dropped) L.push(`       · ${d.path} — ${d.zh ?? d.en ?? ''}`);
    } else L.push('    没有导入    无');

    // ⭐ A 类「文件未被引用」的可行动提示（文件头 ④）。**不是错误** —— 不进 blockers、不改退出码。
    // 只在「本来就不走导入」那部分**之外**还有剩的时候出现：随包说明与包描述文件本身落进 A 类是必然，
    // 报它们等于每个包都报（噪音会让提示失效）。见 isNeverReferencable()。
    if (up.unreferenced?.length) {
      L.push(`    ⭐ 可行动：上面这 ${up.unreferenced.length} 条是**本该生效**、但 pack.json 没有引用它们的文件`);
      L.push('       —— 把它们的路径写进 pack.json 引用一次，否则一个字节都不会被导入：');
      for (const p of up.unreferenced) L.push(`       · ${p}`);
      L.push('       怎么引用：数据文件 → content（如 "content": ["chess"] 读包里的 chess.json）·');
      L.push('                 图与音效 → art · 公告 → notices · 包内面板模块 → client.panels');
      if (up.unreferencedExcluded?.length) {
        L.push(`       （另有 ${up.unreferencedExcluded.length} 条是随包说明 / 包描述文件本身，本来就不走导入，已排除）`);
      }
    }
    if (up.rejected.length) {
      L.push(`    ✗ 被拒 ${up.rejected.length} 条`);
      for (const r of up.rejected) L.push(`       · ${r.code}：${r.detail}`);
    } else L.push('    被拒        无');
    if (up.assumed.length) {
      L.push(`    ? 需要作者确认（ASSUMED）${up.assumed.length} 条`);
      for (const a of up.assumed) L.push(`       · ${a.zh ?? a.what ?? ''}`);
    } else L.push('    需要作者确认（ASSUMED）  无');
  }

  const en = rep.engine;
  if (en.skipped) {
    L.push(`  引擎装载器  ${en.root}（来源：${en.source}）`);
    L.push(`    ⚠ 跳过：${en.skipped}`);
  } else if (en.error) {
    L.push(`  引擎装载器  ${en.root}（来源：${en.source}）`);
    L.push(`    ✗ ${en.error}`);
  } else if (en.refused) {
    L.push(`  引擎装载器  ${en.root}（来源：${en.source}）`);
    L.push(`    ✗ 装载器拒包（refused=true）· 退出码 ${en.exitCode} · stdout ${en.stdoutBytes} 字节`);
    L.push(`      装载器只说了：${en.stderr || '（stderr 也是空的）'}`);
  } else {
    L.push(`  引擎装载器  ${en.root}（来源：${en.source}）`);
    L.push(`    ${en.errors ? '✗' : '✓'} 退出码 ${en.exitCode} · ${en.errors} error(s) · ${en.warnings} warning(s) · 装载 ${en.packs} 个包`);
    for (const it of en.issues.slice(0, 20)) {
      L.push(`       · [${it.severity}] ${it.pack ?? ''} ${it.code ?? ''} ${it.field ?? ''} ${it.message ?? ''}`.trimEnd());
    }
    if (en.issues.length > 20) L.push(`       · …还有 ${en.issues.length - 20} 条`);
  }

  L.push(rep.ok ? '  结论        通过（0 个阻断项）' : `  结论        不通过（${rep.blockers.length} 个阻断项）`);
  for (const b of rep.blockers) L.push(`    ✗ ${b}`);
  return L;
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pkg) throw usageErr('缺少 <包>');
  const abs = path.resolve(args.pkg);
  if (!fs.existsSync(abs)) throw usageErr(`没有这个路径：${abs}`);
  const st = fs.statSync(abs);
  const isDir = st.isDirectory();

  let kind = isDir ? 'dir' : 'other';
  if (!isDir) {
    const fd = fs.openSync(abs, 'r');
    const head = Buffer.alloc(4);
    try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (looksLikeZip(head)) kind = 'zip';
  }

  const input = { path: abs, kind, bytes: st.size, extractedTo: null, layout: null, packId: null };

  const upCfg = resolveUpstream(args.upstream);
  const enCfg = resolveEngine(args.engine);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-precheck-'));
  let engineDir = null;
  let extractNote = null;
  try {
    if (isDir) {
      engineDir = abs; // 目录原样交给装载器 —— 目录名 ≠ 包 id 时**照实**让它拒，不替它改名
    } else if (kind === 'zip') {
      try {
        const ex = await extractZip(abs, tmpRoot);
        engineDir = ex.dir;
        input.extractedTo = ex.dir;
        input.layout = ex.layout;
        input.packId = ex.packId;
      } catch (e) {
        extractNote = `解压失败：${e.message}`;
      }
    } else {
      extractNote = '这个文件既不是目录也不是 zip';
    }

    const upstream = upCfg.root
      ? { ...runUpstream(upCfg.root, abs), source: upCfg.source, configured: true }
      : { root: null, source: null, configured: false, skipped: null, error: null, exitCode: null,
          version: null, versionSource: null, ok: null, imported: [], dropped: [], rejected: [], assumed: [], check: null };
    // A 类两栏（文件头 ④）：只读上游的 `dropped`，不重算引用集。上游没配置 / 跑不起来时两栏都是空数组。
    const unrefSplit = splitUnreferenced(upstream.dropped);
    upstream.unreferenced = unrefSplit.unreferenced;
    upstream.unreferencedExcluded = unrefSplit.unreferencedExcluded;

    const engine = engineDir
      ? { ...runEngine(enCfg.root, engineDir), source: enCfg.source }
      : { root: enCfg.root, source: enCfg.source, skipped: extractNote, error: null, exitCode: null,
          refused: false, stdoutBytes: 0, stderr: '', errors: 0, warnings: 0, packs: 0, issues: [] };

    const blockers = [];
    if (upstream.configured) {
      if (upstream.skipped) blockers.push(`上游导入器不可用：${upstream.skipped}`);
      else if (upstream.error) blockers.push(`上游导入器没给出可读结果：${upstream.error}`);
      else if (!upstream.ok) blockers.push('上游导入器拒了这个包（见「被拒」那几条）');
    }
    if (engine.skipped) blockers.push(`引擎装载器不可用：${engine.skipped}`);
    else if (engine.error) blockers.push(`引擎装载器没给出可读结果：${engine.error}`);
    else if (engine.refused) blockers.push(`引擎装载器拒包（退出码 ${engine.exitCode}，stdout ${engine.stdoutBytes} 字节）`);
    else if (engine.errors > 0) blockers.push(`引擎装载器报了 ${engine.errors} 个 error`);
    // 装载器把「没有 pack.json 的目录」当**工坊根**扫，一个包都没找到也报退出码 0、errors 0
    // —— 那是静默的假绿。所以「0 个包」必须自己点出来，不能当通过。
    else if (engine.packs === 0) blockers.push('引擎装载器一个包都没装载 —— 这个根目录下没有它认得的包');

    const report = {
      tool: 'forge-precheck',
      format: 1,
      input,
      upstream,
      engine,
      blockers,
      ok: blockers.length === 0,
    };
    report.summary = buildSummary(report);

    const text = args.json ? JSON.stringify(report, null, 2) : report.summary.join('\n');
    console.log(text);
    if (args.out) fs.writeFileSync(path.resolve(args.out), `${text}\n`, 'utf8');
    process.exit(report.ok ? 0 : 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`forge-precheck: ${e.message}`);
  if (e.usage) console.error(USAGE);
  process.exit(2);
});
