// 审核辅助：把「名称与内容」里最需要人眼确认的几件事自动挑出来。
//
// **它不下结论，只挑重点。** 每一条都写清为什么值得看一眼；最终由人拍板。
// 分三档：blocker（基本不能上线）/ warn（要看一眼）/ info（记录一下）。
//
// 这里最要紧的一类是「包里有没有夹带官方游戏素材」—— 那是这个仓库唯一不可谈判的红线，
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

/** 名称检查（上传时填的 mod 名）。 */
export function reviewName(name) {
  const out = [];
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s) out.push(F('blocker', 'NAME_EMPTY', '名称为空'));
  if (s.length > 60) out.push(F('warn', 'NAME_LONG', `名称长 ${s.length} 字，超过 60 字（列表里会显示不下）`));
  if (/[\u0000-\u001f\u007f]/.test(s)) out.push(F('blocker', 'NAME_CONTROL', '名称里有控制字符'));
  if (/[<>]/.test(s)) out.push(F('warn', 'NAME_ANGLE', '名称里有尖括号（显示时会转义，但最好去掉）'));
  if (IMPERSONATE.test(s)) out.push(F('warn', 'NAME_IMPERSONATE', '名称含「官方 / official / 鹰角 / Yostar」这类词 —— 容易让人误以为是官方出品'));
  if (/^(.)\1+$/.test(s) && s.length > 3) out.push(F('warn', 'NAME_NOISE', '名称是同一个字符重复'));
  return out;
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

/** 是否允许上线：有 blocker 就不行。 */
export const hasBlocker = (flags) => flags.some((f) => f.level === 'blocker');
