# 本地用户画像 Tickets（to-tickets）

来源 `docs/user-profile/spec.md`（D1–D13 已确认）。每张票为可独立验证的薄片；实施一律 TDD（纯逻辑测试先行），C 阶段实现循环按主流程执行。

## 依赖边

```
TP-1 ──> TP-2 ──> TP-3
         │  └────> TP-5
         └───────> TP-4
TP-6 blocked by TP-3 + TP-4 + TP-5（收尾）
```

## TP-1 画像状态机（profile-core 纯函数）

- 新增 `src/renderer/core/recommend/profile-core.ts`（无任何 lx 运行时依赖，vitest 直测）：
  - 信号类型与 `reduceProfileSignal`：loves/completes/skips 计数 + 滚动事件缓冲（≤500 FIFO）+ 艺人表按计数权重 Top200 截断；计数器单调归一（垃圾值不污染）。
  - `isCompleteListen(playedSec, durationSec)`：≥90% 为 true；时长未知（0/非有限数）恒 false。
  - `decideEndorsement(会话推荐曲目集, 信号) → 艺人 | null`：仅正向信号、仅推荐集命中（id 或 sameSong 同曲变体）时返回艺人。
  - `localBonus(状态, 艺人) → [-10, +10]`：loves 重、completes 轻、skips 负（权重系数为 Implementation，藏模块内）。
  - `summaryDue(状态)`：`(loves + completes) - summary.basedOnCount >= 20`。
  - `buildSummaryPrompt(状态) → 摘要消息`（纯构建器，内部取 Top50 艺人计数与近 100 条事件；提示词侧限定"只正向描述偏好、不含指令式措辞"，摘要落盘前 ≤200 字截断，D12）。
  - `hydrateProfile(快照)` 宽松水合（沿用 hydrateMetrics 口径：有效字段保留、垃圾字段缺省）。
- 验证：全部 vitest（含边界：截断恒成立、水合垃圾容错、90% 判定点、同曲变体命中、无摘要时 basedOnCount=0 触发首轮）。
- AC：支撑 AC1–AC6 的谓词级部分。

## TP-2 画像编排（profile.ts + 落盘 + 捕获点）

- 新增 `src/renderer/core/recommend/profile.ts`（**不 import session**；全部事件处理器内部 try/catch 兜底不外抛，B7-m6）：
  - 常驻 `window.app_event` 订阅 `musicToggled`/`play`/`pause`/`playerLoadeddata`（订阅方式与 session.ts:520-531 同源）：自有 play/pause/trackEnd 时长累计器（复用 session-core 导出的 `accumulatePlayTime/readPlayedMs`）；**时长快照锚定 `playerLoadeddata`**（`setPlayMusicInfo` 先 `setProgress(0,0)` 后派发 `musicToggled`，切歌点 `maxPlayTime` 恒为 0，不可作快照点，D9/B7-C1）。
  - 切歌结算：`isCompleteListen(播放秒, 时长快照)` 为真 → completes 信号；事件经 `onProfileSignal` 注册表对外广播。推荐曲跳过的 skips 信号**不在本票判定**——由 TP-3 session 侧经 `recordRecommendedSkip(艺人/曲目)` 主动入口回注（D11）。
  - 收藏捕获：挂钩在 `listManage/action.ts` 的 `listMusicAdd` **内部去重后仍有实际新增**且 `id == loveList.id` 处（`listMusicMove` 委托 `listMusicAdd` 自动覆盖 move-into-love；sync 合入计入；整单恢复 `overwriteMusicList` 路径不触发，D13）；通知经 `window.app_event` 新桥（AppEvent 增 `loveListMusicsAdded` 发射方法，携带实际新增 musicInfos），profile.ts 订阅——双方零新增 import 边。
  - 挂载点 `core/useApp/index.ts` 且**先于 useDataInit 完成注册**（沿用 `initRecommendRadio` 先例；不注册则开启电台外的收听不累计——本票即负责常驻）。
  - `data.ts` 新增 `recommendProfile` 读写对 + 键注册（沿用 recommendMetrics 先例）；启动水合一次，事件直写落盘（量级小，不节流）。
  - dev hook `__lxRecommend` 增 `profile()` 只读快照。
- 验证：类型检查 + lint + 构建；冒烟 = 收藏一首歌（含重复收藏同一首验证不重复计数）、完整播完一首歌 → data.json `recommendProfile` 计数可见；重启后续增。
- AC：AC1（画像部分）、AC2、AC3（回注通道）、AC6、AC8。Blocked by TP-1。

