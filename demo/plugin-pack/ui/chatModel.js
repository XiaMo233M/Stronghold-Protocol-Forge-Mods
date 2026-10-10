// ui/chatModel.js —— 房间内聊天的**纯逻辑层**（原件 `① 独立件/public/js/ui/chatModel.js` 的改写版）。
//
// 原件是 485 行，且第一条 import 就是 `import { isQuickId } from '../../../shared/protocol.js'` ——
// 那是**引擎的 wire 契约**，一个包**拿不到**（`/workshop-panels/` 只服务这个包自己的 URL；相对路径逃出包目录
// 会被装载器拒）。所以这里**不 import 引擎的任何东西**：原件从 `isQuickId` 拿的那一条形状判据，
// 在这里是**本文件自己写死的一行**（见 `QUICK_ID_RE`），并且**只用于客户端置灰**，不是权威 ——
// 权威在服务端（引擎按自己的白名单判，未知 ⇒ `BAD_MSG`）。
//
// 口径与原件逐条对齐（原件的口径来源是它自己那份 `D给B-…md`，本包照抄语义）：
//   · 单条上限 **120 码点**（`Array.from` 而不是 `String.prototype.slice`：后者按 UTF-16 码元切，
//     一个 emoji 会被切成半个，玩家看到"口口"）。
//   · 历史 **200 条**（原件 `CHAT_HISTORY_CAP`）。
//   · 昵称显示上限 **24 码点**。
//   · 「观战者不可发言（战斗中死了而观战的可以）」⇒ 判据是**是否曾占过座位**。
//   · 老服务端不认识聊天 ⇒ **优雅降级**（置灰 + 一句说明），不是弹错误刷屏。

import { clampText, formatClock } from './dom.js';

export { formatClock };

/** 单条上限：**120 码点**。 */
export const CHAT_MAX_CODEPOINTS = 120;
/** 客户端最多留多少条（服务端补发默认 50；留大一点以便一局内翻看）。 */
export const CHAT_HISTORY_CAP = 200;
/** 昵称显示上限。 */
export const CHAT_NAME_CAP = 24;
/**
 * 一条快捷短语 id 的形状。**这是本包自己的一份判据，不是权威** —— 引擎的 `shared/protocol.js isQuickId`
 * 是权威（原件 import 了它，包 import 不到）。原件那一版含大写（因为它自己裁定 id 叫 `niceOne` / `myBad`）；
 * 本包**不发明 protocol**，所以这里只用来决定按钮的 `disabled`，真正的拒绝在服务端。
 */
export const QUICK_ID_RE = /^[A-Za-z0-9_]{1,32}$/;

/** 空白串（含全角空格）不该发出去。 */
export function isBlank(value) {
  return clampText(value, CHAT_MAX_CODEPOINTS) === '';
}

/** 昵称：截断 + 空则回落成 id 的短形式。 */
export function displayName(name, from) {
  const n = clampText(name, CHAT_NAME_CAP);
  if (n) return n;
  const id = from === null || from === undefined ? '' : String(from);
  return id ? `玩家 ${id.slice(-4)}` : '玩家';
}

/**
 * 把任意来路的消息收敛成固定形状（**宽容**：字段缺失 / 类型不对都不抛）。
 * ⚠️ `at` 缺省用 `Date.now()`（原件的同一条）—— 本层是**浏览器**层，不在确定性战斗路径上。
 * @returns {{ from: string, name: string, text: string, at: number }}
 */
export function normalizeMessage(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const from = m.from === null || m.from === undefined ? '' : String(m.from);
  const at = Number.isFinite(Number(m.at)) ? Number(m.at) : Date.now();
  return { from, name: displayName(m.name, from), text: clampText(m.text, CHAT_MAX_CODEPOINTS), at };
}

