// kits/chess_char_9_16_a.js — 煌（T4 强攻手）。原件 `kits/custom.js` 第 774-890 行逐字搬来。

import { skillBbOf, skillRec } from '@kit/tier1.js';
import { frontOf } from '@sim/dir.js';
import { COLS, ROWS } from '@sim/constants.js';

import { num, mods, talentBb } from './lib/bb.js';
import { on } from './lib/unit.js';
import { PRIO_REVIVE } from './lib/engine.js';
import { configure } from './lib/constants.js';

// 格键算术用的是引擎的 canvas 尺寸（`@sim/constants.js` 的 COLS/ROWS），而 `lib/` 里的辅助文件
// 够不到 `@sim/`（见 `lib/constants.js` 文件头），所以在这里注入一次。
configure({ COLS, ROWS });

/** 煌 S3 沸腾爆裂 收尾: PRTS 备注 "对前方3×3区域内的所有敌人造成一次物理伤害（碰撞判定，可对空）" — the circle of
 *  radius 1.5 around the front tile's centre covers exactly those 9 tiles (its corners are √2 ≈ 1.41 away)（原件 custom.js:44）。 */
const HUANG_BURST_RADIUS = 1.5;
/** 煌 S3 的切割 / 攻防爬坡节奏: PRTS 备注 "前8秒内每秒更新一次攻防属性…9s时攻防属性更新至最大属性值"（原件 custom.js:46）。 */
const HUANG_RAMP_SEC = 9;

