// server/battle/bonds.mjs — 卡兹戴尔（kazdelShip）与罗德岛（rhodesShip）两条盟约的**战斗那一半**，
// 以及它们四件盟约装备的联动。逐句移植自本包原件的 `server/sim/content/bonds/custom.js`（330 行），
// 只改「怎么拿到引擎助手」：原件 import 引擎内部的相对路径，这里走包接口白名单 `@battle/index.js`（同一批函数）。
//
// 数值一律从包自己的黑板读（`buffParams(bondRecord(id), 'env_gbuff_new')`，装备的条件值读
// `act2autochess_equip_custom_*`），**不写任何字面量** —— 与原件的头部注同一条纪律。
//
//   卡兹戴尔  成员对处于 眩晕 / 停顿 / 束缚 / 不动 的敌人增伤（`hit` 上的 `dmg.mul`）；
//             6 名不同成员时全员 +攻速，且攻击额外携带 真实伤害；
//             准备阶段每 `layer` 层发一件萨卡兹的断角（那一半在 server/meta/bonds.mjs）。
//   罗德岛    成员 攻击力 / 生命上限 随层数直接乘算；6 名不同成员时全员 受治疗量×、每 N 秒回 SP、
//             生命回复速度、以及元素损伤的削减。
//   装备      提卡兹之根（盟约成员额外攻速/攻击）、断角连击（两件同装时对受控敌每秒真伤）、
//             抑制环（元素损伤减轻）、源石弧（受伤减轻 + 全队属性共享）、M3利爪 + M3茧甲（攻击附带真伤）。
import {
  num, bondRecord, buffParams, buffsOf, bondActive, bondTier, bondLayers, isMember, onField, playerOps,
  itemsOf, itemKeyOf, hasItemKey, passiveBuff, directMods, fxOn, itemRecord, battleStore,
} from '@battle/index.js';
import { ELEMENT_GAUGE_MAX } from '@sim/constants.js';

const KAZDEL = 'kazdelShip';
const RHODES = 'rhodesShip';
const EYE_KEY = 'chess_item_c_02_e';
const HORN_KEY = 'chess_item_c_01_e';
const RING_KEY = 'chess_item_c_03_e';
const ARC_KEY = 'chess_item_c_04_e';
const CLAW_KEY = 'chess_item_c_05_e';      // M3利爪（本包）
const CARAPACE_KEY = 'chess_item_4_12_e';  // M3茧甲 / M3护甲（官方）
const COMBO_DPS_SCALE = 0.2;               // 断角连击：每秒 20% 攻击力（原件的设计数值）
const POLL = 0.25;                         // 源石弧「全队属性」的重算间隔（秒）

/** 一条盟约的黑板 `{ ...bb, ...bbStr }`（只有数值），读不到就是 {}。 */
const bbOf = (id) => buffParams(bondRecord(id), 'env_gbuff_new') ?? {};

/** 某件装备上 `bbStr.key` 为 `key` 的那条 buff 的参数。 */
function itemParams(itemId, key) {
  const rec = itemRecord(itemId);
  if (!rec) return null;
  for (const b of buffsOf(rec)) if (b.bbKey === key) return b.p;
  return null;
}

/** `u` 身上某一族装备的实际 id（不分品质），没有则 null。 */
const itemIdOf = (u, key) => itemsOf(u).find((x) => itemKeyOf(x) === key) ?? null;

/**
 * 敌人处于 眩晕 / 停顿 / 束缚 / 不动（任一）。
 * 「不动」是**移动状态**而不是 buff：被阻挡 / 没在移动 / 移速为 0 / flags.noMove —— 与原件同一个判据。
 */
function controlled(t) {
  if (!t) return false;
  const f = (t.s && t.s.flags) || {};
  if (f.stun || f.bind || f.immobile || f.rooted) return true;
  if (t.blockedBy || t.moving === false || !(t.s && t.s.moveSpeed > 0) || f.noMove) return true;
  return !!(t.findBuff && (t.findBuff('stun') || t.findBuff('sluggish') || t.findBuff('bind') || t.findBuff('immobile')));
}

