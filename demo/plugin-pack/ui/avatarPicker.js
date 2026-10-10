// ui/avatarPicker.js —— 头像选择器（网格 + 本地持久化）。
//
// 原件是 `③ 核心UI增强/新增文件/public/js/ui/avatarPicker.js`（157 行）。它读
// `/assets/avatar/manifest.json`（184 张 PNG 的清单）画一个网格，选中的 id 存本地偏好，
// 并经 `room.avatar`（原件 protocol patch 的 C2S）镜像给服务端，让别人也看得见。
//
// 逐条保留：
//   · **协议里永远不出现文件名/路径**：存的是 id（`[a-z0-9_]{1,32}`），id → URL 的映射只在这里。
//   · `cleanAvatarId`（坏 id 一律丢）、`avatarSrc`（没有 id 就 null ⇒ 调用方退回字形，不是一张坏图）。
//   · 选择器是**网格 + 筛选框 + 「用默认」+ 「关闭」**，且读不到清单时**如实报一条**而不是空白。
//
// ===== 0.13.0：那「发不出去的一半」发出去了 =====
//
// 上一版这一节**只存在本机**，并在界面上如实写明「别人看不到」，因为引擎没有头像同步的消息
// （`shared/protocol.js` 的 C2S 里没有 `room.avatar`），而包**不能发明新的线上类型**。
//
// 现在引擎给了 `room.appearance`（业主裁决：换装与头像对同房的人可见），它收的是
// `{ [charId]: { skinId } | { avatar } }` —— 头像走的就是 `{ avatar: <id> }` 那一支。
// 于是这次选择**真的能到达别人**：写本地偏好（自己看）+ `ctx.session.send('room.appearance', …)`（别人看）。
//
// 仍然不变的两条边界：
//   · **协议里永远不出现文件名/路径**：存的是 id，id → URL 的映射只在这里；
//   · 面板**只能发白名单里的那条展示消息**（`ctx.session.send` 的闭枚举），改不了对局状态。
//
// ⚠️ 素材路径 `/assets/avatar/` 是**原件 fork 的目录**，本引擎里没有它。所以一键体验的前提是
//    安装方自己把那些素材放进去；读不到就显示那条错误（原件的 `err` 分支），⛔ 不内置任何素材。

import { el, attrs, clear, tr, loadPref, savePref } from './dom.js';

/** 本地偏好键（只存 id，不存路径）。 */
export const AVATAR_PREF = 'avatar.id';
/** 清单地址（与素材同目录）。 */
export const AVATAR_MANIFEST_URL = '/assets/avatar/manifest.json';

/** 合法 id：小写 slug（⛔ 不许 URL / 路径 / 大写，也必须是字符串）。 */
export function cleanAvatarId(v) {
  if (typeof v !== 'string') return '';
  return /^[a-z0-9_]{1,32}$/.test(v) ? v : '';
}

/** id → 图片 URL。**没有 id 就返回 null**（调用方据此退回首字母字形，而不是显示一个坏图）。 */
export function avatarSrc(id) {
  const k = cleanAvatarId(id);
  return k ? `/assets/avatar/${k}.png` : null;
}

/**
 * 局内该显示谁的头像（原件 2026-10-09 的三级来源）：
 *   ① 对局公开态自带的 `player.avatarId` ② `room.seats/spectators` 里那一席的 `avatarId` ③ 自己 ⇒ 本地偏好。
 * ⛔ 一律过 `cleanAvatarId`；拿不到 ⇒ `''`。
 * @param {{playerId?:string, avatarId?:string}|null} player
 * @param {{ room?:any, myId?:string|null, myAvatarId?:string|null }} [ctx]
 */
export function avatarIdForPlayer(player, ctx = {}) {
  const pid = player && player.playerId !== null && player.playerId !== undefined ? String(player.playerId) : '';
  const own = cleanAvatarId(player && player.avatarId);
  if (own) return own;
  const room = ctx.room;
  const seats = [
    ...(Array.isArray(room && room.seats) ? room.seats : []),
    ...(Array.isArray(room && room.spectators) ? room.spectators : []),
  ];
  const hit = seats.find((s) => s && String(s.playerId) === pid);
  const fromSeat = cleanAvatarId(hit && hit.avatarId);
  if (fromSeat) return fromSeat;
  if (pid && ctx.myId !== null && ctx.myId !== undefined && pid === String(ctx.myId)) return cleanAvatarId(ctx.myAvatarId);
  return '';
}

/** 网格里要用的那一份清单（`{ avatars: [{id,file,label}] }`；坏数据一律当空）。 */
export function pickerItems(manifest) {
  const list = manifest && Array.isArray(manifest.avatars) ? manifest.avatars : [];
  return list
    .map((a) => ({
      id: cleanAvatarId(a && a.id),
      file: a && typeof a.file === 'string' ? a.file : '',
      label: a && typeof a.label === 'string' ? a.label : '',
    }))
    .filter((a) => a.id && a.file);
}

