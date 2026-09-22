# 本地用户画像 Spec（to-spec：只汇总已确认决定）

2026-09-22 容量策略修正：艺人表仍限制为 200 位，但保留当前产生行为的艺人，其余名额按证据量排序。已淘汰艺人再次出现时，从现有的最近 500 条事件恢复窗口内计数，再累计本次信号；仍在表内的艺人沿用历史累计值。总计数不重复累计，不新增持久化字段。此规则替代下文严格 Top200 的截断口径，避免表满后新艺人永远无法学习；窗口以外的已淘汰记录无法恢复。

2026-09-20 修复更新：摘要确认计数以请求快照为准，时长快照绑定曲目身份，相关编排已增加自动化测试，见 [AI 歌曲推荐审查](../ai-recommendation-review.md)；下文保留原始阶段规格。

来源：2026-09-14 grill-with-docs 两轮裁决（Q1–Q10），决策全文账本见下文 D1–D13；立场反转（红心证据地位、跨会话口味持久）的"为什么"见 `docs/adr/0002-user-profile-behavior-signals.md`；统一词汇见仓库根 `CONTEXT.md`（用户画像 / 行为信号 / 背书 / 红心排除改定义）。

## 目标

把用户的隐式行为固化为**本地用户画像**：收藏（加入「我喜欢」）、听完（自然播放 ≥90% 曲目时长）为正向信号，推荐曲 30 秒内被切走为负向信号；信号增量累计为艺人计数底座（O(1) 更新，不随收藏量增长变慢），有 API Key 时按增量阈值异步生成散文摘要。画像作用于推荐两档：AI 档把摘要拼入排序指令，本地档给画像艺人加分/降分。对本台推荐曲的正向信号（背书）即时作用于当前 run（等同 good 机制）。

## 非目标（明确不做）

- 服务端上报、任何形式的画像同步（延续 D10 无遥测立场，ADR 0002）
- 画像的 UI 管理入口（本期无设置页/展示页改动）
- 跳过即时进 run 级 negativeArtists（Q8=B：跳过只进画像降权）
- 红心歌作为候选重新进入推荐（Q2=A：红心排除语义保留，ADR 0002）
- 指数衰减、流派/年代/语言维度的画像（Q6=A：仅艺人维度 + 滚动事件缓冲）
- 取消收藏的回扣或负向化（正向信号语义 = "发生过背书"，取消不构造负向；B7-C2 补裁）
- 整单恢复/迁移批量写入的信号化（`overwriteMusicList` 路径不产生事件；B7-C2 补裁）
- `prompts.ts`/`judgment.ts`/`gates.ts` 语义改动（T-B0 只读约束延续；摘要经 `profileSummary` 独立通道注入排序提示词，不改模板、不回流 stateWords 机器解析面）
- 新依赖

## 边界

- 新增集中在 `src/renderer/core/recommend/`（新增 `profile-core.ts` 纯函数模块 + `profile.ts` 编排适配器）；存量改动点：`session.ts`（背书接线、画像 `profileSummary`/`profileBoost` 经 `buildExploreOptions` 透传）、`engine.ts`（`ExploreOptions` 增 `profileBoost`/`profileSummary` 两个可选入口：前者供 localRank 加分调用，后者仅在 aiRank 内拼入排序提示词文本）、`src/renderer/store/list/listManage/action.ts`（收藏收口挂钩一处）、`src/renderer/utils/data.ts`（画像落盘读写对）、`ipc.ts`/管道层的键注册。
- 收藏捕获点唯一：`src/renderer/store/list/listManage/action.ts` 的 `listMusicAdd`——渲染端真实落单与按 id 去重的唯一收口（B7-C2 复核：`listMusicMove` 委托 `listMusicAdd` 故 move-into-love 自动覆盖；sync 远端合入同走此函数，本人他端收藏同为证据，**计入**）；通知在其内部去重后仍有实际新增时发出；**列表未加载进内存时（`allMusicList` 懒加载，早退路径）按原始入参发射——此刻无列表无法去重，重复收藏/取消后再收藏的幂等由 profile-core `reduceProfileSignal` 的同曲 love 去重兜底**；通知**必须经 `window.app_event` 事件桥**（AppEvent 增一个发射方法，如 `loveListMusicsAdded`），profile.ts 订阅该事件——window 全局通信，双方零新增 import 边，依赖方向恒为 session → profile 单向（B7-M1/M2 补裁，不以"告警"为降级条件）。
- 听完/跳过捕获独立于电台订阅：profile.ts 自挂常驻 `window.app_event` 订阅（play/pause/musicToggled/playerLoadeddata + 曲首时长快照），不开电台也累计画像；挂载点在 `core/useApp/index.ts` 且**必须先于 useDataInit 完成注册**（沿用 `initRecommendRadio` 先例，否则启动恢复的首个 `musicToggled` 被吞）。
- 背书只响应"对象为本台推荐曲"的正向信号（当前会话 `recommendedIds` 命中，含同曲变体）；其余信号只进画像。推荐曲跳过的归属判定由 **session 侧**完成（其切歌结算已有 on-path 判定结论），经 profile 公开的主动入口回注；profile 不 import session（B7-M1 补裁）。

