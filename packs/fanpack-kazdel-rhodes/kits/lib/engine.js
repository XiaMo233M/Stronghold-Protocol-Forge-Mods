// kits/lib/engine.js — 原件从**四个不在白名单的引擎模块**取来的东西，这里是它们在本包内的等价实现。
//
// 为什么内联而不是"开白名单"：`@kit/` / `@sim/` 只开 tier1..6 + summoner + constants/dir/targeting
// （shared/kitImports.js KIT_IMPORT_FILES 就是闭合的那张表，docs/WORKSHOP.md §4.5.1）。它**刻意**不是
// 「server/sim/ 下的任何东西」——§28.12 明写"The module set is closed … @sim/ opens three files, not a directory"。
// 原件这四处要的东西，本包都够得着等价物，所以按 §4.6 的判据内联成包自己的代码；**需要新开白名单的一处都没有**。
//
// 逐条出处（对照 `E:\destop\卫戍协议罗德岛卡兹戴尔盟约mod\fanpack-mod\payload\server\sim`）：
//
//   1. `hasHp`  ← `damage.js`（原件第 64-66 行）
//      `!!u && u.alive && (u.bossPool ? u.bossPool.hp > 0 : u.hp > 0)`
//      "还活着且还有血（boss 看它的池）"。原件里**只有**维什戴尔的魂灵之影用它（custom.js:493），
//      判据是「这次命中的目标是不是已经空了」，再决定要不要挂残影 / 缓速。
//
//   2. `periodicDamage` ← `damage.js`（原件第 112-114 行）
//      `makeDamageInfo({ amount, type: 'true', canDodge: false, sourceless: true, tags: ['dot', 'periodic'] })`
//      即官方 `periodic_damage` 模板的一次「无来源真实持续伤害」。原件里**只有**赫德雷 S3 的每跳用它（custom.js:1060）。
//      它不是「流失」：`sourceless` 是**伤害**（PRTS 伤害分类 BUFF / "自残类型"），走护盾与受伤倍率；
//      与 `Battle.loseHp` 那条 流失 的路是两回事（docs/SIM.md 的 dealDamage / loseHp 两段）。
//
//   3. `bodyInKeys` ← `body.js`（原件函数体逐字，第 76-82 行）
//      "单位是否占据 `keys` 里的任意一格"。**常规单位是一点**（按 `Math.round(y)/Math.round(x)` 的格键），
//      **巨型单位**（数据 `hitArea`，PRTS "受击判定区域为长4.95、宽2.95的长方形"）占它矩形盖到的**每一格**。
//      原件里**只有**阿斯卡纶 S2 恩赐的尸爆用它（custom.js:703）。原件模块头写明它 "Pure functions of (x, y,
//      hitArea); no battle state"，所以逐字搬过来是等价的 —— 这里刻意**不**简化成"取它所在的格"：
//      一只巨型敌人站得让矩形压住阿斯卡纶的格子时，两者判罚不同。
//
//   4. `PRIO_REVIVE` ← `content/items/battle.js`（原件第 73 行）`= -100`
//      坚固维式重锤那条 不死 窗口的钩子优先级。原件里 Mon3tr 的 fatal 保险（custom.js:218）与煌的紧急除颤
//      （custom.js:867）都用它。**它必须是 −100 这一个数**：装备层那条 不死 排在它之后一位（−99，PRIO_UNDYING_HELD），
//      "持有不死的情况下不会触发"就是由这个次序决定的（原件注释逐字写了这条读法）。
//      这是一个**工具常量**，已经进了交付包；业主若将来把它开进白名单可以整块换掉（见交付说明的未决项）。

import { COLS, ROWS } from './constants.js';

/** 单位所在格键（出界为 −1）。body.js posKey 逐字。 */
function posKey(u) {
  const r = Math.round(u.y), c = Math.round(u.x);
  return r < 0 || r >= ROWS || c < 0 || c >= COLS ? -1 : r * COLS + c;
}

/** 巨型单位矩形（`{ dx, dy }` 平移后居中）盖到的每一格键；常规单位只有它所在那一格。body.js bodyKeys 逐字。 */
function bodyKeysOf(u) {
  if (!u.hitArea) { const k = posKey(u); return k < 0 ? [] : [k]; }
  const a = u.hitArea;
  const cx = u.x + a.dx, cy = u.y + a.dy;
  const x0 = cx - a.w / 2, x1 = cx + a.w / 2, y0 = cy - a.h / 2, y1 = cy + a.h / 2;
  const out = [];
  const r0 = Math.max(0, Math.floor(y0 + 0.5 + 1e-9)), r1 = Math.min(ROWS - 1, Math.ceil(y1 - 0.5 - 1e-9));
  const c0 = Math.max(0, Math.floor(x0 + 0.5 + 1e-9)), c1 = Math.min(COLS - 1, Math.ceil(x1 - 0.5 - 1e-9));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(r * COLS + c);
  return out;
}

/**
 * 存活且还有血（boss 看它的血池）。damage.js hasHp 逐字。
 * @param {any} u
 * @returns {boolean}
 */
export const hasHp = (u) => !!u && u.alive && (u.bossPool ? u.bossPool.hp > 0 : u.hp > 0);

/**
 * 官方 `periodic_damage` 模板的一次无来源真实持续伤害（DamageInfo）。damage.js periodicDamage 逐字 ——
 * 字段与同一份 makeDamageInfo 的默认值一致（docs/SIM.md 的 DamageInfo 形状）。
 * @param {number} amount
 */
export const periodicDamage = (amount) => ({
  amount: Number.isFinite(+amount) ? +amount : 0,
  type: 'true',
  element: null,
  atkScale: 1,
  defIgnoreFlat: 0,
  defIgnorePct: 0,
  resIgnoreFlat: 0,
  resIgnorePct: 0,
  mul: 1,
  canDodge: false,
  isSkill: false,
  isSplash: false,
  isAttack: false,
  isProjectile: false,
  tags: ['dot', 'periodic'],
  cancel: false,
  noSp: false,
  ignoreSleep: false,
  ignoreSelect: false,
  sourceless: true,
  attackId: 0,
  traitAlly: null,
});

/**
 * 单位是否占据 `keys`（Set / Map 这类有 `has` 的，或数组）里的任意一格。body.js bodyInKeys 逐字。
 * @param {any} u
 * @param {any} keys
 * @returns {boolean}
 */
export function bodyInKeys(u, keys) {
  if (!u || !keys) return false;
  const has = typeof keys.has === 'function' ? (k) => keys.has(k) : (k) => keys.includes(k);
  if (!u.hitArea) { const k = posKey(u); return k >= 0 && has(k); }
  for (const k of bodyKeysOf(u)) if (has(k)) return true;
  return false;
}

/**
 * 坚固维式重锤那条 不死 窗口的钩子优先级（content/items/battle.js PRIO_REVIVE = −100）。
 * 装备层那条 不死 排在它之后一位（−99），所以"持有不死时不触发"是这个数决定的。
 * @type {number}
 */
export const PRIO_REVIVE = -100;
