// ui/noticePanels.js —— 登录页的「更新公告」与「特别鸣谢」两个面板。
//
// 原件是 `① 独立件/public/js/ui/titlePanels.js`（173 行，含 CREDITS_TOP / CREDITS_REFS / CREDITS_LINE 三张
// 硬编码表）＋ `announcementData.js`（42 行，正文由 `tools/build-announcements.mjs` 从 `CHANGELOG.md` 生成）。
//
// **这一件在 0.12.0 有了接口**（`pack.json.notices`，DESIGN §28.15 / WORKSHOP §1.13）：公告与鸣谢现在是引擎自己的
// 载体，合并体走既有的 `/data/notices.json`（没有新路由），客户端经 `ctx.data.get('notices')` 读它。
// 所以这里不再硬编码正文 —— 它画的是**合并后**的那一份（引擎的公告 + 这个包声明的鸣谢）。
//
// 与原件逐条对齐的三条硬约束（原件 §1-① / ② / ③）：
//   ① **每行的链接必须是真 `<a>` 且新窗口打开**（`target="_blank"` + `rel="noopener noreferrer"`）；
//   ② **离线/无网也不报错** ⇒ 数据来自引擎已经抓过的那份缓存（`ctx.data.get`），本模块**不发任何请求**；
//   ③ **窄屏不溢出** ⇒ 侧栏收成一行、面板本体固定层且自身可滚（样式在 `css/plugin-pack.css`）。
//
// ⚠️ 服务端在合并期会**点名跳过** url 不是 `https://` 的署名条目（WORKSHOP §1.13），客户端是**第二个读者**，
//    所以这里再判一次（与引擎同一条：`https://` 才变成可点的链接，否则只显示名字）。
// ⚠️ 原件 `announcementData.js` 那份「骨架版公告」不在这里 —— 引擎的公告**从 `CHANGELOG.md` 生成**
//    （单一事实源）。一份包自带的假公告只会盖在一个真实存在的公告体系上。

import { el, attrs, clear, tr } from './dom.js';

/** 两个面板（顺序即出现顺序）。 */
export const PANELS = Object.freeze([
  Object.freeze({ id: 'news', label: '更新公告', micro: 'PATCH NOTES' }),
  Object.freeze({ id: 'credits', label: '特别鸣谢', micro: 'CREDITS' }),
]);

/** 只认 `https://` 的链接（与引擎合并期那条判据逐字相同）。 */
export function safeUrl(url) {
  return typeof url === 'string' && url.startsWith('https://') ? url : null;
}

/** 一行的链接：有 URL 的是**真锚点、新窗口**；没有的渲染成纯文本（原件：⛔ 不给它编一个 URL）。 */
export function creditsLinks(links) {
  const list = (Array.isArray(links) ? links : [])
    .map((l) => ({ label: l && typeof l.label === 'string' ? l.label : null, url: safeUrl(l && l.url) }))
    .filter((l) => l.url);
  if (!list.length) return null;
  const wrap = el('span', 'pp-tpanel__links');
  for (const l of list) {
    const a = el('a', 'pp-tpanel__link');
    attrs(a, { href: l.url, target: '_blank', rel: 'noopener noreferrer' });
    a.textContent = `${l.label ? `${l.label} · ` : ''}${l.url.replace(/^https:\/\//, '')}`;
    wrap.appendChild(a);
  }
  return wrap;
}

/** 一条署名：名字（＋可选角色 / 备注）／链接／一行说明。 */
function creditRow(entry) {
  const li = el('li', 'pp-tpanel__credit');
  const head = el('div', 'pp-tpanel__credithead');
  head.appendChild(el('b', 'pp-tpanel__creditname', entry.name));
  if (entry.note) head.appendChild(el('span', 'pp-tpanel__role', entry.note));
  li.appendChild(head);
  const links = creditsLinks(entry.links);
  if (links) li.appendChild(links);
  return li;
}

/**
 * 画一整份 notices（引擎的合并体）。
 * @param {HTMLElement} box 往哪里画
 * @param {any} notices `{ announcements: [...], credits: [...] }`（缺失一律当空，不抛）
 * @param {string} which 'news' | 'credits'
 * @param {Function|null} t
 */
