// ui/skinPicker.js —— 干员详情面板里的「皮肤」一节。
//
// 原件是 `③ 核心UI增强/新增文件/public/js/ui/skinPicker.js`（102 行）＋ `skins.js`（选择状态与同步）。
// 它要往**干员详情面板**插一节 —— 这正是 `screen.loadout.detail` 这个槽位存在的理由（WORKSHOP §1.9.3）。
//
// ===== 0.13.0：这一节从「只能画空态」变成真能画 =====
//
// 上一版这一节**如实只画一个空态说明**，因为缺两样东西（当时写进了判定表）：
//   ① 引擎不告诉面板「当前详情是哪个干员」—— `screen.loadout.detail` 的宿主只有 `data-mod-slot`，
//      没有 `data-mod-slot-key` ⇒ `ctx.hostKey` 是 `null`；
//   ② 没有「一套外观」这个概念的表 —— 只有官方的 `assets.chars[charId].skins`（那 174 张内置皮肤），
//      而**包声明的时装**（`pack.json.skins`）到不了客户端。
//
// 两样都补上了（**引擎改动，本包只是读者**）：
//   ① `ctx.hostKey` 现在是当前干员的 id（宿主带 `data-mod-slot-key`；README 的「宿主键」一节）；
//   ② `assets.skins[charId] = [{ pack, id, name, series?, desc?, art?, voices? } …]` —— 包的时装与官方的
//      内置皮肤都从这里读，**一条链**（`assets.skins` 是引擎合并好的那一份）。
//
// 三条仍然成立的性质：
//   · **没有可选外观就静默不显示**（原件 `if (!list.length) return null`）。
//   · **数据来自引擎已经抓过的那张表**（`ctx.data.get('assets')`，零新请求）。
//   · **选择按干员存**，并**广播给别人**（`room.appearance`）：这一节换的装，同房的人立刻看得见。
//
// 选择落哪：`ctx.session.setPref`（引擎给的**一格受限偏好口**，只有短标量）＋
// `ctx.session.send('room.appearance', …)`（引擎给的**白名单消息口**，今天只放展示类的 `room.appearance`）
// —— 两者都不是「对局状态」：前者是本机偏好，后者是「别人看到的你」。**不碰对局**：皮肤是纯外观，
// 所以这一节在比赛里也允许改（与原件「局外才改」相反 —— 那是原件受它自己的 store 所限；引擎侧
// `room.appearance` 刻意没有 phase gate，因为它只改显示、不碰战果）。

import { el, attrs, clear, tr } from './dom.js';

/**
 * 某个干员的可选外观：**包声明的时装**（`assets.skins`）与**官方内置皮肤**（`assets.chars[].skins`）合并成一条链。
 *
 * 为什么两条都要：官方那 174 张在 `chars[charId].skins` 里（引擎自带），而包声明的新时装在 `assets.skins` 里。
 * 玩家看到的应该是**一张列表**，不是「官方的在一边、包的在另一边」。
 * @param {any} assets `ctx.data.get('assets')` 的快照
 * @param {string} charId
 */
export function availableSkins(assets, charId) {
  const out = [];
  const seen = new Set();
  // ① 包声明的时装（引擎合并进 `assets.skins[charId]`，按 (包 id, 时装 id) 排好序）
  const declared = assets && assets.skins && assets.skins[charId];
  if (Array.isArray(declared)) {
    for (const s of declared) {
      if (!s || typeof s.id !== 'string' || seen.has(s.id)) continue;
      seen.add(s.id);
      out.push({
        id: s.id, name: s.name || s.id, series: s.series || null, pack: s.pack || null,
        avatar: (s.art && s.art.avatar) || null,
      });
    }
  }
  // ② 官方内置皮肤（`chars[charId].skins`，一个 id → 记录的表）
  const builtin = assets && assets.chars && assets.chars[charId] ? assets.chars[charId].skins : null;
  if (builtin && typeof builtin === 'object') {
    for (const [id, rec] of Object.entries(builtin)) {
      if (seen.has(id)) continue;          // ② 不覆盖 ①：包声明的同名时装优先（那是作者显式写的那一份）
      seen.add(id);
      out.push({ id, name: (rec && rec.name) || id, series: null, pack: null, avatar: (rec && rec.avatar) || null });
    }
  }
  return out;
}