const isEnemy = (t) => !!t && t.side === 'enemy' && t.alive;
const tagged = (dmg, tag) => !!(dmg && Array.isArray(dmg.tags) && dmg.tags.includes(tag));

/** 这个玩家凑够了 `cnt` 名不同成员（先看人数，再看阈值下标）——与官方 bonds/core.js 的 reached 同一条。 */
function reachedCount(battle, pid, bondId, cnt) {
  const st = battle.getPlayer(pid)?.bonds?.[bondId];
  if (!st || !st.active) return false;
  const need = num(cnt, 0);
  if (!(need > 0)) return true;
  if (num(st.count, 0) >= need) return true;
  const th = bondRecord(bondId)?.thresholds;
  const idx = Array.isArray(th) ? th.indexOf(need) : -1;
  return idx >= 0 && num(st.tier, 0) >= idx + 1;
}

export function install(battle) {
  if (!battle || !Array.isArray(battle.players)) return;
  // 幂等：这个模块只该被调用一次（server/sim/content/index.js 每场一次），但重复调用不该让每个 `battle.on` 挂两遍。
  const guard = battleStore(battle, 'fanpack:bonds', () => ({ installed: false }));
  if (guard.installed) return;
  guard.installed = true;

  for (const p of battle.players) {
    const pid = p.playerId;
    const kazdel = bondActive(battle, pid, KAZDEL);
    const rhodes = bondActive(battle, pid, RHODES);
    // 装备那几条腿是独立于盟约的（只看装备），所以这一圈照跑，每条腿自己判条件。
    const ops = playerOps(battle, pid);

    // ---- 卡兹戴尔 ----------------------------------------------------------------------------------------------
    if (kazdel) {
      const bb = bbOf(KAZDEL);
      const members = ops.filter((u) => isMember(battle, u, KAZDEL));
      const L = () => bondLayers(battle, pid, KAZDEL);
      const six = bondTier(battle, pid, KAZDEL) >= 2 || reachedCount(battle, pid, KAZDEL, bb.power_bond_char_cnt);

      // 一层：对受控敌人的增伤（条件伤害 → `hit` 上的倍率）
      if (members.length) {
        const memberSet = new Set(members);
        battle.on('hit', (c) => {
          const s = c.source, t = c.target, dmg = c.dmg;
          if (!s || !memberSet.has(s) || !dmg || dmg.sourceless || tagged(dmg, `bond:${KAZDEL}`)) return;
          if (!isEnemy(t) || !controlled(t)) return;
          const bonus = num(bb.base_damage_scale) + num(bb.damage_scale_per_stack) * L();
          if (bonus > 0) dmg.mul *= 1 + bonus;
        });
      }

      // 二层（6 名不同成员）：全员 +攻速，攻击额外带真实伤害
      if (six && members.length) {
        const aspd = num(bb.bonus_attack_speed);
        const scale = num(bb.true_damage_scale);
        const memberSet = new Set(members);
        for (const u of members) if (aspd > 0) passiveBuff(battle, u, `bond:${KAZDEL}:aspd`, { aspd });
        if (scale > 0) {
          battle.on('damaged', (c) => {
            const s = c.source, t = c.target, dmg = c.dmg;
            if (!s || !memberSet.has(s) || !dmg || !dmg.isAttack || !isEnemy(t)) return;
            if (tagged(dmg, `bond:${KAZDEL}`)) return;
            battle.dealDamage(s, t, { amount: scale * s.s.atk, type: 'true', canDodge: false, tags: [`bond:${KAZDEL}`] });
          });
        }
      }
    }

    // ---- 罗德岛 ------------------------------------------------------------------------------------------------
    if (rhodes) {
      const bb = bbOf(RHODES);
      const members = ops.filter((u) => isMember(battle, u, RHODES));
      const live = () => {
        const L = bondLayers(battle, pid, RHODES);
        const mods = directMods({
          atk: num(bb.base_atk) + num(bb.atk_per_stack) * L,
          hp: num(bb.base_max_hp) + num(bb.max_hp_per_stack) * L,
        });
        for (const u of members) passiveBuff(battle, u, `bond:${RHODES}`, mods);
      };
      if (members.length) {
        live();
        battle.on('layerGain', (c) => {
          if (c && c.playerId === pid && c.bondId === RHODES) battle.after(0, live);
        });
      }
      const six = bondTier(battle, pid, RHODES) >= 2 || reachedCount(battle, pid, RHODES, bb.power_bond_char_cnt);
      if (six && members.length) {
        const healMul = 1 + num(bb.heal_scale);
        for (const u of members) if (healMul !== 1) passiveBuff(battle, u, `bond:${RHODES}:heal`, { healingTakenMul: healMul });
        const spIv = num(bb.sp_interval, 2), spN = num(bb.sp_per_interval, 1);
        if (spIv > 0 && spN > 0) {
          battle.every(spIv, () => {
            for (const u of members) if (onField(u) && u.skill) u.skill.gainSp(spN, 'bond');
          });
        }
        const hpPct = num(bb.regen_hp_scale), elPct = num(bb.regen_element_scale);
        // regen_hp_scale 是「生命回复速度」，不是治疗：引擎自己按 hpRegenRatio 跳，治疗加成不放大它、禁疗也停不住它。
        for (const u of members) if (hpPct > 0) passiveBuff(battle, u, `bond:${RHODES}:regen`, { hpRegenRatio: hpPct });
        if (elPct > 0) {
          battle.every(1, () => {
            for (const u of members) if (onField(u)) battle.reduceElement(u, elPct * ELEMENT_GAUGE_MAX);
          });
        }
      }
    }

    // ---- 盟约装备（提卡兹之根 / 断角连击 / 抑制环 / 源石弧 / M3利爪） ----------------------------------------------
    installBondItems(battle, pid, ops);
  }
}

