// kits/chess_char_9_18_a.js — 凯尔希（T4 医师）。原件 `kits/custom.js` 第 223-319 行逐字搬来。

import { COLS, ROWS } from '@sim/constants.js';

import { num, mods } from './lib/bb.js';
import { on, whileOn, inRangeOf, tokenOf } from './lib/unit.js';
import { configure } from './lib/constants.js';

// 格键算术用的是引擎的 canvas 尺寸（`@sim/constants.js` 的 COLS/ROWS），而 `lib/` 里的辅助文件
// 够不到 `@sim/`（见 `lib/constants.js` 文件头），所以在这里注入一次。
configure({ COLS, ROWS });

/** Mon3tr（凯尔希的召唤物）的 token id（原件 custom.js:235）。 */
const KALTS_TOKEN = 'token_10002_kalts_mon3tr';

// 凯尔希 — T4 医师. Her Mon3tr (token_10002_kalts_mon3tr) is a hand card the mode hands her; the token record
// already carries its 25 s redeploy time.
//   天赋1 Mon3tr: 优先治疗自身和Mon3tr (the heal picker's content hook `heal.prefer`, server/sim/ai.js — her own
//     tile first, then the token; a unit the hook does not return still heals, this is a reorder, not a filter) and
//     "Mon3tr不在凯尔希攻击范围内时防御力降至0" (a short defPct −1 buff kept up while the token stands outside her
//     range). The talent's third clause (the token counts as a hand card here) is the pack's own model.
//   天赋2 不毁重构: Mon3tr knocked out (not retreated) → the 8 surrounding tiles are stunned for 3 s and take
//     1200 true damage.
//   指令：熔毁 (S3, 18 s): Mon3tr gains DEF +120 % and an ATK bonus decaying from +160 % to +0 % (1 s steps), its
//     damage type turns true, and if it killed nothing while the skill ran 凯尔希 loses 50 % of her max HP when it
//     ends. "该技能与Mon3tr绑定" only means the buffs land on the token (she buffs nothing else), so nothing to gate.
export default function kit(bb, chess) {
  const atkFrom = num(bb['attack@atk'], 1.6);
  const defUp = num(bb['attack@def'], 1.2);
  const penalty = num(bb['attack@hp_ratio'], 0.5);
  return {
    trait: {
      heal: {
        mode: 'single',
        prefer(battle, unit, cands) { // 优先治疗自身和Mon3tr
          if (cands.includes(unit)) return unit;
          const tk = tokenOf(battle, unit, KALTS_TOKEN);
          return tk && cands.includes(tk) ? tk : null;
        },
      },
    },
    skill: {
      kind: 'duration',
      duration: num(bb.duration, 18),
      onStart(ctx) {
        ctx.unit.mem.kaltsKills = 0;
        ctx.unit.mem.kaltsMelt = 0;
      },
      onTick(ctx) {
        const { battle, unit, dt } = ctx;
        const tk = tokenOf(battle, unit, KALTS_TOKEN);
        if (!tk) return;
        unit.mem.kaltsMelt = num(unit.mem.kaltsMelt) + num(dt);
        if (unit.mem.kaltsMelt < 1) return;
        unit.mem.kaltsMelt = 0;
        // 攻击力从 +160% 逐渐降低至 +0%: re-grant the pair every second at the fraction of the skill left
        const dur = num(unit.skill?.duration, 18);
        const left = Math.max(0, num(unit.skill?.timeLeft, dur));
        const frac = dur > 0 ? left / dur : 0;
        battle.addBuff(tk, {
          key: 'kalts:melt', refresh: 'replace', duration: Math.max(left, 0.1),
          mods: mods({ defPct: defUp, atkPct: atkFrom * frac }), tags: ['skill', 'kalts'],
        });
      },
      onEnd(ctx) {
        const { battle, unit } = ctx;
        if (num(unit.mem.kaltsKills) > 0 || !on(unit)) return; // 技能期间未击杀任何敌人
        const loss = unit.s.maxHp * penalty;
        if (loss > 0) battle.dealDamage(unit, unit, { amount: loss, type: 'true', isSkill: true, tags: ['skill', 'kalts'] });
      },
    },
    talents: [
      { install(battle, unit) { // 天赋1 Mon3tr — Mon3tr不在凯尔希攻击范围内时防御力降至0
        whileOn(battle, unit, 0.25, () => {
          const tk = tokenOf(battle, unit, KALTS_TOKEN);
          if (!tk) return;
          if (inRangeOf(unit, tk)) battle.removeBuff(tk, 'kalts:outrange');
          // a 0.4 s buff refreshed every 0.25 s: it lapses on its own the moment the token is gone / out of reach
          else battle.addBuff(tk, { key: 'kalts:outrange', duration: 0.4, refresh: 'extend', mods: { defPct: -1 }, visible: true, tags: ['talent'] });
        });
      } },
      { install(battle, unit) { // 不毁重构
        battle.on('kill', (c) => {
          const tk = tokenOf(battle, unit, KALTS_TOKEN);
          if (!tk || c.victim !== tk) return;
          if (c.reason === 'retreat' || c.reason === 'expired') return; // 不包括撤退
          if (tk.mem.kaltsKills != null) tk.mem.kaltsKills++;
          if (unit.mem.kaltsKills != null) unit.mem.kaltsKills++;
          for (const e of battle.foesInRadius(tk.tileC, tk.tileR, 1)) {
            if (!e.alive) continue;
            battle.applyStatus(e, 'stun', { duration: 3, source: unit });
            battle.dealDamage(unit, e, { amount: 1200, type: 'true', isSkill: true, tags: ['talent', 'kalts'] });
          }
        }, { owner: unit });
      } },
    ],
    install(battle, unit) { // 指令：熔毁 — "伤害类型变为真实" while the skill runs
      // The 'hit' hook runs before mitigation and the pipeline re-reads `dmg.type` after it (damage.js), so the
      // token's own normal attacks land as 真实伤害 for the skill's duration; a phys/arts one keeps its dodge roll
      // off (真实伤害 is not dodged).
      battle.on('hit', (c) => {
        if (!unit.skill || !unit.skill.active) return;
        if (c.dmg.type !== 'phys' && c.dmg.type !== 'arts') return;
        const tk = tokenOf(battle, unit, KALTS_TOKEN);
        if (!tk || c.source !== tk) return;
        c.dmg.type = 'true';
        c.dmg.canDodge = false;
      }, { owner: unit });
    },
  };
}
