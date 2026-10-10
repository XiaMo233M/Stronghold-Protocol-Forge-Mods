// ui/bondfmt.js —— 盟约效果文本的格式化链，逐字移植自引擎的 `public/js/ui/richText.js`（三个纯函数，无任何 import）。
//
// 为什么可以移植：`formatPlaceholder` / `fillPlaceholders` / `formatBondEffect` 是对**一条盟约记录**做纯计算的函数
// —— 输入 `bond.effectDescRaw` + `bond.effectDescParams` + `bond.bb`，输出展开后的文本。没有 DOM、没有 store、
// 没有网络，所以「包内自己带一份」与「包 import 引擎内部模块」在结果上完全等价，而前者不需要引擎为它开一格接口
// （引擎的内部模块本来就不该被包 import：那正是 §28.12 白名单在防的事）。
//
// 与引擎那份的唯一差别：数值格式判据逐字相同（含 `%` 后缀与四位小数上限、`-0` 折成 `0`），
// 以及层数型概率同样夹在 100 %（引擎那边对应 sim 的 `min(1, …)`，见 richText.js 的注释与 GitHub #108）。

/** 一个占位符的数值格式（`{0:0.0%}` 这类）。与引擎逐字相同。 */
export function formatPlaceholder(value, fmt = '0') {
  const v = Number(value);
  if (!Number.isFinite(v)) return '?';
  const f = typeof fmt === 'string' ? fmt : '0';
  const pct = f.endsWith('%');
  const core = pct ? f.slice(0, -1) : f;
  const dot = core.indexOf('.');
  const decimals = dot >= 0 ? Math.min(4, core.length - dot - 1) : 0;
  const n = pct ? v * 100 : v;
  const fixed = n.toFixed(decimals);
  const clean = Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;
  return pct ? `${clean}%` : clean;
}

/** 把 `{i:fmt}` / `{i}` 换成数值（不认识的索引原样留着）。与引擎逐字相同。 */
export function fillPlaceholders(src, values, formats = []) {
  if (src == null) return '';
  return String(src).replace(/\{(\d{1,2})(?::([^{}]{1,12}))?\}/g, (whole, idx, fmt) => {
    const i = Number(idx);
    const v = Array.isArray(values) ? values[i] : undefined;
    if (v == null) return whole;
    if (typeof v === 'string') return v;
    return formatPlaceholder(v, formats[i] || fmt || '0');
  });
}

/**
 * 一条盟约在**第 layers 层**的效果文本（`{i:fmt}` = `bb[base] + bb[perStack] × layers`）。
 * @param {any} bond bonds.json 的一条记录
 * @param {number} [layers]
 * @returns {string} 富文本（标记原样保留，渲染端决定怎么显示）
 */
export function formatBondEffect(bond, layers = 0) {
  if (!bond || typeof bond !== 'object') return '';
  const src = bond.effectDescRaw || bond.effectDesc || '';
  const params = Array.isArray(bond.effectDescParams) ? bond.effectDescParams : [];
  const bb = bond.bb && typeof bond.bb === 'object' ? bond.bb : {};
  const L = Number.isFinite(Number(layers)) ? Math.max(0, Number(layers)) : 0;
  const values = [];
  const formats = [];
  for (const p of params) {
    if (!p || !Number.isInteger(p.index)) continue;
    const base = Number(bb[p.base]) || 0;
    const per = Number(bb[p.perStack]) || 0;
    // 层数型概率（迅捷 / 不屈 base_prob + prob_per_stack、奇迹 baseprob + prob）夹在 100 %，与 sim 的 min(1, …) 一致
    const chance = /prob/i.test(`${p.base}|${p.perStack}`);
    values[p.index] = chance ? Math.max(0, Math.min(1, base + per * L)) : base + per * L;
    formats[p.index] = p.format || '0';
  }
  return fillPlaceholders(src, values, formats);
}
