// ui/serverStatus.js —— 「这台服务器现在有多忙」药丸（在线人数 / 房间数）。
//
// 原件（① 独立件）是三个文件：`serverStatus.js`（轮询 + 解析，211 行）＋ `serverStatusPill.js`（preact 组件）
// ＋ `hud.js.patch`（把药丸塞进顶栏）。这里合成一个**面板模块**：面板挂在 `screen.game.hud`（引擎的 HUD 层），
// 自己轮询、自己画。原件那两半的语义逐条保留：
//
//   · **`online` 取"已握手的会话"**，按新旧服务器兼容顺序回退
//     `sessionsOnline → onlinePlayers → humans → sessions → sockets`（原件 2026-10-08 那次误报的修法）。
//     ⚠️ 引擎今天的 `/healthz`（`server/http/routes.js healthReport`）**没有** `sessionsOnline` /
//     `onlinePlayers` / `dormantRooms` —— 它给的是 `sockets` / `sessions` / `rooms` / `matches` / `humans` / `bots`
//     / `spectators` / `build`。所以药丸在这台服务器上落到 `humans`（在座真人），拿不到就退 `sessions`。
//     这三条字段名的**缺失**是原件对 0.2.1 上游的假设，不是本包能补的东西（见判定表 §补不上）。
//   · **读不到服务器 ≠ 0 人在线**：请求失败 ⇒ 柔和的一条「离线」，绝不显示一个自信的 `0`。
//   · **一次都没轮询完 ⇒ 什么都不画**：加载的那半秒里显示 `0 在线 / 0 房间`，在一个人满为患的服务器上
//     会被读成"这里没人"。
//   · 45 秒一次、5 秒超时、同一时刻**只允许一个请求在飞**（慢服务器不许堆成一个积压）。
//
// 原件把「轮询器」与「组件」分成两层是为了在 Node 里单测组件（没有 DOM）。面板这一层跑在浏览器里，
// 而这一版的验证是**装载器 + 纯逻辑**（本机没有 Chrome），所以这里把两条*可判的*性质做成导出函数
// （`parseServerStats` / `pillView`），面板本体只负责画 —— 与原件的分工一致，只是搬进了同一个文件。

import { el, attrs, clear, tr } from './dom.js';

/** 多久重新读一次人口。 */
export const POLL_INTERVAL_MS = 45_000;
/** 一个不回答的 `/healthz` 就放弃，否则一次挂起会卡死后面每一次轮询。 */
export const FETCH_TIMEOUT_MS = 5_000;
/** 「一次都没轮询完」的哨兵（与「轮询过但失败了」是两个不同的、都能画出来的值）。 */
export const SERVER_STATUS_OFFLINE = Object.freeze({ offline: true });

/**
 * 从一份 `/healthz` 正文里取出要显示的数字。
 *
 * **宽容是刻意的**：每个字段都是可选的，任何不可用的值变成 `null`（静态替身、没有这些计数器的老服务器、
 * 一个仍然解析成 JSON 的代理错误页）。所有计数按非负整数向下取整，所以一个跑偏的 `-1` / `2.7`
 * 永远不会以"人数"的样子出现在屏幕上。
 * @param {any} body 解析后的 /healthz JSON
 * @returns {{ online: number|null, sockets: number|null, sessions: number|null, rooms: number|null,
 *             matches: number|null, humans: number|null, bots: number|null, spectators: number|null, build: string|null }}
 */
export function parseServerStats(body) {
  const count = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null);
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const sockets = count(b.sockets);
  const sessionsOnline = count(b.sessionsOnline);
  const onlinePlayers = count(b.onlinePlayers);
  return {
    // 顺序即语义：**优先"人"**，只有老服务器什么都不给时才退回"连接数"。
    // 一个够不到的服务器必须显示「离线」，绝不显示一个自信的 `0 在线` ⇒ 缺字段时带 null 而不是 0。
    online: sessionsOnline ?? onlinePlayers ?? count(b.humans) ?? count(b.sessions)
      ?? (sockets === null ? null : sockets),
    sockets,
    sessions: count(b.sessions),
    rooms: count(b.rooms),
    matches: count(b.matches),
    humans: count(b.humans),
    bots: count(b.bots),
    spectators: count(b.spectators),
    build: typeof b.build === 'string' && b.build ? b.build : null,
  };
}

/**
 * 药丸的三种状态**作为数据**（判据落在这里，不需要浏览器）。
 * @param {any} s 读数（`undefined` = 还没轮询完；`SERVER_STATUS_OFFLINE` = 够不到）
 * @returns {null | { kind: 'offline'|'reading', online: number|null, rooms: number|null, detail: string }}
 */
