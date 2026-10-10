// ui/alliances.js —— 盟约策略总览面板：核心 / 附加盟约、每一层的效果与所需成员数、成员与配套装备、以及 机变策略。
//
// 原件是 `public/js/screens/alliances.js`（491 行）＋ `public/css/screens/alliances.css`（92 行），它**就地新增一个
// 屏幕**并要求 `main.js` 认识 `openAllianceCodex()` / `<AllianceCodexHost/>`、`index.html` 加一行 `<link>` ——
// 那是改引擎。这里与 `ui/equipment.js` 同一套做法，改成 C 层的一个普通面板：
//
//   * 挂点 `root.overlays`；开关是**面板自己的**一个按钮；
//   * 数据来自 `ctx.data.get('bonds' | 'bands' | 'chess' | 'items' | 'assets')`（只读冻结快照）；
//   * 样式走 `client.panels[].styles[]`。
//
// **纯模型函数逐字移植**（bondRows / bandRows / bondLayers / bondLayerTexts / bondMembers / bondEquipment /
// bondPhases / filterBonds / filterBands 与三张名字表）—— 它们只碰传入的记录。效果文本的格式化链在
// `./bondfmt.js`（同样逐字移植，见那个文件的说明）。渲染那半从 Preact 换成纯 DOM 助手。
//
// 边界：拿不到 store / match / battle；不改任何对局状态（纯展示）。**读表要声明**：`bonds` / `bands` / `chess` /
// `items` / `assets` 都写在 `client.panels[].data` 里，否则 `ctx.data.get` 会点名 `CLIENT_DATA_UNDECLARED`。

import { el, attrs, clear, tr } from './dom.js';
import { formatBondEffect } from './bondfmt.js';

/** 生效阶段的标签（bond `activeType`）。只有数据说得清的两种才标：BATTLE = 盟约的行都写「战斗开始时/战斗中」，
 *  ALL = 战斗与休整期都生效（远见 / 奇迹 / 投资人 —— 它们的效果在商店里）。其它原始值既不标也不作为筛选项。 */
export const PHASE_NAMES = Object.freeze({ BATTLE: '战斗中生效', ALL: '全程生效' });
/** 机变策略的模式标签（`modeTypeList`）。 */
export const MODE_NAMES = Object.freeze({ LOCAL: '本地模式', SINGLE: '独立模拟', MULTI: '同盟模拟' });
/** 计数方式的标签（bond `countMode` + countsHand / countsGoldenOnly）。 */
export const COUNT_NAMES = Object.freeze({ BOARD: '场上', HAND: '手牌', DECK: '待部署区', GLOBAL: '全局' });

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

// ---- model（纯函数，逐字移植） ---------------------------------------------------------------------------------------

/** 核心盟约在前（按 bondOrder，再按数据次序），附加盟约在后（同样排序）。 */
export function bondRows(bonds) {
  const list = (Array.isArray(bonds) ? bonds : []).filter((b) => b && b.bondId);
  const ord = (b) => (Number.isFinite(b.bondOrder) ? b.bondOrder : 99);
  const core = list.filter((b) => b.isCore).sort((a, b) => ord(a) - ord(b));
  const add = list.filter((b) => !b.isCore).sort((a, b) => ord(a) - ord(b));
  return [...core, ...add].map((bond) => ({ bond, isCore: !!bond.isCore }));
}

/** 机变策略：按 sortId，再按 bandId（与选秀用的次序一致）。 */
export function bandRows(bands) {
  const sid = (b) => (Number.isFinite(b?.sortId) ? b.sortId : 99);
  return (Array.isArray(bands) ? bands : [])
    .filter((b) => b && b.bandId)
    .sort((a, b) => sid(a) - sid(b) || (a.bandId < b.bandId ? -1 : a.bandId > b.bandId ? 1 : 0))
    .map((band) => ({ band }));
}