/** 追加一条（**环形**：超过 `cap` 丢最旧的）。返回新数组（不原地改）。 */
export function appendChat(list, msg, cap = CHAT_HISTORY_CAP) {
  const base = Array.isArray(list) ? list : [];
  const next = base.concat([normalizeMessage(msg)]);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** 同一条消息的指纹（**去重**用：重连补发 + 实时广播可能重叠）。 */
export function messageKey(m) {
  const n = normalizeMessage(m);
  return `${n.from}\u0000${n.at}\u0000${n.text}`;
}

/**
 * 合并补发历史：`history` 是权威的**前段**，本地可能已有更晚的实时消息。
 * 以 history 为底，再把"本地独有的"按 `messageKey` 补在后面，最后按 `cap` 截断。
 * ⚠️ **宽容**：`history` 不是数组（旧服务端 / 字段改名）⇒ 当"没有历史"，**不抛**。
 */
export function mergeHistory(local, history, cap = CHAT_HISTORY_CAP) {
  const base = Array.isArray(history) ? history.map(normalizeMessage) : [];
  const extra = (Array.isArray(local) ? local : []).map(normalizeMessage);
  const seen = new Set(base.map(messageKey));
  const merged = base.concat(extra.filter((m) => !seen.has(messageKey(m))));
  merged.sort((a, b) => a.at - b.at);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

/** 服务端"不认识 `room.chat`"的识别（新客户端 + **旧服务端** ⇒ `error BAD_MSG`）。 */
export function isUnsupportedChatError(err) {
  if (!err) return false;
  const code = err.code !== null && err.code !== undefined ? String(err.code) : '';
  if (code === 'BAD_MSG' || code === 'UNKNOWN' || code === 'BAD_INTENT') return true;
  const msg = err.msg !== null && err.msg !== undefined ? String(err.msg) : String(err.message || '');
  return /bad[_ ]?msg|unknown|不支持/i.test(msg);
}

/** 自己发的消息要右对齐 / 配色区分（`from` 与自己的 id 相同）。 */
export function isMine(msg, selfId) {
  const n = normalizeMessage(msg);
  return n.from !== '' && String(selfId) === n.from;
}

/** 能不能发言（原件的客户端判据：**是否曾占过座位**）。 */
export function canSpeakInRoom(room) {
  return !!(room && room.everSeated);
}

/** 未读数：收起时用（红点）。`since` = 上次"看过"的时刻（ms epoch）。 */
export function countUnread(list, since) {
  const t = Number(since);
  if (!Number.isFinite(t)) return 0;
  return (Array.isArray(list) ? list : []).filter((m) => normalizeMessage(m).at > t).length;
}

/** 拖动判定：位移小于这个像素数仍算"点击"（原件 `lanPanel.js` 用的就是 10）。 */
export const DRAG_SLOP_PX = 10;

/** 这次指针位移算不算"真的在拖"（纯函数，好单测）。 */
export function isDragMove(dx, dy, slop = DRAG_SLOP_PX) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
  return Math.hypot(dx, dy) >= slop;
}

/**
 * 把面板位置夹进视口（纯函数 —— Node 里没有 DOM，所以把"能算的部分"抽出来）。
 * @param {{x:number,y:number}|null} pos 期望位置（px，相对视口左上角）
 * @param {{w:number,h:number,vw:number,vh:number,pad?:number}} box 面板尺寸 + 视口尺寸
 * @returns {{x:number,y:number}} 夹取后的位置（`pos` 非法时兜到右下角默认位）
 */
export function clampPanelPos(pos, box) {
  const pad = Number.isFinite(box && box.pad) ? box.pad : 4;
  const vw = Number.isFinite(box && box.vw) ? box.vw : 0;
  const vh = Number.isFinite(box && box.vh) ? box.vh : 0;
  const w = Number.isFinite(box && box.w) ? box.w : 0;
  const h = Number.isFinite(box && box.h) ? box.h : 0;
  const maxX = Math.max(pad, vw - w - pad);
  const maxY = Math.max(pad, vh - h - pad);
  const rawX = Number.isFinite(pos && pos.x) ? pos.x : maxX;
  const rawY = Number.isFinite(pos && pos.y) ? pos.y : maxY;
  return { x: Math.min(Math.max(pad, rawX), maxX), y: Math.min(Math.max(pad, rawY), maxY) };
}

/**
 * 尺寸规则（原件 2026-10-08 的用户 bug「聊天框不能自由放大缩小」）：坏输入 ⇒ `null`（＝用 CSS 默认尺寸）；
 * 给值就夹进 `[min, 视口的 90%/85%]`。
 */
export function clampPanelSize(size, box) {
  const w = Number(size && size.w);
  const h = Number(size && size.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const vw = Number.isFinite(box && box.vw) && box.vw > 0 ? box.vw : 1280;
  const vh = Number.isFinite(box && box.vh) && box.vh > 0 ? box.vh : 720;
  const minW = Number.isFinite(box && box.minW) ? box.minW : 190;
  const minH = Number.isFinite(box && box.minH) ? box.minH : 130;
  return {
    w: Math.max(minW, Math.min(Math.round(w), Math.round(vw * 0.9))),
    h: Math.max(minH, Math.min(Math.round(h), Math.round(vh * 0.85))),
  };
}

/**
 * 收起后消息按钮回原处（原件 2026-10-08 的用户口径：「收起后消息按钮应该回到最开始的位置，而不是停留在当前位置，
 * 这样既迷惑又误导人」）：**收起 ⇒ 位置一律作废**；**展开 ⇒ 保留**给它的位置。
 */
export function posForCollapse(collapsed, pos) {
  return collapsed ? null : (pos === undefined ? null : pos);
}

/** 个人屏蔽名单的**净化**（纯函数）。 */
export function cleanMuted(value) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];
  for (const x of arr) {
    const id = x === null || x === undefined ? '' : String(x);
    if (!id || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 64) break;
  }
  return out;
}