export function pillView(s, t = null) {
  if (s === undefined) return null;                       // 还没有一次轮询完成 ⇒ 什么都不画
  if (s === SERVER_STATUS_OFFLINE) {
    return { kind: 'offline', online: null, rooms: null, detail: tr(t, '读不到服务器状态（/healthz 无响应）') };
  }
  // `?? 0`：一个省掉这两个计数的读数（老服务器）显示 0 而不是空白 —— 药丸的头条数字才是玩家来要的。
  const online = s.online ?? 0;
  const rooms = s.rooms ?? 0;
  const detail = [
    // ⚠️ 措辞要点明口径：这一格是"已握手的会话/在座的人"，不是连接数。
    tr(t, '在线 {n} 人', { n: online }),
    tr(t, '房间 {n}', { n: rooms }),
    s.matches !== null && s.matches !== undefined ? tr(t, '对局 {n}', { n: s.matches }) : null,
    // ⚠️ 这是**技术读数**，量的是连接不是人 —— 如实标出来，免得下一个人又拿它当人数。
    s.sockets !== null && s.sockets !== undefined ? tr(t, '连接 {n}（含未握手）', { n: s.sockets }) : null,
    s.sessions !== null && s.sessions !== undefined ? tr(t, '会话 {n}（含重连窗口）', { n: s.sessions }) : null,
    s.spectators ? tr(t, '观战 {n}', { n: s.spectators }) : null,
    s.bots ? tr(t, 'AI {n}', { n: s.bots }) : null,
  ].filter(Boolean).join(' · ');
  return { kind: 'reading', online, rooms, detail };
}

/**
 * 读一次 `/healthz`。**从不抛**：够不到 / 非 200 / 不是 JSON / 太慢，一律 resolve 成 `null`，
 * 调用方把它画成「离线」。
 * @param {{ fetchFn?: Function, timeoutMs?: number }} [o]
 */
export async function fetchServerStatus(o = {}) {
  const fetchFn = o.fetchFn || ((url, init) => globalThis.fetch(url, init));
  const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : FETCH_TIMEOUT_MS;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const tooSlow = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => {
      try { if (ctrl) ctrl.abort(); } catch { /* ignore */ }
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchFn('/healthz', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }),
      tooSlow,
    ]);
    if (!res || !res.ok) return null;
    return parseServerStats(await res.json());
  } catch {
    return null;
  } finally {
    if (timer !== null) globalThis.clearTimeout(timer);
  }
}

/**
 * 面板入口。挂进 `screen.game.hud`（引擎对局 HUD 层里的一个容器）。
 * @param {any} ctx 注入面 `{ id, pack, slot, order, gate, host, hostKey, session, net, data, log }`
 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  let snapshot;                 // undefined = 还没轮询完
  let timer = null;
  let pending = false;
  let disposed = false;

  const root = el('span', 'pp-serverpill');
  attrs(root, { 'data-pp-server-status': '' });
  host.appendChild(root);

  function render() {
    if (disposed) return;
    const v = pillView(snapshot);
    clear(root);
    if (!v) return;              // 还没有读数 ⇒ 不画（原件的三态之一）
    if (v.kind === 'offline') {
      attrs(root, { title: v.detail, 'data-pp-status-kind': 'offline' });
      root.appendChild(el('span', 'pp-serverpill__label', tr(null, '离线')));
      return;
    }
    attrs(root, { title: v.detail, 'data-pp-status-kind': 'reading' });
    const stat = (label, value, title) => {
      const wrap = el('span', 'pp-serverpill__stat');
      attrs(wrap, { title });
      wrap.appendChild(el('span', 'pp-serverpill__value', value));
      wrap.appendChild(el('span', 'pp-serverpill__label', label));
      return wrap;
    };
    root.appendChild(stat(tr(null, '在线'), v.online, tr(null, '在线 {n} 人', { n: v.online })));
    root.appendChild(el('span', 'pp-serverpill__sep'));
    root.appendChild(stat(tr(null, '房间'), v.rooms, tr(null, '房间 {n}', { n: v.rooms })));
  }

  async function check() {
    if (disposed || pending) return;   // 一次只允许一个请求在飞
    pending = true;
    let next;
    try {
      next = (await fetchServerStatus()) ?? SERVER_STATUS_OFFLINE;
    } catch (err) {
      ctx.log?.warn?.('server status poll failed', err);
      next = SERVER_STATUS_OFFLINE;
    } finally {
      pending = false;
    }
    if (disposed) return;
    snapshot = next;
    render();
  }

  render();                            // 首帧：`undefined` ⇒ 什么都不画
  timer = globalThis.setInterval(() => { void check(); }, POLL_INTERVAL_MS);
  void check();

  return {
    unmount() {
      disposed = true;
      if (timer !== null) globalThis.clearInterval(timer);
      timer = null;
    },
  };
}
