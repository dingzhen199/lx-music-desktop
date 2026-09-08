import { describe, expect, it } from 'vitest'
import { bandEnergies, buildBucket, computeRms, summarizeBuckets } from './feature'
import type { AudioBucket } from './feature'

// makeTimeData: 生成时域采样（常数振幅 → RMS 等于常数值）
const makeTimeData = (rms: number, length = 256): Float32Array => {
  const arr = new Float32Array(length)
  for (let i = 0; i < length; i++) arr[i] = rms
  return arr
}

// makeFreqData: 按 dB 生成频域数据（-120 视为近 0 线性值）
const makeFreqData = (lowDb: number, midDb: number, highDb: number): Float32Array => {
  const arr = new Float32Array(128).fill(-120)
  for (let i = 0; i < 128; i++) {
    arr[i] = i === 0 ? -120 : (i <= 42 ? lowDb : i <= 84 ? midDb : highDb)
  }
  return arr
}

const flatFreq = (db = -60): Float32Array => makeFreqData(db, db, db)

const makeBuckets = (count: number, rms: number | ((i: number) => number), freq: Float32Array = flatFreq()): AudioBucket[] => {
  const out: AudioBucket[] = []
  for (let i = 0; i < count; i++) {
    out.push(buildBucket(i * 1000, makeTimeData(typeof rms === 'function' ? rms(i) : rms), freq, i === 0 ? null : out[i - 1].rms))
  }
  return out
}

describe('computeRms - 时域 RMS 计算', () => {
  it('常数振幅 0.3 的采样序列 RMS 为 0.3', () => {
    // act & assert
    expect(computeRms(makeTimeData(0.3))).toBeCloseTo(0.3, 5)
  })

  it('全零采样 RMS 为 0', () => {
    // act & assert
    expect(computeRms(makeTimeData(0))).toBe(0)
  })

  it('正负混合采样（正弦近似）RMS 为振幅的 1/√2 附近', () => {
    // arrange
    const arr = new Float32Array(256)
    for (let i = 0; i < arr.length; i++) arr[i] = Math.sin((i / arr.length) * Math.PI * 2)
    // act & assert
    expect(computeRms(arr)).toBeCloseTo(1 / Math.sqrt(2), 3)
  })
})

describe('bandEnergies - 低中高频带能量', () => {
  it('低频占优时低频能量占比最大', () => {
    // act
    const { low, mid, high } = bandEnergies(makeFreqData(-30, -60, -90))
    const total = low + mid + high
    // assert
    expect(low / total).toBeGreaterThan(0.9)
    expect(mid / total).toBeLessThan(low / total)
  })

  it('高频占优时高频能量占比最大', () => {
    // act
    const { low, mid, high } = bandEnergies(makeFreqData(-90, -90, -30))
    const total = low + mid + high
    // assert
    expect(high / total).toBeGreaterThan(0.9)
  })

  it('全带相同 dB 时三带能量近似相等（低频略偏多取自 bin 1..42）', () => {
    // act
    const { low, mid, high } = bandEnergies(flatFreq())
    const total = low + mid + high
    // assert
    expect(low / total).toBeCloseTo(1 / 3, 1)
    expect(mid / total).toBeCloseTo(1 / 3, 1)
    expect(high / total).toBeCloseTo(1 / 3, 1)
  })
})

describe('buildBucket - 单桶构造', () => {
  it('首桶（无前驱）onset 为 0，RMS 与频带取自输入数组', () => {
    // act
    const bucket = buildBucket(1000, makeTimeData(0.3), flatFreq(), null)
    // assert
    expect(bucket.t).toBe(1000)
    expect(bucket.rms).toBeCloseTo(0.3, 5)
    expect(bucket.onset).toBe(0)
    expect(bucket.low).toBeGreaterThan(0)
    expect(bucket.mid).toBeGreaterThan(0)
    expect(bucket.high).toBeGreaterThan(0)
  })

  it('onset 为当前 RMS 与前桶 RMS 的正差（下降为 0）', () => {
    // act
    const up = buildBucket(2000, makeTimeData(0.4), flatFreq(), 0.3)
    const down = buildBucket(3000, makeTimeData(0.1), flatFreq(), 0.3)
    // assert
    expect(up.onset).toBeCloseTo(0.1, 5)
    expect(down.onset).toBe(0)
  })
})

