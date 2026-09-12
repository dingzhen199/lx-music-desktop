# HANDOFF — lx-music-desktop 探索/AI 功能 交接文档

> 写给下一个会话（或本人续测）：本文档自包含，含未落地诉求、已完成工作、待办 Bug 与建议排查路径、运行指南与坑清单。

## 0. 项目与当前状态

- 分支 `fix/dedup-redheart`（本功能全部工作在此，见 §5）；`master` 保持 origin 基线（d5a4cf54），本地无多余中转 commit。
- 变更集：**已全部提交**（含条目 14 的本轮修复，共 5 个新 commit，本地未推送）；工作区只剩 `HANDOFF.md` 未跟踪（本文档自身，一直未提交）。
- **生产构建产物 `dist/` 必须始终是生产构建**：`npm run build:main && npm run build:renderer && npm run build:renderer-lyric && npm run build:renderer-scripts`。当前 dist 为 2026-09-10 重新生成并已验证无 dev 标记（grep `localhost:9080`/`index-dev`/`development` 全 0）。
  - ⚠️ 多次被 dev 构建覆盖（`npm run dev` / runner-dev 会把 dist/main.js 变成 dev 版 → DevTools 窗口 + 加载 localhost:9080 → 白屏/chrome-error、e2e 假失败）。已加防线：`e2e/harness.js` 启动前校验 `dist/main.js` 无 dev 标记——**2026-09-09 又发生一次**：压缩器把 `"development"` 转义成 `\u0064evelopment` 导致旧守卫漏判，harness 已增强为多特征匹配（转义变体 + localhost:9080 + index-dev），当前生产 main.js 已验证零命中。
  - 开发调试请用 `npm run dev`（它自己会编译 dev 产物，改回生产前记得重新 build:main）。
- 音源现状（重要环境事实）：本机对 kw/wy/kg/tx/mg 等的**音频 URL 请求被限流**（播放栏显示"换源失败，请尝试手动在搜索页指定其他来源"）；搜索/歌单/榜单等数据 API 正常。**e2e 中所有"播放/暂停/下一首"类用例（基线、deep、ai、common 各套件的对应步骤）因此偶发 FAIL**——这是外部因素，不是功能 bug；多轮测试后更明显（疑似测试量触发限流，休整后可恢复）。mg/bd SDK 会抛未处理的 "try max num"（重试超限），同样属外部。
- 首次启动流程：许可协议（"接受 (18)" 倒计时按钮，注意不要点成"不接受"）→ 开源声明弹窗（"好的 (OK)"）。e2e 的 `agree()` 已处理。
- **推送约定（用户指示，2026-09-09）**：推送代码前先开新分支（如 `feat/xxx`、`fix/xxx`、`chore/xxx`），避免直接推 master/main；本仓库已装 `.git/hooks/pre-push` 拦截主分支直推（确需时 `git push --no-verify` 绕过）。origin 原本误配为原始仓库 lyswhut/lx-music-desktop，已改为用户自己的 fork：`https://github.com/dingzhen199/lx-music-desktop.git`；如需同步上游可 `git remote add upstream https://github.com/lyswhut/lx-music-desktop.git`。

## 1. 用户诉求（当前流转）

### 诉求 A（✅ 已定位根因并修复，2026-09-09）：探索路径点击"具体的歌"不跳转，而是把"当前被 AI 分析的歌"重新播放
用户原话 3 组：
1. "探索路径的打开点了似乎没用，不会跳转到新歌，而还是需要自己按下一首"；
2. "探索路径点**具体的歌**不会跳转到新歌，而是把**当前被 ai 分析的歌**重新播放了"；
3. （本次）"路径点具体的歌不会跳转到新歌，而是把当前被ai分析的歌重新播放了 此问题仍然存在"。

**根因（已证实，非 AI 特有，与限流无关）**：`playPathItem` 用 `setPlayMusicInfo(null, musicInfo) + play()` 切歌，但
- `setPlayMusicInfo` 只更新播放栏标题/状态并同步触发 `musicToggled`；`usePlayProgress` 的 handler 会执行 `setCurrentTime(0)`——**把当前音频元素 seek 到 0**；
- `play()` 只有 `audio.src` 为空时才取 URL 换源（`isEmpty()`），否则只是 `setPlay()` **续播现有音频**。