/** 四件盟约装备 + M3 那一对：原件 `installBondItems` 的逐句移植。 */
function installBondItems(battle, pid, ops) {
  const has = (u, key) => hasItemKey(u, key);

  // 提卡兹之根：卡兹戴尔成员的条件加成
  for (const u of ops) {
    if (!has(u, EYE_KEY) || !isMember(battle, u, KAZDEL)) continue;
    const p = itemParams(itemIdOf(u, EYE_KEY), 'act2autochess_equip_custom_kazdel_eye');
    if (!p) continue;
    const mods = directMods({ atk: num(p.atk_scale) });
    const aspd = num(p.attack_speed_scale);
    if (aspd) mods.aspd = aspd;
    passiveBuff(battle, u, `bond:${KAZDEL}:eye`, mods);
  }

  // 断角连击：提卡兹之根 + 萨卡兹的断角 同装 → 每秒对范围内受控敌人造成 20% 攻击力的真实伤害
  for (const u of ops) {
    if (!has(u, EYE_KEY) || !has(u, HORN_KEY) || !isMember(battle, u, KAZDEL)) continue;
    battle.every(1, () => {
      if (!onField(u) || !u.canAct) return;
      const keys = Array.isArray(u.rangeKeys) ? u.rangeKeys : [];
      if (!keys.length) return;
      let hit = 0;
      for (const e of battle.enemiesInKeys(keys, u, u.profile)) {
        if (!isEnemy(e) || !controlled(e)) continue;
        battle.dealDamage(u, e, { amount: COMBO_DPS_SCALE * u.s.atk, type: 'true', canDodge: false, tags: [`bond:${KAZDEL}:combo`] });
        hit++;
      }
      if (hit) fxOn(battle, 'bondProc', u, `bond:${KAZDEL}:combo`, 'dot', { n: hit });
    });
  }

  // 罗德岛抑制环：元素损伤减轻
  for (const u of ops) {
    if (!has(u, RING_KEY)) continue;
    const p = itemParams(itemIdOf(u, RING_KEY), 'act2autochess_equip_custom_rhodes_ring');
    const cut = num(p?.elem_taken);
    if (cut > 0) passiveBuff(battle, u, `bond:${RHODES}:ring`, { elemTakenMul: Math.max(0.05, 1 - cut) });
  }

  // 罗德岛特制源石弧
  for (const u of ops) {
    if (!has(u, ARC_KEY)) continue;
    const id = itemIdOf(u, ARC_KEY);
    const p = itemParams(id, 'act2autochess_equip_custom_rhodes_arc');
    if (!p) continue;
    const taken = num(p.damage_taken);
    if (taken > 0) passiveBuff(battle, u, `bond:${RHODES}:arc:taken`, { dmgTakenMul: Math.max(0.05, 1 - taken) });
    const member = isMember(battle, u, RHODES);
    const share = num(p.field_sum_share);
    // [ASSUMED]「攻击力和生命总和的 X% 加成」= 在场干员 攻击力 / 生命上限 之和的 X%，以固定值给出（原件同一条假设）
    if (member && share > 0) {
      const apply = () => {
        if (!onField(u)) return;
        let atk = 0, hp = 0;
        for (const o of battle.allies()) {
          if (o === u || o.kind !== 'op' || !onField(o)) continue;
          atk += num(o.s.atk); hp += num(o.s.maxHp);
        }
        passiveBuff(battle, u, `bond:${RHODES}:arc:sum`, { atkFlat: share * atk, hpFlat: share * hp });
      };
      apply();
      battle.on('deploy', () => battle.after(0, apply));
      battle.on('death', () => battle.after(0, apply));
      battle.every(POLL, apply);
    }
    // 与抑制环的联动：源石弧的「属性提升效果」（攻击力 / 生命上限 + 受伤减少）共享给全队。
    // 携带者自己已经有受伤减少那一条，所以那一份只发给别人 —— dmgTakenMul 是乘算，自己再来一份会变成 −19% / −36%。
    if (member && has(u, RING_KEY)) {
      const base = itemParams(id, 'attr_common_global_buff');
      const atk = num(base?.atk), hp = num(base?.max_hp);
      if (atk > 0 || hp > 0 || taken > 0) {
        const mods = directMods({ atk, hp });
        const shared = taken > 0 ? { ...mods, dmgTakenMul: Math.max(0.05, 1 - taken) } : mods;
        const apply = () => { for (const o of ops) if (onField(o)) passiveBuff(battle, o, `bond:${RHODES}:arc:share`, o === u ? mods : shared); };
        apply();
        battle.on('battleStart', apply);
        battle.on('deploy', () => battle.after(0, apply));
        battle.every(POLL, apply);
      }
    }
  }

  // M3利爪（本包）+ M3茧甲 / M3护甲（官方）：攻击附带 攻击力 × atk_scale 的真实伤害。只看装备，不看盟约。
  for (const u of ops) {
    if (!has(u, CLAW_KEY) || !has(u, CARAPACE_KEY)) continue;
    const p = itemParams(itemIdOf(u, CLAW_KEY), 'act2autochess_equip_custom_m3_claw');
    const scale = num(p?.atk_scale);
    if (!(scale > 0)) continue;
    battle.on('damaged', (c) => {
      const s = c.source, t = c.target, dmg = c.dmg;
      if (s !== u || !dmg || !dmg.isAttack || !isEnemy(t)) return;
      if (tagged(dmg, 'item:m3claw')) return;
      battle.dealDamage(u, t, { amount: scale * u.s.atk, type: 'true', canDodge: false, tags: ['item:m3claw'] });
    });
  }
}
