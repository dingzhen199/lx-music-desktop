# e2e（Playwright × Electron）

针对 T-A1~T-A3 / T-B0~T-B2 新能力的端到端测试。测试对象为 **dist 生产构建**（先运行
`npm run build:main && npm run build:renderer && npm run build:renderer-lyric && npm run build:renderer-scripts`）。

> **⚠ 电台化演进后的过时声明（2026-09-13，探索电台 TT-1~TT-5 合入后）**
> 本目录脚本的 T-B1/T-B2 断言尚未适配电台语义，已知失效点：
> - `e2e/e2e.js`、`e2e/deep.js`、`e2e/ai.js` 中播放栏按钮定位器 `[aria-label="从此歌出发"]`
>   已不存在——该按钮演进为电台开关，aria-label 随状态在"开启探索电台/关闭探索电台"间切换（`explore__radio_start/stop`）。
> - 经 UI 开启的探索会话现在=电台开启：路径外切歌会自动跟歌重锚（约 1.2s 防抖），
>   `deep.js` D7b"切歌后再点按钮重开会话"类手序会被自动重锚抢先/干扰；点击开关按钮的语义变为"收台"。
> - 首计划与续补统一追加稍后播放**队尾**（不再置顶），任何断言队列头部顺序的校验需复核。
> - "结束会话"按钮现在经设置项（`recommend.radio`）单源收台并清场，行为结果不变（回空态）但链路不同。
> 在上述断言完成适配前，`e2e/e2e.js`、`e2e/deep.js`、`e2e/ai.js` 对电台相关场景的结果不可作为回归依据；
> 适配工作单独立项（定位器改状态无关选择器 + 流程预期按电台状态机重写）。
> `e2e/common.js`、`e2e/smoke.js`、`e2e/sync.js` 与 sameSong 相关断言不涉及上述触面。

## 运行

```bash
node e2e/e2e.js    # 基线：启动/协议/探索空态/A1 链接识别/A3 弹窗/设置 AI/搜索播放/探索会话
node e2e/deep.js   # T-B2 深度：自动续补/far 反馈/一句话约束/离开返回/幂等/结束
node e2e/sync.js   # T-A2/T-A3：导入真实歌单→元数据持久化校验→重启→启动自动同步记录
node e2e/ai.js     # T-B1：mock LLM（e2e/mockLlm.js）→ 设置 AI → AI 计划/排序请求命中（预写 recommend.engine='ai'）
node e2e/radio.js  # 探索电台（TT-1~TT-5）：跟歌重锚/约束作废/本地引擎/断网失败收台/指标落盘/重启自动开台（预写 recommend.engine='local'）
node e2e/platform.js  # 平台相似推荐（默认引擎，零 LLM）：平台推荐标识/隐藏距离与约束控件/喜欢与不再推荐反馈/来源理由/设置页不依赖 AI
node e2e/common.js  # 常用功能回归：导航/搜索/播放控制/播放详情/桌面歌词/我的列表 CRUD/收藏/榜单/设置 tab
node e2e/smoke.js  # 仅冒烟：启动+页面文本+错误采集
```

> 2026-09-20 平台相似推荐合入后：推荐默认引擎为 platform（平台相似歌曲，零 LLM）。
> `radio.js`/`ai.js` 分别预写 `recommend.engine='local'/'ai'` 以回归旧引擎路径；
> 平台默认路径由 `platform.js` 覆盖（依赖外网 wy/tx 相似端点，见 docs/platform-similar-recommendation-p0.md）。

## 关键约定

- **数据隔离**：macOS 上 Electron 的 `userData` **不跟随 `$HOME`**，必须传
  `--user-data-dir=<临时目录>`（见 `harness.js`），否则会读写真实用户数据。
  这是踩坑后的硬性约定，请勿回退成 HOME 方案。
- 首次启动需过“许可协议”倒计时与“开源声明”弹窗，`acceptAgreement()` 已处理。
- 首启“更新日志”弹窗（`common.showChangeLog`）在版本信息网络返回后才弹出、时机不定，
  常拦截后续点击造成随机级联超时；`harness.js` 已在新建 profile 时预写
  `LxDatas/config_v2.json` 关闭它。兜底仍保留 `pathProbe.dismissOverlayModal()`。
- 播放栏按钮是 `div[aria-label]` 而非 `<button>`，选择器用 `[aria-label=…]` 通用属性匹配。
- 默认开启“源名伪装”（小蜗=酷我、小芸=网易云、小秋=腾讯、小枸=酷狗），断言用别名。
- 搜索/播放依赖外网音源，偶发失败属网络波动（套件其余步骤仍会继续）。
- 失败截图与 mock LLM 请求记录写入 `$TMPDIR/lx-e2e-artifacts/`。

## 路径点击跳播探针（pathProbe.js）

`deep.js` D3b 与 `ai.js` AI-路径点击跳播共用 `e2e/pathProbe.js`：
仅断言播放栏标题切换**不足以**证明真正换歌（`setPlayMusicInfo` 会同步切标题，
但若播放器没有加载新音频，用户会看着新标题继续听旧歌）。探针叠加音频级信号：

- `playerLoadstart`（主音频元素加载了新资源）；
- 播放栏状态文本变化（URL 拉取/换源失败）；
- 标题后来被自动切歌顶走成别的歌（限流环境下换源失败后 FIFO 弹队首的证据）。

任一信号 + 标题命中即判“机制正常”；限流导致资源未加载属于外部因素。

## 同曲规则独立副本（sameSongRules.js）

`deep.js` D3c（路径无重复曲目）用 `pathProbe.sameSongText` 两两比对路径行。该实现与
`src/renderer/core/recommend/sameSong.ts` 是**两份物理独立的同规则实现**：oracle 若直接复用
被测实现，实现本身出错时会连 oracle 一起错、发现不了问题，因此 `e2e/sameSongRules.js` 刻意不复用 src。

漂移由 `e2e/sameSongRules.test.js` 兜底（`npm test` 自动收集）：用共享语料逐例比对两侧判定——
真实 artist 顺序/合作者变体、全部分隔符、大小写与空白差异、空艺人、`(Live)` 版本、同名异曲。
**改动任一侧的同曲规则后必须跑 `npm test`，不一致会直接红。**

