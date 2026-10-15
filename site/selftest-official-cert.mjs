#!/usr/bin/env node
// site/selftest-official-cert.mjs — §4c「官方 mod」证书的判据（本刀**不接生产**，只判形状与红/绿）。
//
//   node site/selftest-official-cert.mjs [--upstream <上游精简包根>] [--engine <引擎检出>]
//
// 上游根取 --upstream > SP_UPSTREAM；引擎取 --engine > SP_ENGINE > 兄弟目录 ../Stronghold-Protocol。
//
// 为什么这么判（每条都在下面真跑）：
//   ① 形状：七道闸 id 唯一、三条提醒都在（这是文案不许被删的判据）。
//   ② 真证据：拿**两个真包**跑 `site/forge-precheck.mjs` 采两份真报告，并**真跑一次**
//      `plugin.mjs check <导入产物> --strict --json` —— 证明 `checks.strictProblems` 那一格是**真数字**，
//      不是编的（`tools/plugin.mjs:307` 给数字、`:309` 定 --strict 的失败条件）。
//   ③ 真红 A：`boss-fixed-pool` 的真报告（dropped=4）⇒ **拒发**，理由点名 dropped-0。
//   ④ 真红 B：`duel-data` 的真报告（dropped=0 且 assumed=0，但 issues 非空 ⇒ ok=false）⇒ **拒发**
//      —— 这一条专证「只看 dropped/assumed 是不够的」。
//   ⑤ 绿：七闸全过的证据（**夹具**，见下面的注释）⇒ 发证，证书字段逐个核。
//   ⑥ 逐闸红：只坏一格也要拒发，且拒绝原因的 id 对得上（"只差一道也不发"）。
//   ⑦ 过期：`revalidate` —— 上游版本变了 / 包字节变了 ⇒ `expired`（= 提醒 ③ 的机器落点）。
//   ⑧ 只读：跑完前后，被检的两个真包 zip 的 sha256 一字不变。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CERT_STATUS, GATES, REMINDERS, STANDARD, STANDARD_VERSION, badgeText, certify, judge, revalidate }
  from './official-mod.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const PRECHECK = path.join(HERE, 'forge-precheck.mjs');
const BOSS_ZIP = path.join(REPO, 'mods', 'boss-fixed-pool', '1.0.0', 'mod.zip');
const DUEL_ZIP = path.join(REPO, 'mods', 'duel-data', '0.1.0', 'mod.zip');

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
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-officialcert-'));

/** 跑一个 node 脚本；返回退出码与 stdout/stderr。 */
function run(entry, args, cwd) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, SP_UPSTREAM: '' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 把一份 forge-precheck 报告转成证书要的证据（**只搬运，不重算**）。 */
function evidenceFromReport(rep, extra = {}) {
  return {
    pack: { packId: rep.input?.packId ?? null, sha256: extra.sha256 ?? null, bytes: rep.input?.bytes ?? null },
    upstream: { version: rep.upstream?.version ?? null, versionSource: rep.upstream?.versionSource ?? null },
    importReport: {
      ok: rep.upstream?.ok === true,
      dropped: rep.upstream?.dropped ?? [],
      assumed: rep.upstream?.assumed ?? [],
      rejected: rep.upstream?.rejected ?? [],
      check: rep.upstream?.check ?? null,
      reportSha256: extra.reportSha256 ?? null,
    },
    strict: extra.strict ?? null,
    engine: { errors: rep.engine?.errors ?? 0, refused: rep.engine?.refused === true, packs: rep.engine?.packs ?? 0 },
    realRun: extra.realRun ?? null,
  };
}

