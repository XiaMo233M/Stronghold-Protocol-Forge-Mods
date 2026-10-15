#!/usr/bin/env node
// site/selftest-precheck.mjs — 「站侧导入预检」的判据（五条，红/绿都真跑）。
//
//   node site/selftest-precheck.mjs [--upstream <上游精简包根>] [--engine <引擎检出>]
//
// 上游根取 --upstream > SP_UPSTREAM；**没有就核不到**（①红，并把原因写出来，不许静默）。
// 引擎检出取 --engine > SP_ENGINE > 兄弟目录 ../Stronghold-Protocol（与工具同一套顺序）。
//
// 四条：
//   ① 绿 —— 已发布的真包 mods/boss-fixed-pool/1.0.0/mod.zip：上游 ok=true、imported 展平 10 条、
//      check 非空、版本取自可核字段 MANIFEST.json:app；我们这侧 0 error、装载 1 个包。
//      **故意不用 18.8 MB 的 ave-mujica**：它超上游 `ZIP_RAW_MAX = pluginBytes + 64 KiB`
//      （server/plugins/forgeImport.js:95）。
//   ② 红 —— (a) 无 pack.json 的目录：上游 ok=false + issues=[{PLUGIN_FORGE_INPUT, no pack.json}] + 退出码 1；
//            (b) **我们这侧的红**：一个装载器会拒的包 ⇒ 工具记 engine.refused=true + 退出码 2 + stdout 0 字节。
//                引擎工具不存在时这条判据红 —— 不替它糊过去。
//   ③ 降级 —— --upstream 指到不存在的路径：不崩、摘要说明跳过、另一项照跑；
//            上游整个没配置时不报错，摘要写「未配置上游导入器，跳过该项」。
//   ④ 只读 —— 跑完前后，被检包每个文件的 sha256 一字不变（目录形状与 zip 形状各跑一遍）。
//   ⑤ W4 · A 类「文件在包里但 pack.json 没有引用它」的可行动提示（上游原文 `forgeImport.js:1899`）：
//      绿 = 真包本身只有「本来就不走导入」的那两类（`.md`/`.txt` 说明 + 包描述文件本身）落在这一类
//      ⇒ 提示**不出现**；
//      红 = 同一个真包的复制件 + 未被引用的 `assets/orphan.png` + 包内嵌套的 `sub/pack.json`
//      ⇒ 提示**出现**且只点名 `orphan.png`（嵌套 `pack.json` 被压掉）；**不进 blockers、不改退出码**
//      （提示 ≠ 错误）。复制件在临时目录，仓库零删除。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZipEntries, readZipFile } from './zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const TOOL = path.join(HERE, 'forge-precheck.mjs');
const GREEN_ZIP = path.join(REPO, 'mods', 'boss-fixed-pool', '1.0.0', 'mod.zip');

const argv = process.argv.slice(2);
const argOf = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : null);
const UPSTREAM = argOf('--upstream') || process.env.SP_UPSTREAM || null;
const ENGINE = argOf('--engine') || process.env.SP_ENGINE || null;
const ENGINE_ARGS = ENGINE ? ['--engine', ENGINE] : [];

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-precheck-selftest-'));

/** 跑工具；env 里给 `SP_UPSTREAM: ''` 就能把环境变量那一路压掉（空串是 falsy）。 */
function runTool(args, env = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 判据自己去看 stdout */ }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', json };
}

const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
  return out.sort();
}
const snapshot = (dir) => Object.fromEntries(walk(dir).map((rel) => [rel, sha256(path.join(dir, rel))]));

