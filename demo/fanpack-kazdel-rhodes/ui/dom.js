// ui/dom.js —— 面板共用的一点点 DOM/文本工具。
//
// 为什么每个面板不各自写一份：`extensions.js` 给面板的注入面里**没有** Preact、没有 htm、没有引擎的
// `components.js`（那是引擎自己的模块，包的模块 import 不到它 —— `/workshop-panels/` 只服务这个包自己的 URL，
// 而相对 import 一个 `../../../public/js/ui/components.js` 会解析到这个包目录之外，被拒）。
// ⇒ 包要画界面只有两条路：**原生 DOM**（本文件用的），或自己带一份 Preact 进包。
// 这里选前者：注入面给了 `host`（一个属于这次挂载的 <div>），原生 DOM 够画这些面板，而且零额外字节。
//
// ⚠️ 本包全部客户端模块**不使用正则后行断言**（`(?<` 家族）—— 本仓 `test/client-static.test.js` 对这个字符序列
//    有守卫（它在 `public/js/**` 上跑；本包不在这棵树下，但那条纪律同样适用于浏览器里跑的任何字节）。

/** 建一个元素，带上 class 与文本。`attrs` 里的键原样 `setAttribute`（`on*` 不接受 —— 事件用 addEventListener）。 */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** 把 `{ 'data-x': 'y', title: '…' }` 写到一个元素上（null/undefined 跳过）。 */
export function attrs(node, map) {
  for (const [k, v] of Object.entries(map || {})) {
    if (v === undefined || v === null || v === false) continue;
    node.setAttribute(k, v === true ? '' : String(v));
  }
  return node;
}

/** 清空一个元素（面板每次重画前调；比 innerHTML='' 少一次解析）。 */
export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
}

/** 读一个客户端 store 点路径（只读；不存在 ⇒ `undefined`）。与 `extensions.js readGate` 同一条口径。 */
export function readPath(state, path) {
  let cur = state;
  for (const seg of String(path || '').split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 一个会话级的预览偏好（不住在引擎 store 里 —— 面板拿不到 store 写口，只有 `session.setPreload`）。
 *  `localStorage` 在浏览器里可用；坏 JSON / 隐私模式一律安全回退。 */
export function loadPref(key, fallback) {
  try {
    const raw = globalThis.localStorage?.getItem(`sp.mod.plugin-pack.${key}`);
    if (raw === null || raw === undefined) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 写上面那个偏好（失败无害）。 */
export function savePref(key, value) {
  try { globalThis.localStorage?.setItem(`sp.mod.plugin-pack.${key}`, JSON.stringify(value)); } catch { /* 隐私模式等 */ }
}

/** 把一个 `{ t }` 风格的翻译器包一层：`t()` 不存在时原样返回 msgid（不会把界面变成空白）。 */
export function tr(t, msgid, args) {
  try {
    return typeof t === 'function' ? t(msgid, args) : msgid;
  } catch {
    return msgid;
  }
}

/** 本地时钟 `HH:MM`（与原件 `chatModel.formatClock` 同一形状）。 */
export function formatClock(at) {
  const n = Number(at);
  if (!Number.isFinite(n)) return '--:--';
  const d = new Date(n);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 按**码点**截断并去掉首尾空白（原件 `clampText` 的同一口径：一个 emoji 是一个码点，不是两个码元）。 */
export function clampText(value, limit = 120) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const points = Array.from(s);
  const cut = points.length > limit ? points.slice(0, limit).join('') : s;
  return cut.replace(/\s+$/u, '').replace(/^\s+/u, '');
}
