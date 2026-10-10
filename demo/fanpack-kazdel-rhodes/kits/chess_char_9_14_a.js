// kits/chess_char_9_14_a.js — 阿米娅（T3 核心术师）。原件 `kits/custom.js` 第 918-944 行逐字搬来。

import { COLS, ROWS } from '@sim/constants.js';

import { num, mods, talentBb } from './lib/bb.js';
import { on } from './lib/unit.js';
import { configure } from './lib/constants.js';

// 格键算术用的是引擎的 canvas 尺寸（`@sim/constants.js` 的 COLS/ROWS），而 `lib/` 里的辅助文件
// 够不到 `@sim/`（见 `lib/constants.js` 文件头），所以在这里注入一次。
configure({ COLS, ROWS });

// 阿米娅 — T3 核心术师 (corecaster). Trait 攻击造成法术伤害 is the corecaster default — nothing to author.
//   天赋 情绪吸收: every attack of hers refunds `amiya_t_1[atk].sp` (2) 技力, every kill `amiya_t_1[kill].sp` (8).
//   奇美拉 (S3, 30 s): ATK +atk (130 %), max HP +max_hp (50 %), the skill's own (expanded) range and — "伤害类型变为
//     真实" — her attacks land as 真实伤害 (`attack.dmgType`, the same switch Mon3tr's 熔毁 uses). "技能结束后阿米娅
//     强制退出战场": onEnd retreats her — PRTS 史尔特尔 余烬's reading of 强制退出战场 ("视为撤回干员"), so the mode
//     leaves a 倒地干员 on her tile and redeploys her there.
export default function kit(bb, chess, def) {
  const t0 = talentBb(chess, 0);
  const spAtk = num(t0['amiya_t_1[atk].sp']), spKill = num(t0['amiya_t_1[kill].sp']);
  return {
    skill: {
      kind: 'duration',
      mods: mods({ atkPct: num(bb.atk), hpPct: num(bb.max_hp) }),
      targeting: { rangeGrid: def?.skill?.rangeGrid ?? null },
      attack: { dmgType: 'true' },
      onEnd({ battle, unit }) {
        if (on(unit)) battle.retreat(unit, { reason: 'retreat' });
      },
    },
    talents: [
      { install(battle, unit) { // 情绪吸收
        if (spAtk > 0) battle.on('attack', (c) => { if (c.attacker === unit) unit.skill.gainSp(spAtk, 'talent'); }, { owner: unit });
        if (spKill > 0) battle.on('kill', (c) => { if (c.killer === unit) unit.skill.gainSp(spKill, 'talent'); }, { owner: unit });
      } },
    ],
  };
}
