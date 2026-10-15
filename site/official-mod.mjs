// site/official-mod.mjs — §4c「官方 mod」证书：**只做判据与字段形状**。
//
// ⚠️ 本模块**不接生产**：`site/server.mjs` 与 `site/pages/**` 一字未动，**不部署、不改服务**。
//    设计、文案、每个字段的来源与「怎么核」见 `site/OFFICIAL-MOD.md`。
//
// 为什么这么切（三条，都是本仓既有纪律）：
// ① **证书只由证据算，自己不跑任何东西。** 上游导入器 / `check --strict` / 我们装载器 / 真装真跑
//    四份证据各有来源（见 OFFICIAL-MOD.md 的字段表）；本模块只判「齐不齐、过不过」并定形状。
// ② **判据只有一份。** 这里读的字段名与 `site/forge-precheck.mjs` 的报告**逐字对齐**
//    （`upstream.dropped` / `upstream.assumed` / `upstream.version` / `upstream.versionSource` /
//    `engine.errors` / `engine.refused` / `engine.packs`）—— 不在这里重跑导入器、不重算引用集
//    （AGENTS.md §3「不抄规则」）。
// ③ **「上游一升级就过期」是机器可判的**（`revalidate`），不是文案里的一句话 —— 否则标签会悄悄过期，
//    而提醒 ③ 要说的正是这件事。
//
// 术语：本文件里的「证据（evidence）」= 上面那四份东西的**已采集结果**；「证书（certificate）」= 判过之后的形状。

// ---------------------------------------------------------------- 标准与版本
/** 标准名（闭枚举：目前只有这一档）。 */
export const STANDARD = 'official-arch';
/**
 * 本证书**规则**的版本。规则（哪几道闸、字段含义）一改就要抬 —— 否则旧证书的含义会跟着漂。
 * 与 `upstream.version`（上游软件版本）是**两个不同的版本号**，别混。
 */
export const STANDARD_VERSION = 1;

/** 证书状态：`valid` 可展示；`expired` 只留档、不再当作有效标签。 */
export const CERT_STATUS = Object.freeze({ VALID: 'valid', EXPIRED: 'expired' });

// ---------------------------------------------------------------- 三条必须出现在界面上的提醒
// ⚠️ 文案**只此一份**：投稿页 / 公开页 / 证书详情都从这里取，不许各自抄一份（抄了就会漂）。
// `where` 是**必须出现的位置**，由判据盯着（selftest-official-cert.mjs ⑥）。
export const REMINDERS = Object.freeze([
  {
    id: 'cold-start',
    where: Object.freeze(['submit', 'public']),
    text: '⭐ 一开始会很冷清：实测 52 个真投稿里只有 1 个做到「0 丢弃 + 0 猜测」。'
      + '它是**标准**，不是主流 —— 请允许它长期是一小众档。',
  },
  {
    id: 'not-better',
    where: Object.freeze(['submit', 'public']),
    text: '⭐ 它**不等于「更好的 mod」**：官方架构面**比本站的面窄** —— 少 5 个界面挂载点、'
      + '少 tier2–6 与 `@ops/` 官方 kit、少字段级 `overrides` 与口径（`variants`）通道。'
      + '换来的是**跨站可用 + 可核验**，**不是功能更强**。',
  },
  {
    id: 'revalidate',
    where: Object.freeze(['cert']),
    text: '⭐ **上游一升级就要复验**：证书里记的是签发时的上游版本 + 包字节 SHA-256。'
      + '上游出新版本后，这条证书会变成「已过期」，必须重跑一次才会重新有效。',
  },
]);

// ---------------------------------------------------------------- 七道闸
/**
 * 每道闸一条；`id` 是机器可读的拒绝原因，判据按 id 断言。`文件:行` 是这道闸的**依据来源**。
 */
export const GATES = Object.freeze([
  { id: 'import-ok', label: '上游导入器 ok=true 且 issues 为空',
    from: 'import-forge --dry-run --json 的 ok / issues（上游 server/plugins/forgeImport.js:2180-2193）' },
  { id: 'dropped-0', label: '上游 dropped = 0 条',
    from: '同一份报告的 skipped（forge-precheck.mjs:129 读进 upstream.dropped）' },
  { id: 'assumed-0', label: '上游 ASSUMED = 0 条',
    from: '同一份报告的 assumed（forge-precheck.mjs:131）' },
  { id: 'strict-0', label: '上游 check --strict 的 problems 与 warnings 都是 0',
    from: '独立跑 `plugin.mjs check <导入产物> --strict --json`：数字在 :307，'
      + '--strict 的失败条件在 :309（`problems || (strict && warnings)`）' },
  { id: 'engine-clean', label: '我们装载器未拒包、0 error、恰好装载 1 个包',
    from: 'forge-precheck.mjs:167-175 的 engine.refused / errors / packs' },
  { id: 'real-run', label: '真装真跑：match host 就绪，且有房间码或 seed',
    from: '站上既有真装真跑流程（照 §5 的实测口径；本模块**不产**这份证据）' },
  { id: 'fingerprint', label: '指纹齐：上游版本 + 来源字段 + 包字节 SHA-256（64 位 hex）',
    from: '上游版本取自 MANIFEST.json:app，退 package.json:version（forge-precheck.mjs:85-95）；'
      + 'SHA-256 由站侧对 mod.zip 现算' },
]);

