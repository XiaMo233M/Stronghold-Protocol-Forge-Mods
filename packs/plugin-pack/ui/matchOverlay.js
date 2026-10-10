// ui/matchOverlay.js —— 快速匹配浮层（"正在为你寻找同难度的公开同盟…"）。
//
// 原件是 `③ 核心UI增强/新增文件/public/js/ui/matchOverlay.js`（114 行）。它必须**跨屏**存在
// （`room.matchmake` 会立刻把你放进/建好一个房并推 `room.state`，界面马上切到房间屏 ——
// 浮层如果长在大厅屏里就会随它一起卸载）。
//
// 本包把它挂在 `root.guide`（**固定浮层**：与当前在哪一屏无关，挂一次就一直在）—— 这正是原件那条
// "跨屏"要求在包层唯一的表达方式。原件的做法是"大厅与房间两屏各渲染一次同一份组件"；包**不能**往
// 某两个屏里插东西（那需要改引擎），但固定浮层的**效果**与它一致。
//
// 逐条保留的原件行为与纯逻辑：
//   · `matchingStatus(waited, fillMs, queue)` —— 服务端补齐时限之前是"在找人"，之后是"等 AI 补满"。
//   · `shouldShowMatch(search, inMatch)` —— 开局了或不在匹配 ⇒ 不显示。
//   · 收起后退成一条**顶部计时条**（旁边一个 ✕ 取消）。
//   · 计时**由本层自己走**（`setInterval`），换屏不打断。
//
// ⚠️ **本包读不到 `s.matchSearch`**（注入面里没有 store）⇒ 它**不能知道"我是不是在匹配中"**。
//    原件的状态住在 store（`s.matchSearch`）、由大厅屏的按钮写入。包既读不到也写不了。
//    ⇒ 本包的做法：`mount` 时**不显示**，并导出一个**可被同一页面上别人调用**的控制器
//    （`startMatching` / `stopMatching`，在 `globalThis.__ppMatchOverlay` 上暴露一份）——
//    但**没有任何引擎代码会调它**（引擎不认识本包），所以在这一版它**实际不会显示**。
//    这是本件**补不上**的那一半，已点名进判定表（缺的接口：一个只读的会话态读数，或引擎把"匹配中"
//    放进 `ctx` 的某一格）。纯逻辑（`matchingStatus` / `shouldShowMatch`）**真的写出来了**，可单测。

import { el, attrs, clear, tr } from './dom.js';

/** 服务端补齐时限的缺省值（原件：拿不到就用 60 秒）。 */
export const DEFAULT_FILL_MS = 60_000;

/**
 * 匹配浮层的**纯逻辑**（判据落在这里）。
 * 口径：服务端 `matchmakeFillMs`（缺省 60s）之前是"在找人"，之后是"等 AI 补满"；
 * `/healthz` 的 `matchmaking` = **正在凑人的房数**。
 * @param {number} waitedMs 已等待毫秒
 * @param {number} [fillMs] 服务端补齐时限
 * @param {number} [queue] `/healthz.matchmaking`（NaN = 还没拿到）
 */
export function matchingStatus(waitedMs, fillMs = DEFAULT_FILL_MS, queue = NaN) {
  const waited = Number.isFinite(waitedMs) && waitedMs > 0 ? waitedMs : 0;
  const fill = Number.isFinite(fillMs) && fillMs > 0 ? fillMs : DEFAULT_FILL_MS;
  const q = queue === null || queue === undefined || queue === '' ? NaN : Number(queue);   // `null` 是"还没拿到"，**不是 0**
  return {
    elapsed: Math.floor(waited / 1000),
    phase: waited >= fill ? 'filling' : 'searching',
    fillIn: Math.max(0, Math.ceil((fill - waited) / 1000)),
    queueText: Number.isFinite(q) ? String(Math.max(0, Math.trunc(q))) : '—',
  };
}

/** 开局了（对局开始）或不在匹配 ⇒ 浮层不该再显示。 */
export function shouldShowMatch(search, inMatch) {
  return !!search && !inMatch;
}

/** 匹配中**其它入口要被锁**（原件口径：不能开其它难度 / 独立模拟 / 开房）。 */
export function matchLocksLobby(search) {
  return !!search;
}

