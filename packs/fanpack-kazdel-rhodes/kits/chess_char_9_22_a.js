// kits/chess_char_9_22_a.js — 逻各斯（T6 核心术师）。原件 `kits/custom.js` 第 321-427 行逐字搬来。

import { skillBbOf, skillRec } from '@kit/tier1.js';
import { COLS } from '@sim/constants.js';

import { num, mods, talentBb } from './lib/bb.js';
import { configure } from './lib/constants.js';

// 格键算术用的是引擎的 canvas 尺寸（`@sim/constants.js` 的 COLS/ROWS），而 `lib/` 里的辅助文件
// 够不到 `@sim/`（见 `lib/constants.js` 文件头），所以在这里注入一次。
configure({ COLS });

// 逻各斯 — T6 核心术师. Trait 攻击造成法术伤害 is the corecaster default (ranged/arts/bolt), nothing to author.
//   天赋1 语汇演化: on every attack, a `prob` roll fires an EXTRA arts hit of atk_scale × ATK at a random targetable
//     enemy inside 逻各斯's range and slows it for `sluggish` s. [ASSUMED: "攻击范围内一个随机目标" — a uniform pick
//     over the whole range, the main target included (the text excludes none).]
//   天赋2 剜魂具辞: every attack marks its targets with resFlat `magic_resistance` (−10) and artsTakenFlat
//     `atk_addition` (+150) for `duration` s — the flat half is the engine mod `artsTakenFlat` (buffs.js, applied
//     after mitigation in damage.js), the official "受到的法术伤害提高N点" attribute.
//   延异视阈 (S3): 持续时间无限 ⇒ kind 'toggle' — ATK +`atk` (160 % normal / 220 % elite), up to 3 targets at once
//     and the skill's own (expanded) range. "使攻击范围内敌方子弹的飞行速度大幅降低" = enemy projectiles inside the
//     range are slowed to projectile_move_scale of their speed while it runs (a per-tick sweep, a flag on the
//     projectile so a shell is only slowed once), and "技能结束时将其全部清除" = onEnd drops every enemy projectile
//     inside the range (the range is still the skill's own while onEnd runs).
export default function kit(bb, chess, def) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const prob = num(t0.prob), extraScale = num(t0.atk_scale), slow = num(t0.sluggish);
  const carve = num(t1.duration, 5), carveRes = num(t1.magic_resistance), carveArts = num(t1.atk_addition);
  const slowFactor = num(bb.projectile_move_scale, 1);
  // S1 (skchr_logos_1) is authored in `skills` as well, so its numbers must come from ITS OWN blackboard (bb is the
  // SELECTED skill's) — and the range grid from its own record.
  const logos1 = skillBbOf(chess, 'skchr_logos_1');
  const logos1Grid = skillRec(chess, 'skchr_logos_1')?.rangeGrid ?? null;
  const logos1KillScale = num(logos1['attack@kill_atk_scale']);
  const logos1KillDamage = num(logos1['attack@kill_damage'], 9999999);
  const onGrid = (unit, x, y) => !unit.rangeKeySet || unit.rangeKeySet.has(Math.round(y) * COLS + Math.round(x));
  const enemyProj = (battle, unit) => battle.projectiles.list.filter((p) => p.source && p.source.side === 'enemy' && onGrid(unit, p.x, p.y));
  return {
    skill: {
      kind: 'toggle', // 持续时间无限
      mods: mods({ atkPct: num(bb.atk) }),
      targeting: { maxTargets: Math.max(1, Math.floor(num(bb['attack@max_target'], 1))), rangeGrid: def?.skill?.rangeGrid ?? null },
      onTick({ battle, unit }) {
        if (!(slowFactor > 0) || slowFactor >= 1) return;
        // PRTS 备注: "减速效果只对水平坐标位于范围内的、阵营为敌方的部分弹道生效，受影响的弹道的飞行速度/角速度
        // 降低至0.05倍" — `projectile_move_scale` is that 0.05, applied once per projectile. The engine's projectiles
        // are straight lines with a single `speed`, so there is no angular velocity to slow as well.
        for (const p of enemyProj(battle, unit)) {
          if (p.logosSlowed) continue;
          p.logosSlowed = true;
          p.speed *= slowFactor;
        }
      },
      onEnd({ battle, unit }) {
        // PRTS 备注: "技能结束时的效果受缴械类效果制约"
        if (unit.s.flags.disarm) return;
        const hit = enemyProj(battle, unit);
        if (!hit.length) return;
        const list = battle.projectiles.list;
        for (const p of hit) {
          const i = list.indexOf(p);
          if (i >= 0) list.splice(i, 1); // 清除: dropped without resolving, so nothing hits
        }
      },
    },      skills: {
      // S1 (skchr_logos_1): 攻击范围扩大、攻击力 +40 %/+70 %；攻击范围内生命值低于自身攻击力 90 %/120 % 的敌人
      // 「立刻倒下」，并对另一个随机目标造成等于该敌人生命值的法术伤害 — 持续时间无限（同样是 toggle，开启后不再关闭）。
      // 阈值比的是敌人的最大生命（官方「生命值低于…的敌人」），斩杀用黑板里的 attack@kill_damage。
      // 注意：`skills` 的值必须是 SkillSpec **对象**（selectSkillSpec 直接把它当 spec 用）——写成工厂函数会让
      // SkillRuntime 拿到一个函数，kind 回落到棋子记录里的 kind（赫德雷 S2 就是这样变成每次技力满都重开的）。
      skchr_logos_1: {
        kind: 'toggle',
        mods: mods({ atkPct: num(logos1.atk) }),
        ...(logos1Grid ? { targeting: { rangeGrid: logos1Grid } } : {}),
        onTick({ battle, unit }) {
          if (!(logos1KillScale > 0) || !unit.alive) return;
          const keys = Array.isArray(unit.rangeKeys) ? unit.rangeKeys : [];
          if (!keys.length) return;
          const limit = num(unit.s.atk) * logos1KillScale;
          for (const e of battle.enemiesInKeys(keys, unit, unit.profile)) {
            if (!e.alive || e.side !== 'enemy' || e.s.flags.invulnerable) continue;
            if (!(num(e.s.maxHp) < limit)) continue;
            const pool = battle.enemiesInKeys(keys, unit, unit.profile).filter((o) => o !== e && o.alive && o.side === 'enemy');
            const hp = num(e.s.maxHp);
            battle.dealDamage(unit, e, { amount: logos1KillDamage, type: 'arts', isSkill: true, tags: ['skill', 'logos'] });
            const extra = pool.length ? battle.rng.pick(pool) : null;
            if (extra && extra.alive) battle.dealDamage(unit, extra, { amount: hp, type: 'arts', isSkill: true, tags: ['skill', 'logos'] });
          }
        },
      },
    },      talents: [
      { install(battle, unit) { // 语汇演化
        battle.on('beforeAttack', (c) => {
          if (c.attacker !== unit || !(prob > 0) || !(extraScale > 0)) return;
          if (!battle.rng.chance(prob)) return;
          const keys = unit.rangeKeys;
          if (!keys || !keys.length) return;
          const foes = battle.enemiesInKeys(keys, unit, unit.profile);
          if (!foes.length) return;
          const t = foes[Math.min(foes.length - 1, Math.floor(battle.rng() * foes.length))];
          if (!t) return;
          battle.dealDamage(unit, t, { amount: unit.s.atk * extraScale, type: 'arts', canDodge: false, tags: ['talent', 'logos'] });
          if (slow > 0) battle.applyStatus(t, 'sluggish', { duration: slow, source: unit });
          battle.fx('extraAttack', { x: t.x, y: t.y, id: unit.id });
        }, { owner: unit });
      } },
      { install(battle, unit) { // 剜魂具辞
        battle.on('hit', (c) => {
          if (c.source !== unit || !c.dmg.isAttack) return;
          if (!c.target || c.target.side !== 'enemy') return;
          battle.addBuff(c.target, {
            key: 'logos:carve', duration: carve, refresh: 'replace', visible: true, tags: ['talent'],
            mods: mods({ resFlat: carveRes, artsTakenFlat: carveArts }),
          });
        }, { owner: unit, priority: 10 });
      } },
    ],
  };
}
