# e2e（Playwright × Electron）

针对 T-A1~T-A3 / T-B0~T-B2 新能力的端到端测试。测试对象为 **dist 生产构建**（先运行
`npm run build:main && npm run build:renderer && npm run build:renderer-lyric && npm run build:renderer-scripts`）。

## 运行

```bash
node e2e/e2e.js    # 基线：启动/协议/探索空态/A1 链接识别/A3 弹窗/设置 AI/搜索播放/探索会话
node e2e/deep.js   # T-B2 深度：自动续补/far 反馈/一句话约束/离开返回/幂等/结束
node e2e/sync.js   # T-A2/T-A3：导入真实歌单→元数据持久化校验→重启→启动自动同步记录
node e2e/ai.js     # T-B1：mock LLM（e2e/mockLlm.js）→ 设置 AI → AI 计划/排序请求命中
node e2e/common.js  # 常用功能回归：导航/搜索/播放控制/播放详情/桌面歌词/我的列表 CRUD/收藏/榜单/设置 tab
node e2e/smoke.js  # 仅冒烟：启动+页面文本+错误采集
```

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