describe('summarizeBuckets - 桶摘要（人读特征事实单）', () => {
  it('空桶：valid=false、rhythm=unknown、文本含保守措辞', () => {
    // act
    const sheet = summarizeBuckets([])
    // assert
    expect(sheet.valid).toBe(false)
    expect(sheet.durationSec).toBe(0)
    expect(sheet.bucketCount).toBe(0)
    expect(sheet.rhythm).toBe('unknown')
    expect(sheet.text).toContain('未采集到')
    expect(sheet.text).toContain('unknown')
    expect(sheet.text).toContain('不作判断')
  })

  it('一致桶：动态范围为 0、onset 率为 0、节奏平缓、三带各约 1/3', () => {
    // act
    const sheet = summarizeBuckets(makeBuckets(10, 0.25))
    // assert
    expect(sheet.valid).toBe(true)
    expect(sheet.durationSec).toBe(10)
    expect(sheet.bucketCount).toBe(10)
    expect(sheet.rmsAvg).toBeCloseTo(0.25, 5)
    expect(sheet.rmsPeak).toBeCloseTo(0.25, 5)
    expect(sheet.dynamicRange).toBeLessThan(0.05)
    expect(sheet.onsetRate).toBe(0)
    expect(sheet.rhythm).toBe('平缓/无节拍')
    expect(sheet.lowRatio).toBeCloseTo(1 / 3, 1)
    expect(sheet.midRatio).toBeCloseTo(1 / 3, 1)
    expect(sheet.highRatio).toBeCloseTo(1 / 3, 1)
  })

  it('动态大：线性爬升的 RMS 产生明显动态范围', () => {
    // act
    const sheet = summarizeBuckets(makeBuckets(20, i => 0.05 + (i * 0.45) / 19))
    // assert
    expect(sheet.rmsPeak).toBeCloseTo(0.5, 3)
    expect(sheet.dynamicRange).toBeGreaterThan(0.3)
  })

  it('onset 高：强弱交替的 RMS 判定为打击突出', () => {
    // act
    const sheet = summarizeBuckets(makeBuckets(12, i => (i % 2 === 0 ? 0.1 : 0.45)))
    // assert
    expect(sheet.onsetRate).toBeGreaterThan(0.3)
    expect(sheet.rhythm).toBe('打击突出')
    expect(sheet.text).toContain('打击突出')
  })

  it('onset 低：几乎恒定的 RMS 判定为平缓/无节拍', () => {
    // act
    const sheet = summarizeBuckets(makeBuckets(12, i => 0.2 + i * 0.001))
    // assert
    expect(sheet.onsetRate).toBeLessThan(0.1)
    expect(sheet.rhythm).toBe('平缓/无节拍')
  })

  it('文本段包含关键措辞（响度/动态范围/频带能量占比/节奏运动）与置信度说明', () => {
    // act
    const sheet = summarizeBuckets(makeBuckets(6, 0.2))
    // assert
    expect(sheet.text).toContain('覆盖时长约 6s')
    expect(sheet.text).toContain('响度')
    expect(sheet.text).toContain('动态范围')
    expect(sheet.text).toContain('频带能量占比')
    expect(sheet.text).toContain('节奏运动')
    expect(sheet.text).toContain('不构成对编曲、流派或音色的事实判断')
  })

  it('短样本文本带“样本较短”提示', () => {
    // act
    const sheet = summarizeBuckets(makeBuckets(6, 0.2))
    // assert
    expect(sheet.text).toContain('样本较短')
  })

  it('不截断输入：summarizeBuckets 按传入桶数统计（滚动窗口截断属于采集器集成逻辑，另见 pull/sampleNow）', () => {
    // act
    const sheet = summarizeBuckets(makeBuckets(150, i => 0.1 + (i % 10) * 0.01))
    // assert
    expect(sheet.bucketCount).toBe(150)
    expect(sheet.durationSec).toBe(150)
  })
})