/** 某人是否被我屏蔽。 */
export function isMuted(from, muted) {
  const id = from === null || from === undefined ? '' : String(from);
  return !!id && cleanMuted(muted).includes(id);
}

/** 屏蔽 / 取消（返回新数组）。 */
export function toggleMuted(muted, from) {
  const id = from === null || from === undefined ? '' : String(from);
  if (!id) return cleanMuted(muted);
  const list = cleanMuted(muted);
  return list.includes(id) ? list.filter((x) => x !== id) : list.concat([id]);
}

/** 过滤**显示**：只丢掉被屏蔽者的消息，**不动**列表本身、**不动**历史。 */
export function filterMuted(list, muted) {
  const ban = new Set(cleanMuted(muted));
  if (!ban.size) return Array.isArray(list) ? list : [];
  return (Array.isArray(list) ? list : []).filter((m) => !ban.has(m && m.from !== null && m.from !== undefined ? String(m.from) : ''));
}

/**
 * 能不能**打字**：只有房间**明确**说不许时才置灰（`chatMode === 'quick'` / `'off'`）；
 * 缺省（`null` / `undefined`）⇒ **允许**。
 *
 * 🔴 为什么缺省是"允许"：旧服务端根本不发 `chatMode`，而它那边的打字是好用的 ⇒ 缺省置灰 =
 * 把旧服务端的打字功能整个关掉（真回退，而且玩家只看到"打字已关闭"、不知道为什么）。
 * 反过来"缺省允许"的最坏情况很轻：新服务端若忘了带这个字段而房主又关了打字，玩家打一段字会被服务端
 * `CHAT_OFF` 拒（**服务端本来就有强制**，这才是唯一的执行者）。
 * ⚠️ 本引擎的 `room.state` **没有** `chatMode` 字段（那是原件那条 patch 加的）—— 所以这条判据在这台引擎上
 * 恒为"允许"，而服务端也不会有 `CHAT_OFF`。这会随 `room.chat` 是否被引擎采纳而变（见判定表）。
 */
export function canTypeInRoom(room) {
  const mode = room && room.chatMode !== null && room.chatMode !== undefined ? String(room.chatMode) : null;
  return mode === null || mode === 'open';
}

/**
 * 🆕 快捷短语（原件的 `QUICK_PHRASES` 九条）。
 * ⚠️ **文案不在本包**：文本是引擎 `public/i18n/*` 的 msgid（`我玩 {bond}` 等），服务端只认 id。
 * 本包**不能**给引擎补这些 msgid（`pack.json.i18n` 只能补"引擎已经有这个 msgid"的键，而引擎里没有这九条 ——
 * 见判定表）。所以短语按钮在这一版**只用 id 作为标签的回退**，并如实记下这条差。
 */
