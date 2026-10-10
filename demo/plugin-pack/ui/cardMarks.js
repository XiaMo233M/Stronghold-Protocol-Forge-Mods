// ui/cardMarks.js —— 卡面标记（"本局我想要"高亮）。
//
// 原件是 `③ 核心UI增强/新增文件/public/js/ui/cardMarks.js`（纯逻辑 + 持久化，123 行）**加上**
// `public__js__ui__shopBar.js.patch` 与 `public__js__ui__bondStrip.js.patch`（把标记画进商店卡与盟约弹层的
// 那两处 JSX）。本包用一个 `client.panels[]` 条目把这三件合成一件事，**两条通道一起用**：
//
//   · `wraps: [{ component: 'game.shopCard', mode: 'wrap' }]` —— 引擎的**商店卡组件**被包一层。
//     这是 0.13.0 的 `CLIENT_WRAP_COMPONENTS` 之一（`public/js/ui/modComponents.js MOD_COMPONENT_IDS`），
//     而 `ctx.props` 给的是**这一帧**那个组件的 props 只读快照：卡上那名棋子的 id 就在
//     `ctx.props.slot.id`（引擎 `shopBar.js ChessCard({ slot, ... })`）。⇒ 原件 patch 里那颗 ★
//     （"卡角上的星，逐卡切换高亮"）在这里**真的能做出来**，而且不改引擎一个字节。
//     ⚠️ 但 `orig` 是**一个 vnode**，不是 DOM 节点 —— 而本包**没有 Preact**（注入面里没有，包也 import 不到
//     引擎的 `vendor/preact.module.js`）。⇒ 一个纯 DOM 的 `wrap` 返回不了"把 orig 嵌进去的一棵树"。
//     所以这里的 `wrap` 走**加法**：它返回 `orig` **原样**（引擎自己那份卡照旧渲染，绝不被本包改坏），
//     而"标记"由下面那个槽位面板画进卡里的 `[data-mod-slot="screen.game.shopCard"]` 容器（引擎已经渲染了它）。
//     ⇒ 结论：`wraps` 这一格**声明了但只能做"不加不减"**（见判定表 §wrap 的边界）；真正生效的是槽位。
//   · `slot: 'screen.game.shopCard'`（**可重复**宿主，每张卡一个容器）—— 面板挂进**每一张**卡，
//     `ctx.hostKey` 告诉它是哪一张（那正是棋子的 id）。
//
// 候选集合 = X 的那条实测口径（原件 §候选集合）**逐字保留**：候选是 `visible !== false && isHidden !== true`
// 的 chess 记录；`diy.ownedPool`（char id）与 chess 键**交集 0**，拿它当候选一个都标不出来。

import { el, attrs, clear, tr, loadPref, savePref } from './dom.js';

/** 上限：防坏数据把偏好存爆（正常一局标几十张就到头）。 */
export const CARD_MARKS_MAX = 400;

/**
 * 本局标识（纯函数，可判据）：`房间码#相位`。
 * ⚠️ 本包**拿不到 `room`**（注入面里没有 store / 对局态），所以 marker 只能从 `ctx.props` 里能读到的东西推。
 * 商店卡这一帧的 props 里没有房间码 ⇒ 本包退化成**一个全局键**（原件 2026-10-09 那个用户 bug 的根源）。
 * 修法在原件里是"键里带 marker"；**这里做不到**，所以标记**会跨局残留** —— 这是本包补不上的一条，
 * 已如实记在判定表（缺的接口：一个只读的"当前房间/相位"读数，或 `ctx.data` 之外的一格会话态）。
 * @param {{ code?: string, inMatch?: boolean }|null} room
 */
export function marksMarker(room) {
  const code = room && room.code !== null && room.code !== undefined ? String(room.code) : '';
  if (!code) return '';
  return `${code}#${room.inMatch ? 'match' : 'lobby'}`;
}

/** 坏数据 ⇒ 空集，**不抛**。 */
export function cleanMarks(v) {
  const out = [];
  for (const raw of Array.isArray(v) ? v : []) {
    const id = raw === null || raw === undefined ? '' : String(raw);
    if (!id || id.length > 64 || out.includes(id)) continue;
    out.push(id);
    if (out.length >= CARD_MARKS_MAX) break;
  }
  return out;
}

/** 一条 chess 记录是否"玩家可能看到"（**唯一一处定义**，候选 / 阶级 / 盟约都问它）。 */
export function isChessVisible(rec) {
  return !!rec && rec.visible !== false && rec.isHidden !== true;
}

