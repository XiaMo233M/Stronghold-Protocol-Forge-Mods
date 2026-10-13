# NOTICE-来源说明

## 原件是什么、从哪来

- **原件**：`jingjiangze/stronghold-ws-compression` —— <https://github.com/jingjiangze/stronghold-ws-compression>
  （2026-10-11 建，MIT）。它是从一个在跑的卫戍协议服务端（`jingjiangze/stronghold-master-play`，
  线上 `build a697834a6599`）里抽出来的 WebSocket 链路层。
- **本包是原作者自己做的**，不是第三方拿别人的 mod 改写 —— 所以「原作者」与「改写者」是同一方，
  署名以本包 `pack.json` 的 `author` 为准。没有需要另行保留的原件许可文件。

## 它改了什么

**什么都没改。** 本包是把原件的**事实与自查步骤**搬进一份工坊包，不含任何引擎数据、
不含任何游戏素材、`content: []`、`combat: false`、`layer: C`。
包里只有两样东西：

| 件 | 落点 | 说明 |
|---|---|---|
| `ws-compression.json` | `routes` 声明的 `/data/ws-compression.json` | 三档语义、期望的协商串、阈值为什么是 64、实测数字、自查判定表 |
| `ui/wsCompression.js` | `client.panels` 的 `root.guide` | 把上面那份 JSON 画出来 |

## 做不了的部分（**这一节是重点**）

原件的核心能力是**启用并调优传输层压缩**，而这件事**工坊包做不到**：

1. **包不能启用压缩。** 压缩是 `WebSocketServer({ perMessageDeflate })` 的**启动选项**，
   作用在建连时刻的**扩展协商**上。而包在服务端能声明的只有 `server.preDispatch`
   （拦**入站 C2S 消息**）与 `routes`（只读 `.json`）—— `preDispatch` 拿到消息时握手早已完成，
   deflate 开没开已经定死。**没有任何一种 `pack.json` 写法能打开它。**
2. **包不能注入服务端代码去改它。** `server.modules` 的白名单与装载器不允许，
   且 `.js` 在 `routes` 通道被明确拒绝（那是代码执行面，不是数据面）。
3. **面板读不到实时的协商结果。** 面板拿到的 `ctx` 只有会话态（`ctx.me`），**不含网络层**，
   读不到 `WebSocket` 对象。所以本包**不显示「你现在的协商是 X」** —— 那需要一个它拿不到的值。
   它给的是**判定表 + 去哪看**：开发工具 → Network → 那条 ws → Response Headers →
   `Sec-WebSocket-Extensions`。宁可让玩家自己看一眼，也不给一个可能是错的自信结论。

**所以本包不是「装了就让压缩生效」的包。** 它是一份**可核对的参考与自查工具**；
真正开压缩是运维在服务端改一个环境变量/选项并重启 —— 见原件 README 的「用」一节。

## 已在真机验证（2026-10-11）

原件的这一版（`b.start` 进白名单 + 一词回退开关）**已在线上盒子跑过并逐项验过**：

| 检查 | 结果 |
|---|---|
| 部署 build | `8dc03d15fddc`（契约自检通过后才翻的槽） |
| 协商串 | `permessage-deflate; client_no_context_takeover` —— 两个限制项都没有 |
| 逐帧校验 | 36 帧全部解出，**解析/结构失败 0**；`b.start` / `m.public` / `m.private` 结构完整 |
| 整局逐字节 | **125.3 → 57.5 B/s（−54.1%）**，应用层 70,626 B → 在线 8,610 B（8.20×） |
| 回退开关 | 本机验证：`WS_COMPRESS_EXTRA=none` 下 `b.start` 离开可压列表；线上回退路径 = `ws-extra.txt` 写 `none` + 重启该槽 |

> 离线换算：57.5 B/s/席 → 10 Mbps 约 **21,000 并发**（留 20% 余量约 17,000）。
> 这是**服务端侧**的数字，本包复现不了 —— 它只负责让这些数字可核对。

## 素材从哪来

**没有任何素材。** 没有图标、没有音频、没有字体、没有从游戏里解包的数据导出物。
`css/ws-compression.css` 与 `ui/wsCompression.js` 是本包自带的样式与代码，MIT。

## 许可

本包 `license: MIT`（与原件相同）。《明日方舟》及其素材版权归鹰角网络所有；
本包不含、也不主张任何此类素材。