/** 画一次浮层 / 计时条。 */
function render(root, state) {
  clear(root);
  const ms = matchingStatus(Date.now() - state.at, state.fillMs, state.queue);
  if (state.collapsed) {
    const bar = el('div', 'pp-match-bar');
    attrs(bar, { 'data-pp-match-bar': '' });
    const expand = el('button', 'pp-btn pp-btn--ghost pp-btn--sm', `⏱ ${ms.elapsed}s ｜ ${tr(null, '匹配中')}`);
    attrs(expand, { type: 'button', 'data-pp-match-expand': '', title: tr(null, '展开匹配面板') });
    expand.addEventListener('click', () => { state.collapsed = false; render(root, state); });
    bar.appendChild(expand);
    const cancel = el('button', 'pp-btn pp-btn--sm pp-btn--danger', '✕');
    attrs(cancel, { type: 'button', 'data-pp-match-cancel': '', title: tr(null, '取消匹配'), 'aria-label': tr(null, '取消匹配') });
    cancel.addEventListener('click', () => state.onCancel?.());
    bar.appendChild(cancel);
    root.appendChild(bar);
    return;
  }
  const ov = el('div', 'pp-match-ov');
  attrs(ov, { 'data-pp-match-overlay': '' });
  const box = el('div', 'pp-match-ov__box');
  box.appendChild(el('div', 'pp-match-ov__tag', tr(null, '快速匹配')));
  box.appendChild(attrs(el('div', 'pp-match-ov__phase',
    ms.phase === 'searching' ? tr(null, '正在为你寻找同难度的公开同盟…') : tr(null, '已到补齐时间，AI 队友马上入场…')),
    { 'data-pp-match-phase': ms.phase }));
  const row = el('div', 'pp-match-ov__row');
  row.appendChild(attrs(el('span', 'pp-match-ov__elapsed', `${ms.elapsed}s`), { 'data-pp-match-elapsed': String(ms.elapsed) }));
  const cancel = el('button', 'pp-btn pp-btn--sm pp-btn--danger', '✕');
  attrs(cancel, { type: 'button', 'data-pp-match-cancel': '', title: tr(null, '取消匹配'), 'aria-label': tr(null, '取消匹配') });
  cancel.addEventListener('click', () => state.onCancel?.());
  row.appendChild(cancel);
  box.appendChild(row);
  box.appendChild(el('div', 'pp-match-ov__hint', tr(null, '最多再等 {n} 秒，之后由 AI 补满开局', { n: ms.fillIn })));
  box.appendChild(attrs(el('div', 'pp-match-ov__hint', tr(null, '正在凑人的同盟：{q} 个', { q: ms.queueText })), { 'data-pp-match-queue': ms.queueText }));
  const actions = el('div', 'pp-match-ov__actions');
  const collapse = el('button', 'pp-btn pp-btn--sm pp-btn--secondary', tr(null, '收起'));
  attrs(collapse, { type: 'button', 'data-pp-match-collapse': '' });
  collapse.addEventListener('click', () => { state.collapsed = true; render(root, state); });
  actions.appendChild(collapse);
  const cancel2 = el('button', 'pp-btn pp-btn--sm pp-btn--secondary', tr(null, '取消匹配'));
  attrs(cancel2, { type: 'button', 'data-pp-match-cancel-2': '' });
  cancel2.addEventListener('click', () => state.onCancel?.());
  actions.appendChild(cancel2);
  box.appendChild(actions);
  ov.appendChild(box);
  root.appendChild(ov);
}

/**
 * 面板入口。挂进 `root.guide`（固定浮层 ⇒ 跨屏）。
 *
 * ⚠️ 本包读不到"我是不是在匹配中"（见文件头）⇒ 挂载时**不显示**任何东西。控制器放在
 * `globalThis.__ppMatchOverlay` 上供同页面调用（本引擎不会调它）。
 * @param {any} ctx
 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  const root = el('div', 'pp-match-root');
  attrs(root, { 'data-pp-match-root': '' });
  host.appendChild(root);

  /** @type {any} */
  let state = null;
  let timer = null;

  function stop() {
    state = null;
    if (timer !== null) { globalThis.clearInterval(timer); timer = null; }
    clear(root);
  }

  function start(opts = {}) {
    stop();
    state = {
      at: Number.isFinite(opts.at) ? opts.at : Date.now(),
      fillMs: Number.isFinite(opts.fillMs) ? opts.fillMs : DEFAULT_FILL_MS,
      queue: NaN,
      collapsed: opts.collapsed === true,
      onCancel: typeof opts.onCancel === 'function' ? opts.onCancel : () => stop(),
    };
    const tick = () => {
      if (!state) return;
      render(root, state);
    };
    timer = globalThis.setInterval(tick, 1000);
    tick();
    return { stop };
  }

  const api = { start, stop, matchingStatus, shouldShowMatch, matchLocksLobby };
  try { globalThis.__ppMatchOverlay = api; } catch { /* ignore */ }

  return {
    unmount() {
      stop();
      try { if (globalThis.__ppMatchOverlay === api) delete globalThis.__ppMatchOverlay; } catch { /* ignore */ }
    },
  };
}