// 煌 — T4 强攻手 (centurion). Trait 同时攻击阻挡的所有敌人: the profession layer sets `hitAllBlocked` — nothing to author.
//   天赋1 紧急除颤 (PRTS 备注 "每次部署后，煌常态持有不死效果；首次生命比例低于或等于25%时，触发天赋并解除不死效果" —
//     the undying is a 'fatal' saver at PRIO_REVIVE that stops working once the flag is spent): the first time her HP
//     ratio reaches hp_ratio (25 %) she heals `huang_t_1[heal].hp_ratio` (50 %) of her max HP and for
//     `huang_t_1[lock].duration` (6 s) damage that would take her below `huang_t_1[lock].min_hp_ratio` (50 %) is
//     reduced — PRTS: "该伤害减少(伤害值−当前生命值+最大生命值×50%)点", i.e. the HP is clamped back to that floor
//     right after the loss. [ASSUMED: the clamp is done on the `damaged` hook, which runs after the HP loss.]
//   天赋2 严酷训练: `interval` (15 s) after deployment she gains 抵抗 (`resist`, value `1 + one_minus_status_resistance`
//     = 0.5).
//   沸腾爆裂 (S3, 10 s): 攻击力和防御力逐渐增至 +atk/+def — the pair is re-granted every second at min(1, t/9)
//     (PRTS 备注 "前8秒内每秒更新一次攻防属性…9s时攻防属性更新至最大属性值"); at the 9 s mark, "对前方一格内的敌方
//     单位进行切割" = ONE physical hit of her ATK [ASSUMED: the 备注 gives no coefficient for this instance] to every
//     GROUND enemy she reaches (her range is her own tile + the one in front). When the skill ends she loses
//     `hp_ratio` (25 %) of her max HP — never below 1 HP (PRTS "最多令生命值降至1点") — and deals
//     `damage_by_atk_scale` × 此时攻击力 physical to every enemy in the 3×3 area in front (碰撞判定, flyers included).
export default function kit(bb, chess) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const thr = num(t0.hp_ratio, 0.25);
  const healRatio = num(t0['huang_t_1[heal].hp_ratio'], 0.5);
  const floor = num(t0['huang_t_1[lock].min_hp_ratio'], 0.5);
  const lockFor = num(t0['huang_t_1[lock].duration'], 6);
  const resistAfter = num(t1.interval, 15);
  const resist = Math.max(0, Math.min(0.95, 1 + num(t1.one_minus_status_resistance)));
  const atkUp = num(bb.atk), defUp = num(bb.def);
  const burstScale = num(bb.damage_by_atk_scale, 1);
  const hpCost = num(bb.hp_ratio, 0.25);
  // S2 (skchr_huang_2) is authored in `skills` as well: its own blackboard and its own range grid
  const huang2 = skillBbOf(chess, 'skchr_huang_2');
  const huang2Grid = skillRec(chess, 'skchr_huang_2')?.rangeGrid ?? null;
  /** Everything of hers she reaches at that moment (her range + the enemies it blocks). */
  const reached = (battle, unit) => {
    const out = battle.enemiesInKeys(unit.rangeKeys, unit, unit.profile);
    for (const e of unit.blocking) if (e.alive && !out.includes(e)) out.push(e);
    return out;
  };
  return {
    skill: {
      kind: 'duration',
      onStart(ctx) {
        ctx.unit.mem.huangT = 0;
        ctx.unit.mem.huangTick = 0;
        ctx.unit.mem.huangCut = false;
      },
      onTick({ battle, unit, dt }) {
        const dur = num(unit.skill?.duration, 10);
        unit.mem.huangT = num(unit.mem.huangT) + num(dt);
        const t = unit.mem.huangT;
        if (t - num(unit.mem.huangTick) >= 1) { // 每秒更新一次攻防属性
          unit.mem.huangTick = t;
          const prog = Math.min(1, t / HUANG_RAMP_SEC);
          battle.addBuff(unit, {
            key: 'huang:burst', refresh: 'replace', duration: Math.max(0.4, dur - t + 0.3), visible: true, tags: ['skill', 'huang'],
            mods: mods({ atkPct: atkUp * prog, defPct: defUp * prog }),
          });
        }
        if (!unit.mem.huangCut && t >= HUANG_RAMP_SEC) { // 切割: one hit on everything she reaches, ground only
          unit.mem.huangCut = true;
          for (const e of reached(battle, unit)) {
            if (!e.alive || e.isFlying) continue;
            battle.dealDamage(unit, e, { amount: unit.s.atk, type: 'phys', isSkill: true, tags: ['skill', 'huang'] });
          }
        }
      },
      onEnd({ battle, unit }) {
        if (!on(unit)) return;
        const atk = unit.s.atk; // 此时攻击力 (the ramp is still applied while onEnd runs)
        // PRTS 备注 orders it 流失生命 first: "9s时攻防属性更新至最大属性值，随后流失生命，对前方3×3区域内的所有敌人
        // 造成一次物理伤害（碰撞判定，可对空）"
        const loss = Math.min(unit.s.maxHp * hpCost, Math.max(0, unit.hp - 1)); // 不会导致自身死亡
        if (loss > 0) battle.loseHp(unit, loss, { source: unit });
        const [fr, fc] = frontOf(unit.tileR, unit.tileC, unit.dir);
        for (const e of battle.foesInRadius(fc, fr, HUANG_BURST_RADIUS, true)) {
          if (!e.alive) continue;
          battle.dealDamage(unit, e, { amount: atk * burstScale, type: 'phys', isSkill: true, tags: ['skill', 'huang'] });
        }
        battle.fx('aoe', { x: fc, y: fr, id: unit.id, r: HUANG_BURST_RADIUS, skill: 'huang' });
      },
    },
    skills: {
      // S2 (skchr_huang_2): 攻击力 +55 %/+70 %、防御力 +15 %/+20 %、攻击距离加长 — 持续时间无限。用户 2026-10-06：
      // 这类「持续无限 / 可切换」技能开启后不再关闭，所以是 toggle（开启即保持到被击倒）。值必须是 SkillSpec 对象
      // （见 逻各斯 S1 处的注释）。攻击距离用技能自己的 rangeGrid（3 格），从棋子记录的 skills[] 里取，避免写死。
      skchr_huang_2: {
        kind: 'toggle',
        mods: mods({ atkPct: num(huang2.atk), defPct: num(huang2.def) }),
        ...(huang2Grid ? { targeting: { rangeGrid: huang2Grid } } : {}),
      },
    },
    talents: [
      { install(battle, unit) { // 紧急除颤
        battle.on('fatal', (c) => { // 常态不死, spent with the rescue
          if (c.unit !== unit || c.prevented || unit.mem.huangRescue) return;
          c.prevented = true;
        }, { owner: unit, priority: PRIO_REVIVE });
        battle.on('damaged', (c) => {
          if (c.target !== unit || !unit.alive) return;
          if (!unit.mem.huangRescue) {
            if (!(thr > 0) || unit.hpRatio > thr) return;
            unit.mem.huangRescue = battle.time; // 仅一次 (mem is per deployment)
            battle.heal(unit, unit, unit.s.maxHp * healRatio, { self: true, ignoreHealFree: true, tags: ['talent', 'huang'] });
            battle.addBuff(unit, { key: 'huang:lock', duration: lockFor, visible: true, tags: ['talent', 'huang'] });
            return;
          }
          if (!unit.findBuff('huang:lock')) return;
          const min = unit.s.maxHp * floor; // 使生命值不低于50 %
          if (unit.hp < min) unit.hp = min;
        }, { owner: unit, priority: 30 });
      } },
      { install(battle, unit) { // 严酷训练
        if (!(resistAfter > 0) || !(resist > 0)) return;
        battle.after(resistAfter, () => {
          if (on(unit)) battle.applyStatus(unit, 'resist', { value: resist, duration: Infinity, source: unit });
        }, { owner: unit });
      } },
    ],
  };
}