于是：播放栏标题已切成点击目标，但音频元素**仍是旧歌的 src，且被 seek 到 0 后继续播放**——"看着新标题重播旧（锚点/AI 分析）歌"，与用户描述逐字吻合。旧歌播完后 `playNext` 弹稍后播放队首——而点击的歌已被 `removeTempPlayList` 移出队列——用户永远听不到点击的歌。**deep.js D3b 一直 PASS 的原因：它只断言标题切换（同步发生），无法发现音频未换**。

**修复**：新增 `core/player/action.ts playMusicInfoNow(musicInfo)`——`setPlayMusicInfo` 后走内部 `handlePlay()`（`setStop` 清空音频 → `setMusicUrl` 取新 URL → `setResource` → autoplay），与 `playList`/`playNext` 的换歌路径一致且保留稍后播放队列（`playList`/`playListById` 依然严禁）。`session.ts playPathItem` 两个分支均已改用。

**已排除的假设（插桩验证）**：
- AI 开启与否无差别（`e2e/ai.js` 新增"AI-路径点击跳播"用例，PASS）；
- 锚点歌**未**漏进候选（recall.ts `sameTrack` 排除正常：锚点 `kw_118987` 枫 不在 path 中，无"标题同锚点未排除"命中）；
- 换源限流下的行为=机制正常：标题先切到目标、URL 拉取失败后 5 秒被自动切歌顶走（判据：标题先切换再被顶走=正常；从未切换=click 未生效）。`pathProbe.js` 已实现该双信号探针（见 §2）。

### 诉求 B（✅ 已实现并验证，2026-09-09）：切歌后点"从此歌出发"应重新做推荐，而不是停留在上次推荐的歌
用户原话："如果歌曲切换了，点击从此歌出发应该重新做推荐，而不是还在上一次推荐的歌上。"
- 现状（已核实）：`session.ts:293` `startSession()` 开头 `if (state.value) return` —— **幂等**：会话存在时点播放栏"从此歌出发"（ControlBtns.handleStartExplore：先 `router.push('/explore')` 再 `startSession()`）只跳页，不重开。用户切歌后再点，仍停留在旧会话/旧推荐——**这就是用户抱怨的行为**。
- 已实现（`session.ts startSession`）：
  - 会话存在且 `currentMusic().id` 与 `state.value.anchor.id` **不同** → 先 `removeTempByIds(st.recommendedIds)` 清掉旧会话入队的歌曲（**保留用户手动入队的稍后播放**）→ `endSession()` → 新建会话（锚点=新当前歌，初始计划重新生成、路径清空）。
  - 相同则维持幂等（不重启，避免误触把当前会话打断）。
  - 只有用户显式点击"从此歌出发"才触发重开判定；切歌/自动续补等内部流程不经过 `startSession`，不会误判重开。
  - Explore 页空态按钮与播放栏按钮共用 `startSession`，语义统一。
- e2e：deep.js 新增 `D2b-锚点相同时再点不重启`（幂等）与 `D7b-切歌后点从此歌出发重开会话`（重开：锚点从旧歌变为点击行歌），均 PASS。

## 2. 已完成工作（均已落地源码 + 验证并提交；分支见 §5）

