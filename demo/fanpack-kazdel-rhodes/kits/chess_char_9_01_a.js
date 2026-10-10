// kits/chess_char_9_01_a.js — 红豆（char_290_vigna）的别名件：包内这枚棋子**复用官方同一干员**的 kit。
//
// 原件（`kits/custom.js` 第 12、21-26 行）的写法是：
//
//     import OFFICIAL_VIGNA from './ops/chess_char_1_05-vigna.js';
//     const of = (reg, id) => (reg && typeof reg[id] === 'function' ? reg[id] : null);
//     const ALIASES = { chess_char_9_01_a: of(OFFICIAL_VIGNA, 'chess_char_1_05_a') };
//
// 那是**引擎内部**的一份相对 import（`kits/custom.js` 与 `kits/ops/` 同在 `server/sim/content/kits/` 下）。
// 搬进工坊包之后这条路**两端都不成立**，已实测（_up/mod-compat/out/probe-alias.mjs，三个用例）：
//
//   * `./ops/chess_char_1_05-vigna.js` 被判成**包相对**（isPackRelativeSpecifier = true），于是加载器把它解到
//     `<包>/kits/ops/chess_char_1_05-vigna.js` —— 包里没有这个文件 ⇒ `KIT_IMPORT_FAILED`，kit 被跳过。
//     它不是"向上走到引擎"的路径，而是"向下走到本包"的路径（§28.18 的几何：URL 里没有 kits/ 这一段）。
//   * `@kit/ops/chess_char_1_05-vigna.js` 被 `KIT_IMPORT` 拒（前缀合法、模块名没开）。
//   * 即便把那 33 行**字节**抄进 `<包>/kits/ops/`，它自己第 4 行的 `'../shared/tier1.js'` 在包里等于
//     `<包>/kits/shared/tier1.js`（不存在）⇒ 一样 `KIT_IMPORT_FAILED`。这条路是死的，不是"还没试"。
//
// 所以「别名」在包里**只能**换成等价的重写：官方那份 kit 只用到 5 个 tier1 helper，其中 3 个走白名单
// （`@kit/tier1.js` 的 num / talentBb / traitBb），另外 2 个（`onHitBy` / `batMod`）逐字内联在下面 ——
// 两处都只有一行表达式，且都不需要开新白名单。**判定依据**：只要引擎能力有公开路径就走公开路径（num /
// talentBb / traitBb），没有的（onHitBy 这个"只在自己打敌人时触发"的 'hit' 包装、batMod 的"缩短描述"分支）
// 就内联成本包的代码，见 docs/WORKSHOP.md §4.5 / §4.6。
//
// 等价性（逐条，对照 `server/sim/content/kits/ops/chess_char_1_05-vigna.js`）：
//   * `num` / `talentBb` / `traitBb` 是**同一个函数对象**（白名单直通 `.../kits/shared/tier1.js`）。
//   * `onHitBy(battle, unit, fn, priority = 0)` 的内联体逐字相同：
//     `battle.on('hit', (ctx) => { if (ctx.source === unit && ctx.target && ctx.target.side === 'enemy') fn(ctx); }, { owner: unit, priority })`。
//   * `batMod(v, chess)` 的调用点是 `batMod(bb.base_attack_time, chess)`，**desc 省略 = ''**，于是
//     `/间隔[^，。；]*缩短/.test('')` 恒为 false ⇒ 函数体退化成 `Math.max(-0.9, x / bat)`。
//     下面那个 `officialBatMod` 保留了两条分支（好让它与官方那份逐字对照），实际走的就是第二条。
//
// [ASSUMED] 无。这一件是纯粹的重写，没有任何数值或行为上的判断。

import { num, talentBb, traitBb } from '@kit/tier1.js';

/** 官方 tier1.js `onHitBy` 逐字（只在自己打敌人时触发）。 */
function onHitBy(battle, unit, fn, priority = 0) {
  return battle.on('hit', (ctx) => { if (ctx.source === unit && ctx.target && ctx.target.side === 'enemy') fn(ctx); }, { owner: unit, priority });
}

/** 官方 tier1.js `batMod` 逐字（调用点 desc 省略，所以第一个分支永不命中）。 */
function batMod(v, chess = null, desc = '') {
  const x = num(v, 0);
  if (!x) return 0;
  if (x > 0 && x < 1 && /间隔[^，。；]*缩短/.test(desc)) return x - 1;
  const bat = num(chess?.stats?.bat, 1) || 1;
  return Math.max(-0.9, x / bat);
}

/**
 * 官方 `chess_char_1_05_a` 的 kit 函数逐字（把它的 default export 取出来直接当本件的默认导出）。
 * 契约与原件一致：`(bb, chess, def) => Kit`。一件一文件、默认导出就是 kit 函数（docs/WORKSHOP.md §4）。
 * @param {any} bb 当前选中技能的黑板
 * @param {any} chess 棋子记录
 */
export default function kit(bb, chess) {
  const t = talentBb(chess, 0);
  const tb = traitBb(chess);
  return {
    skill: { kind: 'duration', mods: { atkPct: num(bb.atk), batPct: batMod(bb.base_attack_time, chess) } },
    talents: [{ install(battle, unit) {
      const key = 'vigna:proc';
      battle.on('beforeAttack', (ctx) => {
        if (ctx.attacker !== unit) return;
        const p = unit.skill?.active ? num(t.prob2) : num(t.prob1);
        if (p > 0 && battle.rng.chance(p)) {
          battle.addBuff(unit, { key, duration: 0.1, mods: { atkPct: num(t.atk) } });
          battle.fx('crit', { x: unit.x, y: unit.y, id: unit.id });
        }
      }, { owner: unit });
      // melee hits resolve synchronously inside the attack: the one-attack buff is dropped right after it
      battle.on('attack', (ctx) => { if (ctx.attacker === unit && unit.findBuff(key)) battle.removeBuff(unit, key); }, { owner: unit });
      if (tb.hp_ratio != null && num(tb.atk_scale, 1) !== 1) {
        onHitBy(battle, unit, ({ target, dmg }) => { if (dmg.isAttack && target.hpRatio < num(tb.hp_ratio)) dmg.amount *= num(tb.atk_scale, 1); });
      }
    } }],
  };
}
