// kits/chess_char_9_11_a.js — 霜叶（T1 领主）。原件 `kits/custom.js` 第 735-772 行逐字搬来。

import { num, mods, batPct } from './lib/bb.js';

// 霜叶 — T1 领主 (lord). Trait 可以进行远程攻击，但此时攻击力降低至80%: the profession layer reads the trait
// blackboard (`rangedScale` from `atk_scale`) — nothing to author.
//   天赋 掩护打击 (the elite record only): 攻击范围扩大 — the talent carries its own grid, installed as the unit's
//     permanent range (unit.rangeGrid + refreshRange, the module idiom) — and 攻击间隔略微增大 (`base_attack_time`
//     +0.15 s).
//   凝冰枪刃 (S2, 25 s in the data): ASPD +`attack_speed`; every attack lands a `slow` of |move_speed| and, with
//     `prob` chance, a 束缚 for `debuff` s (PRTS 凝冰枪刃 gives 1.5 s for the 束缚 at Lv4 — the blackboard's `debuff`
//     matches). PRTS names no duration for the slow itself, so it shares `debuff`; since every attack refreshes it and
//     `debuff` ≥ her interval, the slow is continuous anyway [ASSUMED duration].
export default function kit(bb, chess) {
  const slowBy = Math.min(0.9, Math.abs(num(bb.move_speed)));
  const bindProb = num(bb.prob), bindFor = num(bb.debuff, 1.5);
  const cover = (chess?.talents || []).find((t) => t && t.index === 0) ?? null;
  return {
    skill: { kind: 'duration', mods: mods({ aspd: num(bb.attack_speed) }) },
    talents: [
      { install(battle, unit) { // 掩护打击 (elite only)
        if (!cover) return;
        const bat = num(cover.bb && cover.bb.base_attack_time);
        if (bat) battle.addBuff(unit, { key: 'frostl:cover', mods: { batPct: batPct(bat, chess) }, persist: true, allowDead: true });
        const g = cover.rangeGrid;
        if (Array.isArray(g) && g.length) {
          unit.rangeGrid = g.map((p) => [p[0], p[1]]);
          battle.refreshRange(unit);
        }
      } },
    ],
    install(battle, unit) { // 凝冰枪刃: 每次攻击减速 + 束缚
      battle.on('hit', (c) => {
        if (!unit.skill || !unit.skill.active) return;
        if (c.source !== unit || !c.dmg.isAttack) return;
        if (!c.target || c.target.side !== 'enemy') return;
        if (slowBy > 0) battle.applyStatus(c.target, 'slow', { value: slowBy, duration: bindFor, source: unit });
        if (bindProb > 0 && battle.rng.chance(bindProb)) battle.applyStatus(c.target, 'bind', { duration: bindFor, source: unit });
      }, { owner: unit, priority: 10 });
    },
  };
}
