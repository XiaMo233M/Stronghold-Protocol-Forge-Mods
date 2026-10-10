// kits/lib/constants.js — 引擎那两个**格键算术**常量在本包里的落点。
//
// 为什么需要这一层：`kits/lib/*.js` **不得**写 `@kit/` / `@sim/`（实测，见 bb.js 文件头与
// `_up/mod-compat/out/probe-libimports.mjs`：辅助文件被 Node 按真实 `file:` URL 原样加载，
// `@sim/...` 没有 import map 可解 ⇒ KIT_IMPORT_FAILED）。所以引擎常量只能由**干员文件**注入 ——
// 干员文件是装载器的入口，那个源文件会被 `rewriteKitImports()` 重写，白名单对它是成立的。
//
// 数值（实测 `server/sim/constants.js`）：
//   COLS = GEO.CANVAS_COLS = 33   ← **canvas stride，不是「棋盘 21 列」**
//   ROWS = GEO.CANVAS_ROWS = 27
// 棋盘本身是 19×21（`FIELD_ROWS` / `FIELD_COLS`），但引擎的格键（`rangeKeySet`、`bodyKeys` 的
// `r * COLS + c`）用的是 canvas 尺寸。把 COLS 当成 21 会让 `inRangeOf` / `bodyInKeys` 整体错位 ——
// 这不是纸面问题：实测把 21 写死时凯尔希的 `kalts:outrange`（"Mon3tr 不在攻击范围内则防御力降至 0"）
// 判罚与原件不同（DEF 403.2 vs 739.2），是 `equiv-all-kits.mjs` 抓出来的。
//
// 默认值取引擎的真值（0 = 还没注入），并由 `test/packFanpackKits.test.js` 钉在引擎当前值上（漂移即红）。

/** 引擎 `@sim/constants.js` 的 `COLS`（canvas 列数）。 @type {number} */
export let COLS = 33;

/** 引擎 `@sim/constants.js` 的 `ROWS`（canvas 行数）。 @type {number} */
export let ROWS = 27;

/**
 * 注入引擎常量。干员文件在模块顶层调用一次：`configure({ COLS, ROWS })`。
 * 只接受正有限数，写错/漏掉时保留默认（默认就是引擎真值，所以漏掉也不会静默错位）。
 * @param {{ COLS?: number, ROWS?: number }} [constants]
 */
export function configure(constants) {
  if (Number.isFinite(constants?.COLS) && constants.COLS > 0) COLS = constants.COLS;
  if (Number.isFinite(constants?.ROWS) && constants.ROWS > 0) ROWS = constants.ROWS;
}