1. **AI 排序 IPC 4096 拦截**（用户最早"AI 计划从未出现"）：`llmValidate.ts`（纯函数 validateLlmParams，message.content 上限 256_000）+ `recommendation.ts` 调用 + 20 单测。已过审。
2. **AI 测试连接按钮**：`SettingAi.vue`（纯 JS 语法！勿写 TS）、三语 key `setting__ai_test_*`；testing/ok/fail/needConfig 四态，错误信息直接展示。
3. **探索路径点击跳播**：engine `ExploreItemView.musicInfo`、session-core `SessionPathItem.musicInfo`、`playPathItem`、Explore 视图 `@click`/hover；`handleMusicToggled` 保留 `existing.musicInfo`。
4. **ranking 解析健壮化**：`json.ts extractRankingRows`（数组/多键名/双重编码字符串/{chunks} 拼接/截断→[]）+ 10 单测；`engine.ts aiRank` 改用之；`llm.ts` max_tokens 8192（openai-compat 新增、anthropic 1800→8192）；`session.ts lastAiRankError` + Explore 页"AI 排序失败：…"可见行（i18n `explore__ai_rank_failed` 三语，冒号已入文案）。
5. **AI rank 重试**（最近一次）：`engine.ts` AI 排序抛错时最多 2 次重试（800/1600ms），全部失败才回退本地；e2e 用 `E2E_MOCK_FAIL_RANK_TIMES=2` 验证（日志"重试中(1/2)(2/2)"→第 3 次成功→AI 计划）。已过审（minor：鉴权类错误也会重试，注释已说明）。
6. **IPC 代理克隆异常**（"An object could not be cloned"，播放栏"添加到…"弹窗）：`rawUnwrap.ts unwrapMusicInfos`（逐条 toRaw，toRaw 只解一层、数组字面量无代理可解）+ rendererListManage IPC 边界加固 + 2 单测（structuredClone 复现/通过）。deep.js D1b 回归。
7. **e2e 基建**：`e2e/harness.js`（--user-data-dir 隔离（macOS 下 $HOME 无效！）、主窗口轮询（firstWindow 可能拿到 DevTools 窗口）、prod 构建守卫）、`e2e/mockLlm.js`（可发垃圾排名文本模拟）、`package.json` 新增 `playwright-core`（devDep）。
8. **e2e 套件**：
   - `e2e/e2e.js` 基线 14 项；`e2e/deep.js` 探索深度 14 项（D1b 添加列表、D2b 幂等点击、D3b 路径点击音频级探针、D7b 切歌重开会话）；`e2e/sync.js` T-A2/T-A3 7 项（sqlite3 校验元数据与启动同步）；`e2e/ai.js` AI 通道 13 项（`E2E_MOCK_FAIL_RANK_TIMES` 可配，新增"AI-路径点击跳播"）；`e2e/common.js` 常用功能 12 项（导航/播放控制/播放详情/桌面歌词窗口/我的列表 CRUD/收藏/榜单/设置 tab）。说明在 `e2e/README.md`。
   - 最近一次全量（2026-09-10）：单测 **273/273**；deep **15/15**、sync 7/7、ai 12/13、common 11/12、e2e 13/14——**所有 FAIL 均为音频 URL 限流导致的"播放中"断言**。
9. **探索路径点击跳播音频级修复**（本轮）：见 §1-A 根因；`playMusicInfoNow` + `playPathItem` 两分支改造。
10. **LLM 超时放宽 + AI 排序分批**（本轮，工程侧）：用户反馈"太容易超时了"（`HeadersTimeoutError`，60s 首字超时）：
    - `src/main/utils/llm.ts` `LLM_TIMEOUT` 60_000 → 180_000（undici `timeout` 为响应头超时，长上下文慢模型常见）；
    - `engine.ts aiRank` 分批：`RANK_BATCH_SIZE = 16`，每批独立调用 LLM（批内 candidate_id 从 0 编号、行级守门不变），合并后按 score 降序全局排序再走弧线；单批失败仍整体抛错走现有重试（最多 2 次）→ 本地回退。e2e `E2E_MOCK_FAIL_RANK_TIMES=2` 验证重试、AI-路径点击跳播 PASS。
    - 注意：mock 下每次计划 = 3 次排序请求，`ai.js` 的 `>=` 断言不受影响。
10b. **LLM 上限按用户要求放大**（用户：模型现在 1M 上下文 / 384K 输出，别给太小）：
    - `llm.ts` `max_tokens` 8192 → **384_000**（openai-compat + anthropic 统一）；模型/网关 4xx 报 max_tokens 超限时自动降档 8192 重试一次（`isMaxTokensError`）；
    - `llmValidate.ts` `MAX_MESSAGE_LENGTH` 256_000 → **1_000_000**（对齐 1M 上下文）+ 2 处测试同步；
    - 空内容处理（用户反馈"LLM 返回空内容"）：`extractContentText` 兼容 content string/null/数组；空内容抛带原因的错误（finish_reason=length 截断 / 仅 reasoning_content / 无原因），供 Explore 页"AI 排序失败：…"展示；mock 支持 `E2E_MOCK_EMPTY_CONTENT_TIMES` 模拟。