## 决策总账 D1–D13

| # | 决策 | 来源 |
| --- | --- | --- |
| D1 | 三类行为信号：收藏（重正向）、听完（轻正向，≥90% 时长）、推荐曲 30 秒内切走（负向） | Q3+Q8 |
| D2 | 本地底座仅艺人维度计数 + 滚动事件缓冲（≤500 条）+ 艺人表 Top200 截断；不做指数衰减 | Q6+Q10 |
| D3 | 画像加分双向（正向封顶 +10、负向至多 -10），具体权重系数藏进 profile-core 实现 | Q5+Q8 |
| D4 | 红心歌不重新进候选（红心排除保留）；收藏行为构成画像正向证据 | Q2 |
| D5 | 背书即时作用于 run：推荐曲正向信号 → 艺人进 positiveArtists + 触发一次续补；**不产生 far/good 指标事件** | Q4+Q9 |
| D6 | AI 档注入方式 = engine `ExploreOptions.profileSummary` **独立通道**：摘要仅拼接进 aiRank 的排序提示词文本，**不进入 stateWords**（从而不经 `effectiveExcludes`/`parseSessionConstraints`/`wantsInstrumental`/`transformationAllowed` 等任何机器解析面）；prompts.ts 零改动；无摘要不传 | Q1+Q5 + B7-R3 补裁 |
| D7 | LLM 摘要：每累计 ≥20 个新正向事件 fire-and-forget 重写一次；输入 = Top50 艺人计数 + 最近 100 条事件；无 Key 不调用；失败保留旧摘要；成功落盘 `basedOnCount` | Q7 |
| D8 | 存储：`data.json` 新增 `recommendProfile` 键，走 data.ts 读写对 + 宽松水合（沿用 recommendMetrics 先例） | Q10 |
| D9 | 听完判定：切歌结算点比较 play/pause 累计秒数与**曲首时长快照**；快照锚定 `playerLoadeddata` 事件（`setPlayMusicInfo` 先 `setProgress(0,0)` 后派发 `musicToggled`，切歌点 `maxPlayTime` 恒已被清零，不可作快照点）；元数据加载前被切走的曲目时长未知，保守不判定 | Q3 + B7-C1 补裁 |
| D10 | 收藏捕获挂钩在 `listMusicAdd` 去重后非空时经 app_event 桥通知（列表未加载进内存时按原始入参发射，此刻无法去重，重复幂等由 profile reducer 的同曲 love 去重兜底）；听完捕获用独立常驻订阅，与 session.ts 指标订阅并存互不依赖 | B7-C2 补裁 |
| D11 | 依赖方向恒为 session → profile 单向：session 订阅 profile 信号广播完成背书判定，推荐曲跳过由 session 结算后回注；profile 不 import session；收藏通知走 `window.app_event` 桥（零 import 边） | B7-M1/M2 补裁 |
| D12 | 摘要文本约束：`buildSummaryPrompt` 提示词侧限定"只正向描述偏好、不含指令式措辞"，输出落盘前按 ≤200 字截断；**不设词表消毒**——注入通道已与全部机器解析面隔离（D6），词表防护无意义且是对解析器触发词的打地鼠 | B7-M3 补裁，B7-R3 修订 |
| D13 | 取消收藏不回扣计数、不产生负向信号；整单恢复/迁移不产生信号；sync 远端合入的收藏计入 | B7-C2 补裁 |

## 模块设计（codebase-design 词汇）

- **深模块：画像状态机（profile-core.ts）**。接口收敛为一组纯函数：信号归并 `reduceProfileSignal(状态, 信号)`、`isCompleteListen(播放秒, 时长秒)` 谓词、`decideEndorsement(会话推荐曲目集, 信号) → 艺人 | null`、`localBonus(状态, 艺人) → [-10, +10]`、`summaryDue(状态) → bool`、`buildSummaryPrompt(Top艺人, 事件) → 消息`、`hydrateProfile(快照)`。实现里藏住：权重公式、Top200 截断、500 条滚动窗口、计数归一。接口即测试面，vitest 直测。
- **适配器：profile.ts**。常驻 `app_event` 播放事件订阅（自有时长累计器；`playerLoadeddata` 点快照 `maxPlayTime`）、收藏事件桥订阅、`onProfileSignal` 信号广播注册表（供 session.ts 订阅）、`recordRecommendedSkip` 主动入口（session 回注用）、LLM 摘要异步调度（在途单飞 + 失败保旧）、落盘水合；不含判定逻辑，不 import session。
- **适配器：session.ts 增量**。订阅画像信号广播，`decideEndorsement(本会话推荐集, 信号)` 命中 → 走既有 `applyFeedbackCore(状态, 'good', 艺人)` 等价转移 + 续补（不发指标）；切歌结算点推荐曲 <30s 经 `recordRecommendedSkip` 回注画像；`buildExploreOptions` 经 `profileSummary` 独立通道透传画像摘要（不拼会话级 instruction/stateWords，仅在 aiRank 调用点拼入排序提示词文本，D6/D12）、闭包注入 `localBonus`。
- **适配器：engine.ts 增量**。`ExploreOptions` 增可选 `profileBoost: (艺人) => number`（localRank 打分叠加后照常 clamp 到 [0,100]）与 `profileSummary: string`（仅 aiRank 内拼入排序提示词文本，stateWords 机器解析面零接触）；其余不动。

