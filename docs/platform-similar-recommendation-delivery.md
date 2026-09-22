# 平台相似推荐交付报告（AC1–AC12）

日期：2026-09-20。对照 `docs/platform-similar-recommendation-spec.md` 验收标准逐项报告。证据指针：`{SCRATCH}` 为本次执行的过程留痕目录（探针输出、全量测试/构建日志、冒烟 JSON）；仓库内证据以文件与测试名标注。

> 历史快照声明：本报告不自动随代码变更更新。2026-09-20 之后当前分支又合入了用户画像、多活音源及其他修复；当前 HEAD 的验收应执行 `npm test`、`npm run lint`、`npm run typecheck`、`npm run build` 和 `npm run test:e2e`，不能直接沿用本页的测试数量或 AC 结论。

**到达阶段：双平台聚合完成（wy + tx 均经 P0 真实验证并接入聚合）。** 冒烟样本中两平台列表无同曲交集，聚合在本样本的作用是扩充候选而非共同推荐加分；tx 种子定位对连续搜索限流敏感（真实使用的稀疏触发压力远低于冒烟）。不把技术通过等同于听感效果已证明（无人试听，见冒烟记录待试听清单）。

| 编号 | 结论 | 证据 |
| --- | --- | --- |
| AC1 | 通过 | `docs/platform-similar-recommendation-p0.md`（日期、端点/调用方式、请求响应字段、登录条件、按单曲相似确认、MusicInfo 映射、顺序/分页/上限/错误表现、脱敏样例）。每条结论来自当日实际网络请求：wy 探针 `{SCRATCH}/p0-wy.json`、tx 探针 `{SCRATCH}/p0-tx.json` 及多轮过程留痕。未验证项已列明（长期稳定性、地域差异、其他平台）。文档/代码/日志经凭证模式扫描无命中。 |
| AC2 | 通过（双平台） | wy：`musicSdk/wy/simiSong.js`（eapi `/api/v1/discovery/simiSong`，实测）；tx：`musicSdk/tx/simiSong.js`（musicu.fcg `rcmusic.similarSongRadioServer/get_simsongs`，实测）。P1 闭环（定位→召回→过滤→显示→入队→切歌→续补→错误处理）与 P2 聚合均已实现并有测试；真实闭环另经 `e2e/platform.js`（8/8 PASS，dist 生产构建真实 UI）与 20 种子真实冒烟驱动。 |
| AC3 | 通过 | `platformSession.test.ts`：默认模式（含旧 `ai.enable=true` + Key 齐备）初始推荐/续补/反馈全程 LLM 调用数 0，旧引擎入口未被调用；`profile.test.ts`：平台/local 模式累计满摘要阈值不发 LLM，仅显式 `recommend.engine='ai'` 发。无 AI Key 可推荐（平台路径不读 AI 配置，e2e P3 实证）。 |
| AC4 | 通过 | `seedMatch.test.ts`：错版本（Live/DJ/伴奏/女声版标注）、同名不同歌、起点/候选歌手缺失、时长超容差全部拒绝；无可靠匹配跳过平台不取第一条（`platformRecall.test.ts`「匹配失败跳过平台」）；歌手大小写（Beyond/BEYOND）与括号别名（冯沁苑(买辣椒也用券)）双向命中。 |
| AC5 | 通过 | `similarFusion.test.ts`：各来源排名与备用音源条目保留；同源重复只计一次；输入批次顺序互换结果不变（确定性）；单源高排名候选保留展示机会。 |
| AC6 | 通过 | `platformRecall.test.ts`：起点自身及同作品变体、会话已消费（id+同曲）、当前队列同曲、红心、「不再推荐」均排除；艺人多样性（同主艺人≤2）与画像有界调整（±15%）在 `similarFusion.test.ts`。 |
| AC7 | 通过 | `platformRecall.test.ts`：单源失败不丢其他源结果；`all-failed / no-match / empty / empty-after-filter / exhausted` 五态可区分；相似调用仅单层重试一次；`platformSession.test.ts`：候选用尽不重试相同来源、会话保持；全部失败走会话层有限重试（不无限）。 |
| AC8 | 通过 | 复用既有会话机制并保持回归：`session.test.ts`（旧计划返回不入队、路径跳播只消费目标不清队列）；`recommendPlayback.test.ts`（既有，播放队列语义）；`e2e/radio.js` 12/12 PASS（显式 local 引擎回归，含清场不删用户手动项的收台口径）。 |
| AC9 | 通过 | `similarCache.test.ts`（TTL/容量/LRU/同键覆盖/真实空列表可缓存）；`platformRecall.test.ts`（失败不写缓存、取消不算失败、偏好变化后读缓存重新过滤、同种子第二次命中缓存不再请求）。 |
| AC10 | 通过 | Explore 平台模式：无距离滑杆/约束输入/角色徽章/伪声学距离（`e2e/platform.js` P4/P6 实证）；理由仅来源事实（网易相似歌曲推荐/QQ 音乐相关歌曲推荐/两个平台共同推荐）；反馈为「喜欢这首/不再推荐这首」（P5）；四语言新键齐全（脚本校验 none missing）；旧 `ai`/`local` 引擎值兼容加载（`platformSession.test.ts`「旧引擎值的兼容加载」+ 垃圾值回落 platform）；设置页不再表现为依赖 AI（P7）。 |
| AC11 | 通过 | 全量 Vitest 33 文件 568 测试通过（`{SCRATCH}/npm-test.log`，TEST_EXIT=0）；ESLint 0 错误（`{SCRATCH}/lint.log`）；主/渲染进程 tsc 均 0 错误（`{SCRATCH}/tsc-main.log`、`tsc-renderer.log`）；生产构建成功（`{SCRATCH}/build.log`，BUILD_EXIT=0）。 |
| AC12 | 通过 | `docs/platform-similar-recommendation-smoke.md` + `{SCRATCH}/smoke.json`：20 种子真实冒烟（17 ok、33/40 定位、平均 771ms、0 重复、同艺人≤2、聚合 vs 单平台客观差异、待试听清单）。明确未验证：人工试听、长期稳定性、跨源同曲加分的真实触发（样本内两平台列表无交集）。 |