11. **e2e 稳定性（本轮）**：
    - `e2e/pathProbe.js`：`playerLoadstart`/状态变化/标题被顶走三信号探针（`clickPathRowAndVerify`、`clickNonCurrentPathRow`、`dismissOverlayModal`）。
    - `e2e/harness.js`：新建 profile 时预写 `LxDatas/config_v2.json` 关闭 `common.showChangeLog`——首启"更新日志"弹窗在版本信息网络返回后才弹出、时机不定，曾随机拦截点击导致 base 套件 4/14 级联超时；预置后恢复 13/14（唯一 FAIL 仍为限流）。
    - 各套件 dblclick 前统一 `dismissOverlayModal()` 兜底。
12. **推荐重复曲目与红心歌排除**（2026-09-09，用户反馈"大量重复歌曲 + 已红心歌曲出现"）：
    - 根因：全链路同曲判定只按「id 或精确 artist::title」（recall `sameTrack`/`seen`、judgment `diversify`、session-core `appendToPath`、跨批次 `excludeIds`），平台对同一首歌的 artist 串顺序/分隔符/合作者数量不同（截图：Möbius "Benjamin, Laco, 薄野弘之" vs "mpi, Laco, Benjamin, 薄野弘之"；Inferno 同 artist 异 id）→ 同曲多 id 变体穿过去重进路径/队列；「我喜欢」列表作为弱偏好源直接进候选（路径出现"来自你喜欢的列表"行）。
    - 修复：新增 `sameSong.ts`（title 归一化 + artist token 交集/双方都空→同曲）与 `candidatePool.ts`（`buildCandidatePool`：id 去重→锚点排除（含 id 通道）→红心排除（`normalizeTitle` 分桶 Map，全量喜欢列表，不受 200 截断）→语言门控→同曲去重；`filterExcludeTracks`：跨批次按 id+sameSong 排除）；`recall.ts` 删 liked 候选源（仅作红心排除与计数）；`engine.ts` `ExploreOptions.excludeTracks` + aiRank/localRank 同曲保险；`session-core.ts` `appendToPath` 按 id 或 sameSong 合并；`session.ts` refill 传 excludeTracks、handleMusicToggled 查找同语义。
    - 审核：code-review 双轴 2 major（锚点 id 通道回归、红心 200 截断）已修复并双段复审通过（0 block/critic/major；3 minor，其中 2 条注释已修、1 条风险评估接受）；只读文件 judgment/gates/prompts 零改动。
    - 验证（2026-09-09）：单测 **187/187**；deep **15/15**（新增 **D3c-路径无重复曲目**：pathProbe 复刻 sameSong 规则两两比对路径行）；ai 12/13、e2e 13/14（限流"播放中"外部因素）；构建 4 bundle 通过。
