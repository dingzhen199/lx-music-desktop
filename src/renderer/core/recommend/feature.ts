/**
 * 音频特征事实单：采样桶构造与摘要的纯逻辑 + 播放器接入的采集器。
 *
 * 思路（来自 from-here 的“特征事实单”要求）：
 * - 从 AnalyserNode 拉取时域/频域 Float32 数据，按 1s 节流构造 AudioBucket；
 * - summarizeBuckets 为纯函数，输出人读文本段 + 数值对象，供 LLM 分析的“音频特征事实单”段落；
 * - 特征单只表述粗略信号统计（RMS/频带能量/onset），不确定时标 unknown，不臆断编曲与流派。
 * 本文件的纯函数部分不依赖任何 lx 运行时模块，由 vitest 直接测试；
 * AudioFeatureCollector 通过运行时动态 import 接入播放器插件，保证模块可在测试环境加载。
 */

/** 采样桶间隔（毫秒）。 */
export const BUCKET_INTERVAL_MS = 1000

/** 滚动保留的最大桶数（约 90s 音频）。 */
export const MAX_BUCKETS = 90

/** 单个采样桶（t 为毫秒时间戳，其余为数值特征）。 */
export interface AudioBucket {
  t: number
  rms: number
  low: number
  mid: number
  high: number
  onset: number
}

/** 特征事实单（纯函数 summarizeBuckets 的输出）。 */
export interface FeatureSheet {
  valid: boolean
  durationSec: number
  bucketCount: number
  rmsAvg: number
  rmsPeak: number
  dynamicRange: number
  lowRatio: number
  midRatio: number
  highRatio: number
  onsetRate: number
  rhythm: '打击突出' | '平缓/无节拍' | 'unknown'
  text: string
}

/** 时域 RMS：sqrt(mean(x^2))。 */
export const computeRms = (timeData: Float32Array): number => {
  if (!timeData?.length) return 0
  let sum = 0
  for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i]
  return Math.sqrt(sum / timeData.length)
}

/** dB 转线性幅度（10^(dB/20)）。 */
const dbToLinear = (db: number): number => {
  return Math.pow(10, db / 20)
}

/**
 * 频带能量：跳过 DC(bin 0)，将剩余 bin 均分三段取平均线性幅度。
 * 频域数据为 dB，先转线性再平均，避免直接平均 dB 带来的物理失真。
 */
export const bandEnergies = (freqData: Float32Array): { low: number, mid: number, high: number } => {
  if (!freqData || freqData.length <= 1) return { low: 0, mid: 0, high: 0 }
  const active = freqData.length - 1
  const third = Math.max(1, Math.floor(active / 3))
  let lowSum = 0
  let midSum = 0
  let highSum = 0
  for (let i = 1; i < freqData.length; i++) {
    const v = dbToLinear(freqData[i])
    if (i <= third) lowSum += v
    else if (i <= third * 2) midSum += v
    else highSum += v
  }
  return { low: lowSum / third, mid: midSum / third, high: highSum / Math.max(1, active - third * 2) }
}

/** 构造单个采样桶；onset 为当前 RMS 与前桶 RMS 的正差（首桶/下降为 0）。 */
export const buildBucket = (t: number, timeData: Float32Array, freqData: Float32Array, prevRms: number | null): AudioBucket => {
  const rms = computeRms(timeData)
  const { low, mid, high } = bandEnergies(freqData)
  return {
    t,
    rms,
    low,
    mid,
    high,
    onset: prevRms == null ? 0 : Math.max(0, rms - prevRms),
  }
}

/** 取样本的分位数（nearest-rank，q∈[0,1]）。 */
const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))
  return sorted[index]
}

/** 保守的比例输出：总和为 0 时按均分（1/3）处理。 */
const ratioOf = (value: number, total: number): number => {
  return total > 0 ? value / total : 1 / 3
}

/**
 * 桶摘要（纯函数）：平均/峰值 RMS、动态范围(p90-p10)、低中高频带能量比、
 * onset 率、覆盖时长秒与节奏运动文本；空桶输出 unknown 保守措辞。
 */