export const QUICK_PHRASES = Object.freeze([
  Object.freeze({ id: 'playing', msgid: '我玩 {bond}', arg: 'bond' }),
  Object.freeze({ id: 'need', msgid: '请给我 {chess}', arg: 'chess' }),
  Object.freeze({ id: 'thanks', msgid: '感谢 {mate}', arg: 'mate' }),
  Object.freeze({ id: 'sorry', msgid: '对不起！', arg: null }),
  Object.freeze({ id: 'wait', msgid: '稍等一下', arg: null }),
  Object.freeze({ id: 'help', msgid: '救命！', arg: null }),
  Object.freeze({ id: 'careful', msgid: '小心 {enemy}', arg: 'enemy' }),
  Object.freeze({ id: 'niceOne', msgid: '漂亮！', arg: null }),
  Object.freeze({ id: 'myBad', msgid: '我的错', arg: null }),
]);

const QUICK_BY_ID = new Map(QUICK_PHRASES.map((p) => [p.id, p]));
/** 认识的 id（伪造 / 未知的一律丢掉）。 */
export const QUICK_ID_SET = new Set(QUICK_PHRASES.map((p) => p.id));
/** 带参的 4 条（本包**不带参发送** —— 见 `quickMsgPayload` 的说明）。 */
export const QUICK_ARG_IDS = Object.freeze(QUICK_PHRASES.filter((p) => p.arg).map((p) => p.id));
/** 无参的 5 条（本包当前只发这些）。 */
export const QUICK_PARAMLESS_IDS = Object.freeze(QUICK_PHRASES.filter((p) => !p.arg).map((p) => p.id));

/** 一条 id 的句式定义（不认识 ⇒ null）。 */
export function quickPhraseOf(id) {
  return QUICK_BY_ID.get(String(id)) || null;
}

/**
 * 把收到的 `quick.msg` 收敛成固定形状（宽容：缺字段 / 类型不对 / 未知 id 都不抛）。
 *
 * 🔴 **本包的包通道装不下它**：原件这一条走的是引擎的 S2C `quick.msg`（它的 `shared__protocol.js.patch`
 * 定义的），而包**不能定义新的协议类型**。本包的通道是 `pack.msg`（类型名由引擎定、通道名由包定），
 * 所以一条短语要在**同房间的客户端之间**走动，只能走本包自己的通道（`ctx.net.send('chat', …)`）。
 * ⇒ 本函数因此**保留**：它收敛的是**经本包通道收到的**那条载荷（同一个形状），
 *   而"服务端到底认不认这九条 id"**不由本包决定**（判定表 §发不出去）。
 */
export function normalizeQuickMessage(msg) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const from = m.from === null || m.from === undefined ? '' : String(m.from);
  const at = Number.isFinite(Number(m.at)) ? Number(m.at) : Date.now();
  const raw = Array.isArray(m.ids) ? m.ids : (typeof m.ids === 'string' ? m.ids.split(',') : []);
  const ids = [];
  for (const x of raw) {
    const id = String(x).trim();
    if (!QUICK_BY_ID.has(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= 3) break;
  }
  if (!ids.length) return null;
  const rawArg = m.arg === null || m.arg === undefined ? '' : String(m.arg).trim();
  const arg = rawArg && rawArg.length <= 24 && !/\s/.test(rawArg) ? rawArg : '';
  return { from, name: displayName(m.name, from), ids, at, kind: 'quick', ...(arg ? { arg } : {}) };
}

