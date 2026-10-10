// server/meta/bonds.mjs — 卡兹戴尔盟约的**准备阶段那一半**（原件 `bonds/custom.js` 的 prep side，291-330 行）：
// 每 `layer` 层发 `count` 件萨卡兹的断角，用玩家级计数器保证「一步只结一次账」，发到手才提示。
//
// 移植时**唯一**的改动是引擎助手的来源：原件 import 引擎内部路径，这里走 `registry.api`（DESIGN §29 —— 包不能把
// 「自己写在哪个目录」写进内容，而 Node 的 ESM 没有 import map）。其余逐句相同，包括数值只从黑板读。
export function registerMeta(registry) {
  const { num, bondRecord, buffParams } = registry.api;
  const KAZDEL = 'kazdelShip';
  const COUNTER = 'fanpack:kazdel:paid';
  const REWARD_HOOKS = ['onLayers', 'onRoundStart', 'onPrepStart', 'onPrepEnd', 'onBuy', 'onGain', 'onSold', 'onMerge'];

  /** 到点了就发；`ctx.grantItem` 的返回值是「真的发到手了」，不是「调用过了」。 */
  function pay(ctx) {
    if (!ctx.bondActive(KAZDEL)) return 0;
    const p = buffParams(ctx.data?.bonds?.[KAZDEL] ?? bondRecord(KAZDEL), 'bond_layer_added_reward_equip');
    const step = Math.floor(num(p?.layer, 0));
    const itemId = typeof p?.reward_item === 'string' && p.reward_item ? p.reward_item : 'chess_item_c_01_e_a';
    if (!(step > 0)) return 0;
    const due = Math.floor(ctx.layers(KAZDEL) / step);
    const count = Math.max(1, Math.floor(num(p.count, 1)));
    let granted = 0;
    for (let guard = 0; guard < 100; guard++) {
      const paid = ctx.counter(COUNTER);
      if (paid >= due) break;
      ctx.setCounter(COUNTER, paid + 1);
      for (let i = 0; i < count; i++) {
        // onPrepEnd 时 grantItem 会先收着，下一个准备阶段开始时合并（effectsMeta 的 _deferItemMerge）
        if (ctx.grantItem(itemId, { source: `bond:${KAZDEL}` })) granted++;
      }
    }
    if (granted && typeof ctx.toast === 'function') ctx.toast(`【卡兹戴尔】获得${granted}件萨卡兹的断角`, 'info');
    return granted;
  }

  const handler = {};
  for (const hook of REWARD_HOOKS) {
    handler[hook] = function kazdelReward(ctx, ev) {
      if (hook === 'onLayers' && !(ev && ev.bondId === KAZDEL)) return;
      pay(ctx);
    };
  }
  registry.bond(KAZDEL, handler);
}
