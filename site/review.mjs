// 审核辅助：把「名称与内容」里最需要人眼确认的几件事自动挑出来。
//
// **它不下结论，只挑重点。** 每一条都写清为什么值得看一眼；最终由人拍板。
// 分三档：blocker（基本不能上线）/ warn（要看一眼）/ info（记录一下）。
//
// 这里最要紧的一类是「包里有没有夹带官方游戏素材」—— 业主 2026-10-12 改了口径
// （见 AGENTS.md §3「素材口径」，取代原「素材红线」）：**含官方素材不因此被打回，如实收录、但必须标注清楚**
// （包内 `PROVENANCE.md` 机械清点 + 站上备注）；**未标注才是问题**。
// 所以这一档的作用是**把命中项挑出来给人看**（进 `ACK_CODES` ⇒ 上线要显式 `acknowledge`），**不是一律拦下**；
// 档位与命中明细**一条都没改** —— 改的只是这段注释的措辞。
// 而人眼翻一个 39 条目的包还行，翻一个 3000 条目的包就不现实了。所以按**特征**挑。

const F = (level, code, text) => ({ level, code, text });

// 官方解包产物的典型形态。命中不等于一定违规（比如同人包也可能自己画了 .atlas？不会），
// 但这些是「打开包就该看到」的东西。
const GAME_ASSET_RULES = [
  [/\.skel$/i, 'Spine 骨骼文件（.skel）—— 官方模型解包的典型产物'],
  [/\.atlas$/i, 'Spine 图集描述（.atlas）—— 同上'],
  [/(^|\/)spine\/(op|enemy|token)\//i, '官方 Spine 目录结构（spine/op|enemy|token）'],
  [/(^|\/)char\/(avatar|portrait)\//i, '官方干员头像 / 立绘路径（char/avatar、char/portrait）'],
  [/(^|\/)avg\//i, '官方剧情资源目录（avg/）'],
  [/(^|\/)audio\/(voice|sfx)\/.*char_\d/i, '官方干员语音 / 音效路径（audio/**/char_<数字>_*）'],
  [/\.(ab|dat|assets|bundle)$/i, 'Unity / 官方资源包格式（.ab / .dat / .assets / .bundle）'],
  [/(^|\/)gamedata\//i, '官方数据表导出目录（gamedata/）'],
];

const DANGEROUS_EXT = /\.(exe|dll|so|dylib|bat|cmd|ps1|sh|com|scr|msi|jar)$/i;
const HUGE_FILE = 10 * 1024 * 1024;          // 单个文件 10 MB
const MANY_AUDIO = 500;                      // 大量音频
const IMPERSONATE = /(官方|official|网易|鹰角|hypergryph|yostar|正版)/i;

// ---------------------------------------------------------------- 两处盲区（2026-10-12 业主裁定）
//
// 起因：一对真实投稿把 218 个文件 / 43.2 MB 打成一个 `.spresources` **不透明容器**送上来。
// 自动检查只看得到 ZIP 层那**一个**大文件（`pack.json` / 容器 / 容器 `.sha256` / 清单共 4 条），
// 于是 flags 全是 info、`suspected=false` —— **容器里的字节从未被逐条看过**。
// 而**能定性它的是投稿人自己写在 `pack.json.description` 里的一句话**：「这些是从《明日方舟》客户端
// 导出的官方素材」——「信号在眼前，没有规则去看」。下面两张表就是补这两处。
//
// **两档都出 `warn`（不是 blocker），但会要求发布时显式 `acknowledge`**
// （业主口径：「让风险显式、由发布决定承担」）。理由：
//   · 不透明容器里是**自制素材**时，warn 就够（不该因为它"不透明"就把整条包拒掉）；
//   · 本站的既有政策本来就是「疑似素材**照收不拒**，但**处处标注**、上线**必须显式确认**」——
//     所以正确的档位是"看得见 + 要点头"，不是"一律拦住"。
//   · 哪些 code 需要点头：见 `ACK_CODES`。
// 窄 / 宽分层（与 `NAME_IMPERSONATE` 同族，但"自述夹带官方素材"这一档要能真的被抓住）：
const SPRES_MAGIC = 'SPRES001';
const SPRES_MAX_HEADER = 16 * 1024 * 1024;      // 与引擎 `tools/spresources.mjs` 的 MAX_HEADER_BYTES 一致

/** 自述「随包夹带官方素材」——**窄**：只认陈述事实的说法，不认单独一个「官方」二字。 */
const SELF_DECL_ASSETS = [
  [/从[^。；\n]{0,14}(明日方舟|鹰角|yostar|hypergryph)[^。；\n]{0,14}客户端[^。；\n]{0,8}(导出|解包|抽出|扒)/i, '「从官方客户端导出 / 解包」'],
  [/客户端\s*(导出|解包)/, '「客户端导出 / 解包」'],
  [/官方\s*(解包|拆包)\s*(件|素材|资源|包)?/, '「官方解包件 / 解包素材」'],
  [/(版权|著作权|所有权)\s*(归|属)\s*[^。；\n]{0,10}(鹰角|yostar|hypergryph)/i, '「版权归鹰角 / Yostar」'],
  [/(这些|本包|该包)[^。；\n]{0,16}是[^。；\n]{0,14}官方素材/, '「内容是官方素材」'],
  [/官方客户端[^。；\n]{0,8}(导出|解包)/, '「官方客户端导出 / 解包」'],
];

/**
 * 宽词表：只求"看得见"，不判违规（与 `NAME_IMPERSONATE` 同一族）。
 *
 * ⚠️ **裸「导出」不算** —— 实测它会打在完全正当的备注上（我们自己的自测夹具里就有
 * 「③ 面板导出补 patched」），那样的 warn 是噪声，而且会连带置 `ackRequired`、
 * 把一次正当的 `/compat/decide` 变成 409。所以「导出」**必须与素材类词相邻**才算（见下一条）。
 */
const SELF_DECL_VOCAB = /(官方素材|官方资源|官方数据|官方美术|鹰角|hypergryph|yostar|正版)/i;

/** 「导出」只在**紧邻素材类词**时才算信号：「客户端导出」「官方素材导出」「导出官方资源」都算，
 *  「面板导出」「导出 JSON」不算。 */
const SELF_DECL_EXPORT = /((官方|客户端|素材|资源|美术|语音|数据表)[^\n]{0,12}导出)|(导出[^\n]{0,12}(官方|客户端|素材|资源|美术|语音|数据表))/i;

/**
 * 命中这些 code 时：**flag 是 warn，但发布要显式 `acknowledge`**。
 * 与 `hasBlocker()` 那条路（→ `suspected` → 进 `flagged/`）是**两条不同的路**：
 * 这一条不改存放区、不改公开面对"疑似素材"的既有标注，只多一道"点头才放行"。
 */
export const ACK_CODES = Object.freeze([
  'CONTAINER_UNREADABLE', 'CONTAINER_GAME_ASSET', 'CONTAINER_EXECUTABLE',
  'SELF_DECLARED_OFFICIAL_ASSETS', 'SELF_DECL_OFFICIAL',
  // 改写版的 pack.json 与**留档原件的根 pack.json** 不一致（业主令 31）。
  // 「保持原注释不变」是兼容包那条硬要求的名字，所以这一档也要显式点头 —— 但**不挡发布**。
  'COMPAT_PACKJSON_DIFFERS',
]);

/** 这批 flags 里有没有"要点头"的。 */
export const needsAcknowledge = (flags) => (flags || []).some((f) => ACK_CODES.includes(f.code));

/**
 * 名称类文本的检查（mod 名 / 原作者 / 兼容者 / 上线显示名都走它）。
 * `label` 只是把「谁不合格」写进文本里，判定逻辑与三档完全一样 —— 复用一份规则，不另立一套。
 */
export function reviewLabel({ label = '名称', value, prefix = 'NAME', required = true } = {}) {
  const out = [];
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (required) out.push(F('blocker', `${prefix}_EMPTY`, `${label}为空`));
    return out;
  }
  if (s.length > 60) out.push(F('warn', `${prefix}_LONG`, `${label}长 ${s.length} 字，超过 60 字（列表里会显示不下）`));
  if (/[\u0000-\u001f\u007f]/.test(s)) out.push(F('blocker', `${prefix}_CONTROL`, `${label}里有控制字符`));
  if (/[<>]/.test(s)) out.push(F('warn', `${prefix}_ANGLE`, `${label}里有尖括号（显示时会转义，但最好去掉）`));
  if (IMPERSONATE.test(s)) out.push(F('warn', `${prefix}_IMPERSONATE`, `${label}含「官方 / official / 鹰角 / Yostar」这类词 —— 容易让人误以为是官方出品`));
  if (/^(.)\1+$/.test(s) && s.length > 3) out.push(F('warn', `${prefix}_NOISE`, `${label}是同一个字符重复`));
  return out;
}

/** 名称检查（上传时填的 mod 名）。 */
export function reviewName(name) {
  return reviewLabel({ label: '名称', value: name });
}

/** 内容检查（zip 的中央目录条目）。 */
export function reviewEntries(entries, { packIdHint = null } = {}) {
  const out = [];
  const files = entries.filter((e) => !e.dir);
  const bytes = files.reduce((n, e) => n + e.uncompSize, 0);

  out.push(F('info', 'SIZE', `${files.length} 个文件 · 解压后约 ${(bytes / 1048576).toFixed(2)} MB`));

  // ① 夹带官方素材的特征
  const hit = new Map();
  for (const e of files) {
    for (const [re, why] of GAME_ASSET_RULES) {
      if (re.test(e.name)) { if (!hit.has(why)) hit.set(why, []); hit.get(why).push(e.name); break; }
    }
  }
  for (const [why, list] of hit) {
    out.push(F('blocker', 'GAME_ASSET', `${why} —— 命中 ${list.length} 条，例如 ${list.slice(0, 3).join('、')}`));
  }

  // ② 单文件过大
  const huge = files.filter((e) => e.uncompSize > HUGE_FILE);
  if (huge.length) {
    out.push(F('warn', 'HUGE', `${huge.length} 个文件超过 10 MB（最大的 ${(Math.max(...huge.map((e) => e.uncompSize)) / 1048576).toFixed(1)} MB）—— 确认是自制素材而不是整段官方资源`));
  }

  // ③ 大量音频
  const audio = files.filter((e) => /\.(mp3|ogg|wav|m4a)$/i.test(e.name));
  if (audio.length >= MANY_AUDIO) {
    out.push(F('warn', 'MANY_AUDIO', `${audio.length} 个音频文件 —— 规模像整包官方语音，确认来源与授权`));
  }

  // ④ 可执行 / 脚本
  const exec = files.filter((e) => DANGEROUS_EXT.test(e.name));
  if (exec.length) {
    out.push(F('blocker', 'EXECUTABLE', `含可执行 / 脚本文件 ${exec.length} 个，例如 ${exec.slice(0, 3).map((e) => e.name).join('、')} —— mod 不该带这些`));
  }

  // ⑤ 路径穿越 / 绝对路径
  const evil = files.filter((e) => e.name.includes('..') || /^([a-z]:)?[\\/]/i.test(e.name));
  if (evil.length) {
    out.push(F('blocker', 'PATH_TRAVERSAL', `条目名里有 .. 或绝对路径 ${evil.length} 条，例如 ${evil.slice(0, 2).map((e) => e.name).join('、')} —— 解压时会写到包外`));
  }

  // ⑥ 形状：是「已完成的包」还是「原件」
  const packJson = entries.find((e) => /^\.?\/?pack\.json$/i.test(e.name));
  if (packJson) {
    out.push(F('info', 'HAS_PACK_JSON', '含 pack.json —— 看起来是已做好的工坊包，可以按「提到 packs/」那条路走'));
  } else {
    out.push(F('info', 'NO_PACK_JSON', '没有 pack.json —— 像是原件（未兼容），按 incoming/ 那条路处理'));
  }
  if (packIdHint) {
    out.push(F('info', 'PACK_ID_HINT', `上传时填的名字：${packIdHint}（与包里 pack.json 的 id 不要求一致，但上线的显示名以哪个为准要定下来）`));
  }

  // ⑦ 顶层形态：包内文件直接放根（导入器要的形状）
  const tops = new Set(files.map((e) => e.name.split('/')[0]));
  if (tops.size === 1 && files.every((e) => e.name.includes('/'))) {
    out.push(F('warn', 'WRAPPED', `所有文件都在同一个顶层目录「${[...tops][0]}/」下 —— 装包器要的是包内文件放在 **zip 根**，请重新压一次（不要套一层文件夹）`));
  }

  return out;
}

/**
 * 解析 `.spresources` 容器（格式定义见引擎 `tools/spresources.mjs`）：
 * `magic` 8 字节 ASCII `SPRES001` + `headerLen` uint32 **小端** + 压紧 JSON 头 + 按清单顺序拼接的文件体。
 *
 * **纯函数**（只吃一个 Buffer，不碰文件系统）—— 与 `reviewEntries` 同一条纪律：这一层只判、不做 IO。
 * 只读到"清单"为止：容器里每个文件的字节**不在这里校验**（那是引擎装载期拿 `.sha256` 旁挂与逐条 sha1 干的事），
 * 这里要做的是**把清单拿出来看一眼**（路径 / 大小），这正是以前缺的那一步。
 *
 * @returns {{ok:true, files:Array<{url:string,size:number}>, headerLen:number, manifestVersion:any}
 *          | {ok:false, error:string}}
 */
export function parseSpresources(buf) {
  if (!buf || buf.length < 12) return { ok: false, error: '容器不足 12 字节（连头都放不下）' };
  const magic = buf.toString('latin1', 0, 8);
  if (magic !== SPRES_MAGIC) return { ok: false, error: `魔数不是 ${SPRES_MAGIC}（读到 ${JSON.stringify(magic)}）` };
  const headerLen = buf.readUInt32LE(8);
  if (!(headerLen > 0) || headerLen > SPRES_MAX_HEADER) return { ok: false, error: `头长度 ${headerLen} 越界（上限 ${SPRES_MAX_HEADER}）` };
  if (12 + headerLen > buf.length) return { ok: false, error: `头长度越过文件末尾（12 + ${headerLen} > ${buf.length}）` };
  let header;
  try { header = JSON.parse(buf.toString('utf8', 12, 12 + headerLen)); }
  catch (e) { return { ok: false, error: `头不是合法 JSON：${e.message}` }; }
  const mf = header && header.manifest;
  const files = mf && Array.isArray(mf.files) ? mf.files : null;
  if (!files) return { ok: false, error: '头里没有 manifest.files 数组' };
  const bad = files.find((f) => !f || typeof f.url !== 'string' || !Number.isFinite(f.size) || f.size < 0);
  if (bad) return { ok: false, error: `manifest.files 里有形状不对的条目（第 ${files.indexOf(bad)} 条）` };
  const total = files.reduce((n, f) => n + f.size, 0);
  if (12 + headerLen + total !== buf.length) {
    return { ok: false, error: `体积账对不上：12 + ${headerLen} + ${total} ≠ 文件长度 ${buf.length}` };
  }
  return { ok: true, files, headerLen, manifestVersion: mf.version };
}

/**
 * 把不透明容器**看进去**：解析清单，再用与 `reviewEntries` **同一套**判据
 * （`GAME_ASSET_RULES` 官方素材特征、`DANGEROUS_EXT` 可执行名）逐条跑一遍。
 * 以前这两条规则只看得到容器那**一个**大文件本身，容器里的 218 条内部路径一条都没过。
 *
 * 读不进去时**不说"没看出问题"**：给一条 `CONTAINER_UNREADABLE`（warn + 要点头）——
 * 「没看过」和「看过没问题」是两件事，这正是那次事故的教训。
 */
export function reviewContainer(buf, { containerName = '容器' } = {}) {
  const out = [];
  const parsed = parseSpresources(buf);
  if (!parsed.ok) {
    out.push(F('warn', 'CONTAINER_UNREADABLE',
      `不透明容器 \`${containerName}\` **读不进去**（${parsed.error}）—— 容器里的字节没能核对，不能按"没看出问题"放过；发布前请人工确认`));
    return out;
  }
  const files = parsed.files;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  out.push(F('info', 'CONTAINER_FILES',
    `容器 \`${containerName}\` 已**逐条看进去**：${files.length} 个文件 · ${(bytes / 1048576).toFixed(2)} MB（清单版本 ${parsed.manifestVersion}）`));

  const hit = new Map();
  for (const f of files) {
    for (const [re, why] of GAME_ASSET_RULES) {
      if (re.test(f.url)) { if (!hit.has(why)) hit.set(why, []); hit.get(why).push(f.url); break; }
    }
  }
  for (const [why, list] of hit) {
    out.push(F('warn', 'CONTAINER_GAME_ASSET',
      `容器 \`${containerName}\` **内部**命中官方素材特征：${why} —— ${list.length} 条，例如 ${list.slice(0, 3).join('、')}（发布前请人工确认来源与授权）`));
  }
  const exec = files.filter((f) => DANGEROUS_EXT.test(f.url));
  if (exec.length) {
    out.push(F('warn', 'CONTAINER_EXECUTABLE',
      `容器 \`${containerName}\` **内部**含可执行 / 脚本名 ${exec.length} 条，例如 ${exec.slice(0, 3).map((f) => f.url).join('、')}`));
  }
  const huge = files.filter((f) => f.size > HUGE_FILE);
  if (huge.length) {
    out.push(F('warn', 'CONTAINER_HUGE',
      `容器 \`${containerName}\` 内部 ${huge.length} 个文件超过 10 MB（最大的 ${(Math.max(...huge.map((f) => f.size)) / 1048576).toFixed(1)} MB）`));
  }
  const audio = files.filter((f) => /\.(mp3|ogg|wav|m4a)$/i.test(f.url));
  if (audio.length >= MANY_AUDIO) {
    out.push(F('warn', 'CONTAINER_MANY_AUDIO', `容器 \`${containerName}\` 内部 ${audio.length} 个音频 —— 规模像整包官方语音，确认来源与授权`));
  }
  return out;
}

/**
 * 找**第一处没被否定**的命中。
 *
 * 为什么需要它：自述检查的正则只认字面，会把**否定句**读成自述 —— 实测撞到两句原文：
 * 「不含任何图片/音频/**官方解包素材**」（`0ead812ea6b0`）与
 * 「素材：本包美术字节 = 0，**不含官方素材**」（`4958f9c84f9a`）。这两句说的恰恰是"**没有**官方素材"。
 * 所以命中处往前 12 字里若出现「不 / 未 / 无 / 非 / 没有 / 绝无 / 零」，跳过这一处、继续找下一处。
 */
function firstNonNegated(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const NEG = /(不|未|无|非|没有|绝无|零)[^。；\n]{0,12}$/;
  let m;
  while ((m = g.exec(text))) {
    const pre = text.slice(Math.max(0, m.index - 14), m.index);
    if (!NEG.test(pre)) return m;
    if (g.lastIndex === m.index) g.lastIndex++;
  }
  return null;
}

/**
 * 自述检查：`pack.json.description` 与上传备注里，作者**自己写的**那句话。
 * 这一档存在的唯一理由：那次事故里，能定性的证据**就在 description 正文里**，而没有任何规则读它。
 */
export function reviewSelfDecl({ note = null, description = null } = {}) {
  const out = [];
  const parts = [['pack.json.description', description], ['上传备注', note]]
    .filter(([, v]) => typeof v === 'string' && v.trim());
  for (const [where, text] of parts) {
    for (const [re, why] of SELF_DECL_ASSETS) {
      const m = firstNonNegated(text, re);
      if (m) {
        out.push(F('warn', 'SELF_DECLARED_OFFICIAL_ASSETS',
          `${where} 里**作者自述**${why}：「…${String(m[0]).slice(0, 80)}…」—— 本站政策是"疑似素材照收不拒，但**处处标注**、上线**必须显式确认**"；发布前请人工确认并在备注里如实标注`));
        break;
      }
    }
  }
  for (const [where, text] of parts) {
    const m = firstNonNegated(text, SELF_DECL_VOCAB) || firstNonNegated(text, SELF_DECL_EXPORT);
    if (m) {
      out.push(F('warn', 'SELF_DECL_OFFICIAL', `${where} 里出现「${m[0]}」这类词 —— 与名称的 NAME_IMPERSONATE 同一族，看一眼再放行`));
      break;
    }
  }
  return out;
}

/**
 * 兼容包的 `pack.json` 与**留档原件的根 `pack.json`** 比一比（业主令 31）。
 *
 * 起因：逐字节比对现网时发现多条的 `pack.json` 与 `orig.zip` 里的那一份不同，
 * 而**站点以前没有任何地方把这件事说出来**（`compatPublishGate` 比的是**上传时快照** `meta.pack`，
 * 不是 `orig.zip`）⇒ 于是在**发布那一刻**补一道提示。
 *
 * **档位与口径**（与"让风险显式、不挡发布"那条一致）：
 *   · 两份不同 ⇒ **`warn`** `COMPAT_PACKJSON_DIFFERS` + **列出差异键**（进 `ACK_CODES` ⇒ 发布要 `acknowledge`）；
 *   · 一字不差 ⇒ 什么也不画（正常情况不该有噪声）；
 *   · **原件根本没有根 `pack.json`**（补丁 / 安装器 / 套了一层目录那一类形态）⇒ **`info`** `COMPAT_ORIGIN_NO_PACKJSON`，
 *     **不是 warn**：那种情况下"声明有没有被改"无从谈起，如实记一句就够。
 */
export function reviewCompatPackJson({ compatText = null, originText = null, originHasRoot = false } = {}) {
  const out = [];
  if (!originHasRoot) {
    out.push(F('info', 'COMPAT_ORIGIN_NO_PACKJSON',
      '留档原件的**根目录没有 `pack.json`**（补丁 / 安装器 / 套了一层目录那一类形态）—— 无从比对"声明有没有被改"，如实记下这一句（不是 warn）。'));
    return out;
  }
  if (typeof compatText !== 'string' || typeof originText !== 'string') {
    out.push(F('warn', 'COMPAT_PACKJSON_DIFFERS', '`pack.json` 文本读不出来，没法与留档原件比对 —— 发布前人工看一眼。'));
    return out;
  }
  if (compatText === originText) return out;
  let a = null, b = null;
  try { a = JSON.parse(compatText); b = JSON.parse(originText); } catch { /* 解析不了就只报"文本不同" */ }
  const keys = [];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) keys.push(k);
    }
  }
  out.push(F('warn', 'COMPAT_PACKJSON_DIFFERS',
    '本条的 `pack.json` 与**留档原件的根 `pack.json`** 不是逐字节相同'
    + (keys.length ? `，差异键：${keys.join('、')}` : '（文本不同，但按字段解析不出差异）')
    + ' —— 「保持原注释不变」是兼容包那条硬要求的名字，所以这里要**显式确认**；确认时请在备注/决定理由里写清改了哪一栏、为什么。'));
  return out;
}

/** 是否允许上线：有 blocker 就不行。 */
export const hasBlocker = (flags) => flags.some((f) => f.level === 'blocker');
