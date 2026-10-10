// server/resourceAdmission.mjs — 本包声明的分发前准入钩子（`pack.json.server.preDispatch`）。
//
// 读这份文件之前先读三份东西：
//   * `docs/WORKSHOP.md` §1.9.1 —— 钩子的注入面与调用位置（0.11.0 的中间层契约）；
//   * `docs/design/mod-layer.md` §28.13.1 —— 为什么是这个位置、为什么注入面里没有 socket / data / lobby；
//   * 同目录的 `../README-改写说明.md` —— 这份代码与原件 `server/admission.cjs` 的逐条差异。
//
// ## 它做什么
//
// 「进房间之前先证明你导入并通过校验了完整资源包」。证明是**公开信息的持有证明**，不是反作弊（见下面「安全口径」）。
//
// ## 它不做什么（这些是硬约束，不是风格）
//
//   1. **不注册 `socket.on('message')`。** 监听器是框架在 `server/net.js` 注册的，再注册一个会让同一条消息被处理
//      两次（`room.create` / `g.buy` 这类有副作用的类型是实打实的双执行）。框架**调用**我们，不把 socket 交给我们。
//   2. **不改对局结果。** 注入面里没有 `data` / `lobby` / `Match` / 任何对局对象，所以这是结构性的：能做的只有
//      观察、记录、上报、以及否决被声明的入口消息。本包也没有声明 `combat: true`。
//   3. **没有进程级可变状态。** 工厂 `createPreDispatch(deps)` **每条连接调用一次**，所以下面的闭包状态天然是
//      连接私有的。**不要**把状态写到模块顶层，也**不要**写「开局前设全局、打完恢复」——多局并发会串味。
//   4. **不读全局时钟。** 一律用注入的 `deps.now()`。
//
// ## 关于 RNG（业主裁决里唯一被排除的一项）
//
// 业主裁决原文：「当然可以注入，只要在同等情况（排除 rng）不会出现注入与不注入结果不一样的情况就行。」
// 本模块用 RNG 的地方恰好只有两处：挑战的 `nonce` 与「这一轮抽哪三个文件」。这两处**必须是**不可预测的 ——
// 可预测的挑战等于没有挑战。而它们在结果层面无害：本包 `combat: false`，且注入面里根本没有能改结果的句柄。
//
// ## 安全口径（诚实，不许对外说成防作弊）
//
// 包发给所有玩家，素材也在公开镜像上，任何人拿到包就能离线算出全部证明，根本不用跑游戏。它把门槛从「翻一个
// localStorage 标记」抬到「背着整份素材」，**仅此而已**。另外两条必须说清楚：
//   * 逐文件指纹在线格式上是 SHA-1 前 12 位 = 48 bit；**明文 HTTP 下主动 MITM 可以同时替换清单与容器，48 bit
//     毫无作用**（所以清单与容器必须走 HTTPS）；
//   * 服务端这一侧的**二次校验**用的是策略文件里的完整 SHA-256（64 hex），不是那 12 位 —— 想再加一层就给清单
//     本身签名，别指望那 48 bit。

import crypto from 'node:crypto';

/** 本包自己发出去的两个回执类型（服务端 → 客户端，不在 `C2S` 里）。 */
export const RESOURCE_REPLY_TYPES = Object.freeze(['resource.accepted', 'resource.rejected']);

/** 挑战的有效期（毫秒）。 */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** 每连接重发挑战的最小间隔（毫秒）——防止一个面板挂载时的重试把挑战刷爆。 */
const CHALLENGE_MIN_INTERVAL_MS = 1000;
/** 一次挑战抽几个文件。 */
const CHALLENGE_SIZE = 3;
/** 声称的证明必须是 64 位小写十六进制（SHA-256 的十六进制写法）。 */
const PROOF_RE = /^[0-9a-f]{64}$/;

const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 持有证明的算式。**必须与客户端逐字一致**：
 *
 *     sha256( nonce + "\n" + url + "\n" + sha256(该 url 的文件字节) )
 *
 * `url` 是策略文件里写的那个字符串（逐字，不做 URL 归一化）；`nonce` 是这一轮挑战的 24 字节随机数的十六进制。
 * 原件的客户端（`integration/client/public/js/resources/preload.js` 的 `prove()`）写的是同一条式子，所以
 * **原件的客户端能直接对我们的服务端出示证明** —— 这不是巧合，是刻意保留的线格式兼容。
 * @param {string} nonce
 * @param {string} url
 * @param {string} fileSha256 64 位小写十六进制
 * @returns {Buffer} 32 字节
 */
export function expectedProof(nonce, url, fileSha256) {
  return crypto.createHash('sha256').update(`${nonce}\n${url}\n${fileSha256}`).digest();
}