const HEX64 = /^[0-9a-f]{64}$/i;
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);

/**
 * 逐道闸判证据。返回 `[{ id, pass, reason }]` —— **每道闸都给理由**（过了也给），
 * 因为「为什么算过」和「为什么没过」都要能复核。
 *
 * @param {object} ev 证据（见 OFFICIAL-MOD.md 的字段表）
 * @returns {{id: string, pass: boolean, reason: string}[]}
 */
export function judge(ev) {
  const e = isObj(ev) ? ev : {};
  const imp = isObj(e.importReport) ? e.importReport : {};
  const up = isObj(e.upstream) ? e.upstream : {};
  const st = isObj(e.strict) ? e.strict : null;
  const en = isObj(e.engine) ? e.engine : {};
  const rr = isObj(e.realRun) ? e.realRun : null;
  const pk = isObj(e.pack) ? e.pack : {};

  const dropped = asArray(imp.dropped);
  const assumed = asArray(imp.assumed);
  const issues = asArray(imp.rejected);

  const v = (ok, reason) => ({ pass: ok, reason });
  const out = [];

  out.push({ id: 'import-ok', ...v(
    imp.ok === true && issues.length === 0,
    imp.ok === true && issues.length === 0
      ? '上游 ok=true、issues 空'
      : `上游 ok=${imp.ok}、issues ${issues.length} 条`
        + (issues.length ? `（首条 ${issues[0]?.code ?? '?'}：${issues[0]?.detail ?? ''}）` : '')
        + ' —— 有 issue 就等于没导入成功，后面的闸都不必看') });

  out.push({ id: 'dropped-0', ...v(dropped.length === 0,
    dropped.length === 0 ? 'dropped = 0 条'
      : `dropped = ${dropped.length} 条（${dropped.slice(0, 5).map((d) => d?.path ?? d).join(' / ')}${dropped.length > 5 ? ' …' : ''}）`) });

  out.push({ id: 'assumed-0', ...v(assumed.length === 0,
    assumed.length === 0 ? 'ASSUMED = 0 条'
      : `ASSUMED = ${assumed.length} 条（${assumed.slice(0, 3).map((a) => a?.zh ?? a?.what ?? a).join(' / ')}${assumed.length > 3 ? ' …' : ''}）`) });

  // ⚠️ 要求 warnings 也是 0：上游 `--strict` 的失败条件就是 `problems || warnings`（tools/plugin.mjs:309）
  //    ⇒ 说「check --strict 通过」却放过 warning，就是自相矛盾。
  out.push({ id: 'strict-0', ...v(
    !!st && st.problems === 0 && st.warnings === 0 && st.exitCode === 0,
    !st ? '核不到：没有独立跑 `plugin.mjs check <导入产物> --strict --json` 的证据'
      : st.problems === 0 && st.warnings === 0 && st.exitCode === 0
        ? 'check --strict 0 problem / 0 warning / 退出码 0'
        : `check --strict problems=${st.problems} warnings=${st.warnings} 退出码=${st.exitCode}`) });

  out.push({ id: 'engine-clean', ...v(
    en.refused === false && en.errors === 0 && en.packs === 1,
    en.refused === false && en.errors === 0 && en.packs === 1
      ? '我们装载器未拒包、0 error、装载 1 个包'
      : `装载器 refused=${en.refused} errors=${en.errors} packs=${en.packs}`) });

  const ranOk = !!rr && rr.matchHostReady === true && (isNonEmptyStr(rr.roomCode) || isNonEmptyStr(rr.seed));
  out.push({ id: 'real-run', ...v(ranOk,
    !rr ? '核不到：没有真装真跑的证据（本模块不产这一份 —— 由站上既有真装真跑流程填）'
      : ranOk ? `真跑于 ${rr.ranAt ?? '(无时刻)'} · ${rr.how ?? '(无说明)'}`
        : `真跑证据不完整：matchHostReady=${rr.matchHostReady} 房间码/seed=${rr.roomCode ?? rr.seed ?? '(都空)'}`) });

  const fpOk = isNonEmptyStr(up.version) && isNonEmptyStr(up.versionSource) && HEX64.test(String(pk.sha256 ?? ''));
  out.push({ id: 'fingerprint', ...v(fpOk,
    fpOk ? `上游 ${up.version} ← ${up.versionSource} · sha256 ${String(pk.sha256).slice(0, 16)}…`
      : `上游 version=${up.version ?? '(空)'} versionSource=${up.versionSource ?? '(空)'}`
        + ` sha256=${pk.sha256 ? '不是 64 位 hex' : '(空)'}`) });

  return out;
}