13. **纯音乐约束硬门 + 指令发送按钮/路径批次展示**（2026-09-09，用户两项诉求）：
    - 诉求 1「输入纯音乐仍推送有歌词的歌」根因：T-B0（judgment）只做反向压制（anchor 人声→压制器乐，transformationAllowed/vocalMismatch），缺「用户要求纯音乐→过滤人声候选」反向硬门，AI 排序对"有无歌词"语义判定不可靠。
    - 修复：新增 `vocalGate.ts`（纯函数）：`wantsInstrumental`（负面前缀 不要/别/不想听/不想/不喜欢/不爱/讨厌/避免 + 共享目标词表 INSTRUMENTAL_TERMS（纯音乐/器乐/instrumental/纯乐器/轻音乐/无人声/无歌词/没有人声/没人声/去掉人声/没有歌词/无词；POSITIVE 另加"不要人声"——裸"人声"不能进 NEGATIVE，否则"不要人声"误判）+ 标点断句）；`candidateIsInstrumental`（元数据词表 or AI 行 continuity.vocal 为数字且 <0.4，null/'' 不误判）；`passesInstrumentalGate`；`engine.ts` exploreOnce 排序后、入队前统一过滤，空结果抛器乐专属文案。**34 条单测锁定语义，词表抽共享常量杜绝单边漂移（连踩三轮的坑）**。
    - 诉求 2「一句话约束需要发送按钮 + 路径展示筛选条件」：Explore 输入框改本地草稿+发送按钮（Enter/按钮提交，不再 debounce 自动触发；active watch immediate+instruction watch 防路由往返清草稿误清约束）；session-core `SessionPathItem.batch {radius,instruction,engine}` 快照 + appendToPath `item.batch ?? existing.batch` 继承；session applyResult 写入批次快照（plan 发起时条件）；Explore 路径按 batch 连续分桶渲染组头（第 N 批 · 距离 X · 约束 Y · AI/本地计划；i18n 三语 explore__instruction_send/explore__path_batch_header/explore__path_batch_none）。
    - e2e：deep.js D5 改为 fill+点发送（谓词硬化含按钮可见/点击成功）；D6 加返回后输入框值断言。
    - 审核迭代（每轮新 subagent）：① code-review 1 CRITIC（草稿挂载清约束）+2 MAJOR（vocal null 强转、标点前缀漏判）+5 MINOR → 修复；② 双段复审 2 MAJOR（负面词表移除误判回归、D5 谓词未落地）+1 MINOR → 修复；③ 最终复审 1 MAJOR（NEGATIVE 漏"去掉人声"）→ 修复；④ 聚焦复审**双段通过**（1 条可选建议已落地：词表抽共享常量）。遗留可接受残差：`请勿去掉人声` 误判（"勿"前缀未入表，低频、已文档化）。
    - 验证（2026-09-09）：单测 **225/225**（vocalGate 34）；deep **15/15**；build:renderer、eslint 通过；只读约束保持。
    - 分支：`fix/dedup-redheart`（含条目 12+13，3 commits）已推送 fork；master 保持 origin 基线（d5a4cf54），本地无多余中转 commit。
14. **审核修复轮**（2026-09-10：code-review 双轴审核 → TDD 实施 → 双轴复审通过）：
    - 审核对象 `d5a4cf54...3a96d70c`（条目 12+13）的结论：Standards 轴 6 项全为判断题（0 硬违规）；Spec 轴 1 缺漏 + 1 范围外 + 2 实现错误。最重两项：① 同曲排除规则在 5 处复制（一旦漂移，用户投诉的"大量重复歌曲"会回归）；② 元数据器乐词表漏 `器乐`（标题写"（器乐版）"的真器乐候选在本地排序路径被硬门误杀）。
    - 行为修复：`vocalGate.ts` 否定链补 `！？!?` 与换行截断（`、：:` **刻意不截断**——"不要华语、纯音乐"是并列列举，截断会把否定诉求反转为器乐诉求；6 个断句字符 + 3 个不断字符全部双向锁定）；`INSTRUMENTAL_META_RE` 补 `器乐` 并注明两套词表刻意独立演进；新增 `hints.ts emptyResultMessage`（优先级：器乐诉求 > 语言硬约束 > 通用；pool/ranked 两阶段既有措辞原样保留），engine 三处空结果抛出点统一，修掉"器乐专属文案不可达"。
    - 标准重构：`sameSong.ts` 新增 `includesSameSong`/`pushUniqueSameSong`（candidatePool 2 处 + engine 分批/排序 2 处收敛；`appendToPath` 的"id 或同曲命中取下标"语义不同，注释说明不复用）；删 localRank 死分支（`source==='liked'`、`t.liked` 加分）与 `sourceCounts.liked`（**`liked` 字段本身保留**：只读 `prompts.ts:263` 的 Familiarity 读取它）；`ExploreOptions.excludeTracks: SongRef[]`；`batchKey`/`groupPathByBatch` 下沉 session-core（视图只留 i18n 组头，渲染 DOM 结构不变）。
    - 测试基建：`e2e/sameSongRules.js` 抽独立 oracle（pathProbe 复用、`deep.js` 零改动）+ `e2e/sameSongRules.test.js` 与 src 一致性测试（18 例语料：真实 artist 变体/全部分隔符/空艺人/大小写空白/(Live)/同名异曲；任一侧漂移即红）；修掉 `src/main/utils/llm.ts:76` 既有 lint 报错（prefer-includes），`npm run lint` 首次 0 problems。
    - 验证（2026-09-10）：单测 **273/273**（13 文件；本轮 225→273，+48）；`npm run lint` 0 problems；4 个 prod bundle 重建通过并验无 dev 标记；e2e deep **15/15**、sync 7/7、e2e 13/14、ai 12/13、common 11/12（3 处 FAIL 与基线一致，全为限流"播放中"外部因素）。
    - 复核：双轴审核 0 block/critic/major（Standards 6/6 原问题确认解决、无新硬违规；Spec 无错误实现），唯一 minor（S1 测试锁定单边：缺 `?`/`\r`/`：`/`:`）已补 4 例，聚焦复审确认 6 个断句字符与 3 个不断字符全部锁定。
    - 分支状态：`fix/dedup-redheart` 新增 5 commits（b6943389/24c270df/63798793/7f61b60f/f48b5f63），**本地未推送**。
    - 遗留可接受：`e2e/harness.js` dev 标记加固仍混在旧 commit ac27fd5e 中（不重写已推送历史）；标准轴 3 条判断题维持现状（两套器乐词表刻意独立、`filter(t => pushUniqueSameSong(...))` 带副作用的谓词、`groupPathByBatch` 内部占位 key），均有注释/单测兜底。