/**
 * 校验策略文件的**内部形状**。
 *
 * 为什么这里还要查一遍：装载期（`server/workshop.js preDispatchIssues`）只保证「`policy` 能解析成一个 JSON 对象」，
 * 它**不认识** `version` / `files` 这两个字段 —— 那是本模块自己的数据格式。所以内部形状是**本模块**的事，
 * 一份形状坏掉的策略在这里必须响亮地失败，而不是让某个玩家永远过不了闸门（`README-改写说明.md` 的「仍然存在的
 * 一个口子」一节把这件事写全了）。
 * @param {unknown} policy
 * @returns {{ ok: true, version: string, files: Array<{url: string, sha256: string}> } | { ok: false, detail: string }}
 */
export function validatePolicy(policy) {
  if (!isPlainObj(policy)) return { ok: false, detail: 'policy must be a JSON object' };
  if (typeof policy.version !== 'string' || !policy.version) return { ok: false, detail: 'policy.version must be a non-empty string (认证挑战里会原样比对它)' };
  if (!Array.isArray(policy.files)) return { ok: false, detail: 'policy.files must be an array of { url, sha256 }' };
  if (policy.files.length < CHALLENGE_SIZE) {
    return { ok: false, detail: `policy.files needs at least ${CHALLENGE_SIZE} entries (one challenge draws ${CHALLENGE_SIZE} distinct files)` };
  }
  for (const [i, f] of policy.files.entries()) {
    if (!isPlainObj(f)) return { ok: false, detail: `policy.files[${i}] must be an object` };
    if (typeof f.url !== 'string' || !f.url.startsWith('/')) return { ok: false, detail: `policy.files[${i}].url must be a site-absolute path (e.g. "/assets/ui/hudPanel/white_sprite.png")` };
    if (typeof f.sha256 !== 'string' || !PROOF_RE.test(f.sha256)) return { ok: false, detail: `policy.files[${i}].sha256 must be 64 lowercase hex digits (the file's full SHA-256, not the container's 12-hex content hash)` };
  }
  const seen = new Set();
  for (const f of policy.files) {
    if (seen.has(f.url)) return { ok: false, detail: `policy.files lists "${f.url}" twice — a challenge could draw the same file twice and the client would answer for it twice` };
    seen.add(f.url);
  }
  return { ok: true, version: policy.version, files: policy.files.map((f) => ({ url: f.url, sha256: f.sha256 })) };
}

/**
 * 包声明的工厂。**框架每条连接调用一次**（`server/modDispatch.js` 的 `instancesFor`），所以下面的
 * `state` 天然是连接私有的：两台客户端、两个房间并发也不会串味。
 *
 * @param {{
 *   pack: string,
 *   policy: object,
 *   policyFile: string|null,
 *   intercepts: readonly string[],
 *   c2s: Record<string, any>,
 *   log: { info?: Function, warn?: Function, error?: Function, debug?: Function },
 *   now: () => number,
 *   send: (conn: any, msg: object) => unknown,
 * }} deps 冻结的、恰好八个键的注入面（`server/modDispatch.js PRE_DISPATCH_DEPS`）
 * @returns {{ onConnection: (conn: any) => void, preDispatch: (conn: any, msg: object) => boolean }}
 */
