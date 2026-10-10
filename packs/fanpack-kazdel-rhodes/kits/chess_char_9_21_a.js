// kits/chess_char_9_21_a.js — Mon3tr（T5 链愈师）。原件 `kits/custom.js` 第 72-221 行逐字搬来，
// 只把**共享**的辅助函数换成包相对 import（§28.18），不改任何数值或行为。

import { COLS, ROWS } from '@sim/constants.js';

import { num, mods, talentBb, batPct } from './lib/bb.js';
import { on, neighbors, tokenOf } from './lib/unit.js';
import { PRIO_REVIVE } from './lib/engine.js';
import { configure } from './lib/constants.js';

// 格键算术用的是引擎的 canvas 尺寸（`@sim/constants.js` 的 COLS/ROWS），而 `lib/` 里的辅助文件
// 够不到 `@sim/`（见 `lib/constants.js` 文件头），所以在这里注入一次。
configure({ COLS, ROWS });

/** 重构体 — a hand card the mode gives Mon3tr's owner（原件 custom.js:33）。 */
const MONSTR_TOKEN = 'token_10050_monstr_prosts';

/** Mon3tr's 重构体 on the field（原件 custom.js:58）。 */
const prostOf = (battle, unit) => tokenOf(battle, unit, MONSTR_TOKEN);
/** `t` is that Mon3tr's own 重构体 (`profile.healThrough(healer, target)` — no battle at hand there)（原件 custom.js:60）。 */
const isProstsOf = (t, unit) => !!t && t.kind === 'token' && t.defId === MONSTR_TOKEN && t.ownerUnit === unit;

