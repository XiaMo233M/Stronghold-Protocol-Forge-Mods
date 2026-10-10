// ui/lanPanel.js —— 游戏内「联机」面板（PC 桌面外壳）。
//
// 原件是 `① 独立件/public/js/ui/lanPanel.js`（290 行）：一个可拖动的「联机」药丸 ＋ 一个面板
// （外网链接 / 局域网链接 / 复制邀请 / 加入别人的房间）。它**只在桌面外壳里渲染**
// （`window.desktop` 存在时才画；纯浏览器里什么都不做）。
//
// 本包保留的是**与外壳无关的那一半**：
//   · `desktopShellPresent()` 的判据（`globalThis.desktop` 存在）—— 这个全局是**外壳注入**的，包**读得到**
//     （它与 store 不同：注入面限制了**引擎内部**句柄，而外壳全局本来就是这个页面的宿主环境）。
//   · `parseInvite` / `goToServer` / `currentServer`（在 `serverLink.js` 里，本面板复用）。
//   · 「加入别人的房间」那条路：把邀请链接粘进来 ⇒ 解析 ⇒ 整页重载到那台服务器。**这条是真的能用的**。
//
// ⛔ **拿不到的那一半（如实列出，不硬凑）**：
//   原件的外壳桥给了 `tunnel('start'|'stop')`、`state()`、`onState`、`copy(text)`、`paste()`、`home()`。
//   这些是**桌面外壳**在 `window.desktop` 上暴露的方法。本包**不假设**它们的形状 —— 原件那一版读的字段
//   （`st.room` / `st.publicUrl` / `st.lanUrl` / `st.tunnelPending` / `st.tunnelError` / `st.port`）属于
//   **那个外壳的私有契约**，不是引擎的接口。
//   ⇒ 所以本面板：**存在外壳时**显示一个「联机」药丸与一个面板，但把外壳相关的三块
//   （外网隧道、复制邀请、回到本机）**如实标成"需要外壳提供"**并置灰，同时**保留真的能用的那一条**
//   （粘贴邀请链接 ⇒ 换服务器）。这正是"包能拿到什么就做什么，拿不到就点名"。

import { el, attrs, clear, tr, loadPref, savePref } from './dom.js';
import { parseInvite, goToServer, currentServer } from './serverLink.js';

/** 拖动位置记忆的键（切换服务器会整页重载，不记的话每次都得重新拖）。 */
const POS_KEY = 'lanPill.pos';

/** 桌面外壳对象，纯浏览器里为 null。 */
function shell() {
  try {
    return globalThis.desktop ? globalThis.desktop : null;
  } catch {
    return null;
  }
}

/** 是否运行在桌面外壳里。 */
export function desktopShellPresent() {
  return !!shell();
}

/**
 * 外壳桥**可能**提供的那些方法（原件用过的）。本包**只探测、不假设返回值形状** ——
 * 缺哪个就置灰哪一块，⛔ 不替外壳编一个。
 */
export function shellBridge() {
  const d = shell();
  if (!d) return null;
  return {
    hasTunnel: typeof d.tunnel === 'function',
    hasCopy: typeof d.copy === 'function',
    hasPaste: typeof d.paste === 'function',
    hasHome: typeof d.home === 'function',
    hasState: typeof d.state === 'function',
  };
}