export const summarizeBuckets = (buckets: AudioBucket[]): FeatureSheet => {
  const list = Array.isArray(buckets) ? buckets : []
  if (!list.length) {
    return {
      valid: false,
      durationSec: 0,
      bucketCount: 0,
      rmsAvg: 0,
      rmsPeak: 0,
      dynamicRange: 0,
      lowRatio: 1 / 3,
      midRatio: 1 / 3,
      highRatio: 1 / 3,
      onsetRate: 0,
      rhythm: 'unknown',
      text: '未采集到有效音频特征（采样桶为空）。节奏运动：unknown，不作判断；本特征单不提供任何事实判断，请先开始播放并采集一段时间。',
    }
  }

  const rmsValues = list.map(b => b.rms)
  const rmsAvg = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length
  const rmsPeak = Math.max(...rmsValues)
  const sorted = [...rmsValues].sort((a, b) => a - b)
  const dynamicRange = Math.max(0, quantile(sorted, 0.9) - quantile(sorted, 0.1))

  const lowSum = list.reduce((s, b) => s + b.low, 0)
  const midSum = list.reduce((s, b) => s + b.mid, 0)
  const highSum = list.reduce((s, b) => s + b.high, 0)
  const bandTotal = lowSum + midSum + highSum
  const lowRatio = ratioOf(lowSum, bandTotal)
  const midRatio = ratioOf(midSum, bandTotal)
  const highRatio = ratioOf(highSum, bandTotal)

  // onset 阈值取“略高于环境底噪”：与整体响度成比例，下限 0.02。
  const onsetThreshold = Math.max(0.02, rmsAvg * 0.2)
  const onsetCount = list.filter(b => b.onset > onsetThreshold).length
  const onsetRate = onsetCount / list.length
  const rhythm: FeatureSheet['rhythm'] = onsetRate >= 0.3 ? '打击突出' : '平缓/无节拍'
  const durationSec = list.length
  const shortSample = durationSec < 30 ? '当前样本较短，仅供参考。' : ''

  const text = [
    `- 覆盖时长约 ${durationSec}s（${list.length} 个采样桶，约每 1s 一桶）`,
    `- 响度（RMS）：平均 ${rmsAvg.toFixed(2)}，峰值 ${rmsPeak.toFixed(2)}`,
    `- 动态范围（p90-p10）：${dynamicRange.toFixed(2)}`,
    `- 频带能量占比：低频 ${(lowRatio * 100).toFixed(0)}%，中频 ${(midRatio * 100).toFixed(0)}%，高频 ${(highRatio * 100).toFixed(0)}%`,
    `- 节奏运动：${rhythm}（onset 率 ${(onsetRate * 100).toFixed(0)}%）`,
    `- 置信度说明：本特征单来自粗略的信号统计（RMS/频带能量/onset），不构成对编曲、流派或音色的事实判断；样本越长越可靠。${shortSample}`,
  ].join('\n')

  return {
    valid: true,
    durationSec,
    bucketCount: list.length,
    rmsAvg,
    rmsPeak,
    dynamicRange,
    lowRatio,
    midRatio,
    highRatio,
    onsetRate,
    rhythm,
    text,
  }
}

// ============================ 播放器接入（集成部分，不作单测） ============================

/**
 * 从 AnalyserNode 拉取特征的采集器：
 * - 1s 节流（interval 触发后仍按 BUCKET_INTERVAL_MS 节流）；
 * - 滚动保留最近 MAX_BUCKETS 桶；
 * - 订阅播放器事件：切歌（musicToggled）清空桶、暂停（pause）停止采样、播放（play）恢复采样。
 * 播放器插件通过动态 import 接入，保证本模块可被 vitest 直接加载（纯函数部分）。
 */
export class AudioFeatureCollector {
  private buckets: AudioBucket[] = []
  private started = false
  private sampling = false
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPullAt = 0
  private getAnalyserFn: (() => AnalyserNode | null) | null = null
  private unsubMusicToggled: (() => void) | null = null
  private unsubPlay: (() => void) | null = null
  private unsubPause: (() => void) | null = null

  isStarted(): boolean {
    return this.started
  }

  /** 当前保留的采样桶（副本）。 */
  getBuckets(): AudioBucket[] {
    return [...this.buckets]
  }

  clear(): void {
    this.buckets = []
  }