/** 默认（未换装）头像。 */
export function defaultAvatar(assets, charId) {
  const rec = assets && assets.chars && assets.chars[charId];
  return (rec && rec.avatar) || null;
}

/** 偏好的键：`skin:<charId>` → 时装 id（`''` = 明确选原版）。与「按干员覆盖配音语言」同一个位置。 */
export const skinPrefKey = (charId) => `skin:${charId}`;

/**
 * 面板入口。
 * @param {any} ctx
 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  const assets = ctx.data?.get?.('assets') ?? null;

  const section = el('section', 'pp-lo-sec');
  attrs(section, { 'data-pp-skin-section': '' });
  const head = el('header', 'pp-lo-sec__head');
  head.appendChild(el('h3', 'pp-lo-sec__title', tr(null, '皮肤')));
  section.appendChild(head);

  // 详情目标是哪个干员：`ctx.hostKey`（0.13.0 起宿主带 `data-mod-slot-key`）。
  // 仍然读不到时**如实留空**并说明 —— 不猜、不列全部（那会是几百张图）。
  const charId = ctx.hostKey || null;
  if (!charId) {
    head.appendChild(el('span', 'pp-lo-sec__note', tr(null, '（需要引擎告知当前干员）')));
    section.appendChild(el('p', 'pp-lo-sec__empty',
      tr(null, '皮肤一节需要知道当前是哪个干员 —— 宿主没带 data-mod-slot-key，所以这里如实留空。')));
    clear(host);
    host.appendChild(section);
    return { unmount() { clear(host); } };
  }

  const list = availableSkins(assets, charId);
  if (!list.length) {
    // 原件同一条：没有可选外观就静默不显示（连标题都不该占地方）
    head.appendChild(el('span', 'pp-lo-sec__note', tr(null, '这款干员没有可选皮肤')));
  } else {
    head.appendChild(el('span', 'pp-lo-sec__note', tr(null, '{n} 款可选', { n: list.length })));
    const grid = el('div', 'pp-lo-skins');
    attrs(grid, { role: 'radiogroup', 'aria-label': tr(null, '选择皮肤') });
    const base = defaultAvatar(assets, charId);
    const current = () => {
      const v = ctx.session?.getPref?.(skinPrefKey(charId), null);
      return typeof v === 'string' ? v : null;
    };
    /** 选中：写偏好 + **广播给别人**（`room.appearance`）。两者都不是「对局状态」。 */
    const pick = (id) => {
      ctx.session?.setPref?.(skinPrefKey(charId), id);
      // 广播：这一格换的装，同房的人立刻看得见。
      // `''`（原版）用 `{ avatar: charId }` 表示「回到这个干员自己的头像」——`room.appearance` 的每一项
      // 必须是 `{ skinId }` 或 `{ avatar }` **恰好一个**（引擎侧的形状判据，写错会被 C2S 层拒掉）。
      ctx.session?.send?.('room.appearance', { picks: { [charId]: id ? { skinId: id } : { avatar: charId } } });
      paint();
    };
    let gridEl = null;
    const cell = (id, name, art, note) => {
      const b = el('button', 'pp-lo-skin');
      attrs(b, { type: 'button', 'data-pp-skin': id, title: note ? `${name} · ${note}` : name });
      if (current() === (id || null)) attrs(b, { 'aria-checked': 'true', 'data-pp-chosen': '' });
      const artBox = el('span', 'pp-lo-skin__art');
      if (art) artBox.appendChild(attrs(el('img', 'pp-lo-skin__img'), { src: art, alt: '', loading: 'lazy' }));
      b.appendChild(artBox);
      b.appendChild(el('b', 'pp-lo-skin__name', name));
      if (note) b.appendChild(el('i', 'pp-lo-skin__series', note));
      b.addEventListener('click', () => pick(id));
      return b;
    };
    const paint = () => {
      const next = el('div', 'pp-lo-skins');
      attrs(next, { role: 'radiogroup', 'aria-label': tr(null, '选择皮肤') });
      next.appendChild(cell('', tr(null, '默认'), base, null));
      for (const s of list) next.appendChild(cell(s.id, s.name, s.avatar || base, s.series || (s.pack ? `${s.pack}` : null)));
      if (gridEl && gridEl.parentNode) gridEl.parentNode.replaceChild(next, gridEl);
      else section.appendChild(next);
      gridEl = next;
    };
    paint();
  }

  clear(host);
  host.appendChild(section);
  return { unmount() { clear(host); } };
}
