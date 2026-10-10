// ui/chat.js —— 对局中的**房间聊天面板**（原件 `① 独立件/public/js/ui/chatPanel.js`，426 行，改写版）。
//
// 原件是两层：`ChatPanel`（**无 hook** 的纯展示组件，好单测）＋ `ChatPanelHost`（带 store / net / 拖动 /
// 持久化的壳）。本包把两层合成一个面板模块 —— 面板拿到的注入面里**没有 store**（`extensions.js` 的边界：
// 「没有 store 句柄、没有对局对象」），所以原件壳层那几处 `useStore(...)` 在这里**必须换掉**：
//
//   · `s.chat`（消息列表）        → 本包自己的数组（经 `ctx.net.on('chat', …)` 收到的东西）＋ 本机自己发的
//   · `s.me.playerId`（我是谁）    → **拿不到**（注入面里没有）。⇒ `isMine` 走一个本包自己的会话级随机 id
//                                    （见下 `SELF_ID`），也就是"这个页面自己发的消息"右对齐，而不是"这个账号"。
//                                    这是**如实降级**：跨页面 / 重连之后自己以前发的消息不再右对齐。
//   · `s.room`（房间态/观战/房主） → **拿不到**。⇒ 发言门退化成"连接在线即可"（原文的门是
//                                    "曾占过座位"）。**这一条是本包补不上的**（见判定表 §聊天）。
//   · `s.connection.status`       → **拿不到**。⇒ 用"通道是否曾经成功发出过"近似。
//   · `loadPref/savePref`         → 本包自己的 `localStorage` 前缀（`dom.js` 的 `loadPref`）。
//
// 逐条保留的原件行为（这些都是用户在原件里的实测口径）：
//   · **可拖动**（标题栏 ⠿；10px 内算点击不算拖）、**可收起**（收起只留一个把手，有新消息在把手上弹红点）、
//     **可缩放**（右下角把手，尺寸过 `clampPanelSize` 夹进视口）、位置与尺寸**跨会话记住**。
//   · **收起 ⇒ 把手回到最开始的位置**（位置作废），不是停在拖走的地方。
//   · **恢复出来的位置必须夹进视口**（旧位置是上一次会话的绝对像素；换窗口尺寸后会渲染到屏幕外 ⇒
//     表现成"这个功能不存在"），并在 `resize` 时再夹一次。
//   · **打开时的遮罩层**：铺满视口、只吃点击 ⇒ 面板外点不到商店（**防误购**）、点遮罩＝收起。
//   · **个人屏蔽**：只影响"我看到什么"，不过滤列表本身（旧历史不隐藏）。
//   · 老服务端不支持 ⇒ **置灰 + 一句说明**，不弹错误刷屏。
//
// ⚠️ **发消息走的是本包自己的通道**（`client.panels[].messages: ["chat"]` ⇒ 线上是 `pack.msg` 且通道名 `chat`）。
//    引擎**不会**服务端存档、不会离线补发、不会跨房间广播（§1.9.6 明说这些是包自己的事）。
//    ⇒ 原件那条 `chat.history` 补发在这里**没有对应物**（`pack.msg` 不带历史），所以"重进房间要看到"
//    这条用户口径**只在本页面会话内成立**。这是本包**补不上的**一半（见判定表）。

import {
  el, attrs, clear, tr, formatClock, clampText,
  loadPref, savePref,
} from './dom.js';
import {
  CHAT_MAX_CODEPOINTS, CHAT_HISTORY_CAP, QUICK_PHRASES, QUICK_PARAMLESS_IDS,
  normalizeMessage, messageKey, appendChat, displayName, isBlank, formatClock as clock,
  clampPanelPos, clampPanelSize, posForCollapse, isDragMove, countUnread,
  isUnsupportedChatError, isMine, cleanMuted, toggleMuted, filterMuted,
  canSendQuickNow, quickMsgPayload, QUICK_ID_RE,
} from './chatModel.js';

/** 这个包自己的通道名（必须与 `pack.json.client.panels[id=chat].messages` 里那一条逐字相同）。 */
export const CHANNEL = 'chat';

