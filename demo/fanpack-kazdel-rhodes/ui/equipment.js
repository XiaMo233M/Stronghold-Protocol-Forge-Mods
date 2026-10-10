// ui/equipment.js — 装备总览（Equipment codex）面板：每一档的每一件装备、它所属的盟约、普通 / 精锐两版效果并排看。
//
// 原件是 `public/js/screens/equipment.js`（317 行）＋ `public/css/screens/equipment.css`（66 行），
// 它**就地新增一个屏幕**并要求 `main.js` 认识 `openEquipCodex()` / `<EquipHost/>`／`index.html` 加一行 `<link>`
// —— 那是「改引擎」。这里改成 C 层的一个普通面板：
//
//   * 挂点 `root.overlays`（引擎按需创建容器的四个浮层之一），开关是**面板自己的**一个按钮；
//   * 数据来自 `ctx.data.get('items' | 'bonds' | 'assets')`（只读冻结快照，三张表都在白名单里）；
//   * 样式写在 `pack.json` 的 `client.panels[].styles[]` 里，引擎不认「装备总览」这件事。
//
// **纯模型函数逐字移植**（cmpItems / codexRows / effectTexts / usedBonds / filterRows / groupByTier）：它们是纯函数，
// 原件自己的测试就是无 DOM 驱动的，所以这一半是等价而不是重写。渲染那一半从 Preact 换成纯 DOM 助手
// （`./dom.js`，与其它交付面板同一套 —— 注入面不给 Preact，也不该给：一个只读图鉴不需要它）。
//
// 边界：拿不到 store / match / battle；不改任何对局状态（纯展示）。

import { el, attrs, clear, tr } from './dom.js';

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const TIERS = [1, 2, 3, 4, 5, 6];
export const NO_BOND = '__none';

/** 档位先、商店序次之、名字最后（与原件同一个比较器）。 */
export function cmpItems(a, b) {
  return (a.tier ?? 0) - (b.tier ?? 0)
    || (a.shopSortId ?? 0) - (b.shopSortId ?? 0)
    || String(a.name).localeCompare(String(b.name), 'zh');
}

/**
 * 每件装备一行：普通记录（`isGolden` false）配上它经 `goldenId` 解析出的精锐记录。
 * 隐藏的那些（`hideInShop` / `shopExcluded`）也列出来 —— 它们是这一档的装备，只是详情栏会标一下。
 */
export function codexRows(list, lookup) {
  const rows = [];
  for (const rec of Array.isArray(list) ? list : []) {
    if (!rec || rec.isGolden) continue;
    const golden = rec.goldenId ? lookup(rec.goldenId) : null;
    rows.push({ ...rec, golden: golden || null });
  }
  rows.sort(cmpItems);
  return rows;
}

/** 一件装备的两段效果文本（普通 / 精锐），空的那个是 `null`。 */
export function effectTexts(row) {
  const pick = (r) => {
    if (!r) return null;
    const v = r.effect ?? r.description ?? r.desc ?? null;
    return typeof v === 'string' && v.trim() ? v : null;
  };
  return { normal: pick(row), golden: pick(row.golden) };
}

/** 这批行用到过哪些盟约 id（按出现次序去重，且只留 `bonds` 表里真的有的）。 */
export function usedBonds(rows, bonds) {
  const seen = new Set();
  for (const r of rows) {
    const b = r.bond ?? r.bondId ?? null;
    if (b && !seen.has(b)) seen.add(b);
  }
  return [...seen].filter((id) => !bonds || Object.hasOwn(bonds, id));
}

