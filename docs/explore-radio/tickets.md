# 探索电台 Tickets（to-tickets）

来源 `docs/explore-radio/spec.md`（D1–D15 已确认）。每张票为可独立验证的薄片；实施一律 TDD（纯逻辑测试先行），C 阶段实现循环按主流程执行。

## 依赖边

```
TT-1 ─┬─> TT-2 ─┐
      └─> TT-4 ─┴─> TT-5
TT-3 独立，无时序约束（改动面与 TT-1/TT-2 无交集，可并行）
```

## TT-1 电台骨架（端到端薄片）

- 新增 setting key `recommend.radio`（默认关）；播放栏"从此歌出发"按钮演进为电台开/关（开 = 立即以当前歌开台，关 = 清场收台）。
- session-core：状态提升为 run（instruction/radius/正负艺人）+ 单曲会话（锚点/推荐 id/路径）两层；新增纯函数 `decideOnSongChange`（on-path-refill / reanchor / ignore + 清场范围）与收台触发判定。
- session.ts：切歌事件接判定函数执行；**入队统一改队尾**（首计划也不再置顶，含 engine 调用参数与既有 addTempPlayList 用法核对）。
- 收台判定写清规则：同一 run 内连续三次计划最终失败（initial 失败与 refill 重试耗尽均计入，任一计划成功即清零）触发收台；`decideOnSongChange` 的 reanchor 分支永远优先于任何队列清空语义（D13 / B7-C1 裁决）。
- 重锚计划沿用约 1.2 秒防抖吸抖（与续补 REFILL_DEBOUNCE_MS 同量级），防快速连切连发 LLM 调用。
- 重启恢复：`recommend.radio` 持久为开时，应用启动后即建立切歌订阅，首事件定义为首个 `musicToggled`（含启动恢复阶段 useDataInit 经 playList 派发的那一个）；**订阅注册必须先于 useDataInit 完成**，否则首事件会被启动恢复消耗或漏接（D15）。
- 验证：session-core 新增转移全部 vitest；冒烟 = 开电台 → 连续切三首歌（每次切换间隔大于防抖约 1.2 秒 + 一个计划周期）→ 每首一个周期内新台入队尾、旧残留已清；另冒烟重启恢复（AC10）。
- AC：AC1、AC2、AC9、AC10、AC8。

## TT-2 约束作废与 run 沿用完备（D3/D7）

- `analysisStale` 谓词 + session 层在约束变更后的计划不再传 `reuseAnalysis`（engine 接口不变）；`reuseAnalysis` 语义注释同步更新。
- run 继承/收台重置边界用例补齐（关台重开 = 全新 run；批次快照记录新 instruction）。
- 验证：单测（作废谓词、继承矩阵）+ 冒烟 AC3（改约束 → 路径批次快照与召回查询集变化）。
- AC：AC3、AC4、AC8。Blocked by TT-1。

## TT-3 低置信全半径拦截（D5）

- engine.ts 无法被 vitest 加载：低置信判定抽离为独立纯函数模块（参照 vocalGate.ts 先例；judgment/prompts/gates 保持只读），engine aiRank 行级过滤由 `radius <= 45` 才拦改为全半径拦。
- 验证：纯函数新增 vitest（近/中/远三档均拦、非 low 不拦）；冒烟观察空结果文案可接受。
- AC：AC6、AC8。无 blocking 依赖，可与 TT-1/TT-2 并行。

## TT-4 本地指标四计数器（D9/D14）

- session-core：指标事件纯 reducer（songChanged >30s 判定、far/good、run start/end、refill 触发/消费）。
- `data.ts` 新增一对读写（单 JSON，不进设置项）；session 编排层在事件点写入；dev hook `__lxRecommend` 暴露读取。
- 时长判定：30 秒跳过以 play/pause 事件累计的实际播放秒数为准，不取切歌墙钟间隙（参照 feature.ts 对播放事件的订阅先例）。
- 续补消费比口径：同批曲目任一进入已播即记该批被消费一次；指标写盘直写不节流（事件量级小）。
- 验证：reducer 单测（含"暂停不计时长"用例）；冒烟 = 一轮真实使用后重启，dev hook 读数量级正确。
- AC：AC7、AC8。Blocked by TT-1。

## TT-5 设置页开关与收尾（D10 第二入口）