## TP-3 背书即时入 run

- `session.ts` 订阅 profile 信号广播：`decideEndorsement(本会话推荐集, 信号)` 命中 → `applyFeedbackCore(状态, 'good', 艺人)` 等价转移 + 触发续补；**不发 far/good 指标事件**（D5：显式反馈口径不变）；非命中信号 session 不动作。
- `session.ts` 切歌结算（`emitSongChangeMetrics` 同源点）：`lastSongRecommended` 为真且播放 <30s → 调 `recordRecommendedSkip` 回注画像 skips 信号（D11；判定材料 session 本地现成，profile 无感知）。
- dev hook 增只读 `session()` 快照出口（复用 `sessionView`，挂在既有 `__lxRecommend` 对象上；B7-M4，冒烟与调试依赖）。
- 验证：单测沿用 TP-1 谓词；冒烟 = 开电台 → 红心稍后播放队里一首推荐歌 → `__lxRecommend.session()` 可见该艺人进 positiveArtists 且触发一次续补；完整听完一首推荐歌同效。
- AC：AC1（run 部分）、AC3（判定部分）。Blocked by TP-2。

## TP-4 画像参与排序

- `engine.ts`：`ExploreOptions` 增可选 `profileBoost: (艺人) => number` 与 `profileSummary: string`；localRank 打分叠加 `profileBoost(t.artist)` 后照常 clamp [0,100]；`profileSummary` **仅在 aiRank 内**拼入 `buildRankingPrompt` 的 instruction 入参文本（"用户长期画像：…"），stateWords 及其机器解析面（effectiveExcludes/parseSessionConstraints/wantsInstrumental/transformationAllowed）**零接触**（D6/B7-R3：摘要散文可能含"器乐/轻音乐"等体裁词，走 instruction 注入会翻转器乐硬门）。
- `session.ts`：`buildExploreOptions` 闭包注入画像 `localBonus`、从画像状态透传 `profileSummary`（有才传）——`prompts.ts` 零改动。
- 验证：单测沿用 TP-1（localBonus 边界、clamp 不变式由 engine 既有结构保证）；通道隔离不变式 = 既有 gates/judgment/vocalGate 单测全绿 + review 核对摘要不在 stateWords 拼接链；冒烟 = 本地档下列表中画像正分艺人排序前移可观察（dev hook 快照对比）。
- AC：AC4（本地档加分 + AI 档摘要通道）、AC8。Blocked by TP-1、TP-2。

## TP-5 LLM 增量摘要

- `profile.ts`：`summaryDue` 命中且 `appSetting['ai.enable']` 且有 Key → fire-and-forget 调 `llmComplete`（复用 session.ts `buildAiConfig` 口径）；**在途单飞守卫**（正在重写时不再触发，参照 session.ts `refillFlight` 先例；B7-m2）；输入 = Top50 计数 + 近 100 条事件（`buildSummaryPrompt`）；失败保留旧摘要并 `console.warn`；成功落盘摘要文本 + `basedOnCount = loves + completes`。
- 验证：单测沿用 TP-1（summaryDue/构建器）；冒烟 = 参照 `e2e/ai.js` 的 `startMockLlm` 假 LLM 先例（`e2e/mockLlm.js`）塞 20 个正向信号 → 摘要落盘且 `basedOnCount` 前移；无 Key 路径确认零调用。
- AC：AC5。Blocked by TP-2。

## TP-6 收尾与文档一致性

- `docs/explore-radio/spec.md` 的 D4 及非目标"任何形式的红心正偏好"条款加"已被 `docs/user-profile/spec.md` 取代（ADR 0002）"注记；CONTEXT.md / ADR 0002 终检无遗漏。
- `e2e/radio.js` 全量重跑确认不回归（重点 R11"重启页面无脚本错误"——profile 常驻订阅是新增异常面；B7-m6）；如环境允许，`e2e/ai.js` 同跑确认 mockLlm 面不破。
- `npm run test` / `npm run lint` / `npm run build` 全绿。
- AC：AC7、AC8。Blocked by TP-3、TP-4、TP-5。

## C 阶段完成标准（呼应主流程 §3 D）

六票全部合入且：每张票验收项通过；每轮 code-review 双轴审核 + 修复后双段审核无 block/critic/major；最终 `npm run build`、`npm run lint`、`npm run test`（含既有与新增）全绿；`docs/` 下相关文档复查无过时。

