import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rendererInvoke } from '@common/rendererIpc'
import { addTempPlayList } from '@renderer/store/player/action'
import { recallCandidates } from './recall'
import { exploreOnce } from './engine'
import { normalizeAnalysis } from './prompts'
import { playMusicInfo } from '@renderer/store/player/state'
import { getFeatureCollector } from './feature'
import type { RecommendLlmParams } from '@common/recommendation'

vi.mock('@renderer/store/setting', () => ({ appSetting: { 'ai.maxConcurrentRequests': 3 } }))
vi.mock('@common/rendererIpc', () => ({ rendererInvoke: vi.fn() }))
vi.mock('@renderer/store/player/action', () => ({ addTempPlayList: vi.fn() }))
vi.mock('@renderer/store/player/state', () => ({ playMusicInfo: { musicInfo: null } }))
vi.mock('@renderer/store/player/playProgress', () => ({ playProgress: { nowPlayTimeStr: '00:10' } }))
vi.mock('./recall', () => ({ recallCandidates: vi.fn() }))
vi.mock('./feature', () => ({
  getFeatureCollector: () => ({ summary: () => ({ valid: true, text: 'test' }), isStarted: () => true }),
  startFeatureCollection: vi.fn(),
  stopFeatureCollection: vi.fn(),
  summarizeBuckets: () => ({ valid: false, text: '未采集到有效音频特征' }),
}))
const invoke = vi.mocked(rendererInvoke)
const anchor = { artist: 'Anchor', title: 'Origin' }
const analysis = normalizeAnalysis({ summary: 'test' }, anchor)
const options = { anchor, ai: { apiKey: 'test', model: 'test' }, reuseAnalysis: analysis, radius: 50 }
const pool = Array.from({ length: 33 }, (_, i) => ({
  encryptedId: `id-${i}`,
  artist: `Artist ${i}`,
  title: `Track ${i}`,
  album: `Album ${i}`,
  source: 'semantic-search',
  distance: 20,
  musicInfo: { id: `id-${i}`, singer: `Artist ${i}`, name: `Track ${i}`, source: 'wy', meta: {} },
}))
const ranked = {
  content: JSON.stringify({
    ranking: [{
      candidate_id: 0,
      score: 0.9,
      confidence: 'high',
      perceptual_distance: 20,
      next_song_worthiness: 0.9,
      meaningful_difference: 0.8,
      surprise_value: 0.7,
      obviousness: 0.1,
      cliche_risk: 0.1,
      journey_role: 'hold',
    }],
  }),
}
const batchIndex = (params: RecommendLlmParams): number => {
  const input = params.messages[1].content.split('下面是音乐平台返回的真实候选：\n')[1]
  return Number(JSON.parse(input)[0].title.split(' ')[1]) / 16
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  playMusicInfo.musicInfo = { id: 'anchor', singer: 'Anchor', name: 'Origin', meta: {} } as any
  vi.mocked(recallCandidates).mockResolvedValue({ items: pool as any, meta: { sourceCounts: {}, error: null } })
})
afterEach(() => vi.useRealTimers())