/** 一条盟约能到的层索引（0 = 未激活 / 基础效果）：有阈值就用阈值个数，没有就用 1..maxCount。 */
export function bondLayers(bond) {
  const th = Array.isArray(bond?.thresholds) ? bond.thresholds.filter((n) => Number.isFinite(n)) : [];
  const max = Number.isFinite(bond?.maxCount) && bond.maxCount > 0 ? bond.maxCount : null;
  const top = Math.max(th.length, max ? Math.min(max, 10) : 1, 1);
  return Array.from({ length: top + 1 }, (_, i) => i);
}

/** 每层一行：层号、它需要的成员数（`thresholds[i - 1]`，基础层 / 无阈值盟约为 null）与解析后的效果文本。 */
export function bondLayerTexts(bond) {
  const th = Array.isArray(bond?.thresholds) ? bond.thresholds.filter((n) => Number.isFinite(n)) : [];
  return bondLayers(bond).map((layer) => ({
    layer,
    need: layer > 0 ? (th[layer - 1] ?? null) : null,
    text: formatBondEffect(bond, layer),
  }));
}

/** 这条盟约的成员（棋手记录），阶级低的在前；包自己加的成员排在最后。 */
export function bondMembers(rows, lookup) {
  const ids = rows?.visibleMembers?.length ? rows.visibleMembers : rows?.members || [];
  const byTier = (a, b) => (a.tier ?? 0) - (b.tier ?? 0) || (a.shopSortId ?? 0) - (b.shopSortId ?? 0)
    || String(a.name).localeCompare(String(b.name), 'zh');
  return (Array.isArray(ids) ? ids : []).map((id) => lookup(id)).filter(Boolean).sort(byTier);
}

/** 这条盟约的配套装备（items.json 的 `giveBondId`），按装备图鉴的商店次序。 */
export function bondEquipment(bondId, items) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && !i.isGolden && i.giveBondId === bondId);
  return list.sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0) || (a.shopSortId ?? 0) - (b.shopSortId ?? 0)
    || String(a.name).localeCompare(String(b.name), 'zh'));
}

/** 这批盟约用到过哪些生效阶段（只留有标签的）。 */
export function bondPhases(rows) {
  const seen = [];
  for (const r of rows || []) {
    const t = r?.bond?.activeType;
    if (t && PHASE_NAMES[t] && !seen.includes(t)) seen.push(t);
  }
  return seen;
}

