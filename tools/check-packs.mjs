#!/usr/bin/env node
// 把本仓库 `packs/` 里的每个包交给**引擎自己的装载器**过一遍：能不能装、报什么错、装成哪一层。
//
//   node tools/check-packs.mjs --engine E:\path\to\Stronghold-Protocol-Forge
//   SP_ENGINE=<引擎目录> node tools/check-packs.mjs
//   node tools/check-packs.mjs --engine <目录> --json      # 机器可读
//
// 为什么要用引擎那一份装载器：包的格式、层级判定与拒绝理由是**引擎决定的**，本仓库只是存放处。
// 在这里抄一份校验规则，规则一升级就会漂 —— 于是「兼容」就变成猜。
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = join(ROOT, 'packs');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const asJson = argv.includes('--json');
const engineArg = flag('--engine', process.env.SP_ENGINE || null);

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
if (!existsSync(PACKS)) {
  console.error(`本仓库没有 packs/ 目录：${PACKS}`);
  process.exit(2);
}

const mod = await import(pathToFileURL(join(engine, 'server/workshop.js')).href);
const consts = await import(pathToFileURL(join(engine, 'shared/constants.js')).href);

// 装载器会把「为什么拒掉这个包」写进 log；这里收着，和它返回的 errors 一起看。
const notes = [];
const log = { info() {}, debug() {}, warn: (m) => notes.push(String(m)), error: (m) => notes.push(String(m)) };

const loaded = mod.loadWorkshop(PACKS, { log });
const errors = loaded.errors ?? [];
const packs = (loaded.packs ?? []).map((p) => ({
  id: p.id, name: p.name, version: p.version, layer: p.layer ?? null, combat: p.combat ?? null, api: p.api ?? null,
}));

const report = {
  engine,
  engineVersion: consts.APP_VERSION ?? null,
  modApiVersion: consts.MOD_API_VERSION ?? null,
  packRoot: PACKS,
  packs,
  errors,
  notes,
};

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  console.log(`引擎：${engine}`);
  console.log(`  引擎版本 ${report.engineVersion} · 模组 API 版本 ${report.modApiVersion}（包的 api 区间就是对它比对）`);
  console.log(`包根：${PACKS}`);
  console.log('');
  if (!packs.length) console.log('  一个包都没装上。');
  for (const p of packs) {
    console.log(`  ✓ ${p.id}  ${p.version}  层 ${p.layer ?? '?'}${p.combat ? ' · 会改战斗结果' : ''}  api=${p.api ?? '(未声明)'}  ${p.name ?? ''}`);
  }
  if (errors.length) {
    console.log('');
    console.log(`  ✗ ${errors.length} 个包被拒：`);
    for (const e of errors) console.log(`      ${e.pack}：${e.reason}`);
  }
  if (!errors.length && packs.length) {
    console.log('');
    console.log(`全部 ${packs.length} 个包都装上了。`);
  }
}

process.exit(errors.length ? 1 : 0);