/**
 * 面板入口。
 * @param {any} ctx
 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  if (!desktopShellPresent()) return {};        // 纯浏览器：本模块什么都不做，保持原样

  const bridge = shellBridge();
  let open = false;
  let pos = loadPref(POS_KEY, null);

  const root = el('div', 'pp-lan');
  attrs(root, { 'data-pp-lan': '' });
  host.appendChild(root);

  /** 药丸（常显、可拖动、10px 内算点击）。 */
  function renderPill() {
    clear(root);
    const wrap = el('div', 'pp-lan__pillwrap');
    const pill = el('button', 'pp-lan__pill');
    attrs(pill, { type: 'button', title: tr(null, '联机：开房间 / 加入朋友的房间') });
    if (pos) pill.setAttribute('style', `left:${pos.x}px; top:${pos.y}px;`);
    pill.appendChild(el('span', 'pp-lan__pilltext', tr(null, '联机')));

    const drag = { id: null, x0: 0, y0: 0, bx: 0, by: 0, moved: false };
    pill.addEventListener('pointerdown', (e) => {
      drag.id = e.pointerId; drag.x0 = e.clientX; drag.y0 = e.clientY;
      drag.bx = pill.offsetLeft; drag.by = pill.offsetTop; drag.moved = false;
    });
    pill.addEventListener('pointermove', (e) => {
      if (drag.id === null || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 10) return;    // 与原件 / 安卓版同一个阈值
      drag.moved = true;
      const maxX = Math.max(0, (globalThis.innerWidth || 0) - pill.offsetWidth - 4);
      const maxY = Math.max(0, (globalThis.innerHeight || 0) - pill.offsetHeight - 4);
      pos = { x: Math.min(Math.max(0, drag.bx + dx), maxX), y: Math.min(Math.max(0, drag.by + dy), maxY) };
      pill.setAttribute('style', `left:${pos.x}px; top:${pos.y}px;`);
    });
    const up = (e) => {
      if (drag.id === null || e.pointerId !== drag.id) return;
      drag.id = null;
      if (drag.moved) { savePref(POS_KEY, pos); return; }
      open = true;                                  // 没拖动 ⇒ 算点击
      renderPanel();
    };
    pill.addEventListener('pointerup', up);
    pill.addEventListener('pointercancel', up);

    wrap.appendChild(pill);
    root.appendChild(wrap);
  }

  /** 面板本体（地址 / 加入 / 复制 / 回到本机）。 */
  function renderPanel() {
    clear(root);
    const overlay = el('div', 'pp-lan__ov');
    attrs(overlay, { 'data-pp-lan-panel': '' });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { open = false; renderPill(); } });

    const box = el('div', 'pp-lan__box');
    const head = el('header', 'pp-lan__head');
    head.appendChild(el('h2', 'pp-lan__title', tr(null, '联机')));
    const close = el('button', 'pp-lan__close', '✕');
    attrs(close, { type: 'button', 'aria-label': tr(null, '关闭'), title: tr(null, '关闭') });
    close.addEventListener('click', () => { open = false; renderPill(); });
    head.appendChild(close);
    box.appendChild(head);

    const local = !currentServer();
    box.appendChild(el('p', 'pp-lan__hint',
      local ? tr(null, '当前在本机服务器上。') : tr(null, '当前在朋友的服务器上 —— 想玩自己的存档就点「回到本机服务器」。')));

    // 外网隧道 / 复制邀请：**需要外壳**。有就画（并如实说明这是外壳提供的），没有就置灰点名。
    const row = (label, hint, disabled) => {
      const r = el('div', 'pp-lan__row');
      r.appendChild(el('span', 'pp-lan__label', label));
      r.appendChild(el('span', 'pp-lan__value', hint));
      if (disabled) r.classList.add('is-disabled');
      return r;
    };
    box.appendChild(row(tr(null, '外网链接'),
      bridge && bridge.hasTunnel ? tr(null, '由桌面外壳提供（本面板不读它的私有状态形状）')
        : tr(null, '需要桌面外壳提供 tunnel() —— 纯浏览器里没有'),
      !(bridge && bridge.hasTunnel)));
    box.appendChild(row(tr(null, '局域网链接'),
      bridge && bridge.hasState ? tr(null, '由桌面外壳提供') : tr(null, '需要桌面外壳提供 state()'),
      !(bridge && bridge.hasState)));

    // ✅ **真的能用的那一条**：粘贴邀请链接 ⇒ 换服务器。
    box.appendChild(el('p', 'pp-lan__hint', tr(null, '加入别人的房间：把朋友发来的邀请链接粘进来（密钥已经含在链接里）：')));
    const join = el('div', 'pp-lan__join');
    const field = el('input', 'pp-input');
    attrs(field, { type: 'text', 'data-pp-lan-join': '', placeholder: 'https://xxxx.trycloudflare.com/?room=ABCD' });
    join.appendChild(field);
    const go = el('button', 'pp-btn pp-btn--primary pp-btn--sm', tr(null, '连接'));
    attrs(go, { type: 'button', 'data-pp-lan-connect': '' });
    const connect = () => {
      const target = parseInvite(field.value);
      if (!target) {
        const warn = el('p', 'pp-lan__warn',
          tr(null, '没找到可用的地址。请把朋友发来的整条邀请链接粘进来（形如 https://xxxx.trycloudflare.com/?room=ABCD）'));
        attrs(warn, { 'data-pp-lan-error': '' });
        if (!box.querySelector('[data-pp-lan-error]')) box.appendChild(warn);
        return;
      }
      goToServer(target.server, target.room);
    };
    go.addEventListener('click', connect);
    field.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') connect(); });
    join.appendChild(go);
    box.appendChild(join);

    if (bridge && bridge.hasPaste) {
      const paste = el('button', 'pp-btn pp-btn--secondary', tr(null, '从剪贴板粘贴链接并进入'));
      attrs(paste, { type: 'button', 'data-pp-lan-paste': '' });
      paste.addEventListener('click', async () => {
        let text = '';
        try { text = await shell().paste(); } catch { /* 忽略 */ }
        if (!text || !text.trim()) return;
        field.value = text.trim();
        connect();
      });
      box.appendChild(paste);
    }

    if (!local) {
      const back = el('button', 'pp-btn pp-btn--secondary', tr(null, '回到本机服务器（我自己的游戏）'));
      attrs(back, { type: 'button', 'data-pp-lan-home': '' });
      back.addEventListener('click', () => {
        if (bridge && bridge.hasHome) { try { shell().home(); return; } catch { /* 落到下面那条 */ } }
        goToServer('', '');
      });
      box.appendChild(back);
    }

    overlay.appendChild(box);
    root.appendChild(overlay);
  }

  if (open) renderPanel();
  else renderPill();

  return { unmount() { clear(host); } };
}