## 平台故障与候选用尽行为

- 单源失败：其余源结果照常展示，状态行非阻断提示「部分来源不可用」（`platformEngine.test.ts`「部分来源失败但仍有结果」）。
- 全部失败：`explorePlatformOnce` 抛错 → 会话层退避重试（续补最多 3 次）→ 连续最终失败达上限收台；**不**回退关键词搜索/同艺人/旧 AI 排序（`platformSession.test.ts`「不静默回退」）。
- 候选用尽：`exhausted` 为非失败状态——不重试、不计失败、会话保持（切歌/换起点后按新种子继续）；缓存 TTL 内续补不再发网络请求。
- 无匹配：种子无法可靠定位的平台跳过；全部平台无匹配时提示「当前歌曲在平台上没有可靠匹配」，不取搜索第一条。

## 单平台与聚合的实际差异（本样本）

wy 单平台每种子约 5 首；聚合后 6–8 首。融合序按来源内排名确定性交错（多数种子聚合 top5 = 3 wy + 2 tx）。本样本两平台相似列表无同曲交集（multiSource=0），「两个平台共同推荐」加分路径未在真实数据上触发（单测覆盖）。tx 依赖搜索定位种子，冒烟连续 20 种子（间隔 8s）出现 2 次限流失败；间隔 2.2s 时全部失败——真实使用为稀疏触发，压力远低。详见冒烟记录。

## 交付物清单

1. 调查记录：`docs/platform-similar-recommendation-p0.md`。
2. 实现与测试：`musicSdk/{wy,tx}/simiSong.js`；`core/recommend/{seedMatch,similarFusion,similarCache,platformRecall,platformEngine}.ts` + 各自 `.test.ts`；`platformSession.test.ts`；session/session-core/profile/设置/语言/UI 改造。全量 568 测试通过。
3. 设置/页面与类型兼容：`recommend.engine`（默认 platform，旧 ai/local 兼容）；四语言新键；Explore/SettingAi 平台模式。
4. 本报告（AC1–AC12 逐项）。
5. 平台故障/候选用尽行为与单平台 vs 聚合差异：见上两节；冒烟记录 `docs/platform-similar-recommendation-smoke.md`。

保留说明：工作区原有未提交改动（41 个路径）全部保留（`{SCRATCH}/git-pre.txt`/`git-post.txt` 超集校验通过），无 reset/revert/覆盖。