/** 本页面的会话级自发 id（注入面里没有 playerId ⇒ 只能近似"这是我发的"）。 */
const SELF_ID = `pp-${Math.random().toString(36).slice(2, 10)}`;

/**
 * 面板入口。
 * @param {any} ctx
 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  const log = ctx.log || console;

  /** 消息列表（本包自己的；经通道收到的 + 本机自己发的）。 */
  let list = [];
  /** 服务端不认识这条通道 / 发不出去 ⇒ 只读态。 */
  let unsupported = false;
  let sending = false;
  let draft = '';
  let collapsed = loadPref('chat.collapsed', false) === true;
  let seenAt = Number(loadPref('chat.seenAt', 0)) || 0;
  let muted = cleanMuted(loadPref('chat.muted', []));
  let pos = loadPref('chat.pos', null);
  let size = clampPanelSize(loadPref('chat.size', null), { vw: globalThis.innerWidth, vh: globalThis.innerHeight });
  let disposed = false;

  // ── 骨架 ──────────────────────────────────────────────────────────────────────────────────────
  const rootEl = el('div', 'pp-chat-host');
  attrs(rootEl, { 'data-pp-chat-host': '' });
  host.appendChild(rootEl);

  /** 每次重画都重建（面板很小，重建比 diff 便宜，且不会留下陈旧的事件绑定）。 */
  function render() {
    if (disposed) return;
    clear(rootEl);
    const effPos = posForCollapse(collapsed, pos);
    rootEl.className = `pp-chat-host${collapsed ? ' is-collapsed' : ''}${effPos ? ' is-pinned' : ''}`;
    rootEl.setAttribute('style', effPos ? `left:${effPos.x}px; top:${effPos.y}px;` : '');

    if (collapsed) {
      const handle = el('button', 'pp-chat__handle');
      attrs(handle, { type: 'button', 'data-pp-chat-toggle': '', title: tr(null, '展开聊天') });
      handle.appendChild(el('span', 'pp-chat__handle-icon', '💬'));
      handle.appendChild(el('span', 'pp-chat__handle-text', tr(null, '聊天')));
      const unread = countUnread(shown(), seenAt);
      if (unread > 0) {
        handle.appendChild(attrs(el('span', 'pp-chat__dot'), { 'data-pp-chat-unread': String(unread) }));
      }
      handle.addEventListener('click', toggle);
      rootEl.appendChild(handle);
      return;
    }

    // 打开态才渲染的遮罩层：铺满视口、只吃点击 ⇒ 面板外点不到商店（防误购）；点它 = 收起。
    const backdrop = el('div', 'pp-chat__backdrop');
    attrs(backdrop, { 'data-pp-chat-backdrop': '', 'aria-hidden': 'true' });
    backdrop.addEventListener('click', toggle);
    rootEl.appendChild(backdrop);

    const box = el('div', 'pp-chat is-open');
    attrs(box, { 'data-pp-chat-root': '', 'data-pp-chat-collapsed': 'false' });
    if (size) box.setAttribute('style', `width:${size.w}px; height:${size.h}px;`);

    // 右下角缩放把手
    const grip = el('div', 'pp-chat__grip');
    attrs(grip, { 'data-pp-chat-resize': '', role: 'separator', title: tr(null, '拖动缩放聊天框') });
    grip.addEventListener('pointerdown', (e) => startResize(e, box));
    box.appendChild(grip);

    // 头部：拖动把手 / 标题 / 条数 / 屏蔽计数 / 收起 / 关闭
    const head = el('div', 'pp-chat__head');
    const dragHandle = el('span', 'pp-chat__gripbar', '⠿');
    attrs(dragHandle, { 'data-pp-chat-drag': '', title: tr(null, '按住拖动面板') });
    dragHandle.addEventListener('pointerdown', (e) => startDrag(e, box));
    head.appendChild(dragHandle);
    head.appendChild(el('span', 'pp-chat__title', tr(null, '房间聊天')));
    const shownList = shown();
    head.appendChild(attrs(el('span', 'pp-chat__count', shownList.length ? tr(null, '{n} 条', { n: shownList.length }) : ''), { 'data-pp-chat-count': String(shownList.length) }));
    if (muted.length) {
      const un = el('button', 'pp-chat__btn', tr(null, '已屏蔽 {n}', { n: muted.length }));
      attrs(un, { type: 'button', 'data-pp-chat-unmute-all': '', title: tr(null, '恢复显示被屏蔽的人') });
      un.addEventListener('click', () => { muted = []; savePref('chat.muted', muted); render(); });
      head.appendChild(un);
    }
    const collapseBtn = el('button', 'pp-chat__btn', tr(null, '收起'));
    attrs(collapseBtn, { type: 'button', 'data-pp-chat-toggle': '', title: tr(null, '收起（新消息会在把手上弹红点）') });
    collapseBtn.addEventListener('click', toggle);
    head.appendChild(collapseBtn);
    box.appendChild(head);

    // 消息列表
    const listEl = el('div', 'pp-chat__list');
    attrs(listEl, { 'data-pp-chat-list': '', role: 'log', 'aria-live': 'polite' });
    if (!shownList.length) {
      listEl.appendChild(el('p', 'pp-chat__empty', tr(null, '还没有人说话 —— 打字回车即可发言。')));
    } else {
      shownList.forEach((m) => listEl.appendChild(messageRow(m)));
    }
    box.appendChild(listEl);

    // 一条说明（三态里最多一条）
    const note = !unsupported ? null
      : el('p', 'pp-chat__note', tr(null, '当前服务器不支持本包的聊天通道 —— 表情包仍可用。'));
    if (note) { attrs(note, { 'data-pp-chat-unsupported': '' }); box.appendChild(note); }

    // 快捷短语那一排
    box.appendChild(quickRow());

    // 输入
    const inputRow = el('div', 'pp-chat__input');
    const field = el('input', 'pp-input pp-chat__field');
    attrs(field, { type: 'text', value: draft, 'data-pp-chat-field': '', placeholder: tr(null, '说点什么…（回车发送）'), maxlength: String(CHAT_MAX_CODEPOINTS) });
    field.addEventListener('input', (e) => { draft = clampText(e.target.value, CHAT_MAX_CODEPOINTS); });
    field.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') { e.preventDefault(); void send(); } });
    inputRow.appendChild(field);
    const sendBtn = el('button', 'pp-btn pp-btn--primary pp-btn--sm', tr(null, '发送'));
    attrs(sendBtn, { type: 'button', 'data-pp-chat-send': '' });
    sendBtn.disabled = sending || isBlank(draft) || unsupported;
    sendBtn.addEventListener('click', () => { void send(); });
    inputRow.appendChild(sendBtn);
    box.appendChild(inputRow);

    box.appendChild(el('p', 'pp-chat__hint', tr(null, '最多 {n} 字 · 拖动标题栏的 ⠿ 换位置', { n: CHAT_MAX_CODEPOINTS })));
    rootEl.appendChild(box);
  }

  /** 屏蔽只影响显示（原件：旧历史不隐藏）。 */
  function shown() {
    return filterMuted(list, muted);
  }

  function messageRow(m) {
    const mine = isMine(m, SELF_ID);
    const quick = m && m.kind === 'quick';
    const row = el('div', `pp-chat__msg${mine ? ' is-mine' : ''}${quick ? ' is-quick' : ''}`);
    attrs(row, { 'data-pp-chat-msg': '', 'data-pp-chat-mine': mine ? 'true' : 'false', 'data-pp-chat-at': String(m.at), 'data-pp-chat-kind': quick ? 'quick' : 'text' });
    const meta = el('span', 'pp-chat__meta');
    meta.appendChild(el('span', 'pp-chat__who', mine ? tr(null, '我') : displayName(m.name, m.from)));
    meta.appendChild(el('span', 'pp-chat__time', clock(m.at)));
    if (quick) meta.appendChild(el('span', 'pp-chat__tag', tr(null, '快捷短语')));
    if (!mine) {
      const mute = el('button', 'pp-chat__mute', tr(null, '屏蔽'));
      attrs(mute, { type: 'button', 'data-pp-chat-mute': m.from, title: tr(null, '屏蔽这个人的消息（只影响你自己看到的）') });
      mute.addEventListener('click', () => { muted = toggleMuted(muted, m.from); savePref('chat.muted', muted); render(); });
      meta.appendChild(mute);
    }
    row.appendChild(meta);
    row.appendChild(el('span', 'pp-chat__text', quick ? quickLabel(m) : m.text));
    return row;
  }

  /** 短语的显示文本：**用 id 本身**（引擎里没有这九条 msgid ⇒ 本包补不了，如实显示 id）。 */
  function quickLabel(m) {
    const ids = Array.isArray(m && m.ids) ? m.ids : [];
    return ids.join(' · ');
  }

  /** 快捷短语那一排（本包只发**无参**的 5 条 —— 带参的那 4 条需要引擎的 `arg` 参数，本包没有那条消息）。 */
  function quickRow() {
    const row = el('div', 'pp-chat__quick');
    attrs(row, { 'data-pp-chat-quick': '' });
    row.appendChild(el('span', 'pp-chat__quick-label', tr(null, '快捷短语')));
    for (const p of QUICK_PHRASES) {
      const ok = QUICK_ID_RE.test(p.id) && canSendQuickNow(p.id, p.arg ? 'x' : null);
      const usable = QUICK_PARAMLESS_IDS.includes(p.id);   // 带参的本包发不出去
      const b = el('button', `pp-chat__quick-btn${p.arg ? ' is-arg' : ''}`, p.id);
      attrs(b, { type: 'button', 'data-pp-chat-quick-btn': p.id, title: usable ? p.msgid : tr(null, '这一条需要参数，当前引擎的协议带不了') });
      b.disabled = !usable || !ok || unsupported;
      b.addEventListener('click', () => { if (!b.disabled) void sendQuick([p.id]); });
      row.appendChild(b);
    }
    return row;
  }

  // ── 行为 ──────────────────────────────────────────────────────────────────────────────────────
  function toggle() {
    collapsed = !collapsed;
    if (collapsed) pos = null;                 // 收起 ⇒ 位置作废（把手回原处）
    savePref('chat.collapsed', collapsed);
    savePref('chat.pos', pos);
    render();
  }

  function startDrag(e, box) {
    if (!e || !box) return;
    const d = { id: e.pointerId, x0: Number(e.clientX) || 0, y0: Number(e.clientY) || 0, bx: box.offsetLeft, by: box.offsetTop, moved: false };
    const move = (ev) => {
      if (d.id !== null && ev.pointerId !== d.id) return;
      const dx = (Number(ev.clientX) || 0) - d.x0;
      const dy = (Number(ev.clientY) || 0) - d.y0;
      if (!d.moved && !isDragMove(dx, dy)) return;
      d.moved = true;
      pos = clampPanelPos(
        { x: d.bx + dx, y: d.by + dy },
        { w: box.offsetWidth, h: box.offsetHeight, vw: globalThis.innerWidth || 0, vh: globalThis.innerHeight || 0 },
      );
      rootEl.className = 'pp-chat-host is-pinned';
      rootEl.setAttribute('style', `left:${pos.x}px; top:${pos.y}px;`);
    };
    const up = (ev) => {
      if (d.id !== null && ev.pointerId !== d.id) return;
      globalThis.removeEventListener?.('pointermove', move);
      globalThis.removeEventListener?.('pointerup', up);
      globalThis.removeEventListener?.('pointercancel', up);
      if (d.moved) savePref('chat.pos', pos);   // 只有"真拖了"才落盘（点一下不算）
    };
    globalThis.addEventListener?.('pointermove', move);
    globalThis.addEventListener?.('pointerup', up);
    globalThis.addEventListener?.('pointercancel', up);
  }

  function startResize(e, box) {
    if (!e || !box) return;
    const r = box.getBoundingClientRect?.();
    const d = { id: e.pointerId, x0: Number(e.clientX) || 0, y0: Number(e.clientY) || 0, w0: r ? r.width : 260, h0: r ? r.height : 240 };
    const move = (ev) => {
      if (d.id !== null && ev.pointerId !== d.id) return;
      const next = clampPanelSize(
        { w: d.w0 + ((Number(ev.clientX) || 0) - d.x0), h: d.h0 + ((Number(ev.clientY) || 0) - d.y0) },
        { vw: globalThis.innerWidth, vh: globalThis.innerHeight },
      );
      if (next) size = next;
    };
    const up = (ev) => {
      if (d.id !== null && ev.pointerId !== d.id) return;
      globalThis.removeEventListener?.('pointermove', move);
      globalThis.removeEventListener?.('pointerup', up);
      globalThis.removeEventListener?.('pointercancel', up);
      savePref('chat.size', size);
      render();
    };
    globalThis.addEventListener?.('pointermove', move);
    globalThis.addEventListener?.('pointerup', up);
    globalThis.addEventListener?.('pointercancel', up);
  }

  /** 把（恢复出来的）位置与尺寸夹进当前视口，并在 resize 时再夹一次。 */
  function reclamp() {
    const vw = globalThis.innerWidth || 0;
    const vh = globalThis.innerHeight || 0;
    if (!vw || !vh) return;
    size = clampPanelSize(size, { vw, vh });
    if (pos) {
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) pos = null;   // 坏位置 ⇒ 回默认角
      else pos = clampPanelPos(pos, { w: size ? size.w : 280, h: size ? size.h : 220, vw, vh });
    }
    render();
  }

  function push(raw) {
    const m = normalizeMessage(raw);
    if (!m.from && !m.text) return;
    list = appendChat(list, m, CHAT_HISTORY_CAP);
    if (!collapsed) { seenAt = m.at; savePref('chat.seenAt', seenAt); }
    render();
  }

  async function send() {
    const text = clampText(draft, CHAT_MAX_CODEPOINTS);
    if (unsupported || sending || isBlank(text)) return;
    sending = true;
    try {
      const ok = ctx.net?.send?.(CHANNEL, { text });
      if (!ok) {
        // `send` 返回 false = 这个通道没有被声明 / 连接没到位。前者是**声明错误**（装载期就该发现），
        // 后者是暂时的 ⇒ 都如实告诉作者一行，并把面板置成只读（原件"老服务端"那条降级）。
        unsupported = true;
        log.warn?.('the chat channel could not be sent — the panel goes read-only');
      } else {
        push({ from: SELF_ID, name: tr(null, '我'), text, at: Date.now() });
        draft = '';
      }
    } catch (err) {
      if (isUnsupportedChatError(err)) unsupported = true;
      else log.warn?.('chat send failed', err);
    } finally {
      sending = false;
      render();
    }
  }

  async function sendQuick(ids) {
    const payload = quickMsgPayload(ids.map((id) => ({ id })));
    if (!payload || unsupported) return;
    const ok = ctx.net?.send?.(CHANNEL, { ids: payload.ids, ...(payload.arg ? { arg: payload.arg } : {}) });
    if (!ok) { unsupported = true; render(); return; }
    push({ from: SELF_ID, name: tr(null, '我'), ids: payload.ids, at: Date.now(), kind: 'quick' });
  }

  // ── 接线 ──────────────────────────────────────────────────────────────────────────────────────
  const off = ctx.net?.on?.(CHANNEL, (data) => {
    if (data && Array.isArray(data.ids)) {
      const q = normalizeMessage({ from: data.from, name: data.name, text: '', at: data.at });
      push({ ...q, kind: 'quick', ids: data.ids, ...(data.arg ? { arg: data.arg } : {}), text: undefined });
      return;
    }
    push(data);
  });

  globalThis.addEventListener?.('resize', reclamp);
  reclamp();

  return {
    unmount() {
      disposed = true;
      try { if (typeof off === 'function') off(); } catch { /* ignore */ }
      globalThis.removeEventListener?.('resize', reclamp);
      clear(host);
    },
  };
}

/** 未使用但保留导出：`messageKey` 是去重判据，本面板在"补发历史"那一半被移除后暂时用不到它。
 *  ⚠️ 保留导出（而不是删掉）是为了让 `chatModel.js` 的那条判据在测试里仍然可被独立验证 —— 见判定表。 */
export { messageKey, formatClock };