/** 用本仓自己的 zip 读取器把一个包解到 destDir（判据造用例用，不落任何东西进仓库）。 */
async function extract(zip, destDir) {
  const entries = await readZipEntries(zip);
  const got = await readZipFile(zip, entries.filter((e) => !e.dir).map((e) => e.name));
  for (const [raw, buf] of got) {
    const rel = String(raw).replace(/\\/g, '/');
    if (rel.split('/').some((s) => !s || s === '.' || s === '..')) continue;
    const abs = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
}

try {
  // ------------------------------------------------------------ ① 绿
  console.log('\n① 绿：已发布的真包 mods/boss-fixed-pool/1.0.0/mod.zip');
  const greenThere = fs.existsSync(GREEN_ZIP);
  check(greenThere, '真包在', greenThere ? `${fs.statSync(GREEN_ZIP).size} B` : `核不到 ${GREEN_ZIP}`);
  if (!UPSTREAM) {
    check(false, '上游根可用', '核不到 —— 既没有 --upstream 也没有 SP_UPSTREAM，这一条只能红');
  } else {
    const r = runTool([GREEN_ZIP, '--upstream', UPSTREAM, ...ENGINE_ARGS, '--json']);
    const up = r.json?.upstream;
    check(!!r.json, '工具给出可解析的 --json', r.json ? '' : (r.stderr.split('\n')[0] || 'stdout 不是 JSON'));
    check(r.status === 0, '工具退出码 0（0 个阻断项）', `退出码 ${r.status}`);
    check(up?.ok === true, '上游 ok=true', `ok=${up?.ok}`);
    check(up?.imported?.length === 10, '上游 imported 展平 10 条', `${up?.imported?.length ?? '核不到'} 条`);
    check(!!up?.check, '上游 check 非空', up?.check ? `「${up.check}」` : '空');
    check(up?.version === '0.3.0' && up?.versionSource === 'MANIFEST.json:app',
      '上游版本取自可核字段', `${up?.version} ← ${up?.versionSource}`);
    check(r.json?.engine?.errors === 0 && r.json?.engine?.packs === 1,
      '我们这侧 0 error、装载 1 个包', `errors=${r.json?.engine?.errors} packs=${r.json?.engine?.packs}`);
  }

  // ------------------------------------------------------------ ② 红
  console.log('\n② 红');

  const noPack = path.join(TMP, 'nopackjson');
  fs.mkdirSync(noPack, { recursive: true });
  fs.writeFileSync(path.join(noPack, 'hello.txt'), 'hi');
  if (!UPSTREAM) {
    check(false, '(a) 上游根可用', '核不到 —— 既没有 --upstream 也没有 SP_UPSTREAM');
  } else {
    const r = runTool([noPack, '--upstream', UPSTREAM, ...ENGINE_ARGS, '--json']);
    const up = r.json?.upstream;
    const rej = up?.rejected ?? [];
    check(up?.ok === false, '(a) 无 pack.json ⇒ 上游 ok=false', `ok=${up?.ok}`);
    check(rej.length === 1 && rej[0].code === 'PLUGIN_FORGE_INPUT' && rej[0].detail === 'no pack.json',
      '(a) issues=[{PLUGIN_FORGE_INPUT, no pack.json}]', JSON.stringify(rej));
    check(up?.exitCode === 1, '(a) 上游退出码 1（被拒当数据，不当崩溃）', `退出码 ${up?.exitCode}`);
    check(r.status === 1, '(a) 工具把这一条当阻断项（退出码 1）', `退出码 ${r.status}`);
  }

  // (b) 我们这侧的红：拿真包改一个引擎不认识的键（AGENTS.md §3：多写一个键整包被拒）
  const redDir = path.join(TMP, 'red', 'boss-fixed-pool');
  fs.mkdirSync(redDir, { recursive: true });
  await extract(GREEN_ZIP, redDir);
  const pj = path.join(redDir, 'pack.json');
  fs.writeFileSync(pj, fs.readFileSync(pj, 'utf8').replace(/^\s*\{/, '{ "zzzUnknownKey": 1,'));
  const rb = runTool([redDir, ...ENGINE_ARGS, '--json'], { SP_UPSTREAM: '' });
  const en = rb.json?.engine;
  const entry = en?.root ? path.join(en.root, 'tools', 'workshop-validate.mjs') : null;
  check(!!entry && fs.existsSync(entry), '(b) 引擎工具在（不在 ⇒ 这条只能红）', entry ?? '核不到引擎根');
  check(en?.refused === true, '(b) 工具记 engine.refused=true',
    `refused=${en?.refused}${en?.skipped ? ` · skipped=${en.skipped}` : ''}`);
  check(en?.exitCode === 2, '(b) 装载器退出码 2', `退出码 ${en?.exitCode}`);
  check(en?.stdoutBytes === 0, '(b) 装载器 stdout 0 字节', `${en?.stdoutBytes ?? '核不到'} 字节`);

  // ------------------------------------------------------------ ③ 降级
  console.log('\n③ 降级');
  const ghost = path.join(TMP, 'definitely-not-here');
  const r3 = runTool([GREEN_ZIP, '--upstream', ghost, ...ENGINE_ARGS, '--json']);
  check(!!r3.json, '--upstream 指到不存在的路径：不崩，仍给出报告', r3.json ? '' : (r3.stderr.split('\n')[0] || ''));
  check(r3.status !== 2, '不是用法错误退出（2）', `退出码 ${r3.status}`);
  check(typeof r3.json?.upstream?.skipped === 'string' && r3.json.upstream.skipped.length > 0,
    '摘要说明上游被跳过（带原因）', r3.json?.upstream?.skipped ?? '核不到');
  check(r3.json?.engine?.refused === false && (r3.json?.engine?.packs ?? 0) >= 1,
    '另一项照跑（引擎仍然跑了）', `packs=${r3.json?.engine?.packs} refused=${r3.json?.engine?.refused}`);

  const r3b = runTool([GREEN_ZIP, ...ENGINE_ARGS, '--json'], { SP_UPSTREAM: '' });
  check(r3b.json?.upstream?.configured === false, '上游整个没配置 ⇒ configured=false（不报错）',
    `configured=${r3b.json?.upstream?.configured}`);
  check((r3b.json?.summary ?? []).some((l) => l.includes('未配置上游导入器，跳过该项')),
    '摘要写「未配置上游导入器，跳过该项」');
  check(r3b.status === 0, '没配置上游不算阻断项', `退出码 ${r3b.status}`);

  // ------------------------------------------------------------ ④ 只读
  console.log('\n④ 只读：跑完前后被检包一字不变');
  const zipBefore = sha256(GREEN_ZIP);
  const dirCopy = path.join(TMP, 'readonly-pack');
  fs.mkdirSync(dirCopy, { recursive: true });
  await extract(GREEN_ZIP, dirCopy);
  const before = snapshot(dirCopy);
  runTool([dirCopy, ...ENGINE_ARGS, '--json'], { SP_UPSTREAM: '' });
  const after = snapshot(dirCopy);
  check(JSON.stringify(before) === JSON.stringify(after), '目录形状：每个文件 sha256 一致',
    `${Object.keys(before).length} 个文件`);
  check(sha256(GREEN_ZIP) === zipBefore, '仓库里的真 zip 本身 sha256 一致', `${zipBefore.slice(0, 16)}…`);
  runTool([GREEN_ZIP, ...ENGINE_ARGS, '--json'], { SP_UPSTREAM: '' });
  check(sha256(GREEN_ZIP) === zipBefore, 'zip 形状再跑一遍，真 zip 仍然一字不变');

  // ------------------------------------------------------------ ⑤ W4：A 类「文件未被引用」的可行动提示
  // 上游原文见 server/plugins/forgeImport.js:1899（`skip(rel, '文件在包里，但 pack.json 没有引用它，没有导入。')`）；
  // 引用集 `used` 在上游内部（`forgeImport.js:1879-1900`攒的）⇒ 我们**只读结果、不重算**。
  // 绿 = 真包本身只有「本来就不走导入」的那两类（.md/.txt 说明 + 包描述文件本身）落在 A 类
  //      ⇒ **提示不出现**（无脑全开会对每个包都报，提示就没有信号）；
  // 红 = 同一个真包的复制件里加一个未被引用的 assets/orphan.png + 一份包内嵌套的 sub/pack.json
  //      ⇒ **提示出现**且只点名 orphan.png（嵌套 pack.json 被压掉，不算可行动），且**不进 blockers**。
  console.log('\n⑤ W4 · A 类提示：文件在包里但 pack.json 没有引用它');
  if (!UPSTREAM) {
    check(false, '上游根可用', '核不到 —— 既没有 --upstream 也没有 SP_UPSTREAM，这一条只能红');
  } else {
    const g = runTool([GREEN_ZIP, '--upstream', UPSTREAM, ...ENGINE_ARGS, '--json'], { SP_UPSTREAM: '' });
    const gUp = g.json?.upstream;
    const gAct = gUp?.unreferenced ?? [];
    const gExcl = gUp?.unreferencedExcluded ?? [];
    check(Array.isArray(gUp?.unreferenced) && Array.isArray(gUp?.unreferencedExcluded),
      '报告里有机读栏 upstream.unreferenced / unreferencedExcluded',
      gUp?.unreferenced === undefined ? '核不到 —— 这两栏还不存在' : `unreferenced=${gAct.length} excluded=${gExcl.length}`);
    check(gExcl.length > 0, '绿：真包里的 .md/.txt 随包说明被认出来、排除在提示之外', `unreferencedExcluded=${gExcl.length}`);
    check(gAct.length === 0, '绿：真包没有「本该生效却没被引用」的文件', `unreferenced=${JSON.stringify(gAct)}`);
    check(!(g.json?.summary ?? []).some((l) => l.includes('可行动')), '绿：摘要里不出现可行动提示');
    check(g.status === 0, '绿：这一条不进 blockers（退出码 0）', `退出码 ${g.status}`);

    // 红：同一个真包的复制件 + 未被引用的 assets/orphan.png + 包内嵌套的 sub/pack.json
    //（复制件在临时目录，仓库零删除）
    const w4Dir = path.join(TMP, 'w4', 'boss-fixed-pool');
    fs.mkdirSync(w4Dir, { recursive: true });
    await extract(GREEN_ZIP, w4Dir);
    fs.mkdirSync(path.join(w4Dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(w4Dir, 'assets', 'orphan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    fs.mkdirSync(path.join(w4Dir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(w4Dir, 'sub', 'pack.json'), '{"id":"nested-not-a-pack"}\n');
    const r5 = runTool([w4Dir, '--upstream', UPSTREAM, ...ENGINE_ARGS, '--json'], { SP_UPSTREAM: '' });
    const a5 = r5.json?.upstream?.unreferenced ?? [];
    const e5 = r5.json?.upstream?.unreferencedExcluded ?? [];
    const s5 = r5.json?.summary ?? [];
    const hi = s5.findIndex((l) => l.includes('可行动'));
    check(JSON.stringify(a5) === JSON.stringify(['assets/orphan.png']),
      '红：未被引用的 assets/orphan.png 被点名（且只有它）', JSON.stringify(a5));
    check(e5.includes('sub/pack.json'),
      '红：包内嵌套的 sub/pack.json 被压进「本来就不走导入」那一栏（不制造噪音）', JSON.stringify(e5));
    check(hi >= 0, '红：摘要里出现可行动提示');
    check(hi >= 0 && s5.slice(hi).some((l) => l.includes('assets/orphan.png')), '红：提示块里带上那条路径');
    check(hi >= 0 && !s5.slice(hi).some((l) => l.includes('sub/pack.json')), '红：提示块里**不**出现嵌套 pack.json');
    check(!(r5.json?.blockers ?? []).some((b) => b.includes('orphan')), '红：提示不是阻断项（blockers 里没有它）',
      `blockers=${JSON.stringify(r5.json?.blockers ?? [])}`);
    check(r5.status === 0, '红：加了未引用文件也不改退出码（提示 ≠ 错误）', `退出码 ${r5.status}`);
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('');
if (failures) { console.log(`✖ ${failures} 项没通过`); process.exit(1); }
console.log('✔ 站侧导入预检五条判据通过');
