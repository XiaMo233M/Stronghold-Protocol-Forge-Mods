// resources/preloadModal.js — 本包的 C 层入口闸门与导入界面（`pack.json.client.panels[0].module`）。
//
// ## 它在链条里的位置
//
//   服务端（`server/resourceAdmission.mjs`）在连接建立时发一个挑战；本面板负责
//   ① 把玩家挡在标题页（`ctx.session.setPreload({ required: true, ready: false })`），
//   ② 让玩家把 `.spresources` 容器导入浏览器缓存（引擎的整条流程，`/js/resources/host.js`），
//   ③ 面对挑战出示「持有证明」，
//   ④ 收到 `resource.accepted` 之后才放行（`{ ready: true }`）。
//
// ## 它拿到的注入面（`public/js/ui/extensions.js` 的冻结对象）
//
// 只有 `id / pack / slot / order / gate / host / session / net / log`。**没有** store 句柄、没有 `net` 对象本身、
// 没有对局对象。所以这个面板可以画错界面，**改不了对局结果**。
//
// ## 四个必须踩对的点（错了会静默失效，所以写在这里）
//
//   1. **资源消息必须走 `ctx.net.sendResourceMessage`，不能走普通的 `send`。** 服务端的挑战是连接建立时就发出去的，
//      那一刻 `status` 还不是 `online`，普通 `send` 会**静默丢弃**。这正是原件踩过的坑。
//   2. **挂载时可能还没看到服务器的挑战。** 挑战在连接建立时发出，而面板要等 `welcome.modPanels` 到了才挂载；
//      两者之间隔着一次握手。所以挂载后主动要一次（`resource.challenge.request`），并且**要重试** ——
//      服务端的重发有 1 秒限流，第一次请求很可能正好落在窗口里被忽略。
//   3. **面板挂载时 `welcome.modAssets` 可能还没被宿主登记。** `public/js/main.js` 先 `import('./resources/host.js')`
//      再登记（异步），而本模块也是被动态 `import` 的 —— 两个 promise 谁先落地没有保证。所以下面有一段**有界的等待**，
//      而不是一次 `modAssetsFor()` 查不到就永久放弃。
//   4. **本面板不声明 `gate`。** 这是有意的：`gate` 的语义是「store 里那个路径为真才挂」，而把闸门打开的正是这个
//      面板自己 —— 一个 `gate: "session.preloadRequired"` 的面板在全新会话里**永远挂不上**（那个标志缺省是 `false`，
//      没有任何别的东西会把它置真）。`docs/WORKSHOP.md` §1.9.3 的示例恰好是这么写的，那是那份文档的一个坑；
//      本包的写法是「无条件挂载 + 挂载时自己关闸」。
//
// ## 不发 `assets` 声明时不启用
//
// 本模块只在包真的声明了 `client.panels` 时才被 `welcome.modPanels` 带来；没有声明 `assets` 的部署里声明会是
// `null`，那时**不设闸门**（不设 = 玩家行为一个字节不变）并记一条 error，而不是把所有人挡在门外。

import { modAssetsFor, importAndVerify, importFromServer, importStateFor } from '/js/resources/host.js';
import { revokeImport } from '/js/resources/bundle.js';

/** 等宿主登记服务器声明的上限（20 × 250 ms = 5 s）。 */
const DECL_WAIT_TRIES = 20;
const DECL_WAIT_MS = 250;
/** 向服务端要挑战的重试（4 × 1200 ms）：服务端的重发有 1 s 限流，第一次请求可能正好被忽略。 */
const CHALLENGE_RETRIES = 4;
const CHALLENGE_RETRY_MS = 1200;
/** 一次挑战里证明的条数（与服务端 `CHALLENGE_SIZE` 一致；对不上时服务端会判 `challenge` 不合格）。 */
const CHALLENGE_SIZE = 3;

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

/** 从本地缓存里取一条被校验过的资源字节（`caches.match` 跨所有缓存找，所以不依赖引擎的缓存名）。 */
async function cachedBytes(url) {
  const response = await caches.match(new URL(url, location.origin).href);
  if (!response) return null;
  return new Uint8Array(await response.arrayBuffer());
}

