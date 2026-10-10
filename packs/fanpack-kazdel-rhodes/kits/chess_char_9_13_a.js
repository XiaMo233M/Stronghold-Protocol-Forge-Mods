// kits/chess_char_9_13_a.js — 坚雷（T2 驭法铁卫）。原件 `kits/custom.js` 第 892-916 行逐字搬来。

import { num, mods, talentBb } from './lib/bb.js';

// 坚雷 — T2 驭法铁卫 (artsprotector — a subProfession the engine's table does not carry, so its trait is authored
// here). Trait 技能开启时普通攻击会造成法术伤害 and 起盾回击's "同时攻击阻挡的所有敌人" both ride on the skill's `attack`
// override: effectiveProfile copies every key of it onto the profile while the skill runs (`dmgType: 'arts'`,
// `hitAllBlocked: true`).
//   天赋 攻守兼备: ATK +atk / DEF +def (4 % each on the normal blackboard) as a permanent buff.
export default function kit(bb, chess) {
  const t0 = talentBb(chess, 0);
  const atk = num(t0.atk), def = num(t0.def);
  return {
    // The record's derived `dmgType` is 'arts' (the trait text mentions 法术), but 驭法铁卫 attacks physically unless a
    // skill runs — the skill's `attack.dmgType` below switches the arts damage on and off with it.
    trait: { dmgType: 'phys' },
    skill: {
      kind: 'duration',
      mods: mods({ atkPct: num(bb.atk) }),
      attack: { dmgType: 'arts', hitAllBlocked: true },
    },
    talents: [
      { install(battle, unit) { // 攻守兼备
        if (!(atk > 0) && !(def > 0)) return;
        battle.addBuff(unit, { key: 'durnar:guard', mods: mods({ atkPct: atk, defPct: def }), persist: true, allowDead: true });
      } },
    ],
  };
}