export function createPreDispatch(deps) {
  const { pack, policy, policyFile, intercepts, log, now, send } = deps || {};
  if (typeof send !== 'function') throw new Error('resourceAdmission: deps.send is not a function — the framework must inject its own send helper');
  if (typeof now !== 'function') throw new Error('resourceAdmission: deps.now is not a function — the clock is injected, never read globally');

  const valid = validatePolicy(policy);
  // 工厂抛异常 = 「这条连接上这个钩子不存在」（`server/modDispatch.js` 记一条 error，运行期不消费、消息照常分发）。
  // 这是**有意**的姿态：一道因为自己的配置错而 fail-closed 的闸门会把所有人挡在门外。代价是「包看着是装着的、
  // 闸门其实没拦」—— 所以策略文件的形状必须在**你自己的构建里**先验一遍（本包的做法见 `tools/selfcheck.mjs`），
  // 而不是指望运行期报错。README 里把这一格如实列了出来。
  if (!valid.ok) {
    throw new Error(`resourceAdmission: 策略文件 "${policyFile || '(未声明)'}" 不合法：${valid.detail}`);
  }
  const files = valid.files;
  const gate = new Set(Array.isArray(intercepts) ? intercepts : []);

  /** 连接私有的状态（工厂每条连接调用一次，所以这就是这条连接的）。 */
  let allowed = false;
  /** @type {{ nonce: string, expiresAt: number, picks: Array<{url: string, sha256: string}> }|null} */
  let challenge = null;
  let lastIssueAt = -Infinity;

  /**
   * 发一次挑战。`nonce` 与会用到哪三个文件都必须是不可预测的（RNG，见文件头）。
   * @param {any} conn
   */
  function issue(conn) {
    if (now() - lastIssueAt < CHALLENGE_MIN_INTERVAL_MS) return;
    lastIssueAt = now();
    const picks = [];
    const taken = new Set();
    while (picks.length < CHALLENGE_SIZE) {
      const i = crypto.randomInt(files.length);
      if (taken.has(i)) continue;
      taken.add(i);
      picks.push(files[i]);
    }
    challenge = { nonce: crypto.randomBytes(24).toString('hex'), expiresAt: now() + CHALLENGE_TTL_MS, picks };
    send(conn, {
      t: 'resource.challenge',
      version: valid.version,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      // 只发 URL：客户端自己从缓存里读那三个文件的字节并算摘要 —— 这正是「持有证明」的意义。
      // **次序是契约的一部分**：`proofs[i]` 必须对应 `files[i]`。
      files: picks.map((f) => f.url),
    });
    log?.info?.(`[${pack}] resource challenge issued (version=${valid.version}, ${CHALLENGE_SIZE} files)`);
  }

  return {
    /**
     * 连接建立时立刻发挑战 —— 这发生在 `hello` 之前，所以客户端必须用 `sendResourceMessage`（走 `_sendRaw`）作答，
     * 用普通的 `send()` 会被静默丢弃（那时 `status` 还不是 `online`）。这是原件踩过的坑之一。
     */
    onConnection(conn) {
      allowed = false;
      challenge = null;
      lastIssueAt = -Infinity;
      issue(conn);
    },

    /**
     * 分发前被调用。`true` = 这条消息已被本钩子消费，框架不再交给大厅。
     * @param {any} conn
     * @param {object} msg 已经过 `C2S` 白名单与 `validateC2S` 的消息
     * @returns {boolean}
     */
    preDispatch(conn, msg) {
      if (!isPlainObj(msg)) return false;

      if (msg.t === 'resource.reset') {
        allowed = false;
        challenge = null;
        lastIssueAt = -Infinity;
        issue(conn);
        return true;
      }

      if (msg.t === 'resource.challenge.request') {
        issue(conn);
        return true;
      }

      if (msg.t === 'resource.proof') {
        allowed = false;
        const proofs = msg.proofs;
        const shapeOk = !!challenge
          && challenge.expiresAt > now()
          && msg.nonce === challenge.nonce
          && msg.version === valid.version
          && Array.isArray(proofs)
          && proofs.length === CHALLENGE_SIZE;
        let bad = -1;
        if (shapeOk) {
          for (let i = 0; i < CHALLENGE_SIZE; i++) {
            const proof = proofs[i];
            const pick = challenge.picks[i];
            if (typeof proof !== 'string' || !PROOF_RE.test(proof)) { bad = i; break; }
            const want = expectedProof(challenge.nonce, pick.url, pick.sha256);
            if (!crypto.timingSafeEqual(want, Buffer.from(proof, 'hex'))) { bad = i; break; }
          }
        }
        allowed = shapeOk && bad < 0;
        // 一轮挑战只用一次：用掉就作废，同一个 nonce 重放会被 `challenge.expiresAt > now()` 那一格挡掉（挑战已清空）。
        challenge = null;
        send(conn, {
          t: allowed ? 'resource.accepted' : 'resource.rejected',
          version: valid.version,
          ...(allowed ? {} : { detail: shapeOk ? `proof[${bad}]` : 'challenge' }),
        });
        log?.[allowed ? 'info' : 'warn']?.(`[${pack}] resource proof ${allowed ? 'accepted' : 'rejected'}${allowed ? '' : ` (${shapeOk ? `proof[${bad}]` : 'no matching challenge / bad shape'})`}`);
        return true;
      }

      if (!allowed && gate.has(msg.t)) {
        // **必须带上 `rid`**：没有 rid 的错误帧在客户端会走 `unhandledError` 弹一条红条（public/js/main.js），
        // 玩家看到的是「点了没反应 + 一条看不懂的错误」。原件只在 `msg.rid != null` 时才带，这里保持同一条件
        // （有些类型本来就不带 rid，硬塞一个会让客户端把它当成一次回复而去 resolve 一个不存在的事务）。
        send(conn, {
          t: 'error',
          ...(msg.rid != null ? { rid: msg.rid } : {}),
          code: 'RESOURCE_REQUIRED',
          msg: '必须导入并通过校验完整资源包后才能进入房间',
        });
        return true;
      }

      return false;
    },
  };
}

export default createPreDispatch;
