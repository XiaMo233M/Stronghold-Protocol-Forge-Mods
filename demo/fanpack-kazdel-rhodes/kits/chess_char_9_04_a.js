// kits/chess_char_9_04_a.js — 闪灵（T3 医师）。原件 `kits/custom.js` 第 946-982 行逐字搬来。

import { COLS, ROWS } from '@sim/constants.js';

import { num, mods, talentBb } from './lib/bb.js';
import { whileOn } from './lib/unit.js';
import { configure } from './lib/constants.js';

// 格键算术用的是引擎的 canvas 尺寸（`@sim/constants.js` 的 COLS/ROWS），而 `lib/` 里的辅助文件
// 够不到 `@sim/`（见 `lib/constants.js` 文件头），所以在这里注入一次。
configure({ COLS, ROWS });

// 闪灵 — T3 医师 (physician). Trait 恢复友方单位生命 is the medic default — nothing to author.
//   天赋1 黑恶魔的庇护: allies inside her range (her own tile included) get +def DEF — a flat `defFlat`, refreshed by a
//     0.25 s aura like every other talent aura.
//   天赋2 法典: ASPD +attack_speed (10) as a permanent buff.
//   教条力场 (S3, 60 s): ATK +atk, and "攻击范围内的所有友方单位防御力+def%" — the same aura with a separate buff key
//     (`defPct`), so the extra DEF lapses with the skill while 黑恶魔的庇护 keeps running.
export default function kit(bb, chess) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const auraDef = num(t0.def);
  const aspd = num(t1.attack_speed);
  const fieldDef = num(bb.def);
  const auraTick = (battle, unit, key, mods, visible) => whileOn(battle, unit, 0.25, () => {
    for (const a of battle.alliesInGrid(unit)) {
      battle.addBuff(a, { key, duration: 0.4, refresh: 'extend', mods, visible: !!visible, tags: ['talent'] });
    }
  });
  return {
    skill: { kind: 'duration', mods: mods({ atkPct: num(bb.atk) }) },
    talents: [
      { install(battle, unit) { // 黑恶魔的庇护
        if (auraDef > 0) auraTick(battle, unit, 'shining:protect', { defFlat: auraDef });
      } },
      { install(battle, unit) { // 法典
        if (aspd > 0) battle.addBuff(unit, { key: 'shining:codex', mods: { aspd }, persist: true, allowDead: true });
      } },
    ],
    install(battle, unit) { // 教条力场
      if (!(fieldDef > 0)) return;
      whileOn(battle, unit, 0.25, () => {
        if (!unit.skill || !unit.skill.active) return;
        for (const a of battle.alliesInGrid(unit)) {
          battle.addBuff(a, { key: 'shining:field', duration: 0.4, refresh: 'extend', mods: { defPct: fieldDef }, visible: true, tags: ['skill', 'shining'] });
        }
      });
    },
  };
}