describe('推荐引擎请求与提交', () => {
  it('3 批同时发起，仅失败批重试；合并保留成功批次并共用 system', async() => {
    const calls = [0, 0, 0]
    const releases: Array<() => void> = []
    invoke.mockImplementation(async(_event, payload) => {
      const batch = batchIndex(payload as RecommendLlmParams)
      calls[batch]++
      if (batch === 1 && calls[batch] === 1) throw new Error('503 retry')
      await new Promise<void>(resolve => releases.push(resolve))
      return ranked
    })
    const result = exploreOnce({ ...options, enqueue: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([1, 1, 1])
    const systems = invoke.mock.calls.map(call => (call[1] as RecommendLlmParams).messages[0].content)
    expect(new Set(systems).size).toBe(1)
    expect(systems[0]).not.toContain('Track 0')
    await vi.advanceTimersByTimeAsync(800)
    expect(calls).toEqual([1, 2, 1])
    releases.forEach(resolve => { resolve() })
    const final = await result
    expect(final.engine).toBe('ai')
    expect(final.candidates.map(c => c.id).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['id-0', 'id-16', 'id-32'])
    expect(final.meta.aiRankError).toBeNull()
    expect(addTempPlayList).not.toHaveBeenCalled()
  })

  it('部分批次耗尽重试仍保留其他 AI 结果', async() => {
    invoke.mockImplementation(async(_event, payload) => {
      if (batchIndex(payload as RecommendLlmParams) === 1) throw new Error('503 unavailable')
      return ranked
    })
    const result = exploreOnce(options)
    await vi.runAllTimersAsync()
    const final = await result
    expect(final.engine).toBe('ai')
    expect(final.candidates.map(c => c.id).sort((a, b) => String(a).localeCompare(String(b)))).toEqual(['id-0', 'id-32'])
    expect(final.meta.aiRankError).toContain('503')
    expect(invoke).toHaveBeenCalledTimes(5)
    expect(addTempPlayList).toHaveBeenCalledTimes(1)
  })

  it('无效分析重试，不把 raw 文本当作成功分析', async() => {
    let analyses = 0
    invoke.mockImplementation(async(_event, payload) => {
      const params = payload as RecommendLlmParams
      if (params.messages[0].content.includes('Music Fingerprint + Aesthetic Reading')) {
        analyses++
        return { content: analyses === 1 ? 'not json' : '{"summary":"有效分析"}' }
      }
      return ranked
    })
    const result = exploreOnce({ ...options, reuseAnalysis: undefined })
    await vi.runAllTimersAsync()
    expect((await result).analysis).toEqual({ summary: '有效分析', aiUsed: true, error: null })
    expect(analyses).toBe(2)
  })

  it('排序途中取消不会入队', async() => {
    let cancelled = false
    invoke.mockImplementation(async() => { cancelled = true; return ranked })
    await expect(exploreOnce({ ...options, isCancelled: () => cancelled })).rejects.toThrow('取消')
    expect(addTempPlayList).not.toHaveBeenCalled()
  })

  it('AI 全部判为低置信时，不得经本地回退重新入队', async() => {
    vi.mocked(recallCandidates).mockResolvedValue({ items: [pool[0]] as any, meta: { sourceCounts: {}, error: null } })
    const row = JSON.parse(ranked.content).ranking[0]
    invoke.mockResolvedValue({ content: JSON.stringify({ ranking: [{ ...row, confidence: 'low' }] }) })
    await expect(exploreOnce(options)).rejects.toThrow()
    expect(addTempPlayList).not.toHaveBeenCalled()
  })

  it('合法空 ranking 表示没有合格歌曲，不重试或本地复活', async() => {
    invoke.mockResolvedValue({ content: '{"ranking":[],"sequence":[]}' })
    await expect(exploreOnce(options)).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(addTempPlayList).not.toHaveBeenCalled()
  })

  it.each([null, '', false, -1, 16, 0.5])('非法 candidate_id=%s 触发校验重试，不映射到第 0 首', async(candidateId) => {
    vi.mocked(recallCandidates).mockResolvedValue({ items: [pool[0]] as any, meta: { sourceCounts: {}, error: null } })
    const row = JSON.parse(ranked.content).ranking[0]
    invoke.mockResolvedValueOnce({ content: JSON.stringify({ ranking: [{ ...row, candidate_id: candidateId }] }) })
      .mockResolvedValue(ranked)
    const pending = exploreOnce(options)
    await vi.runAllTimersAsync()
    expect((await pending).engine).toBe('ai')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('缺失距离按 far 标签处理，不将 null 当作零距离放行', async() => {
    vi.mocked(recallCandidates).mockResolvedValue({ items: [pool[0]] as any, meta: { sourceCounts: {}, error: null } })
    const row = JSON.parse(ranked.content).ranking[0]
    invoke.mockResolvedValue({ content: JSON.stringify({ ranking: [{ ...row, perceptual_distance: null, distance_from_anchor: 'far' }] }) })
    await expect(exploreOnce(options)).rejects.toThrow()
    expect(addTempPlayList).not.toHaveBeenCalled()
  })

  it('本地器乐过滤在选取前执行，前 8 首人声不能挤掉后面的器乐', async() => {
    vi.mocked(recallCandidates).mockResolvedValue({
      items: [...pool.slice(0, 8), { ...pool[8], title: 'Instrumental', distance: 49 }] as any,
      meta: { sourceCounts: {}, error: null },
    })
    const result = await exploreOnce({ ...options, ai: undefined, instruction: '想听纯音乐' })
    expect(result.candidates.map(c => c.id)).toEqual(['id-8'])
  })

  it('AI 服务全部失败仍允许本地回退', async() => {
    invoke.mockRejectedValue(new Error('503 unavailable'))
    const pending = exploreOnce(options)
    await vi.runAllTimersAsync()
    expect((await pending).engine).toBe('local')
    expect(addTempPlayList).toHaveBeenCalledTimes(1)
  })

  it('部分 AI 批次失败时，本地回退仅使用失败批，不复活成功批的淘汰曲', async() => {
    const row = JSON.parse(ranked.content).ranking[0]
    invoke.mockImplementation(async(_event, payload) => {
      if (batchIndex(payload as RecommendLlmParams) === 1) throw new Error('503 unavailable')
      return { content: JSON.stringify({ ranking: [{ ...row, confidence: 'low' }] }) }
    })
    const pending = exploreOnce(options)
    await vi.runAllTimersAsync()
    const result = await pending
    expect(result.engine).toBe('local')
    expect(result.candidates.length).toBeGreaterThan(0)
    expect(result.candidates.every(c => Number(c.id?.slice(3)) >= 16 && Number(c.id?.slice(3)) < 32)).toBe(true)
  })

  it('人声起点近距离明确要求无人声，本地器乐候选仍可通过', async() => {
    vi.mocked(recallCandidates).mockResolvedValue({
      items: [{ ...pool[0], title: '夜曲（无人声 Instrumental）' }] as any, meta: { sourceCounts: {}, error: null },
    })
    const vocalAnalysis = normalizeAnalysis({ fingerprint: { vocal_identity: ['女声'] } }, anchor)
    const result = await exploreOnce({ ...options, ai: undefined, reuseAnalysis: vocalAnalysis, radius: 35, instruction: '不要人声' })
    expect(result.candidates.map(c => c.id)).toEqual(['id-0'])
  })

  it('AI 明确器乐类型在近距离不因 vocal 连续性低被误杀', async() => {
    vi.mocked(recallCandidates).mockResolvedValue({ items: [pool[0]] as any, meta: { sourceCounts: {}, error: null } })
    const row = JSON.parse(ranked.content).ranking[0]
    invoke.mockResolvedValue({
      content: JSON.stringify({ ranking: [{ ...row, vocal_type: 'instrumental', continuity: { vocal: 0.1, timbre: 0.8 } }] }),
    })
    const result = await exploreOnce({ ...options, radius: 35, instruction: '想听纯音乐' })
    expect(result.candidates.map(c => c.id)).toEqual(['id-0'])
  })

  it('续补重新分析旧起点时，不把当前新歌的音频特征和播放位置传给模型', async() => {
    playMusicInfo.musicInfo = { id: 'another', singer: 'Another', name: 'Different', meta: {} } as any
    invoke.mockImplementation(async(_event, payload) => {
      const params = payload as RecommendLlmParams
      if (params.messages[0].content.includes('Music Fingerprint + Aesthetic Reading')) {
        expect(params.messages[1].content).not.toContain(`音频特征事实单：\n${getFeatureCollector().summary().text}`)
        expect(params.messages[1].content).not.toContain('00:10')
        return { content: '{"summary":"元数据分析"}' }
      }
      return ranked
    })
    const result = await exploreOnce({ ...options, reuseAnalysis: undefined })
    expect(result.featureSheet.valid).toBe(false)
    expect(result.position).toBe('')
  })
})