/** 过滤盟约：核心 / 附加、生效阶段、以及覆盖名字 / 效果名 / 描述 / 成员的自由搜索。 */
export function filterBonds(rows, filters = {}, memberNames = {}, phaseName = (t) => t) {
  const q = String(filters.query || '').trim().toLowerCase();
  return (rows || []).filter(({ bond }) => {
    if (filters.core === true && !bond.isCore) return false;
    if (filters.core === false && bond.isCore) return false;
    if (filters.phase && bond.activeType !== filters.phase) return false;
    if (!q) return true;
    const hay = [bond.name, bond.effectName, bond.desc, bond.descRaw, phaseName(bond.activeType), memberNames[bond.bondId]]
      .filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** 过滤机变策略：模式（`modeTypeList`）与覆盖名字 / 效果名 / 描述 / 盟约名的自由搜索。 */
export function filterBands(rows, filters = {}, bondNames = {}) {
  const q = String(filters.query || '').trim().toLowerCase();
  return (rows || []).filter(({ band }) => {
    if (filters.mode && Array.isArray(band.modeTypeList) && !band.modeTypeList.includes(filters.mode)) return false;
    if (!q) return true;
    const bonds = (band.bondIds || []).map((id) => bondNames[id]).filter(Boolean);
    const hay = [band.name, band.effectName, band.desc, band.descRaw, ...bonds].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

// ---- 面板 -----------------------------------------------------------------------------------------------------------

/**
 * 面板入口（C 层契约：`mount(ctx)` 返回 `{ unmount }`，自己画 DOM）。
 * @param {{ host: any, data: { get(name: string): any }, log?: any }} ctx
 */
export function mount(ctx) {
  const host = ctx && ctx.host;
  if (!host || typeof host.appendChild !== 'function') return {};
  const get = (name) => (ctx.data && typeof ctx.data.get === 'function' ? ctx.data.get(name) : null) || {};

  const bondsRaw = get('bonds');
  const bandsRaw = get('bands');
  const chess = get('chess');
  const itemsRaw = get('items');
  const assets = get('assets');

  const bondList = Object.values(bondsRaw);
  const bandList = Object.values(bandsRaw);
  const itemList = Object.values(itemsRaw);
  const bondById = Object.fromEntries(bondList.map((b) => [b.bondId, b]));
  const chessById = (id) => chess[id] || null;

  const rows = bondRows(bondList);
  const bands = bandRows(bandList);
  const phases = bondPhases(rows);
  const bondNames = Object.fromEntries(bondList.map((b) => [b.bondId, b.name]));

  /** 图标：盟约走 `assets.bondIcons[id]`，装备走 `assets.items[id]`，干员走 `assets.chars[id].avatar`。 */
  const bondIcon = (id) => {
    const v = assets?.bondIcons?.[id];
    return typeof v === 'string' && v ? v : null;
  };
  const itemIcon = (id) => {
    const v = assets?.items?.[id];
    return typeof v === 'string' && v ? v : null;
  };
  const chessIcon = (id) => {
    const c = assets?.chars?.[id];
    const v = c && typeof c === 'object' ? c.avatar : null;
    return typeof v === 'string' && v ? v : null;
  };

  /** 面板自己的状态（本地，不碰 store）。 */
  let open = false;
  let tab = 'bonds';            // 'bonds' | 'bands'
  let sel = null;
  let filters = { core: null, phase: null, mode: null, query: '' };

  const root = el('div', 'fx-al');
  host.appendChild(root);
  const onKey = (e) => { if (open && e.key === 'Escape') { open = false; draw(); } };

  const img = (cls, src, alt = '') => {
    const i = el('img', cls);
    attrs(i, { src, alt });
    return i;
  };

  function draw() {
    clear(root);
    if (!open) {
      const b = el('button', 'fx-al__open');
      attrs(b, { type: 'button' });
      b.appendChild(el('span', 'fx-al__openlabel', tr(null, '盟约策略')));
      b.appendChild(el('span', 'fx-al__openmicro', 'ALLIANCE CODEX'));
      b.addEventListener('click', () => { open = true; draw(); });
      root.appendChild(b);
      return;
    }

    const panel = el('div', 'fx-al__panel');
    attrs(panel, { role: 'dialog', 'aria-label': tr(null, '盟约策略') });

    // 顶栏：标题 + 搜索 + 关闭
    const bar = el('div', 'fx-al__bar');
    bar.appendChild(el('b', 'fx-al__title', tr(null, '盟约策略')));
    const q = el('input', 'fx-al__q');
    attrs(q, { type: 'search', value: filters.query, placeholder: tr(null, '搜索盟约 / 机变…') });
    q.addEventListener('input', () => { filters = { ...filters, query: q.value }; draw(); });
    bar.appendChild(q);
    const close = el('button', 'fx-al__close');
    attrs(close, { type: 'button', 'aria-label': tr(null, '关闭') });
    close.textContent = tr(null, '关闭');
    close.addEventListener('click', () => { open = false; draw(); });
    bar.appendChild(close);
    panel.appendChild(bar);

    // 两个页签：盟约 / 机变
    const tabs = el('div', 'fx-al__tabs');
    for (const [id, label] of [['bonds', tr(null, '盟约')], ['bands', tr(null, '机变策略')]]) {
      const b = el('button', `fx-al__tab${tab === id ? ' is-on' : ''}`);
      attrs(b, { type: 'button', 'role': 'tab', 'aria-selected': tab === id ? 'true' : 'false' });
      b.textContent = label;
      b.addEventListener('click', () => { tab = id; sel = null; draw(); });
      tabs.appendChild(b);
    }
    panel.appendChild(tabs);

    // 筛选 chips：盟约 = 核心/附加 + 生效阶段；机变 = 模式
    const chips = el('div', 'fx-al__chips');
    const chip = (label, on, onClick, icon) => {
      const b = el('button', `fx-al__chip${on ? ' is-on' : ''}`);
      attrs(b, { type: 'button', 'aria-pressed': on ? 'true' : 'false' });
      if (icon) b.appendChild(img('fx-al__bicon', icon));
      b.appendChild(el('span', null, label));
      b.addEventListener('click', onClick);
      chips.appendChild(b);
    };
    if (tab === 'bonds') {
      chip(tr(null, '全部'), filters.core == null, () => { filters = { ...filters, core: null }; draw(); });
      chip(tr(null, '核心'), filters.core === true, () => { filters = { ...filters, core: filters.core === true ? null : true }; draw(); });
      chip(tr(null, '附加'), filters.core === false, () => { filters = { ...filters, core: filters.core === false ? null : false }; draw(); });
      for (const p of phases) {
        chip(tr(null, PHASE_NAMES[p]), filters.phase === p, () => { filters = { ...filters, phase: filters.phase === p ? null : p }; draw(); });
      }
    } else {
      chip(tr(null, '全部'), filters.mode == null, () => { filters = { ...filters, mode: null }; draw(); });
      for (const mode of ['LOCAL', 'SINGLE', 'MULTI']) {
        chip(tr(null, MODE_NAMES[mode]), filters.mode === mode,
          () => { filters = { ...filters, mode: filters.mode === mode ? null : mode }; draw(); });
      }
    }
    panel.appendChild(chips);

    const body = el('div', 'fx-al__body');
    const list = el('div', 'fx-al__list');

    if (tab === 'bonds') {
      const shown = filterBonds(rows, { core: filters.core, phase: filters.phase, query: filters.query }, {}, (t) => tr(null, PHASE_NAMES[t] || ''));
      if (!shown.length) list.appendChild(el('div', 'fx-al__empty', tr(null, '没有符合条件的盟约')));
      for (const row of shown) {
        const b = row.bond;
        const card = el('button', `fx-al__card${sel === b.bondId ? ' is-sel' : ''}${row.isCore ? ' is-core' : ''}`);
        attrs(card, { type: 'button', 'data-bond': b.bondId });
        const ic = bondIcon(b.bondId);
        if (ic) card.appendChild(img('fx-al__icon', ic));
        card.appendChild(el('span', 'fx-al__name', b.name));
        card.appendChild(el('span', 'fx-al__kind', tr(null, row.isCore ? '核心' : '附加')));
        const th = Array.isArray(b.thresholds) ? b.thresholds : [];
        if (th.length) card.appendChild(el('span', 'fx-al__th num', th.join(' / ')));
        card.addEventListener('click', () => { sel = b.bondId; draw(); });
        list.appendChild(card);
      }
    } else {
      const shown = filterBands(bands, { mode: filters.mode, query: filters.query }, bondNames);
      if (!shown.length) list.appendChild(el('div', 'fx-al__empty', tr(null, '没有符合条件的机变策略')));
      for (const row of shown) {
        const bd = row.band;
        const card = el('button', `fx-al__card${sel === bd.bandId ? ' is-sel' : ''}`);
        attrs(card, { type: 'button', 'data-band': bd.bandId });
        card.appendChild(el('span', 'fx-al__name', bd.name));
        const modes = (bd.modeTypeList || []).map((mk) => tr(null, MODE_NAMES[mk] || mk)).join(' / ');
        if (modes) card.appendChild(el('span', 'fx-al__kind', modes));
        card.addEventListener('click', () => { sel = bd.bandId; draw(); });
        list.appendChild(card);
      }
    }
    body.appendChild(list);

    // 详情栏
    const detail = el('div', 'fx-al__detail');
    if (tab === 'bonds') {
      const row = sel ? rows.find((r) => r.bond.bondId === sel) : null;
      if (!row) {
        detail.appendChild(el('div', 'fx-al__empty', tr(null, '选一条盟约看效果')));
      } else {
        const b = row.bond;
        const head = el('div', 'fx-al__dhead');
        const ic = bondIcon(b.bondId);
        if (ic) head.appendChild(img('fx-al__dicon', ic));
        head.appendChild(el('b', 'fx-al__dname', b.name));
        detail.appendChild(head);
        if (b.activeType && PHASE_NAMES[b.activeType]) {
          detail.appendChild(el('div', 'fx-al__phase', tr(null, PHASE_NAMES[b.activeType])));
        }
        if (b.countMode || b.countsHand || b.countsGoldenOnly) {
          const key = b.countMode && COUNT_NAMES[b.countMode] ? b.countMode : (b.countsHand ? 'HAND' : 'BOARD');
          detail.appendChild(el('div', 'fx-al__count', tr(null, COUNT_NAMES[key]) + (b.countsGoldenOnly ? ' · ' + tr(null, '仅精锐') : '')));
        }
        // 每一层的效果与所需人数
        for (const L of bondLayerTexts(b)) {
          const box = el('div', 'fx-al__eff');
          const lab = el('div', 'fx-al__effhead');
          lab.appendChild(el('span', 'fx-al__layer', L.layer === 0 ? tr(null, '基础') : (ROMAN[L.layer] || '+' + L.layer)));
          if (L.need != null) lab.appendChild(el('span', 'fx-al__need num', tr(null, '{need} 名', { need: L.need })));
          box.appendChild(lab);
          const txt = formatBondEffect(b, L.layer);
          if (txt) box.appendChild(el('p', 'fx-al__efftext', txt));
          detail.appendChild(box);
        }
        // 成员
        const members = bondMembers(b, chessById);
        if (members.length) {
          const mbox = el('div', 'fx-al__sect');
          mbox.appendChild(el('b', null, tr(null, '成员')));
          const row2 = el('div', 'fx-al__mrow');
          for (const m of members) {
            const t = el('span', 'fx-al__m');
            const mi = chessIcon(m.chessId || m.id);
            if (mi) t.appendChild(img('fx-al__micon', mi));
            t.appendChild(el('span', null, m.name || m.chessId || m.id));
            row2.appendChild(t);
          }
          mbox.appendChild(row2);
          detail.appendChild(mbox);
        }
        // 配套装备
        const eq = bondEquipment(b.bondId, itemList);
        if (eq.length) {
          const ebox = el('div', 'fx-al__sect');
          ebox.appendChild(el('b', null, tr(null, '配套装备')));
          const row3 = el('div', 'fx-al__mrow');
          for (const it of eq) {
            const t = el('span', 'fx-al__m');
            const ii = itemIcon(it.id);
            if (ii) t.appendChild(img('fx-al__micon', ii));
            t.appendChild(el('span', null, it.name || it.id));
            row3.appendChild(t);
          }
          ebox.appendChild(row3);
          detail.appendChild(ebox);
        }
      }
    } else {
      const row = sel ? bands.find((r) => r.band.bandId === sel) : null;
      if (!row) {
        detail.appendChild(el('div', 'fx-al__empty', tr(null, '选一个机变策略看效果')));
      } else {
        const bd = row.band;
        detail.appendChild(el('b', 'fx-al__dname', bd.name));
        const modes = (bd.modeTypeList || []).map((mk) => tr(null, MODE_NAMES[mk] || mk));
        if (modes.length) detail.appendChild(el('div', 'fx-al__phase', modes.join(' / ')));
        const txt = bd.effectDescRaw || bd.effectDesc || bd.desc || '';
        if (txt) detail.appendChild(el('p', 'fx-al__efftext', txt));
        const ids = Array.isArray(bd.bondIds) ? bd.bondIds : [];
        if (ids.length) {
          const sect = el('div', 'fx-al__sect');
          sect.appendChild(el('b', null, tr(null, '相关盟约')));
          const r2 = el('div', 'fx-al__mrow');
          for (const id of ids) {
            const t = el('span', 'fx-al__m');
            const bi = bondIcon(id);
            if (bi) t.appendChild(img('fx-al__micon', bi));
            t.appendChild(el('span', null, bondNames[id] || id));
            r2.appendChild(t);
          }
          sect.appendChild(r2);
          detail.appendChild(sect);
        }
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