---

## 合入后注记（2026-09-14）

**e2e 冒烟发现并修复的缺陷（TP-1/TP-2 收藏捕获链路，探针确诊）：**
- 现象：生产构建 e2e 中收藏一首歌，`myListUpdate(["love"])` 触发但 `recommendProfile` 键始终不落盘、`app_event.loveListMusicsAdded` 从未发射。
- 根因：`rendererListManage.ts` 的 `allMusicList` 懒加载（`getListMusics` 才填充某列表）；`listMusicAdd` 首行 `allMusicList.get(id)` 未命中即早退——用户本次会话从未打开过「我喜欢」页面时，函数在到达 TP-2 挂钩行（去重后发射）之前返回，信号永久丢失（早退路径同样返回 `[id]`，故 `myListUpdate` 正常触发）。
- 修法（两层）：
  - 集成层（action.ts）：`listMusicAdd` 早退分支在 `id == loveList.id` 且原始 `musicInfos` 非空时按原始入参发射 `loveListMusicsAdded`（此刻无列表无法去重）；已加载路径"去重后非空才发射"逻辑与早退返回值语义不变。
  - 纯逻辑（profile-core.ts）：`reduceProfileSignal` 增 love 幂等——同曲（artist+title，sameSong 口径，与 id 无关）的 love 已存在于 ≤500 滚动事件缓冲时不动作（返回原状态引用：总计数/艺人计数/事件均不增）；complete/skip 不受限（重复听完/跳过是合法的重复证据）；旧 love 被 FIFO 淘汰出窗口后再收藏恢复计入。该幂等同时兜底重复收藏与取消后再收藏（D13 口径补充：窗口内不重复计）。
- 测试：profile-core.test.ts 新增 5 例（重复同曲幂等、变体写法幂等、不同歌正常计入、FIFO 窗口恢复计入、complete/skip 不受限）；既有 49 例零断言调整。
- 文档：spec.md D10 行与边界收藏捕获点条已同步补充两层口径。

**TP-6 验证记录（2026-09-14）：**
- `e2e/radio.js` 两次全量实跑 12/12 PASS（第二次在 listManage 修复后，覆盖 R11"重启页面无脚本错误"异常面）。
- `e2e/ai.js` 未执行：`e2e/README.md` 已声明其 T-B1/T-B2 断言过时不可作回归依据（适配单独立项）；本分支 `e2e/` 目录零改动（mockLlm 面未触碰，`git diff d0368787..HEAD -- e2e/` 为空）。
- 画像集成冒烟（一次性脚本，未提交）：生产构建 + 临时 profile：`player_music_love` 快捷键收藏播放中歌曲两次 → `data.json` 的 `recommendProfile` = loves 1（重复收藏幂等生效）、artistCounts 含该艺人 love+1、events 恰一条 love、summary 未达阈值矜持 null；全程无页面脚本错误。
- `docs/explore-radio/spec.md` D4/非目标注记、ADR 0001 superseded 指针均已补齐。

**整分支终审后复核修复（2026-09-14，4 minor + 1 修复残留）：**
- 短曲双计互斥：session `recordRecommendedSkip` 回注携带 `playedSeconds`；profile 入口先以 `isCompleteListen(playedSeconds, lastSettledDurationSec)` 否决——时长取本层自存的"上一首时长"（playerLoadeddata 锚定、不随切歌清零），与两模块 musicToggled 订阅的执行顺序无关；时长未知（0）恒不否决、保守放行（D9 同源口径）。completes 判定仍用 `durationSnapshotSec`。
- 幂等不吞背书：`isDuplicatedLove` 提为导出谓词 `isDuplicateLoveSignal`；`emitSignal` 对被幂等吸收的 love 仍广播背书信号（不落盘不触发摘要），补齐"取消后再收藏本台推荐曲进 positiveArtists 并续补"链路。
- 批量收藏单次落盘：`handleLoveListMusicsAdded` 循环经模块内 `mergeSignal` 归并 + 逐条广播（被吸收 love 同广播），有真实变化才单次落盘 + 单次摘要检查（summaryDue 用归并后最终状态），N 次 save_data 收敛为一次。
- 空曲名不受幂等保护的口径注释补齐（sameSong 空 title 恒否，保守承接边界）。
- 测试：`isDuplicateLoveSignal` 谓词新增 3 例；profile-core 57 例、全量 435 例全绿。