## Test Seams

- profile-core 全部纯函数经 vitest（沿用仓库模式：不启动框架）。
- `isCompleteListen`/`decideEndorsement`/`localBonus`/`summaryDue`/`buildSummaryPrompt` 谓词与构建器为独立测试面（endorse 命中含同曲变体）。
- 注入通道隔离不变式（摘要不回流 stateWords 机器解析面）由既有 gates/judgment/vocalGate 单测全绿 + code-review 结构核对保证（engine 为集成层，vitest 不直测）。
- profile.ts / session.ts / engine.ts 编排与接线为集成层：vitest 不覆盖，验证 = 类型检查 + lint + 全量构建 + 冒烟（dev hook `__lxRecommend` 增 profile 只读快照；LLM 摘要冒烟复用 `e2e/mockLlm.js` 假 LLM）。

## 验收标准（AC）

- AC1（收藏）：收藏任意歌 → 画像 loves+1 并落盘；收藏本台推荐歌 → 当前 run 该艺人进 positiveArtists 且触发一次续补；收藏非推荐歌 → run 不动。（单测 decideEndorsement + 冒烟）
- AC2（听完）：播放 ≥90% 时长 → 画像 completes+1；<90% 不入；时长未知不入。（单测 + 冒烟）
- AC3（跳过）：推荐曲 30 秒内被切走 → 画像 skips+1；非推荐曲跳过不入。（单测 + 冒烟）
- AC4（排序）：本地档中画像正分艺人候选加分（封顶 +10）、跳过多的艺人降分（下限 -10）；aiScore clamp [0,100] 不变式保持；AI 档摘要经独立通道注入排序提示词，instruction/stateWords 机器解析面（`exclusionHit`/语言硬门/器乐门/格式门）行为零变化（既有 gates/judgment/vocalGate 单测全绿为证）。（单测 localBonus/buildSummaryPrompt + code-review 结构核对摘要不在 stateWords 拼接链 + 冒烟）
- AC5（摘要）：累计 ≥20 新正向事件触发一次重写；输入口径为 Top50+近 100 条；无 Key 不发起调用；失败保留旧摘要、`basedOnCount` 不前移。（单测谓词/构建器 + mockLlm 冒烟）
- AC6（持久与容量）：画像落盘 `recommendProfile` 键，重启水合后计数延续；艺人表 ≤200、事件缓冲 ≤500 恒成立。（单测 + dev hook 读回）
- AC7（红心排除不变）：已收藏歌仍不出现在候选池（沿用 buildCandidatePool 既有测试语义，新增画像后不回退）。（单测）
- AC8（回归）：既有 vitest 全绿 + 新增用例全绿；`npm run lint`、`npm run build` 通过；`e2e/radio.js` 冒烟不回归。

## 剩余风险

- **时长未知曲目漏记**：元数据加载（`playerLoadeddata`）前被切走的曲目时长未知，completes 保守不判定（D9，宁缺毋滥）。
- **队列末曲/单曲循环的 completes 缺口**：`setPlayMusicInfo(null)` 不派发 `musicToggled`，队列播尽或停止时末曲无人结算；与既有 metrics 指标的缺口同口径，接受（B7-m3 采录）。
- **背书时点**：背书判定以信号到达时的活跃会话推荐集为准；重锚/收台清空推荐集后到达的旧曲信号不再构成背书（含约 1.2s 重锚防抖窗口），只进画像（B7-m1 采录）。
- **双订阅并存**：profile.ts 的常驻收听订阅与 session.ts 的指标订阅各自持有一个时长累计器，事件同源（play/pause/musicToggled）互不影响；冒烟需覆盖两路共存（开电台 + 收藏 + 听完整流程）。
- **背书与显式反馈叠加**：同曲先收藏后按 far 时正负艺人同存，行为与既有显式反馈一致（ADR 0002 已记录接受）。
- **处理器异常面**：profile 全部事件处理器必须内部 try/catch 兜底不向外抛错（`e2e/radio.js` R11 与 `e2e/ai.js` 的"无脚本错误"断言直接暴露此面；B7-m6 采录）。
- **摘要成本**：阈值内上调即放大 LLM 调用频次，延续无额度闸立场自担；无 Key 路径零成本。

## B4 结论（prototype 判定）

不做一次性原型。状态模型与既有 metrics reducer（session-core TT-4）完全同构，水合/落盘有 recommendMetrics 先例，挂钩点与注入点均已核实；没有"没底"到需要原型回答的问题。

## 验证命令

`npm run test`（vitest 全量）、`npm run lint`、`npm run build`（全量构建）；冒烟参照 `e2e/ai.js` 的 `startMockLlm` 假 LLM 先例（`e2e/mockLlm.js`）与 `e2e/radio.js` 的生产构建 + CDP 模式。