/**
 * 判证据并发证书。**不写盘、不联网、不跑任何东西** —— 纯函数（这样判据才咬得住）。
 *
 * @param {object} ev 证据
 * @param {{ now?: Date }} [opts] 只在判据里注入固定时刻，便于逐字比对
 * @returns {{ ok: boolean, gates: object[], certificate: object|null, reasons: string[] }}
 */
export function certify(ev, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const gates = judge(ev);
  const failed = gates.filter((g) => !g.pass);

  // 没过就**不发证书**，哪怕只差一道 —— 证书的含义是「七道全过」。
  if (failed.length) {
    return { ok: false, gates, certificate: null, reasons: failed.map((g) => `${g.id}：${g.reason}`) };
  }

  const imp = ev.importReport;
  const st = ev.strict;
  const rr = ev.realRun;
  const certificate = {
    standard: STANDARD,
    standardVersion: STANDARD_VERSION,
    certifiedAt: now.toISOString(),
    status: CERT_STATUS.VALID,
    upstream: {
      version: ev.upstream.version,
      versionSource: ev.upstream.versionSource,
      importerTool: ev.upstream.importerTool ?? 'tools/plugin.mjs import-forge --dry-run',
    },
    pack: { packId: ev.pack.packId, sha256: ev.pack.sha256, bytes: ev.pack.bytes ?? null },
    checks: {
      dropped: asArray(imp.dropped).length,
      assumed: asArray(imp.assumed).length,
      // 上游报告里那句**人读**的检查结论（实测形如「check --strict 与 pack 通过；…」），原样存下
      importCheckText: typeof imp.check === 'string' ? imp.check : null,
      // 独立跑出来的**数字**（机器判的那一份）
      strictProblems: st.problems,
      strictWarnings: st.warnings,
      strictExitCode: st.exitCode,
      engineErrors: ev.engine.errors,
      engineRefused: ev.engine.refused,
      enginePacks: ev.engine.packs,
      realRun: {
        ranAt: rr.ranAt ?? null, how: rr.how ?? null,
        roomCode: rr.roomCode ?? null, seed: rr.seed ?? null,
        matchHostReady: rr.matchHostReady === true,
        engineVersion: rr.engineVersion ?? null, reportRef: rr.reportRef ?? null,
      },
    },
    // 预检报告那份 json 的 sha256：两端可以拿同一个包重跑、逐字复核
    reportSha256: imp.reportSha256 ?? null,
  };
  return { ok: true, gates, certificate, reasons: [] };
}

/**
 * 复验：证书是不是还作数。**这就是提醒 ③ 的机器落点。**
 * 判据两条：上游版本与签发时不同 ⇒ 过期；包字节 SHA-256 变了 ⇒ 过期（内容换了，旧证明不覆盖新字节）。
 *
 * @param {object} cert 证书
 * @param {{ upstreamVersion: string, packSha256: string }} now 现在这枚包的上游版本与字节哈希
 * @returns {{ status: string, reasons: string[] }}
 */
export function revalidate(cert, now) {
  const reasons = [];
  if (!isObj(cert)) return { status: CERT_STATUS.EXPIRED, reasons: ['证书不存在'] };
  const issued = cert.upstream?.version ?? null;
  if (!isNonEmptyStr(now?.upstreamVersion)) reasons.push('核不到当前上游版本 ⇒ 不能判定有效');
  else if (issued !== now.upstreamVersion) {
    reasons.push(`上游已从 ${issued} 升到 ${now.upstreamVersion} ⇒ 必须复验（重跑一次才会重新有效）`);
  }
  const cur = String(now?.packSha256 ?? '');
  if (!HEX64.test(cur)) reasons.push('核不到当前包字节 SHA-256 ⇒ 不能判定有效');
  else if (cert.pack?.sha256 !== cur) reasons.push('包字节变了（SHA-256 与签发时不一致）⇒ 旧证明不覆盖新字节');
  return { status: reasons.length ? CERT_STATUS.EXPIRED : CERT_STATUS.VALID, reasons };
}

/**
 * 公开页徽标文案 —— **与「兼容」栏分开**（`where` 也分开展示，不合并成一栏）。
 * ⚠️ 这里给的是公开页那一行字；三条提醒由页面从 REMINDERS 取，不在这里拼。
 */
export function badgeText(cert) {
  if (!isObj(cert)) return null;
  const ver = cert.upstream?.version ?? '核不到';
  const sha = String(cert.pack?.sha256 ?? '').slice(0, 8) || '核不到';
  const tail = cert.status === CERT_STATUS.VALID
    ? `上游 ${ver} · sha256 ${sha}`
    : '已过期 —— 上游升级后未复验';
  return `官方架构（已核验）：0 丢弃 · 0 猜测 · check --strict 通过 · 真跑通过 · ${tail}`;
}