/**
 * 候选集合：本局**真可能出现**的 chess id。
 * @param {object} chess `data/chess.json`（键 = chess id）
 */
export function candidateChessIds(chess) {
  const out = [];
  for (const [id, rec] of Object.entries(chess && typeof chess === 'object' ? chess : {})) {
    if (!isChessVisible(rec)) continue;
    out.push(id);
  }
  return out;
}

/** 一条 chess 记录的盟约归属。 */
export function bondsOf(chess, id) {
  const rec = chess && typeof chess === 'object' ? chess[String(id)] : null;
  return Array.isArray(rec && rec.bonds) ? rec.bonds : [];
}

/** 按盟约批量：该盟约 ∩ 候选（**不是全树**）。 */
export function markBondIds(chess, bondId) {
  const want = String(bondId);
  return candidateChessIds(chess).filter((id) => bondsOf(chess, id).includes(want));
}

/** 查 / 切（纯函数，返回新数组 ⇒ 比较引用就能决定重渲染）。 */
export function isMarked(marks, id) { return cleanMarks(marks).includes(String(id)); }
export function toggleMark(marks, id) {
  const cur = cleanMarks(marks);
  const k = String(id);
  return cur.includes(k) ? cur.filter((x) => x !== k) : cleanMarks([...cur, k]);
}
export function markMany(marks, ids) { return cleanMarks([...cleanMarks(marks), ...(Array.isArray(ids) ? ids : [])]); }
export function unmarkMany(marks, ids) {
  const drop = new Set((Array.isArray(ids) ? ids : []).map(String));
  return cleanMarks(marks).filter((x) => !drop.has(x));
}

/** 入口闸门那一格契约里**唯一**允许的 store 写口 —— 见 `wrap` 的说明。 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  const chessId = ctx.hostKey;            // 可重复宿主：这个键就是棋子 id（引擎 shopBar.js 写进去的）
  if (!chessId) return {};

  let marks = cleanMarks(loadPref('cardMarks', []));
  const marked = () => isMarked(marks, chessId);

  const star = el('button', 'pp-mark');
  attrs(star, {
    type: 'button',
    'data-pp-card-mark': chessId,
    title: marked() ? tr(null, '取消标记') : tr(null, '标记：本局我想要'),
  });
  star.textContent = marked() ? '★' : '☆';
  star.classList.toggle('is-on', marked());
  star.addEventListener('click', (e) => {
    e.stopPropagation?.();                 // ⛔ 绝不吃掉卡片自己的点击（商店必须照旧能买）
    e.preventDefault?.();
    marks = toggleMark(marks, chessId);
    savePref('cardMarks', marks);
    sync();
  });
  star.addEventListener('keydown', (e) => {
    if (e && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault?.();
      e.stopPropagation?.();
      marks = toggleMark(marks, chessId);
      savePref('cardMarks', marks);
      sync();
    }
  });

  function sync() {
    const on = marked();
    star.textContent = on ? '★' : '☆';
    star.classList.toggle('is-on', on);
    attrs(star, { 'aria-pressed': String(on), title: on ? tr(null, '取消标记') : tr(null, '标记：本局我想要') });
  }

  clear(host);
  host.appendChild(star);
  sync();

  // 「全部高亮」那一条（原件绑在盟约弹层的"全部高亮"按钮上）：本包没有盟约弹层的槽位，所以在这里
  // **不提供**那个按钮 —— 但要保留这条能力对 `data` 的用法示范（判定表里点名它缺的宿主）。
  void ctx.data?.get?.('chess');

  return { unmount() { clear(host); } };
}

/**
 * 组件级改写（`client.panels[].wraps`）。
 *
 * **它返回 `orig` 原样**，理由写在文件头：一个纯 DOM 模块拼不出"把 `orig` 嵌进去"的那棵树
 * （本包没有 Preact，而 `orig` 是一个 vnode）。所以：
 *   · 引擎自己的商店卡**逐字照旧渲染**（本包绝不改坏它）；
 *   · 声明 `wraps` 的真正收益在**这里**：它让"这个面板与商店卡有关系"这件事在 `pack.json` 里是**声明的**、
 *     进身份哈希、且被引擎的装载期判过（`CLIENT_WRAP_COMPONENTS` 的闭枚举）；
 *   · 但**不要**把这一条读成"本包改写了商店卡" —— 它没有。判定表 §wrap 把这条写清楚了。
 */
export function wrap() {
  return (orig) => orig;
}