## 3. 下一步（按依赖顺序）

1. ~~修/验诉求 A、B~~（✅ 完成）；~~条目 12/13 的 code-review 双轴审核与修复~~（✅ 完成，见条目 14）。
2. 待办：本轮 5 commits 推送 / 开 PR（用户决定，留意 §0 推送约定）；限流恢复后复跑 common C3、ai"歌曲播放中"、e2e"双击第一首"三处外部 FAIL 应转绿。
3. 可选后续：AI 重试模式复跑（`E2E_MOCK_FAIL_RANK_TIMES=2 node e2e/ai.js`）；`.gitignore` 加 `.DS_Store`（仓库根/子目录出现过）；FAQ/doc 若需补充（目前无 `docs/` 目录，相关文档只有 `e2e/README.md` 与本文档）。

## 4. 常用命令

```bash
npm test                                   # 单测（273，13 文件；含 e2e/sameSongRules.test.js 一致性测试）
npx vitest run e2e/sameSongRules.test.js   # 只跑 e2e 同曲规则一致性（改动任一侧 sameSong 后必跑）
npm run lint                               # 0 problems（本轮起；lint 只覆盖 src，e2e 不在其内）
npm run build:main && npm run build:renderer && npm run build:renderer-lyric && npm run build:renderer-scripts
node e2e/e2e.js / deep.js / sync.js / ai.js / common.js / smoke.js
E2E_MOCK_FAIL_RANK_TIMES=2 node e2e/ai.js  # AI 排序连续失败→重试验证
```

## 5. 提交与分支状态

- 分支 `fix/dedup-redheart`（= 本功能全部工作），基于 `d5a4cf54`（= master = origin/master）：
  - `ac27fd5e` 推荐链路同曲去重与红心歌排除（条目 12）
  - `f833cee3` + `3a96d70c` 纯音乐硬门 + 指令发送按钮/路径批次（条目 13）
  - `b6943389` 器乐硬门否定链标点截断、元数据词表补"器乐"、空结果文案优先级（条目 14 行为修复）
  - `24c270df` 同曲排除助手、删 localRank 死分支、批次分组下沉 session-core（条目 14 标准重构）
  - `63798793` e2e 同曲规则抽独立模块 + 与 src 一致性测试
  - `7f61b60f` 修复 `llm.ts:76` 既有 lint 报错（prefer-includes）
  - `f48b5f63` 补齐器乐否定链标点断句的双向锁定用例
- 推送情况：`ac27fd5e..3a96d70c` 已在 fork；**本轮 5 个 commit 未推送**（推送前按 §0 约定，勿直推 master）。
- 工作区：仅 `HANDOFF.md` 未跟踪（本文档）；`dist/` 为 2026-09-10 生成的生产构建。

## 6. 其他已知噪声（非本轮引入，可后续处理）

- `net::ERR_FILE_NOT_FOUND` 偶发（导入流程出现一次，未定位具体资源，疑似与音源失败相关的缓存图）。
- mg/bd SDK "try max num" 未处理 rejection（网络重试超限）。
- `tsc --noEmit` 全库因 webpack 别名不可用（tsconfig paths 未启用），类型检查实际以 webpack dev/prod 构建为准。