/** 追加一条快捷短语（与 `appendChat` 同规矩：环形 + 不原地改；坏消息 ⇒ 原样返回）。 */
export function appendQuick(list, msg, cap = CHAT_HISTORY_CAP) {
  const q = normalizeQuickMessage(msg);
  if (!q) return Array.isArray(list) ? list : [];
  const base = Array.isArray(list) ? list : [];
  const next = base.concat([q]);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * 一条短语消息的**显示文本**（`t` 注入 ⇒ 本层仍是纯函数）。
 * 带参句式若拿不到参数 ⇒ `t` 会把 `{…}` 原样留下 —— 那是**如实**的"缺参数"，比编一个名字好。
 */
export function quickTextOf(m, deps = {}) {
  const { t, names = {} } = deps;
  const ids = Array.isArray(m && m.ids) ? m.ids : [];
  const arg = m && typeof m.arg === 'string' ? m.arg : null;
  const parts = [];
  for (const id of ids) {
    const p = QUICK_BY_ID.get(id);
    if (!p) continue;
    const value = (arg && names[arg] !== null && names[arg] !== undefined) ? names[arg] : (p.arg && arg ? arg : null);
    const args = p.arg && value !== null ? { [p.arg]: value } : {};
    parts.push(typeof t === 'function' ? t(p.msgid, args) : p.msgid);
  }
  return parts.join(' ');
}

/**
 * `items → 要发的那一条 quick 载荷`。
 *
 * ⚠️ **与原件的一处实质差异**：原件发的是引擎 C2S `room.quickMsg { id, arg }`（它的 patch 定义的）。
 * 本包**发不了那条消息**，只能走自己的包通道。所以这里产出的是**本包通道的载荷形状**（`{ ids, arg? }`），
 * 由 `chat.js` 用 `ctx.net.send('chat', …)` 发出去 —— 同一个房间、同一个包的人收得到；
 * **引擎不会解释它、不会替它做白名单/频率之外的事**（`pack.msg` 的语义就是这样）。
 * 歧义规则保留原件的：**一条消息要么只含无参 id（≤3 个），要么恰好一条带参 id**。
 * @param {Array<{id: string, arg?: string}>} items
 * @param {number} [max]
 * @returns {{ ids: string[], arg?: string }|null} null ⇒ 不发
 */
export function quickMsgPayload(items, max = 3) {
  const arged = [];
  const plain = [];
  for (const it of Array.isArray(items) ? items : []) {
    const id = it && it.id !== null && it.id !== undefined ? String(it.id) : '';
    const p = QUICK_BY_ID.get(id);
    if (!p) continue;                                        // 未知 id 一律不发
    if (!QUICK_ID_RE.test(id)) continue;                      // 形状不认的（本包自己的置灰判据）
    if (!p.arg) { if (!plain.includes(id)) plain.push(id); continue; }
    const arg = it && it.arg !== null && it.arg !== undefined ? String(it.arg).trim() : '';
    if (!arg || arg.length > 24 || /\s/.test(arg)) continue;  // 带参的**必须有合法 arg**
    if (!arged.some((x) => x.id === id)) arged.push({ id, arg });
  }
  if (arged.length) return arged.length === 1 ? { ids: [arged[0].id], arg: arged[0].arg } : null;  // ≥2 条带参 ⇒ 歧义 ⇒ 不发
  return plain.length ? { ids: plain.slice(0, max) } : null;
}

/** 这一条**现在**能不能一键发出去（面板按钮的 `disabled` 与发送路径**共用本函数** ⇒ 不会分叉）。 */
export function canSendQuickNow(id, arg = null) {
  return quickMsgPayload([{ id, arg }]) !== null;
}

/**
 * 房主的打字开关（原件 `room.quick`）。
 * ⚠️ 本引擎**没有** `room.quick`（那条消息在原件自己的 protocol patch 里），所以本包**发不出去**它。
 * 函数保留：它是原件的语义（`on:true` = **打字关掉**），面板据此置灰按钮并如实说明。见判定表。
 * @returns {{ on: boolean, label: string }}
 */
export function textChatSwitch(chatMode) {
  const typingOff = chatMode === 'quick' || (chatMode !== null && chatMode !== undefined && chatMode !== 'open');
  return typingOff ? { on: false, label: '开启打字' } : { on: true, label: '关闭打字' };
}

/** 谁能在**什么时候**改那个开关（原件的客户端镜像：**房主** ＋ **对局开始前**）。 */
export function canToggleTextChat(room, selfId) {
  if (!room || room.hostId === null || room.hostId === undefined || selfId === null || selfId === undefined) return false;
  return String(room.hostId) === String(selfId) && !room.inMatch;
}