  /** 当前桶摘要（纯函数）。 */
  summary(): FeatureSheet {
    return summarizeBuckets(this.buckets)
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.sampling = true
    // 开始新的采集窗口前清空旧桶：重开窗口（如探索会话重开）后，残留桶会被误当作新锚点的特征
    this.buckets = []
    try {
      if (!this.getAnalyserFn) {
        const plugin = await import('@renderer/plugins/player')
        this.getAnalyserFn = plugin.getAnalyser
      }
    } catch (err) {
      this.started = false
      this.sampling = false
      console.error('[feature] 加载播放器分析器失败', err)
      return
    }
    this.lastPullAt = 0
    this.timer = setInterval(() => {
      void this.pull()
    }, BUCKET_INTERVAL_MS)
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- 必须保留 typeof 守卫：window 可能未定义（非浏览器环境），可选链不能防 ReferenceError
    if (typeof window === 'undefined' || !window.app_event) return
    const handleMusicToggled = () => {
      this.clear()
    }
    const handlePlay = () => {
      this.sampling = true
    }
    const handlePause = () => {
      this.sampling = false
    }
    window.app_event.on('musicToggled', handleMusicToggled)
    window.app_event.on('play', handlePlay)
    window.app_event.on('pause', handlePause)
    this.unsubMusicToggled = () => {
      window.app_event.off('musicToggled', handleMusicToggled)
    }
    this.unsubPlay = () => {
      window.app_event.off('play', handlePlay)
    }
    this.unsubPause = () => {
      window.app_event.off('pause', handlePause)
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.sampling = false
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.unsubMusicToggled?.()
    this.unsubMusicToggled = null
    this.unsubPlay?.()
    this.unsubPlay = null
    this.unsubPause?.()
    this.unsubPause = null
  }

  private async pull(): Promise<void> {
    if (!this.started || !this.sampling) return
    const now = Date.now()
    if (now - this.lastPullAt < BUCKET_INTERVAL_MS) return
    this.lastPullAt = now
    this.sampleNow()
  }

  /** 采样一次并滚动入桶（pull / sampleOnce 共用；analyser 不可用时静默跳过）。 */
  private sampleNow(): void {
    const analyser = this.safeAnalyser()
    if (!analyser) return
    const timeData = new Float32Array(analyser.fftSize)
    const freqData = new Float32Array(analyser.frequencyBinCount)
    analyser.getFloatTimeDomainData(timeData)
    analyser.getFloatFrequencyData(freqData)
    const prev = this.buckets.length ? this.buckets[this.buckets.length - 1].rms : null
    const bucket = buildBucket(Date.now(), timeData, freqData, prev)
    this.buckets.push(bucket)
    if (this.buckets.length > MAX_BUCKETS) this.buckets.splice(0, this.buckets.length - MAX_BUCKETS)
  }

  /** 安全获取 analyser：播放器插件在未创建 audio 时可能抛错，此处按不可用处理。 */
  private safeAnalyser(): AnalyserNode | null {
    try {
      return this.getAnalyserFn?.() ?? null
    } catch (err) {
      console.warn('[feature] 获取 analyser 失败（可能尚未开始播放）', err)
      return null
    }
  }

  /** 立即采样一次（未启动采集时的“仅探索时采集”路径），并返回最新摘要。 */
  async sampleOnce(): Promise<FeatureSheet> {
    if (!this.getAnalyserFn) {
      try {
        const plugin = await import('@renderer/plugins/player')
        this.getAnalyserFn = plugin.getAnalyser
      } catch (err) {
        console.error('[feature] 加载播放器分析器失败', err)
        return this.summary()
      }
    }
    this.lastPullAt = Date.now()
    this.sampleNow()
    return this.summary()
  }
}

let collectorSingleton: AudioFeatureCollector | null = null

/** 获取进程内唯一的采集器（无 UI 时由 dev 调试入口 / T-B2 UI 触发）。 */
export const getFeatureCollector = (): AudioFeatureCollector => {
  if (!collectorSingleton) collectorSingleton = new AudioFeatureCollector()
  return collectorSingleton
}

/** 开始采集（幂等）。 */
export const startFeatureCollection = (): void => {
  void getFeatureCollector().start()
}

/** 停止采集（幂等）。 */
export const stopFeatureCollection = (): void => {
  getFeatureCollector().stop()
}
