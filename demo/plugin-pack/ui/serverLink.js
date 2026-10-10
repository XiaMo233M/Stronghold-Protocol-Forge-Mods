// ui/serverLink.js —— 「你正在好友的服务器上」提示条（＋回到本机）。
//
// 原件（① 独立件 `public/js/ui/serverLink.js`，138 行）做两件事：把玩家粘进来的邀请文本解析成一个地址
// （`parseInvite`），以及在**你正在别人的服务器上**时显示一条带返回按钮的横幅（`ServerLinkStrip`）。
// 这里是同一个 `parseInvite` 与同一条横幅的面板化版本。
//
// 为什么它是 `root.overlays`（固定浮层）：原件的横幅是**跨屏常显**的 —— 无论你在哪一屏，只要 `?server=` 还在，
// 就必须有一条路回得去（否则玩家没有任何办法离开别人的服务器）。固定浮层正是「与当前在哪一屏无关」。
//
// ⚠️ **原件里 `?server=` 的接线不在本包能力内**：`public/js/net.js` 的 `serverOverride()` 在**建 socket 的那一刻**
// 读 `?server=`，`main.js` 读 `?room=`。本包**不能**给它加那个参数（那是引擎的网络层，不是包层）—— 见判定表。
// 所以这条横幅的语义在这台引擎上是：**如果页面 URL 里带了 `?server=`，就显示它并给一条回程**。
// 没有那个 URL 参数时它不显示（一个包不能凭自己的意愿把玩家切到别人的服务器上）。
//
// ⚠️ `nativeOverlayPresent()`（原件：桌面外壳 / 安卓外壳已经自带「联机」面板时不再重复）**保留了判据但读数不同**：
// 原件读 `globalThis.desktop` / `globalThis.Android`，那是**外壳注入的全局**，包层拿不到（注入面里没有它，
// 也不该有 —— 一个包不该能探测宿主外壳）。这一半因此**如实降级**：本包总是显示（当 URL 里有 `?server=` 时）。

import { el, attrs, clear, tr } from './dom.js';

/** 一个可能被寻址的主机：有点（域名 / IPv4），或带了显式端口。 */
const HAS_DOT = /\./;

/** 这个包使用的 URL 参数名（与引擎 `net.js` 读的那个同名 —— 包不能改它，只能读它）。 */
export const SERVER_PARAM = 'server';

/**
 * 从玩家粘进来的任何东西里认出一个访客地址。
 *
 * 刻意与原件 `.workbuddy/tools/join-friend.mjs` 的 `parseInvite()` 一致：接受一条完整链接、一个裸主机名、
 * `host:port`，或一整段把链接包在中间的邀请文字。**一个 4 位同盟密钥不是地址**，返回 null ——
 * 那正是告诉调用方"去做一次普通的本地加入"的东西。
 * @param {string} raw
 * @returns {{server: string, room: string|null}|null}
 */
export function parseInvite(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!text) return null;

  const found = text.match(/https?:\/\/[^\s"'<>，。）]+/);
  const candidate = found ? found[0] : text.replace(/\s+/g, '');

  /** @type {string} */
  let host;
  /** @type {string} */
  let port;
  /** @type {string|null} */
  let room;
  if (/^https?:\/\//i.test(candidate)) {
    let url;
    try {
      url = new URL(candidate);
    } catch {
      return null;
    }
    host = url.hostname;
    port = url.port;
    room = url.searchParams.get('room');
  } else {
    const m = candidate.match(/^([^/:?#]+)(?::(\d+))?/);
    if (!m) return null;
    host = m[1];
    port = m[2] || '';
    const q = candidate.match(/[?&]room=([A-Za-z0-9]+)/);
    room = q ? q[1] : null;
  }

  // 一个裸词（比如说一个同盟密钥）不是地址。
  if (!host || (!HAS_DOT.test(host) && !port)) return null;
  if (room) room = room.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  // 带端口 = 局域网 / 明文 ws 主机；裸域名假定是一条 TLS 隧道（引擎 `net.js serverOverride()` 正是这样判的）。
  return { server: port ? `${host}:${port}` : host, room: room || null };
}

/** 这个页面正在哪台服务器上玩，'' 表示本机。 */
export function currentServer() {
  try {
    const v = new URLSearchParams(globalThis.location?.search || '').get(SERVER_PARAM);
    return String(v || '').trim();
  } catch {
    return '';
  }
}

/**
 * 换一台服务器重载 —— `server` 为空时回到本机，可选深链一个房间。
 *
 * **重载是刻意的机制**：引擎 `net.js` 只读一次 `?server=`（建 socket 那一刻），`main.js` 只读一次 `?room=`（boot）。
 * 两者在本机都很便宜：页面与每一份素材都已经在磁盘 / 浏览器缓存里。
 * @param {string} server 主机、`host:port`，或 '' 表示本机
 * @param {string|null} [room]
 */
export function goToServer(server, room) {
  const url = new URL(globalThis.location.href);
  url.searchParams.delete(SERVER_PARAM);
  url.searchParams.delete('room');
  if (server) url.searchParams.set(SERVER_PARAM, server);
  if (room) url.searchParams.set('room', room);
  const query = url.searchParams.toString();
  globalThis.location.href = url.pathname + (query ? `?${query}` : '') + url.hash;
}

/**
 * 面板入口：只在 `?server=` 存在时渲染一条横幅。
 * @param {any} ctx
 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  const server = currentServer();
  if (!server) return {};          // 本机 ⇒ 一个字节都不加

  const bar = el('div', 'pp-gueststrip');
  attrs(bar, { role: 'status', 'data-pp-guest-server': server });
  const text = el('span', 'pp-gueststrip__text');
  text.appendChild(document.createTextNode(tr(null, '正在好友的服务器上：')));
  const code = el('span', 'pp-gueststrip__host', server);
  text.appendChild(code);
  bar.appendChild(text);

  const back = el('button', 'pp-btn pp-btn--sm', tr(null, '回到本机服务器'));
  attrs(back, { type: 'button', 'data-pp-guest-back': '' });
  back.addEventListener('click', () => { goToServer('', ''); });
  bar.appendChild(back);

  clear(host);
  host.appendChild(bar);
  return { unmount() { clear(host); } };
}
