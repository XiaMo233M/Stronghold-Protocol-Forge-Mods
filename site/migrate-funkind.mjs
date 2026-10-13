// 老记录**功能类目迁移**工具（业主 2026-10-14 口径）。
//
//   node site/migrate-funkind.mjs --data /var/lib/sp-modsite          # ① 站上：干跑，打印「将写清单」
//   node site/migrate-funkind.mjs --mirror <仓库>/mods                # ② 本机：拿仓库镜像干跑（离线）
//   ADMIN_TOKEN=… node site/migrate-funkind.mjs --data … --write --base http://127.0.0.1:25570
//
// ⚠️ 三条纪律（业主口径，写死在这里）：
//   ① **不回填、不瞎猜**：`funcKind` 缺省读出来就是 `uncategorized`（未分类）—— 站点侧不需要
//      为「未分类」写任何东西。所以本工具**只写「明确无误」的那一批**，其余**一个字节都不写**
//      （写了只会给记录多加一笔毫无信息量的 revisions）。
//   ② **明确无误的判据只有一条**：`packKind === 'documentation'` ⇒ 拟写 `funcKind = 'documentation'`。
//      这是**技术维度的直接翻译**（说明文档装上不启用功能），不需要猜「这包是干什么的」。
//      ⚠️ 其它任何情况（含 `packKind === 'functional'` 的那 31 条）**一律不写**，
//      逐条标「留未分类，待人工过」—— 从「装上会生效」推不出「它是玩法还是工具还是素材」。
//   ③ **绝不用批量形状**：`--write` 是**一条一个请求**打 `POST /api/<ADMIN_PATH>/funkind`
//      （端点本身就拒 `ids`/`batch`/`items`/`list`），走站点自己的留痕（revisions + audit）。
//
// ⚠️ 凭据纪律：`ADMIN_TOKEN` **只从环境变量读**，不进 argv、不进日志、**连长度都不打印**。
// ⚠️ 默认**干跑**：不加 `--write` 就只打印清单，磁盘与站点一个字节都不动。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fb = null) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? true) : fb; };
const has = (name) => argv.includes(name);
const rj = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

const DATA = flag('--data', null);
const MIRROR = flag('--mirror', null);
const WRITE = has('--write');
const BASE = String(flag('--base', process.env.BASE_URL || '')).replace(/\/+$/, '');
const ADMIN_PATH = String(flag('--admin-path', process.env.ADMIN_PATH || 'admin')).trim();
const AREAS = ['submissions', 'flagged', 'compat'];

if (!DATA && !MIRROR) {
  console.error('用法：node site/migrate-funkind.mjs --data /var/lib/sp-modsite [--write --base http://127.0.0.1:25570]');
  console.error('  或：node site/migrate-funkind.mjs --mirror <仓库>/mods');
  process.exit(2);
}

/** 采集记录：站上按目录列举（与 tools/collect-station.mjs:106-117 同一口径），镜像按 <id>/<版本> 列举。 */
function collect() {
  const out = [];
  if (DATA) {
    const root = resolve(String(DATA));
    for (const area of AREAS) {
      const dir = join(root, area);
      if (!existsSync(dir)) continue;
      for (const rid of readdirSync(dir).sort()) {
        const rd = join(dir, rid);
        try { if (!statSync(rd).isDirectory()) continue; } catch { continue; }
        const meta = rj(join(rd, 'meta.json'));
        if (!meta) continue;
        const dec = rj(join(rd, 'decision.json')) || null;
        out.push({
          id: meta.id || rid, area, dir: rd, name: meta.name ?? null,
          packKind: meta.packKind ?? null, funcKind: meta.funcKind ?? null,
          state: dec ? dec.decision : 'pending', from: `${area}/${rid}`,
        });
      }
    }
    return out;
  }
  const root = resolve(String(MIRROR));
  for (const packEnt of readdirSync(root)) {
    if (packEnt === 'index.json') continue;
    const packDir = join(root, packEnt);
    try { if (!statSync(packDir).isDirectory()) continue; } catch { continue; }
    for (const ver of readdirSync(packDir)) {
      const vd = join(packDir, ver);
      try { if (!statSync(vd).isDirectory()) continue; } catch { continue; }
      const meta = rj(join(vd, 'meta.json'));
      if (!meta) continue;
      const dec = rj(join(vd, 'decision.json')) || null;
      out.push({
        id: meta.id || null, area: meta.area ?? '(镜像)', dir: vd, name: meta.name ?? null,
        packKind: meta.packKind ?? null, funcKind: meta.funcKind ?? null,
        state: dec ? dec.decision : 'pending', from: `mods/${packEnt}/${ver}`,
      });
    }
  }
  return out;
}