// Mon3tr — T5 链愈师. Trait 恢复友方单位生命，且会在3个友方单位间跳跃，每次跳跃治疗量降低25%: the profession layer
// reads the trait blackboard (attack@chain.max_target / atk_scale), so nothing to author.
//   天赋1 自我修复: the 重构体 grants allies around it +15% ATK, and a heal of it by Mon3tr or itself jumps once
//     more without the chain falloff [ASSUMED: the extra jump targets the nearest injured ally in heal range].
//   天赋2 战术协同: a heal by the unit or its 重构体 gives the target (and the healer) +20 ASPD for 10 s, no stack.
//   策略：熔毁 (S3): 25 s — ATK +250%, BAT −1.5 s, block +2, max HP +5000, 80 HP/s drain (true, can kill), attacks
//     deal true damage and heal itself for 50% ATK; it moves onto the 重构体's tile when the skill starts (a
//     【移动】 = Battle.moveRedeploy) and — "技能结束或受到致命伤害时，返回初始位置" — returns to its own tile both
//     when the skill ends and when a lethal blow lands while it runs (a 'fatal' saver at PRIO_REVIVE: the 【返回】 is
//     the same onEnd path). PRTS 备注: 技能期间不死，受到致命伤害结算后**立即结束技能**（即返回）✓ matches the saver;
//     HP is restored [ASSUMED: the 备注 says nothing about HP after the 不死, and a 0-HP unit cannot stand].
export default function kit(bb, chess) {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1);
  const auraAtk = num(t0.atk, 0.15);
  return {
    // Mon3tr is the ONE healer 重构体 accepts: PRTS 重构体 备注 "持有禁疗（可以被Mon3tr无视）" — `profile.healThrough
    // (healer, target)` is what the heal pipeline / heal targeting read (damage.js heal, Battle.injuredAlliesInKeys,
    // ai.js doHeal; the shape upstream's own Mon3tr kit uses, kits/ops/op-monstr.js — 0.2.0 replaced the v0.1.3
    // `healThroughNoHeal` flag with it, see DESIGN §23.42).
    // canHitFly false: his record says so (医疗表默认 true), and 策略：熔毁 把他变成攻击者时"不能对空中敌方单位攻击"
    // [user report 2026-10-06] — the kit trait is where a pack piece pins its profile (professions.js resolveProfile).
    trait: { healThrough: (healer, a) => isProstsOf(a, healer), canHitFly: false },
    skill: {
      kind: 'duration',
      duration: num(bb.duration, 25),
      mods: mods({
        atkPct: num(bb.atk),
        batPct: batPct(bb.base_attack_time, chess),
        blockCnt: num(bb.block_cnt),
        hpFlat: num(bb.max_hp),
      }),
      attack: {
        dmgType: 'true',
        onHit(ctx) {
          const u = ctx.unit, scale = num(bb['attack@heal_scale']);
          if (on(u) && scale > 0) ctx.battle.heal(u, u, u.s.atk * scale, { tags: ['skill', 'monstr'] });
        },
      },
      onTick(ctx) {
        const u = ctx.unit, dps = num(bb.damage_per_second);
        if (!on(u) || !(dps > 0)) return;
        u.mem.monstrDrain = num(u.mem.monstrDrain) + num(ctx.dt);
        while (u.mem.monstrDrain >= 1) {
          u.mem.monstrDrain -= 1;
          ctx.battle.dealDamage(u, u, { amount: dps, type: 'true', isSkill: true, tags: ['skill', 'monstr'] });
        }
      },
      onStart(ctx) {
        const { battle, unit } = ctx;
        const tk = prostOf(battle, unit);
        // PRTS 备注 of 策略：熔毁 spells the flow out: ① 撤退场上的重构体（返回待部署区）② 在它原先的位置执行
        // 【移动】，并在**原位置**部署一个「路标形态」的重构体作为【返回】移动的标志物. So the 重构体 is withdrawn
        // (back to hand) and the 【返回】 is the same redeploy path home — matching what this hook does.
        // "场上不存在重构体时技能不能开启" (the client's skchr_monstr_3 `_onlyAvailableWhenTokenValid`) is the
        // `install` guard below; this branch only backstops a start that slipped through (and pays the charge back).
        if (!tk) { ctx.skill?.end('noToken'); ctx.skill?.addCharge(1); return; }
        if (unit.tileR === tk.tileR && unit.tileC === tk.tileC) return;
        const home = { r: unit.tileR, c: unit.tileC, tok: { r: tk.tileR, c: tk.tileC } };
        battle.retreat(tk, { reason: 'expired', permanent: true });
        const fromX = unit.x, fromY = unit.y;
        if (!battle.moveRedeploy(unit, home.tok.r, home.tok.c)) return;
        unit.mem.monstrHome = home;
        battle.fx('teleport', { x: unit.x, y: unit.y, id: unit.id, fromX, fromY });
      },
      onEnd(ctx) {
        const { battle, unit } = ctx;
        const home = unit.mem.monstrHome;
        unit.mem.monstrHome = null;
        if (!home || !on(unit)) return;
        const fromX = unit.x, fromY = unit.y;
        if (!battle.moveRedeploy(unit, home.r, home.c)) return;
        battle.fx('teleport', { x: unit.x, y: unit.y, id: unit.id, fromX, fromY });
        battle.spawnToken(unit, MONSTR_TOKEN, home.tok.r, home.tok.c);
      },
    },
    talents: [
      { install(battle, unit) { // 自我修复
        const aura = () => {
          if (!on(unit)) return;
          const tk = prostOf(battle, unit);
          if (tk) {
            for (const a of battle.allyUnits) {
              if (!on(a) || a === tk || !neighbors(a, tk)) continue;
              battle.addBuff(a, { key: 'monstr:prost', duration: 1.5, refresh: 'extend', mods: { atkPct: auraAtk }, tags: ['talent'] });
            }
          }
          battle.after(1, aura, { owner: unit });
        };
        aura();
        // 重构体 受到自身和Mon3tr治疗时，可额外进行一次不会衰减的治疗跳跃
        battle.on('heal', (c) => {
          if (!(num(c.amount) > 0) || c.opts?.regen) return;
          if (c.source !== unit && c.source !== prostOf(battle, unit)) return;
          const tk = prostOf(battle, unit);
          if (!tk || c.target !== tk || unit.mem.monstrJumping) return;
          const ally = battle.allyUnits
            .filter((a) => on(a) && a !== c.target && a.hp < a.s.maxHp - 1e-6 && neighbors(a, tk))
            .sort((a, b) => a.hp / a.s.maxHp - b.hp / b.s.maxHp)[0];
          if (!ally) return;
          unit.mem.monstrJumping = true;
          try { battle.heal(c.source, ally, num(c.amount), { tags: ['talent', 'monstr'] }); } finally { unit.mem.monstrJumping = false; }
        }, { owner: unit, priority: 20 });
      } },
      { install(battle, unit) { // 战术协同
        battle.on('heal', (c) => {
          if (!(num(c.amount) > 0) || c.opts?.regen) return;
          const tk = prostOf(battle, unit);
          if (c.source !== unit && !(tk && c.source === tk)) return;
          const buff = { key: 'monstr:coord', duration: num(t1.buff_duration, 10), refresh: 'extend', mods: { aspd: num(t1.attack_speed, 20) }, tags: ['talent'] };
          if (on(c.target)) battle.addBuff(c.target, buff);
          if (c.source !== c.target && on(c.source)) battle.addBuff(c.source, { ...buff });
        }, { owner: unit, priority: 10 });
      } },
    ],
    install(battle, unit) { // 策略：熔毁 — 受到致命伤害时返回初始位置
      // PRTS 重构体 备注: "Mon3tr因移动之外的原因退场时强制撤退场上的重构体" — knocked out or withdrawn (the
      // 熔毁 【移动】 is a moveRedeploy, not a death, and it withdraws the 重构体 itself in onStart)
      battle.on('death', (c) => {
        if (c.unit !== unit) return;
        const tk = prostOf(battle, unit);
        if (tk) battle.retreat(tk, { reason: 'expired', permanent: true });
      }, { owner: unit });
      // "场上不存在重构体时技能不能开启" (the client's skchr_monstr_3 `_onlyAvailableWhenTokenValid`, and the same
      // guard as the official Mon3tr's kit — kits/ops/op-monstr.js): EVERY activation path is refused while no 重构体
      // stands. Without it the skill auto-fires as soon as 技力 is full (its rule is DEFAULT and her 精一 record's
      // DEFAULT skill IS 熔毁), and 熔毁 makes her a true-damage attacker that no longer heals — which is exactly what
      // the owner saw as 「Mon3tr 不放重构体不会治疗干员」(report 2026-10-08).
      const sk = unit.skill;
      if (sk && sk.id === 'skchr_monstr_3' && !Object.prototype.hasOwnProperty.call(sk, 'activate')) {
        const activate = sk.activate;
        Object.defineProperty(sk, 'activate', {
          configurable: true, writable: true, enumerable: false,
          value(reason, opts) { return prostOf(battle, unit) ? activate.call(this, reason, opts) : false; },
        });
      }
      // A lethal blow while the skill runs does not knock it out: it returns home (the skill's own onEnd does the
      // 【返回】 + puts a fresh 重构体 back) and its HP is restored [ASSUMED]. Priority PRIO_REVIVE: a 坚固维式重锤
      // 不死 window (−99, holdsUndying) runs first and is not consumed, so a held Mon3tr never returns (the same
      // "持有不死的情况下不会触发" reading as 史尔特尔's 余烬), while 埃芒加德 / M3茧甲 (below it) step aside.
      battle.on('fatal', (c) => {
        if (c.unit !== unit || c.prevented) return;
        if (!unit.skill || !unit.skill.active) return; // the 【返回】 line belongs to the skill
        c.prevented = true;
        battle.heal(unit, unit, unit.s.maxHp, { self: true, ignoreHealFree: true, silent: true });
        unit.skill.end('fatal');
      }, { owner: unit, priority: PRIO_REVIVE });
    },
  };
}