export function renderNoticePanels(box, notices, which, t = null) {
  clear(box);
  const src = notices && typeof notices === 'object' ? notices : {};
  if (which === 'news') {
    const list = Array.isArray(src.announcements) ? src.announcements : [];
    if (!list.length) {
      box.appendChild(el('p', 'pp-tpanel__empty', tr(t, '暂无可显示的更新公告。')));
      return;
    }
    for (const v of list) {
      const sec = el('section', 'pp-tpanel__ver');
      const head = el('header', 'pp-tpanel__verhead');
      if (v && v.version) head.appendChild(el('b', 'pp-tpanel__vertag', `v${v.version}`));
      if (v && v.date) head.appendChild(el('span', 'pp-tpanel__verdate', v.date));
      sec.appendChild(head);
      if (v && v.summary) sec.appendChild(el('p', 'pp-tpanel__summary', v.summary));
      for (const s of Array.isArray(v && v.sections) ? v.sections : []) {
        const wrap = el('div', 'pp-tpanel__sec');
        if (s && s.name) wrap.appendChild(el('h4', 'pp-tpanel__secname', s.name));
        const ul = el('ul', 'pp-tpanel__items');
        for (const it of Array.isArray(s && s.items) ? s.items : []) {
          ul.appendChild(el('li', 'pp-tpanel__item', String(it)));
        }
        wrap.appendChild(ul);
        sec.appendChild(wrap);
      }
      box.appendChild(sec);
    }
    return;
  }
  const credits = Array.isArray(src.credits) ? src.credits : [];
  if (!credits.length) {
    box.appendChild(el('p', 'pp-tpanel__empty', tr(t, '暂无可显示的鸣谢。')));
    return;
  }
  const ul = el('ul', 'pp-tpanel__list');
  for (const entry of credits) {
    if (!entry || typeof entry.name !== 'string' || !entry.name) continue;   // 引擎合并期也会点名跳过无名条目
    ul.appendChild(creditRow(entry));
  }
  box.appendChild(ul);
}

/**
 * 面板入口：右侧两个按钮 ＋ 一个可关闭的浮层。
 * 浮层只在打开时渲染，关闭走三条路（× 按钮、Esc、点背景）——「面板可关闭」是原件的判据之一。
 * @param {any} ctx
 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  const notices = ctx.data?.get?.('notices') ?? null;
  let open = null;

  const root = el('div', 'pp-title-side');
  attrs(root, { 'data-pp-notice-panels': '' });
  const btns = el('div', 'pp-title-side__btns');
  /** @type {Record<string, HTMLElement>} */
  const buttons = {};
  for (const p of PANELS) {
    const b = el('button', 'pp-title-side__btn');
    attrs(b, { type: 'button', 'data-pp-panel': p.id, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: tr(null, p.label) });
    b.appendChild(el('span', 'pp-title-side__label', tr(null, p.label)));
    b.appendChild(el('span', 'pp-title-side__micro', p.micro));
    b.addEventListener('click', () => setOpen(open === p.id ? null : p.id));
    buttons[p.id] = b;
    btns.appendChild(b);
  }
  root.appendChild(btns);
  const layer = el('div', 'pp-tpanel');
  root.appendChild(layer);
  clear(host);
  host.appendChild(root);

  function setOpen(id) {
    open = id;
    for (const p of PANELS) {
      attrs(buttons[p.id], { 'aria-expanded': open === p.id ? 'true' : 'false' });
      buttons[p.id].classList.toggle('is-on', open === p.id);
    }
    clear(layer);
    if (!open) return;
    const cur = PANELS.find((p) => p.id === open);
    const box = el('div', 'pp-tpanel__box');
    attrs(box, { role: 'dialog', 'aria-modal': 'true', 'aria-label': tr(null, cur.label), 'data-pp-panel-open': cur.id, tabindex: '-1' });
    const head = el('header', 'pp-tpanel__head');
    const title = el('div');
    title.appendChild(el('span', 'pp-tpanel__micro', cur.micro));
    title.appendChild(el('h2', 'pp-tpanel__title', tr(null, cur.label)));
    head.appendChild(title);
    const close = el('button', 'pp-tpanel__close', '✕');
    attrs(close, { type: 'button', 'aria-label': tr(null, '关闭'), title: tr(null, '关闭 (Esc)') });
    close.addEventListener('click', () => setOpen(null));
    head.appendChild(close);
    box.appendChild(head);
    const body = el('div', 'pp-tpanel__body');
    renderNoticePanels(body, notices, cur.id);
    box.appendChild(body);
    layer.appendChild(box);
    // 点背景关（面板本体不关：判据是"可关闭"，不是"点哪儿都关"）。
    layer.addEventListener('mousedown', (e) => { if (e.target === layer) setOpen(null); });
  }

  const onKey = (e) => { if (e && e.key === 'Escape' && open) { e.stopPropagation(); setOpen(null); } };
  document.addEventListener('keydown', onKey, true);

  return {
    unmount() {
      document.removeEventListener('keydown', onKey, true);
      clear(host);
    },
  };
}