const recs = collect();

// ── 分类：**只认一条明确无误的判据** ──
const willWrite = [];       // 拟写（明确无误）
const leaveAlone = [];      // 留未分类，待人工过（不写盘）
const already = [];         // 已经有 funcKind 了：不碰（幂等）
for (const r of recs) {
  if (r.funcKind) { already.push({ ...r, basis: `已经有 funcKind=${r.funcKind} ⇒ 不碰（幂等）` }); continue; }
  if (r.packKind === 'documentation') {
    willWrite.push({ ...r, target: 'documentation', basis: 'packKind=documentation ⇒ 技术维度的直接翻译（说明文档装上不启用功能），无需猜' });
    continue;
  }
  leaveAlone.push({
    ...r, target: null,
    basis: r.packKind === 'functional'
      ? 'packKind=functional：只知道「装上会生效」，**推不出**它是玩法/拓展/工具/素材 ⇒ 留未分类，待人工过（**不写盘**）'
      : `packKind=${r.packKind === null ? '（缺失）' : r.packKind}：判不出 ⇒ 留未分类，待人工过（**不写盘**）`,
  });
}

const pad = (s, n) => { const t = String(s ?? '—'); return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length); };
const show = (rows) => {
  for (const r of rows) {
    console.log(`  ${pad(r.id, 14)} | ${pad(r.name, 26)} | 现 packKind=${pad(r.packKind ?? '（缺失）', 14)} | 拟写 funcKind=${pad(r.target ?? '（不写）', 14)} | ${r.basis}`);
  }
};

console.log(`来源：${DATA ? `站上数据目录 ${resolve(String(DATA))}` : `仓库镜像 ${resolve(String(MIRROR))}`}`);
console.log(`共 ${recs.length} 条记录。`);
console.log('');
console.log(`【甲】将写清单（明确无误，共 ${willWrite.length} 条）—— 逐条：id / 名称 / 现 packKind / 拟写 funcKind / 依据`);
show(willWrite);
if (!willWrite.length) console.log('  （空）');
console.log('');
console.log(`【乙】留未分类，待人工过（**不写盘**，共 ${leaveAlone.length} 条）`);
show(leaveAlone);
console.log('');
console.log(`【丙】已经有 funcKind，不碰（共 ${already.length} 条）`);
show(already);
console.log('');
console.log(`汇总：拟写 ${willWrite.length} 条 · 不写、待人工过 ${leaveAlone.length} 条 · 已有、不碰 ${already.length} 条。`);
console.log('⚠️ 「不写」那批**不需要任何动作**：站点读 `funcKind` 缺省就是 `uncategorized`（未分类），');
console.log('   它们现在就已经落在公开面的「未分类」区里，等维护者在审核详情页一条一条过。');

if (!WRITE) {
  console.log('');
  console.log('（干跑：只打印清单，磁盘与站点一个字节都没动。要真写加 --write 与 --base。）');
  process.exit(0);
}

if (!willWrite.length) {
  console.log('');
  console.log('没有「明确无误」的条目要写 ⇒ **不发任何请求**（不制造空跑）。');
  process.exit(0);
}
if (!BASE) { console.error('✖ --write 需要 --base（站点地址），例如 --base http://127.0.0.1:25570'); process.exit(2); }
const TOKEN = process.env.ADMIN_TOKEN || '';
if (!TOKEN) { console.error('✖ --write 需要环境变量 ADMIN_TOKEN（只从环境变量读，不进 argv、不打印）'); process.exit(2); }

console.log('');
console.log(`开始写入：逐条 POST ${BASE}/api/${ADMIN_PATH}/funkind（**一条一个请求**，绝不批量形状）`);
let okN = 0; let badN = 0;
for (const r of willWrite) {
  const res = await fetch(`${BASE}/api/${ADMIN_PATH}/funkind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ id: r.id, funcKind: r.target }),   // ← 只带这一个 id
  });
  let j = {};
  try { j = await res.json(); } catch { j = {}; }
  if (res.ok) { okN++; console.log(`  ✓ ${r.id} → ${r.target}${j.changed === false ? '（本来就已是这个值，未写盘）' : ''}`); }
  else { badN++; console.log(`  ✗ ${r.id} → HTTP ${res.status} ${j.error || ''}`); }
}
console.log(`写入完成：成功 ${okN} 条 · 失败 ${badN} 条。`);
process.exit(badN ? 1 : 0);