/** 入口。挂进 `root.overlays`（固定浮层 ⇒ 任何一屏都能弹）。 */
export function mount(ctx) {
  const host = ctx.host;
  if (!host) return {};
  let open = false;
  let current = cleanAvatarId(loadPref(AVATAR_PREF, ''));
  let items = null;
  let err = false;
  let query = '';

  const root = el('div', 'pp-avpick');
  attrs(root, { 'data-pp-avatar-root': '' });
  host.appendChild(root);

  function render() {
    clear(root);
    if (!open) {
      const b = el('button', 'pp-btn pp-btn--sm', tr(null, '选择头像'));
      attrs(b, { type: 'button', 'data-pp-avatar-open': '', title: tr(null, '选择头像') });
      b.addEventListener('click', () => { open = true; render(); });
      root.appendChild(b);
      return;
    }
    const overlay = el('div', 'pp-avpick__ov');
    attrs(overlay, { 'data-pp-avatar-picker': '' });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { open = false; render(); } });
    const box = el('div', 'pp-avpick__box');

    const head = el('div', 'pp-avpick__head');
    head.appendChild(el('b', 'pp-avpick__title', tr(null, '选择头像')));
    head.appendChild(el('span', 'pp-avpick__count', tr(null, '共 {n} 张（本地素材，选完立刻生效）', { n: (items || []).length })));
    const clearBtn = el('button', 'pp-btn pp-btn--secondary pp-btn--sm', tr(null, '用默认（首字母）'));
    attrs(clearBtn, { type: 'button', 'data-pp-avatar-clear': '' });
    clearBtn.addEventListener('click', () => { choose(''); });
    head.appendChild(clearBtn);
    const closeBtn = el('button', 'pp-btn pp-btn--secondary pp-btn--sm', tr(null, '关闭'));
    attrs(closeBtn, { type: 'button', 'data-pp-avatar-close': '' });
    closeBtn.addEventListener('click', () => { open = false; render(); });
    head.appendChild(closeBtn);
    box.appendChild(head);

    // 如实写明同步的边界：选好之后同房的人能看到，但「用默认」**不清掉**已经广播的那一项
    // （服务端没有「删掉一项」的语义，见 choose() 的注释）。
    box.appendChild(el('p', 'pp-avpick__note',
      tr(null, '选好之后同房的人立刻看得到。点「用默认」只改你自己这边，别人那边仍是你上次广播的那张。')));

    const search = el('input', 'pp-input');
    attrs(search, { type: 'text', 'data-pp-avatar-search': '', placeholder: tr(null, '筛选（按 id / 名称）'), value: query });
    search.addEventListener('input', (e) => { query = e.target.value || ''; render(); });
    box.appendChild(search);

    if (err) {
      box.appendChild(attrs(el('div', 'pp-avpick__error',
        tr(null, '读不到头像清单（{url}）', { url: AVATAR_MANIFEST_URL })), { 'data-pp-avatar-error': '' }));
    }
    if (items === null && !err) box.appendChild(el('div', 'pp-avpick__loading', tr(null, '正在读取…')));

    const q = query.trim().toLowerCase();
    const shown = (items || []).filter((a) => !q || a.id.includes(q) || a.label.toLowerCase().includes(q));
    const grid = el('div', 'pp-avpick__grid');
    for (const a of shown) {
      const b = el('button', `pp-avpick__cell${a.id === current ? ' is-on' : ''}`);
      attrs(b, { type: 'button', 'data-pp-avatar-id': a.id, title: a.label || a.id });
      b.appendChild(attrs(el('img', 'pp-avpick__img'), { src: `/assets/avatar/${a.file}`, alt: a.label || a.id, loading: 'lazy' }));
      b.addEventListener('click', () => choose(a.id));
      grid.appendChild(b);
    }
    box.appendChild(grid);
    if (items && !shown.length) box.appendChild(el('div', 'pp-avpick__loading', tr(null, '没有匹配的头像')));

    overlay.appendChild(box);
    root.appendChild(overlay);
  }

  function choose(id) {
    current = cleanAvatarId(id);
    savePref(AVATAR_PREF, current);        // 自己看：本地偏好
    // 别人看：引擎的白名单展示消息。头像走 `{ avatar: <id> }` 那一支。
    //
    // 「用默认（首字母）」的情况（`current === ''`）**不广播**：`room.appearance` 的每一项必须是
    // `{ skinId }` 或 `{ avatar }` **恰好一个**，而 `''` 不是合法 id（`isId` 会拒）—— 发出去只会换一个
    // error 帧。回到默认**不清掉**已广播的那一项（服务端没有「删除一项」的语义），这是这个接口今天的边界，
    // 所以界面上如实写明（见下面那条 note）。
    if (current) ctx.session?.send?.('room.appearance', { avatar: { avatar: current } });
    open = false;
    render();
  }

  function loadManifest() {
    if (items !== null || err) return;
    let alive = true;
    globalThis.fetch?.(AVATAR_MANIFEST_URL)
      .then((r) => (r && r.ok ? r.json() : Promise.reject(new Error(String(r && r.status)))))
      .then((j) => { if (alive) { items = pickerItems(j); render(); } })
      .catch(() => { if (alive) { err = true; render(); } });
    // `alive` 在 unmount 时置假（一个还没回来的请求不该往一个已经卸载的面板里写）。
    aliveRef = () => { alive = false; };
  }
  let aliveRef = () => {};

  const onKey = (e) => { if (e && e.key === 'Escape' && open) { open = false; render(); } };
  document.addEventListener('keydown', onKey);

  render();
  loadManifest();          // 打开之前就把清单拉起来（打开时不再等一次）

  return {
    unmount() {
      aliveRef();
      document.removeEventListener('keydown', onKey);
      clear(host);
    },
  };
}