- 设置页新增电台开关（与播放栏同一 `recommend.radio` key，双写单源）；i18n 文案补齐（src/lang 四语言）。
- Explore 页"开始/结束"入口语义对齐：开始 = 开台、结束 = 收台，与播放栏开关同源于 `recommend.radio`。
- 检查前序票遗留文案/快照是否需要同步。
- 验证：播放栏开关 + 设置页开关 + Explore 页入口三处互切状态一致（冒烟）；未配 API Key 开台走本地引擎且页面展示本地模式（AC5）；全量构建 + lint + 既有测试全绿。
- AC：AC5、AC8。Blocked by TT-1，建议收尾执行。

## C 阶段完成标准（呼应主流程 §3 D）

五票全部合入且：每张票验收项通过；每轮 code-review 双轴审核 + 修复后双段审核无 block/critic/major；最终全量构建、lint、vitest（含既有与新增）全绿；`docs/` 下相关文档复查无过时。

---

## 合入后注记（2026-09-13，全部五票完成）

**审核驱动修正（相对票面文字的增量，均为审核发现后的必修）：**
- TT-1：播放栏开关"关"分支补清场（watch 关分支先 `removeTempByIds` 再 `endSession`，与连续失败收台同口径）。
- TT-5：Explore 空态"开始"按钮在电台已为开时置灰（同值写入不触发 watch 的死点击修复；恢复路径 = 切歌自动重开或播放栏开关）。

**遗留 minor（原为各轮审核中确认"可不修复"项；2026-09-13 全部五项已修复，留档说明修法）：**
- `session.ts` 开台序列四步在 `startRadioSession`/`startSession` 间重复（可提取公共函数）。——已修：提取 `openSession(anchor)` 承载公共序列，两入口只留差异（防抖计划 vs 幂等判断 + await 首计划）。
- `session-core.ts` `SongChangeSong` 声明字段中仅 `id` 被 `decideOnSongChange` 消费（可裁剪）。——已修：裁剪为仅 `id`；调用方宽对象经结构类型兼容透传不裁剪，测试零断言改动（另增 1 个 id-only 纯增量用例）。
- TT-4 指标：批次 key 由 (radius, instruction, engine) 派生，稳态连续续补会撞 key 导致旧批次失去归属（消费比失真场景）；需要精确时再给批次身份追加计划序号。——已修：指标登记侧批次 key 追加每 run 单调序号（`${batchKey}#${seq}`，`metricsBatchSeq` 随 openSession 归零、跨重锚延续）；`batchKey` 本身与路径分组语义不变，reducer 不动。
- `ipc.ts`/`data.ts` 通用管道层 `import type` 依赖特性模块（仅类型边，可接受）。——已修：`ipc.ts` 收窄为 `unknown` 透传，类型收口集中在特性门面 `data.ts`。
- 部分文件头覆盖清单注释未随 TT-2/TT-4 增量更新（注释级）。——已修：`session-core.ts` 头部补 TT-4 行、`session-core.test.ts` 头部补 TT-2/TT-4 行。

**修缮复核追加记录（信息级，结论均为接受现状）：**
- 批次序号随 run 归零后，若新旧 run 的批次三元组完全相同，新 run 首个登记会覆盖落盘数据中旧 run 的同 key 批次条目；计数器单调性与"每批至多记一次"口径不受影响，属序号归零方案的固有边界（彻底隔绝需把序号持久化进指标结构，暂不必要）。
- `session.ts` 指标登记处 `registrationKey == null` 兜底实际不可达（批次快照恒为字面量对象），防御式保留。
- `data.ts` 落型处的 `eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion` 经复核批准：lint 的 type 程序走根 tsconfig（路径别名被注释）导致必需断言被误报，真实 tsc 走 `src/renderer/tsconfig.json` 下断言必需；行内豁免 + 注释为最小代价方案。

**范围外警示：** `e2e/e2e.js`、`e2e/deep.js`、`e2e/ai.js` 的 T-B1/T-B2 断言未适配电台语义（定位器与流程预期已过时，详见 `e2e/README.md` 顶部声明），适配单独立项。

**AC 端到端实跑记录（2026-09-13，`e2e/radio.js`，dist 生产构建，12/12 PASS）：**
- 直接通过：AC1（跟歌重锚：切歌→清场→新台入队）、AC5（无 Key 开台走本地引擎，页面显示"本地计划"）、AC9（CDP 断网模拟→连续失败收台→恢复网络切歌自动重开）、AC10（同 profile 重启→零点击自动开台）。
- 弱验证通过：AC3（作废 warn 日志 + 新批次组头携带新约束；召回换道属 AI 模式行为未验）、AC7（不经 dev 钩子，改为 `LxDatas/data.json` 落盘读回，四计数器字段与口径正确）。
- 仍仅单测/评审覆盖：AC2（队尾语义，手动排队前置无稳定 UI 路径）、AC6（低置信拦截，纯谓词单测）。