try {
  // ------------------------------------------------------------ ① 形状
  console.log('\n① 形状：闸与提醒');
  check(GATES.length === 7, '七道闸', `${GATES.length} 条`);
  check(new Set(GATES.map((g) => g.id)).size === GATES.length, '闸 id 唯一',
    GATES.map((g) => g.id).join(', '));
  check(REMINDERS.length === 3, '三条提醒都在（文案不许被删）', REMINDERS.map((r) => r.id).join(', '));
  check(REMINDERS.every((r) => Array.isArray(r.where) && r.where.length > 0), '每条提醒都写了必须出现的位置',
    REMINDERS.map((r) => `${r.id}@${r.where.join('+')}`).join(' · '));
  check(REMINDERS.find((r) => r.id === 'cold-start')?.where.includes('submit')
    && REMINDERS.find((r) => r.id === 'not-better')?.where.includes('public')
    && REMINDERS.find((r) => r.id === 'revalidate')?.where.includes('cert'),
    '三条提醒的位置齐（投稿页 / 公开页 / 证书详情）');
  check(STANDARD === 'official-arch' && STANDARD_VERSION === 1, '标准名与规则版本',
    `${STANDARD}@${STANDARD_VERSION}`);

  // ------------------------------------------------------------ ② 真证据
  console.log('\n② 真证据：拿两个真包跑预检，并真跑一次上游 check --strict');
  const bossBefore = fs.existsSync(BOSS_ZIP) ? sha256(BOSS_ZIP) : null;
  const duelBefore = fs.existsSync(DUEL_ZIP) ? sha256(DUEL_ZIP) : null;
  check(!!bossBefore, '真包在', bossBefore ? `${BOSS_ZIP}` : `核不到 ${BOSS_ZIP}`);
  check(!!duelBefore, '真包在', duelBefore ? `${DUEL_ZIP}` : `核不到 ${DUEL_ZIP}`);

  let bossRep = null, duelRep = null, realStrict = null, realRealRun = null;
  if (!UPSTREAM) {
    check(false, '上游根可用', '核不到 —— 既没有 --upstream 也没有 SP_UPSTREAM，③④ 只能红');
  } else {
    for (const [zip, name] of [[BOSS_ZIP, 'boss'], [DUEL_ZIP, 'duel']]) {
      const out = path.join(TMP, `${name}.json`);
      run(PRECHECK, [zip, '--upstream', UPSTREAM, ...ENGINE_ARGS, '--json', '--out', out], REPO);
      let rep = null;
      try { rep = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* 下面记核不到 */ }
      const rs = fs.existsSync(out) ? sha256(out) : null;
      if (name === 'boss') bossRep = rep ? evidenceFromReport(rep, { sha256: sha256(zip), reportSha256: rs }) : null;
      else duelRep = rep ? evidenceFromReport(rep, { sha256: sha256(zip), reportSha256: rs }) : null;
    }
    check(!!bossRep, '采到 boss-fixed-pool 的真报告');
    check(!!duelRep, '采到 duel-data 的真报告');

    // 真跑一次上游的 check --strict：证明 checks.strictProblems 是**真数字**
    const impOut = path.join(TMP, 'imp');
    const imp = run(path.join(UPSTREAM, 'tools', 'plugin.mjs'),
      ['import-forge', BOSS_ZIP, '--out', impOut, '--json'], UPSTREAM);
    check(imp.status === 0 && fs.existsSync(impOut), '把真包真导入到临时目录（上游导入器不执行包内脚本）',
      `退出码 ${imp.status}`);
    const ck = run(path.join(UPSTREAM, 'tools', 'plugin.mjs'), ['check', impOut, '--strict', '--json'], UPSTREAM);
    try {
      const j = JSON.parse(ck.stdout);
      realStrict = { problems: j.problems, warnings: j.warnings, exitCode: ck.status };
    } catch { /* 下面记核不到 */ }
    check(!!realStrict && typeof realStrict.problems === 'number' && typeof realStrict.warnings === 'number',
      'check --strict --json 给出**数字** problems / warnings（这一格不是编的）',
      realStrict ? JSON.stringify(realStrict) : `核不到（退出码 ${ck.status}）`);
    check(!!realStrict && realStrict.exitCode === 0, '--strict 通过时退出码 0', realStrict ? `退出码 ${realStrict.exitCode}` : '核不到');
  }

  // ------------------------------------------------------------ ③ 真红 A
  console.log('\n③ 真红 A：真报告 dropped=4 ⇒ 拒绝发证');
  if (!bossRep) {
    check(false, '拿 boss-fixed-pool 的真报告判一次', '核不到 —— 上游没配置');
  } else {
    const r = certify(bossRep);
    check(r.ok === false, '不发证', `ok=${r.ok}`);
    check(r.certificate === null, 'certificate 是 null');
    check(r.reasons.some((x) => x.startsWith('dropped-0：')), '理由点名 dropped-0', r.reasons.join(' | '));
    check((bossRep.importReport.dropped ?? []).length > 0, '真报告的 dropped 确实非空',
      `${bossRep.importReport.dropped.length} 条`);
  }

  // ------------------------------------------------------------ ④ 真红 B
  console.log('\n④ 真红 B：dropped=0 且 assumed=0，但上游被拒 ⇒ 仍然拒绝发证');
  if (!duelRep) {
    check(false, '拿 duel-data 的真报告判一次', '核不到 —— 上游没配置');
  } else {
    const r = certify(duelRep);
    check((duelRep.importReport.dropped ?? []).length === 0 && (duelRep.importReport.assumed ?? []).length === 0,
      '这一包确实是 dropped=0 / assumed=0', `dropped=${duelRep.importReport.dropped.length} assumed=${duelRep.importReport.assumed.length}`);
    check(duelRep.importReport.ok === false && duelRep.importReport.rejected.length > 0,
      '但它上游被拒（issues 非空）', JSON.stringify(duelRep.importReport.rejected));
    check(r.ok === false, '不发证', `ok=${r.ok}`);
    check(r.reasons.some((x) => x.startsWith('import-ok：')), '理由点名 import-ok', r.reasons.join(' | '));
    check(!r.reasons.some((x) => x.startsWith('dropped-0：')), '而且**不是**因为 dropped（dropped 就是 0）');
  }

  // ------------------------------------------------------------ ⑤ 绿（夹具）
  console.log('\n⑤ 绿：七闸全过的证据 ⇒ 发证');
  // ⚠️ 这一份是**夹具**，不是真跑：真装真跑那一格由站上既有流程填，本刀**不产**（不部署、不跑对局）。
  //    其余六格全部来自上面采到的**真报告**与**真 check**（③ 里那份真报告把 dropped 换成空数组即为夹具）。
  const cleanSha = 'a'.repeat(64);
  const green = {
    pack: { packId: 'green-fixture', sha256: cleanSha, bytes: 1234 },
    upstream: { version: '0.3.0', versionSource: 'MANIFEST.json:app' },
    importReport: { ok: true, dropped: [], assumed: [], rejected: [],
      check: 'check --strict 与 pack 通过；外观走 visual set，数据走 content set。', reportSha256: 'b'.repeat(64) },
    strict: realStrict ?? { problems: 0, warnings: 0, exitCode: 0 },
    engine: { errors: 0, refused: false, packs: 1 },
    realRun: { ranAt: '2026-10-15T00:00:00.000Z', how: '（绿例夹具：本刀不产真跑证据）',
      roomCode: 'FIXTURE', matchHostReady: true, engineVersion: '0.3.0' },
  };
  const g = certify(green, { now: new Date('2026-10-15T00:00:00.000Z') });
  check(g.ok === true, '发证', `ok=${g.ok}${g.reasons.length ? ` · ${g.reasons.join(' | ')}` : ''}`);
  check(!!g.certificate, 'certificate 不是 null');
  check(g.gates.length === 7 && g.gates.every((x) => x.pass), '七道闸逐条 pass（并且每条都给了理由）',
    g.gates.map((x) => x.id).join(', '));
  const c = g.certificate ?? {};
  check(c.standard === STANDARD && c.standardVersion === STANDARD_VERSION, '证书带了标准名与规则版本',
    `${c.standard}@${c.standardVersion}`);
  check(c.status === CERT_STATUS.VALID, 'status=valid', c.status);
  check(c.certifiedAt === '2026-10-15T00:00:00.000Z', 'certifiedAt 是签发时刻', c.certifiedAt);
  check(c.upstream?.version === '0.3.0' && c.upstream?.versionSource === 'MANIFEST.json:app',
    '上游版本指纹两格都记了', `${c.upstream?.version} ← ${c.upstream?.versionSource}`);
  check(!!c.upstream?.importerTool, '记了用的哪条命令', c.upstream?.importerTool);
  check(c.pack?.sha256 === cleanSha && c.pack?.packId === 'green-fixture', '包指纹两格都记了',
    `${c.pack?.packId} · ${String(c.pack?.sha256).slice(0, 12)}…`);
  check(c.checks?.dropped === 0 && c.checks?.assumed === 0, 'checks.dropped / assumed 都是 0',
    `dropped=${c.checks?.dropped} assumed=${c.checks?.assumed}`);
  check(c.checks?.strictProblems === 0 && c.checks?.strictWarnings === 0 && c.checks?.strictExitCode === 0,
    'checks.strictProblems / strictWarnings / strictExitCode 都是 0',
    JSON.stringify({ p: c.checks?.strictProblems, w: c.checks?.strictWarnings, e: c.checks?.strictExitCode }));
  check(typeof c.checks?.importCheckText === 'string' && c.checks.importCheckText.length > 0,
    '同时留下上游那句**人读**的检查结论（字符串，与上面的数字分开）', c.checks?.importCheckText);
  check(c.checks?.engineErrors === 0 && c.checks?.engineRefused === false && c.checks?.enginePacks === 1,
    '装载器三格都对', JSON.stringify({ e: c.checks?.engineErrors, r: c.checks?.engineRefused, p: c.checks?.enginePacks }));
  check(c.checks?.realRun?.matchHostReady === true, '真跑那一格记了 matchHostReady', String(c.checks?.realRun?.matchHostReady));
  check(c.reportSha256 === 'b'.repeat(64), '报告 sha256 也在（两端可复核）', String(c.reportSha256).slice(0, 12));
  const badge = badgeText(c) ?? '';
  check(badge.includes('官方架构'), '公开页徽标写的是「官方架构」（**与「兼容」标签分开展示**）', badge);
  check(badge.includes('0.3.0') && badge.includes(cleanSha.slice(0, 8)), '徽标带上版本指纹与 sha 前 8 位');

  // ------------------------------------------------------------ ⑥ 逐闸红
  console.log('\n⑥ 逐闸红：只坏一格也要拒发，且理由 id 对得上');
  const broke = [
    ['import-ok', { importReport: { ...green.importReport, ok: false, rejected: [{ code: 'X', detail: 'y' }] } }],
    ['dropped-0', { importReport: { ...green.importReport, dropped: [{ path: 'a/b.json', zh: '文件在包里，但 pack.json 没有引用它，没有导入。' }] } }],
    ['assumed-0', { importReport: { ...green.importReport, assumed: [{ zh: '猜了一把' }] } }],
    ['strict-0', { strict: { problems: 1, warnings: 0, exitCode: 1 } }],
    ['strict-0', { strict: { problems: 0, warnings: 1, exitCode: 1 } }],   // --strict 下 warning 也算不过
    ['strict-0', { strict: null }],
    ['engine-clean', { engine: { errors: 1, refused: false, packs: 1 } }],
    ['engine-clean', { engine: { errors: 0, refused: true, packs: 1 } }],
    ['real-run', { realRun: null }],
    ['real-run', { realRun: { ...green.realRun, matchHostReady: false } }],
    ['fingerprint', { pack: { ...green.pack, sha256: 'not-a-hash' } }],
    ['fingerprint', { upstream: { version: '', versionSource: 'MANIFEST.json:app' } }],
  ];
  for (const [id, patch] of broke) {
    const r = certify({ ...green, ...patch });
    const hit = r.ok === false && r.reasons.some((x) => x.startsWith(`${id}：`));
    check(hit, `坏「${id}」⇒ 拒发且理由点名它`, hit ? r.reasons[0] : `ok=${r.ok} reasons=${r.reasons.join(' | ')}`);
  }

  // ------------------------------------------------------------ ⑦ 过期
  console.log('\n⑦ 过期：上游升级 / 包字节变了 ⇒ expired（提醒 ③ 的机器落点）');
  const rv1 = revalidate(c, { upstreamVersion: '0.3.0', packSha256: cleanSha });
  check(rv1.status === CERT_STATUS.VALID && rv1.reasons.length === 0, '版本与字节都没变 ⇒ valid', rv1.status);
  const rv2 = revalidate(c, { upstreamVersion: '0.3.1', packSha256: cleanSha });
  check(rv2.status === CERT_STATUS.EXPIRED, '上游升到 0.3.1 ⇒ expired', rv2.reasons.join(' | '));
  const rv3 = revalidate(c, { upstreamVersion: '0.3.0', packSha256: 'c'.repeat(64) });
  check(rv3.status === CERT_STATUS.EXPIRED, '包字节变了 ⇒ expired', rv3.reasons.join(' | '));
  const rv4 = revalidate(c, { upstreamVersion: null, packSha256: null });
  check(rv4.status === CERT_STATUS.EXPIRED, '核不到当前版本/字节 ⇒ expired（不许默认有效）', rv4.reasons.join(' | '));
  check((badgeText({ ...c, status: CERT_STATUS.EXPIRED }) ?? '').includes('已过期'), '过期后徽标如实写「已过期」');
  check(judge(green).length === 7, 'judge() 与 certify() 用的是同一份闸（不重判一遍）');

  // ------------------------------------------------------------ ⑧ 只读
  console.log('\n⑧ 只读：跑完前后两个真包 zip 的 sha256 一字不变');
  check(sha256(BOSS_ZIP) === bossBefore, 'boss-fixed-pool/mod.zip 未变', `${String(bossBefore).slice(0, 16)}…`);
  check(sha256(DUEL_ZIP) === duelBefore, 'duel-data/mod.zip 未变', `${String(duelBefore).slice(0, 16)}…`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('');
if (failures) { console.log(`✖ ${failures} 项没通过`); process.exit(1); }
console.log('✔ §4c 官方 mod 证书判据通过');