const CSS = `
.sp-rp-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
  background:rgba(8,10,16,.72);font-size:14px;line-height:1.6}
.sp-rp-card{width:min(520px,92vw);padding:20px 22px;border-radius:12px;background:#161a24;color:#e8ecf4;
  box-shadow:0 12px 40px rgba(0,0,0,.5);border:1px solid #2a3142}
.sp-rp-title{margin:0 0 4px;font-size:17px;font-weight:600}
.sp-rp-state{margin:0 0 12px;color:#9fb0c8}
.sp-rp-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.sp-rp-btn{padding:7px 14px;border-radius:8px;border:1px solid #3a445c;background:#222a3a;color:#e8ecf4;cursor:pointer}
.sp-rp-btn:disabled{opacity:.45;cursor:default}
.sp-rp-btn-primary{border-color:#4b6bd6;background:#2f4bb0}
.sp-rp-detail{margin-top:10px;color:#ffb4a2;white-space:pre-wrap;word-break:break-word}
.sp-rp-list{margin:8px 0 0;padding-left:18px;color:#9fb0c8}
.sp-rp-ok{color:#8fe0a0}
`;

function ensureStyle(doc) {
  if (!doc || !doc.head || doc.getElementById('sp-rp-style')) return;
  const node = doc.createElement('style');
  node.id = 'sp-rp-style';
  node.textContent = CSS;
  doc.head.appendChild(node);
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * 面板的挂载点。契约：`export function mount(ctx)`，可以返回 `{ unmount() }`。
 * @param {{ id: string, pack: string, slot: string, order: number, gate: string|null,
 *   host: HTMLElement, session: { setPreload: Function },
 *   net: { on: Function, sendResourceMessage: Function },
 *   log: { info: Function, warn: Function, error: Function } }} ctx
 */
export function mount(ctx) {
  const doc = ctx.host.ownerDocument || globalThis.document;
  const log = ctx.log || { info() {}, warn() {}, error() {} };
  ensureStyle(doc);

  const card = el(doc, 'div', 'sp-rp-card');
  const title = el(doc, 'h2', 'sp-rp-title', '完整资源包');
  const stateLine = el(doc, 'p', 'sp-rp-state', '正在检查本地已导入的资源包…');
  const list = el(doc, 'ul', 'sp-rp-list');
  const detail = el(doc, 'div', 'sp-rp-detail');
  const row = el(doc, 'div', 'sp-rp-row');
  const btnServer = el(doc, 'button', 'sp-rp-btn sp-rp-btn-primary', '从服务器导入（推荐）');
  const btnPick = el(doc, 'button', 'sp-rp-btn', '选择本地文件…');
  const btnRecheck = el(doc, 'button', 'sp-rp-btn', '重新校验');
  const fileInput = el(doc, 'input');
  fileInput.type = 'file';
  fileInput.accept = '.spresources';
  fileInput.style.display = 'none';

  row.append(btnServer, btnPick, btnRecheck);
  card.append(title, stateLine, list, row, detail, fileInput);
  const overlay = el(doc, 'div', 'sp-rp-overlay');
  overlay.appendChild(card);
  ctx.host.appendChild(overlay);

  /** @type {'checking'|'missing'|'importing'|'ready'|'error'} */
  let phase = 'checking';
  let disposed = false;
  /** @type {any} 服务器宣告的那一条（`welcome.modAssets`）。 */
  let decl = modAssetsFor(ctx.pack);
  let retryTimer = null;
  let retriesLeft = 0;
  // 计时器必须能被收掉：一个已经离开页面的面板不该继续发资源消息。
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); if (!disposed) fn(); }, ms); timers.add(t); return t; };
  const stopRetry = () => { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } };

  const buttons = [btnServer, btnPick, btnRecheck];
  const busy = (on) => { for (const b of buttons) b.disabled = on || phase === 'ready'; };

  function say(text, extra) {
    stateLine.textContent = text;
    if (extra !== undefined) detail.textContent = extra;
  }

  function bullets(lines) {
    list.textContent = '';
    for (const line of lines) list.appendChild(el(doc, 'li', null, line));
  }

  const unsubscribe = [];

  /**
   * 面板挂载时 `welcome.modAssets` 可能还没登记完（见文件头第 3 点）：**有界**等待，不是一次查询定生死。
   * @returns {boolean} 是否还需要继续等
   */
  function waitForDeclaration() {
    if (decl) return false;
    let tries = 0;
    say('正在等待服务器宣告资源包…');
    const tick = () => {
      if (disposed) return;
      decl = modAssetsFor(ctx.pack);
      if (decl) { onDeclared(); return; }
      if (++tries >= DECL_WAIT_TRIES) {
        log.error('宿主一直没有登记这个包的 assets 声明；本面板不会设闸门（服务器侧的准入仍然生效）');
        say('服务器没有宣告资源包，无法启用导入流程。');
        bullets([]);
        return;
      }
      later(tick, DECL_WAIT_MS);
    };
    later(tick, DECL_WAIT_MS);
    return true;
  }

  /** 声明到手之后才开始真正的流程（挂载时声明的登记是异步的）。 */
  function onDeclared() {
    // 入口闸门：先关闸，再谈导入。放行只发生在服务端 `resource.accepted` 之后。
    ctx.session.setPreload({ required: true, ready: false });
    log.info('闸门已关：导入并通过服务端准入校验之前，路由停在标题页');
    unsubscribe.push(ctx.net.on('resource.challenge', onChallenge));
    unsubscribe.push(ctx.net.on('resource.accepted', onAccepted));
    unsubscribe.push(ctx.net.on('resource.rejected', onRejected));
    unsubscribe.push(ctx.net.on('status', (s) => {
      if (disposed) return;
      // 重连之后服务端会重新发挑战，但面板不能假设自己听得见 —— 上线时主动要一次。
      if (s && s.status === 'online' && phase !== 'ready') requestChallenge();
    }));
    refresh();
  }

  /**
   * 换容器 = 换身份（容器摘要进了包的内容哈希，DESIGN §28.2）。旧缓存**一张都不许再用**，所以撤掉这个包的收据，
   * 并把**当前清单覆盖到的那些 URL** 从 SW 的索引里摘掉。
   *
   * 说清楚这一格的边界：引擎的索引是 `{url: 指纹}` 的**全局**一份，条目上不记「这条属于哪个包」，所以一个
   * 不在新清单里出现的旧 URL 仍会留在索引里、SW 仍会拿它回答。本面板能做的只有上面两件事；要彻底干净得让引擎
   * 把索引按包分段（`README-改写说明.md` 的「值得回报给中间层的几格」列了它）。
   * @param {any} st `importStateFor` 的结果
   */
  async function revokeStale(st) {
    let urls = null;
    try {
      const res = await fetch(st.decl.manifest, { cache: 'no-store' });
      const manifest = await res.json();
      if (manifest && Array.isArray(manifest.files)) urls = manifest.files.map((f) => new URL(f.url, location.origin).href);
    } catch { /* 取不到清单就只撤收据：撤一半好过为了一条网络错误把流程卡死 */ }
    await revokeImport(ctx.pack, { urls });
  }

  async function refresh() {
    if (disposed || !decl) return;
    phase = 'checking';
    busy(true);
    say('正在检查本地已导入的资源包…');
    bullets([]);
    detail.textContent = '';
    try {
      const st = await importStateFor(ctx.pack);
      if (disposed) return;
      if (st.stale) {
        phase = 'missing';
        say('服务器上的资源包换了（容器摘要不同），本机那份作废，请重新导入。');
        bullets([`本机收据：${st.receipt && st.receipt.digest ? String(st.receipt.digest).slice(0, 12) : '无'}…`, `服务器摘要：${String(st.decl.digest).slice(0, 12)}…`]);
        await revokeStale(st);
        busy(false);
        return;
      }
      if (!st.receipt) {
        phase = 'missing';
        say('本机还没有导入过这个资源包。');
        bullets([`容器：${st.decl.container}`, `服务器摘要：${String(st.decl.digest).slice(0, 12)}…`]);
        busy(false);
        return;
      }
      // 有收据：先试着出示证明。证明本身会逐文件重算 SHA-256 —— **证明就是深度校验**：摘要对不上时服务端会判
      // `proof[i]` 不合格，那时 `resource.rejected` 会让我们退回「重新导入」。
      say(`本机已导入（清单版本 ${st.receipt.manifest || '?'}，${st.receipt.count || '?'} 个文件），正在向服务器证明…`);
      busy(false);
      requestChallenge();
    } catch (err) {
      if (disposed) return;
      phase = 'error';
      say('检查本地资源包失败。', err && err.message ? err.message : String(err));
      busy(false);
    }
  }

  function requestChallenge() {
    if (disposed) return;
    retriesLeft = CHALLENGE_RETRIES;
    stopRetry();
    ask();
  }

  function ask() {
    if (disposed) return;
    ctx.net.sendResourceMessage({ t: 'resource.challenge.request' });
    if (retriesLeft-- > 0) {
      stopRetry();
      retryTimer = later(() => { if (phase !== 'ready') ask(); }, CHALLENGE_RETRY_MS);
    }
  }

  async function onChallenge(msg) {
    if (disposed || !msg || typeof msg !== 'object') return;
    stopRetry();
    const urls = Array.isArray(msg.files) ? msg.files : [];
    if (urls.length !== CHALLENGE_SIZE) {
      log.error(`服务器发来 ${urls.length} 个文件，期望 ${CHALLENGE_SIZE} 个；不发证明`);
      return;
    }
    const proofs = [];
    const missing = [];
    for (const url of urls) {
      const bytes = await cachedBytes(url).catch(() => null);
      if (!bytes) { missing.push(url); continue; }
      const fileHash = await sha256Hex(bytes);
      // 算式必须与服务端逐字一致：sha256( nonce + "\n" + url + "\n" + sha256(该文件字节) )
      proofs.push(await sha256Hex(`${msg.nonce}\n${url}\n${fileHash}`));
    }
    if (disposed) return;
    if (missing.length) {
      phase = 'missing';
      say('本地缓存里缺少服务器要求的那几个文件，请重新导入资源包。');
      bullets(missing);
      return;
    }
    say('已提交证明，等待服务器放行…');
    ctx.net.sendResourceMessage({ t: 'resource.proof', nonce: msg.nonce, version: msg.version, proofs });
  }

  function onAccepted() {
    if (disposed) return;
    stopRetry();
    phase = 'ready';
    ctx.session.setPreload({ ready: true });
    say('已通过服务端准入校验，可以用这份本地资源包进房间了。');
    bullets([]);
    busy(true);
    // 放行之后这张卡片就该消失：玩家已经能看到界面了。
    overlay.style.display = 'none';
    log.info('服务端已放行（resource.accepted）：闸门打开');
  }

  function onRejected(msg) {
    if (disposed) return;
    stopRetry();
    phase = 'missing';
    // 服务端说这份缓存里的字节不对（或挑战过期 / 形状不符）：先撤收据，再让玩家重新导入。
    revokeImport(ctx.pack, { urls: null }).catch(() => {});
    say('服务端拒绝了这次证明，本机缓存不可信，请重新导入资源包。');
    detail.textContent = msg && msg.detail ? `服务端判据：${msg.detail}` : '';
    busy(false);
  }

  async function runImport(task) {
    busy(true);
    phase = 'importing';
    detail.textContent = '';
    try {
      const report = await task();
      if (disposed) return;
      if (!report.valid) {
        phase = 'missing';
        say(`导入完成但有文件没通过校验（${report.missing.length} 个缺失）。`);
        bullets(report.missing.slice(0, 8));
        busy(false);
        return;
      }
      say(`已导入 ${report.count} 个文件（${report.bytes} 字节），正在向服务器证明…`);
      bullets([]);
      busy(false);
      requestChallenge();
    } catch (err) {
      if (disposed) return;
      phase = 'error';
      say('导入失败。', err && err.message ? err.message : String(err));
      busy(false);
    }
  }

  btnServer.addEventListener('click', () => { if (decl) runImport(() => importFromServer(ctx.pack)); });
  btnPick.addEventListener('click', () => fileInput.click());
  btnRecheck.addEventListener('click', () => refresh().catch(() => {}));
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    runImport(() => importAndVerify(file, ctx.pack, { deep: false }));
  });

  if (decl) onDeclared();
  else waitForDeclaration();

  return {
    unmount() {
      disposed = true;
      stopRetry();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const off of unsubscribe) { try { off(); } catch { /* ignore */ } }
      overlay.remove();
    },
  };
}

export default mount;
