// ui/wsCompression.js —— 「这台服务器的 WS 压缩开着吗」参考面板（工坊包 ws-compression-reference）。
//
// 它做的事只有一件：把 `/data/ws-compression.json`（本包自己的只读路由）画出来，并给出**自查步骤**。
//
// 为什么面板不给实时结论：面板拿到的上下文只有会话态（`ctx.me`），**不含网络层** ——
// 读不到 `WebSocket` 对象的协商结果。所以这里不猜、不显示「你现在的协商是 X」，
// 只给判定表与「去哪里看」。宁可让玩家自己看一眼，也不给一个可能是错的自信结论。
//
// 挂载点 `root.guide`：固定浮层，与当前在哪个界面无关；容器由注册点在面板真的挂载时创建。
// `ctx.host` 是本次挂载专用的 `<div>`，往里画即可。

/** 参考数据的地址（本包 routes 声明的只读路由）。 */
export const DATA_PATH = '/data/ws-compression.json';

/** 不回答就放弃：一次挂起不该把面板永远卡在「加载中」。 */
export const FETCH_TIMEOUT_MS = 6000;

/**
 * 把一份 `/data/ws-compression.json` 正文整理成可画的行。
 *
 * **宽容是刻意的**（与 plugin-pack 的 serverStatus 同一条纪律）：每个字段都可选，缺了就不画那一行，
 * 绝不显示一个自己编的默认值 —— 一份读不到的数据显示成「压缩没开」是最糟的失败方式。
 * @param {any} body
 * @returns {{ modes: Array<{key: string, summary: string, expected: string}>, measured: Array<[string, string]>,
 *             selfCheck: { how: string, reading: Array<[string, string]> } | null,
 *             notSupported: string[], upstream: string | null }}
 */
export function parseReference(body) {
  const raw = body && typeof body === 'object' ? body : {};
  const modes = Array.isArray(raw.modes)
    ? raw.modes.filter((m) => m && typeof m.mode === 'string').map((m) => ({
      key: m.mode,
      summary: typeof m.summary === 'string' ? m.summary : '',
      expected: typeof m.expectedNegotiated === 'string' ? m.expectedNegotiated : '',
    }))
    : [];

  const m = raw.measured && typeof raw.measured === 'object' ? raw.measured : {};
  const measured = [];
  if (typeof m.hotStreamsRatio === 'string') measured.push(['热流压缩倍数', m.hotStreamsRatio]);
  if (typeof m.perSeatBytesPerSec === 'number') measured.push(['人均带宽', `${m.perSeatBytesPerSec} B/s`]);
  if (typeof m.tenMegabitCapacity === 'string') measured.push(['10 Mbps 容量', m.tenMegabitCapacity]);
  if (typeof m.coldStartNote === 'string') measured.push(['冷启动那笔账', m.coldStartNote]);

  const sc = raw.selfCheck && typeof raw.selfCheck === 'object' ? raw.selfCheck : null;
  const selfCheck = sc && typeof sc.how === 'string'
    ? {
      how: sc.how,
      reading: sc.reading && typeof sc.reading === 'object'
        ? Object.entries(sc.reading).map(([k, v]) => [k, String(v)])
        : [],
    }
    : null;

  const notSupported = Array.isArray(raw.notSupported) ? raw.notSupported.filter((s) => typeof s === 'string') : [];
  const upstream = typeof raw.upstream === 'string' ? raw.upstream : null;
  return { modes, measured, selfCheck, notSupported, upstream };
}

/** 读一次参考数据；失败返回 null（调用方据此画「读不到」，而不是画一个空表）。 */
async function fetchReference(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? globalThis.setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(DATA_PATH, ctl ? { signal: ctl.signal } : undefined);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer !== null) globalThis.clearTimeout(timer);
  }
}

/** 一个安全的文本节点（绝不 innerHTML —— 包里的字与新到的数据都不该被当成标记）。 */
function el(tag, cls, text) {
  const n = globalThis.document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}

function render(host, ref) {
  host.textContent = '';
  const root = el('div', 'wsc');
  root.appendChild(el('div', 'wsc-title', 'WS 压缩参考'));

  if (ref === null) {
    // 读不到 ≠ 没开。这一条是刻意的：把一次失败的请求画成结论，就是面板撒谎。
    root.appendChild(el('div', 'wsc-note wsc-warn', '读不到 /data/ws-compression.json（这台服务器可能没装本包，或路由没被服务）。'));
    host.appendChild(root);
    return;
  }

  if (ref.modes.length) {
    root.appendChild(el('div', 'wsc-h', '档位'));
    const ul = el('ul', 'wsc-list');
    for (const m of ref.modes) {
      const li = el('li');
      li.appendChild(el('b', null, m.key));
      if (m.summary) li.appendChild(el('span', 'wsc-dim', ` — ${m.summary}`));
      if (m.expected) {
        const code = el('code', 'wsc-code', m.expected);
        li.appendChild(code);
      }
      ul.appendChild(li);
    }
    root.appendChild(ul);
  }

  if (ref.measured.length) {
    root.appendChild(el('div', 'wsc-h', '实测'));
    for (const [k, v] of ref.measured) {
      const row = el('div', 'wsc-row');
      row.appendChild(el('span', 'wsc-k', k));
      row.appendChild(el('span', 'wsc-v', v));
      root.appendChild(row);
    }
  }

  if (ref.selfCheck) {
    root.appendChild(el('div', 'wsc-h', '自己核对这台服务器'));
    root.appendChild(el('div', 'wsc-note', ref.selfCheck.how));
    for (const [sig, meaning] of ref.selfCheck.reading) {
      const row = el('div', 'wsc-row');
      row.appendChild(el('code', 'wsc-code', sig));
      row.appendChild(el('span', 'wsc-v', meaning));
      root.appendChild(row);
    }
  }

  if (ref.notSupported.length) {
    root.appendChild(el('div', 'wsc-h', '本包做不到的（如实列出）'));
    const ul = el('ul', 'wsc-list wsc-list-warn');
    for (const s of ref.notSupported) ul.appendChild(el('li', null, s));
    root.appendChild(ul);
  }

  if (ref.upstream) {
    const a = el('a', 'wsc-src', ref.upstream);
    a.href = ref.upstream;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    root.appendChild(a);
  }

  host.appendChild(root);
}

/**
 * 面板入口。引擎在挂载时调用一次。
 * @param {{ host: HTMLElement, log?: { warn?: Function } }} ctx
 */
export function mount(ctx) {
  const host = ctx?.host;
  if (!host) return undefined;
  let disposed = false;

  void (async () => {
    const body = await fetchReference();
    if (disposed) return;
    try {
      render(host, body === null ? null : parseReference(body));
    } catch (err) {
      ctx.log?.warn?.('ws-compression panel render failed', err);
    }
  })();

  return {
    unmount() {
      disposed = true;
      try { host.textContent = ''; } catch { /* the host may already be gone */ }
    },
  };
}

export default mount;