/** 过滤：档位 / 盟约 / 搜索串 / 是否只看商店可售。搜索覆盖名字、id 与盟约名。 */
export function filterRows(rows, filters = {}, bondNames = {}) {
  const { tier = null, bond = null, query = '', shopOnly = false } = filters;
  const q = String(query || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (tier != null && (r.tier ?? 0) !== tier) return false;
    if (shopOnly && (r.hideInShop || r.shopExcluded)) return false;
    if (bond != null) {
      const b = r.bond ?? r.bondId ?? NO_BOND;
      if (bond === NO_BOND ? !!b : b !== bond) return false;
    }
    if (q) {
      const hay = `${r.name ?? ''} ${r.id ?? ''} ${bondNames[r.bond ?? r.bondId] ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 按档位分组（档位升序，组内保持传入次序）。 */
export function groupByTier(rows) {
  const out = [];
  for (const tier of TIERS) {
    const group = rows.filter((r) => (r.tier ?? 0) === tier);
    if (group.length) out.push({ tier, rows: group });
  }
  return out;
}

/** 一个盟约的显示名：能从 `bonds` 表拿到就用它，否则退回 id 本身。 */
const bondName = (bonds, id) => (id && bonds && bonds[id] && bonds[id].name) || id || '';

/**
 * 面板入口（C 层契约：`mount(ctx)` 返回 `{ unmount }`，自己画 DOM）。
 * @param {{ host: any, data: { get(name: string): any }, log?: any }} ctx
 */
export function mount(ctx) {
  const host = ctx && ctx.host;
  if (!host || typeof host.appendChild !== 'function') return {};
  const get = (name) => (ctx.data && typeof ctx.data.get === 'function' ? ctx.data.get(name) : null) || {};

  const items = get('items');
  const bonds = get('bonds');
  const assets = get('assets');
  const list = Object.values(items);

  /** 图标：装备图标走 `assets.items[id]`，盟约图标走 `assets.bondIcons[id]`（都是引擎既有的表）。 */
  const iconOf = (table, id) => {
    const bag = assets && typeof assets === 'object' ? assets[table] : null;
    const v = bag && typeof bag === 'object' ? bag[id] : null;
    return typeof v === 'string' && v ? v : null;
  };

  const rows = codexRows(list, (id) => items[id]);
  const bondIds = usedBonds(rows, bonds);
  const names = Object.fromEntries(bondIds.map((id) => [id, bondName(bonds, id)]));

  /** 面板自己的状态（纯本地，不碰 store：一个只读图鉴没有可同步的东西）。 */
  let open = false;
  let sel = null;
  let filters = { tier: null, bond: null, query: '', shopOnly: false };

  const root = el('div', 'fx-cx');
  host.appendChild(root);

  const onKey = (e) => { if (open && e.key === 'Escape') { open = false; draw(); } };

  /** 重建整个面板（数据是只读快照，没有增量更新这回事；几百件装备重建一次是毫秒级）。 */
  function draw() {
    clear(root);
    if (!open) {
      const b = el('button', 'fx-cx__open');
      attrs(b, { type: 'button' });
      b.appendChild(el('span', 'fx-cx__openlabel', tr(null, '装备总览')));
      b.appendChild(el('span', 'fx-cx__openmicro', 'EQUIPMENT CODEX'));
      b.addEventListener('click', () => { open = true; draw(); });
      root.appendChild(b);
      return;
    }

    const panel = el('div', 'fx-cx__panel');
    attrs(panel, { role: 'dialog', 'aria-label': tr(null, '装备总览') });

    // 顶栏：标题 + 搜索 + 关闭
    const bar = el('div', 'fx-cx__bar');
    bar.appendChild(el('b', 'fx-cx__title', tr(null, '装备总览')));
    const q = el('input', 'fx-cx__q');
    attrs(q, { type: 'search', value: filters.query, placeholder: tr(null, '搜索装备…') });
    q.addEventListener('input', () => { filters = { ...filters, query: q.value }; draw(); });
    bar.appendChild(q);
    const close = el('button', 'fx-cx__close');
    attrs(close, { type: 'button', 'aria-label': tr(null, '关闭') });
    close.textContent = tr(null, '关闭');
    close.addEventListener('click', () => { open = false; draw(); });
    bar.appendChild(close);
    panel.appendChild(bar);

    // 筛选：档位 / 仅商店 / 盟约
    const chips = el('div', 'fx-cx__chips');
    const chip = (label, on, onClick, extra) => {
      const b = el('button', `fx-cx__chip${on ? ' is-on' : ''}`);
      attrs(b, { type: 'button', 'aria-pressed': on ? 'true' : 'false' });
      if (extra) b.appendChild(extra);
      b.appendChild(el('span', null, label));
      b.addEventListener('click', onClick);
      chips.appendChild(b);
      return b;
    };
    chip(tr(null, '全部'), filters.tier == null, () => { filters = { ...filters, tier: null }; draw(); });
    for (const tier of TIERS) {
      chip(ROMAN[tier], filters.tier === tier,
        () => { filters = { ...filters, tier: filters.tier === tier ? null : tier }; draw(); });
    }
    chip(tr(null, '仅商店'), filters.shopOnly, () => { filters = { ...filters, shopOnly: !filters.shopOnly }; draw(); });
    panel.appendChild(chips);

    const bchips = el('div', 'fx-cx__chips');
    const bchip = (label, on, onClick, img) => {
      const b = el('button', `fx-cx__chip${on ? ' is-on' : ''}`);
      attrs(b, { type: 'button', 'aria-pressed': on ? 'true' : 'false' });
      if (img) {
        const i = el('img', 'fx-cx__bicon');
        attrs(i, { src: img, alt: '' });
        b.appendChild(i);
      }
      b.appendChild(el('span', null, label));
      b.addEventListener('click', onClick);
      bchips.appendChild(b);
    };
    bchip(tr(null, '全部盟约'), filters.bond == null, () => { filters = { ...filters, bond: null }; draw(); });
    for (const id of bondIds) {
      bchip(names[id], filters.bond === id,
        () => { filters = { ...filters, bond: filters.bond === id ? null : id }; draw(); },
        iconOf('bondIcons', id));
    }
    panel.appendChild(bchips);

    // 主体：左边网格，右边详情
    const body = el('div', 'fx-cx__body');
    const grid = el('div', 'fx-cx__grid');
    const shown = filterRows(rows, filters, names);
    const groups = groupByTier(shown);
    if (!groups.length) grid.appendChild(el('div', 'fx-cx__empty', tr(null, '没有符合条件的装备')));
    for (const g of groups) {
      const block = el('div', 'fx-cx__group');
      block.appendChild(el('div', 'fx-cx__tier', ROMAN[g.tier]));
      const row = el('div', 'fx-cx__row');
      for (const r of g.rows) {
        const card = el('button', `fx-cx__card${sel === r.id ? ' is-sel' : ''}`);
        attrs(card, { type: 'button', 'data-item': r.id, title: r.name || r.id });
        const ic = iconOf('items', r.id);
        if (ic) {
          const img = el('img', 'fx-cx__icon');
          attrs(img, { src: ic, alt: '' });
          card.appendChild(img);
        }
        card.appendChild(el('span', 'fx-cx__name', r.name || r.id));
        if (r.golden) card.appendChild(el('span', 'fx-cx__gold', tr(null, '精锐')));
        card.addEventListener('click', () => { sel = r.id; draw(); });
        row.appendChild(card);
      }
      block.appendChild(row);
      grid.appendChild(block);
    }
    body.appendChild(grid);

    const detail = el('div', 'fx-cx__detail');
    const current = sel ? rows.find((r) => r.id === sel) || null : null;
    if (!current) {
      detail.appendChild(el('div', 'fx-cx__empty', tr(null, '选一件装备看效果')));
    } else {
      detail.appendChild(el('div', 'fx-cx__dname', current.name || current.id));
      const bid = current.bond ?? current.bondId ?? null;
      const bl = el('div', 'fx-cx__dbond');
      const bi = bid ? iconOf('bondIcons', bid) : null;
      if (bi) {
        const img = el('img', 'fx-cx__bicon');
        attrs(img, { src: bi, alt: '' });
        bl.appendChild(img);
      }
      bl.appendChild(el('span', null, bondName(bonds, bid) || tr(null, '无盟约')));
      detail.appendChild(bl);
      if (current.hideInShop || current.shopExcluded) {
        detail.appendChild(el('div', 'fx-cx__note', tr(null, '不在商店出售')));
      }
      const texts = effectTexts(current);
      for (const [label, text] of [[tr(null, '普通'), texts.normal], [tr(null, '精锐'), texts.golden]]) {
        if (!text) continue;
        const box = el('div', 'fx-cx__eff');
        box.appendChild(el('b', null, label));
        box.appendChild(el('p', null, text));
        detail.appendChild(box);
      }
    }
    body.appendChild(detail);
    panel.appendChild(body);
    root.appendChild(panel);
  }

  draw();
  if (typeof window !== 'undefined') window.addEventListener('keydown', onKey);

  return {
    unmount() {
      if (typeof window !== 'undefined') window.removeEventListener('keydown', onKey);
      clear(root);
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
