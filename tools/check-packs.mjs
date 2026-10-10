#!/usr/bin/env node
// 把仓库里的包交给**引擎自己的装载器**过一遍：能不能装、报什么错、装成哪一层。
//
//   node tools/check-packs.mjs --engine E:\path\to\Stronghold-Protocol-Forge
//   node tools/check-packs.mjs --engine <目录> --root incoming       # 只看某一个根
//   node tools/check-packs.mjs --engine <目录> --json                # 机器可读
//
// 为什么要用引擎那一份装载器：包的格式、层级判定与拒绝理由是**引擎决定的**，本仓库只是存放处。
// 在这里抄一份校验规则，规则一升级就会漂 —— 于是「兼容」就变成猜。
//
// 三个根的含义不同，判定标准也不同：
//   packs/     兼容**已完成**的包。这里的包必须全部装上 —— 它是闸门。
//   demo/      格式示例（给人照抄的样板）。也必须全部装上 —— 它同样是闸门。
//   incoming/  组员上传的**未完成兼容**的包。这里被拒是**正常现象**，只报不拦（见 incoming/README.md）。
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 每个根：`gate` 为真表示「这里的包必须全部装上」，否则只报告。 */
const ROOTS = [
  { name: 'packs', label: '兼容完成的包', gate: true },
  { name: 'demo', label: '格式示例', gate: true },
  { name: 'incoming', label: '组员上传、尚未完成兼容', gate: false },
];

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const all = (name) => argv.reduce((acc, a, i) => (a === name ? [...acc, argv[i + 1]] : acc), []);
const asJson = argv.includes('--json');
const engineArg = flag('--engine', process.env.SP_ENGINE || null);
const only = all('--root').filter(Boolean);

if (!engineArg) {
  console.error('缺少引擎检出。用法：node tools/check-packs.mjs --engine <Stronghold-Protocol-Forge 目录>');
  console.error('（也可以用环境变量 SP_ENGINE）');
  process.exit(2);
}
const engine = resolve(String(engineArg));
for (const need of ['server/workshop.js', 'shared/constants.js']) {
  if (!existsSync(join(engine, need))) {
    console.error(`这不是一个引擎检出（缺 ${need}）：${engine}`);
    process.exit(2);
  }
}

const mod = await import(pathToFileURL(join(engine, 'server/workshop.js')).href);
const consts = await import(pathToFileURL(join(engine, 'shared/constants.js')).href);
const engineVersion = consts.APP_VERSION ?? null;
const modApiVersion = consts.MOD_API_VERSION ?? null;

const wanted = only.length ? ROOTS.filter((r) => only.includes(r.name)) : ROOTS;
if (!wanted.length) {
  console.error(`--root 只能是：${ROOTS.map((r) => r.name).join(' / ')}`);
  process.exit(2);
}

const results = [];
for (const root of wanted) {
  const dir = join(ROOT, root.name);
  if (!existsSync(dir)) {
    results.push({ ...root, dir, present: false, packs: [], errors: [], empty: true });
    continue;
  }
  const empty = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length === 0;
  const loaded = mod.loadWorkshop(dir, { log: { info() {}, debug() {}, warn() {}, error() {} } });
  results.push({
    ...root,
    dir,
    present: true,
    empty,
    packs: (loaded.packs ?? []).map((p) => ({
      id: p.id, name: p.name, version: p.version,
      layer: p.layer ?? null, combat: p.combat ?? null, api: p.api ?? null,
    })),
    errors: (loaded.errors ?? []).map((e) => ({ pack: e.pack, reason: e.reason })),
  });
}

const failedGates = results.filter((r) => r.gate && r.present && !r.empty && r.errors.length);

if (asJson) {
  process.stdout.write(JSON.stringify({ engine, engineVersion, modApiVersion, roots: results, failedGates: failedGates.map((r) => r.name) }, null, 2) + '\n');
} else {
  console.log(`引擎：${engine}`);
  console.log(`  引擎版本 ${engineVersion} · 模组 API 版本 ${modApiVersion}（包的 api 区间就是对它比对）`);
  for (const r of results) {
    console.log('');
    const tag = r.gate ? '闸门' : '仅报告';
    console.log(`── ${r.name}/（${r.label} · ${tag}）`);
    if (!r.present) { console.log('     （目录不存在）'); continue; }
    if (r.empty) { console.log('     （空：还没有包）'); continue; }
    for (const p of r.packs) {
      console.log(`   ✓ ${p.id}  ${p.version}  层 ${p.layer ?? '?'}${p.combat ? ' · 会改战斗结果' : ''}  api=${p.api ?? '(未声明)'}  ${p.name ?? ''}`);
    }
    for (const e of r.errors) console.log(`   ✗ ${e.pack}：${e.reason}`);
    if (!r.errors.length) console.log(`     ${r.packs.length} 个包全部装上。`);
    else if (!r.gate) console.log(`     ${r.errors.length} 个包还没装上 —— incoming/ 里这是**正常**的，等兼容（见 incoming/README.md）。`);
  }
  console.log('');
  if (failedGates.length) console.log(`✗ 闸门没过：${failedGates.map((r) => r.name + '/').join(' ')}`);
  else console.log('✓ 闸门通过（packs/ 与 demo/ 里的包全部装上）');
}

process.exit(failedGates.length ? 1 : 0);
