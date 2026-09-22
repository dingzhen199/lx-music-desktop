import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as SessionModule from './session'
import type { ExploreResult } from './engine'

const mocks = vi.hoisted(() => ({
  explore: vi.fn(),
  addQueue: vi.fn(),
  removeQueue: vi.fn(),
  playNow: vi.fn(),
  // 本文件覆盖旧引擎（ai/local）的会话语义；平台默认路径见 platformSession.test.ts
  setting: { 'recommend.radio': false, 'recommend.radius': 50, 'recommend.autoRefill': true, 'ai.enable': false, 'recommend.engine': 'local' },
  player: { musicInfo: { id: 'anchor', singer: 'Anchor', name: 'Origin', meta: {} } as any },
  queue: [] as any[],
}))
vi.mock('./engine', () => ({ exploreOnce: mocks.explore }))
vi.mock('./platformEngine', () => ({ explorePlatformOnce: vi.fn() }))
vi.mock('@renderer/store/setting', () => ({ appSetting: mocks.setting }))
vi.mock('@renderer/store/player/state', () => ({ playMusicInfo: mocks.player, tempPlayList: mocks.queue, isPlay: { value: false } }))
vi.mock('@renderer/store/player/action', () => ({ addTempPlayList: mocks.addQueue, removeTempPlayList: mocks.removeQueue }))
vi.mock('@renderer/core/player', () => ({ playMusicInfoNow: mocks.playNow }))
vi.mock('@renderer/utils/data', () => ({ getRecommendMetrics: async() => null, saveRecommendMetrics: vi.fn() }))
vi.mock('./feature', () => ({ startFeatureCollection: vi.fn(), stopFeatureCollection: vi.fn() }))
vi.mock('./profile', () => ({ getProfileState: () => null, onProfileSignal: vi.fn(), recordRecommendedSkip: vi.fn() }))
// platformEngine（session 直接引入）的列表仓库依赖：mock 掉避免拉起真实 store 链（document 等）
vi.mock('@renderer/store/list/listManage/rendererListManage', () => ({ getListMusics: async() => [] }))
vi.mock('@renderer/store/list/listManage/state', () => ({ loveList: { id: 'love' }, userLists: [] }))

const result = (id: string): ExploreResult => ({
  engine: 'ai',
  anchor: { artist: 'Anchor', title: 'Origin', album: '' },
  position: '00:00',
  featureSheet: {} as any,
  analysis: { summary: '', aiUsed: true, error: null },
  rawAnalysis: {} as any,
  candidates: [{
    id,
    artist: 'Artist',
    title: id,
    album: '',
    source: 'wy',
    reason: '',
    journeyRole: 'hold',
    distance: 20,
    musicInfo: { id, singer: 'Artist', name: id, source: 'wy', meta: {} } as any,
  }],
  meta: { sourceCounts: {}, recallError: null, aiRankError: null },
})
let session: typeof SessionModule
beforeEach(async() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  mocks.player.musicInfo = { id: 'anchor', singer: 'Anchor', name: 'Origin', meta: {} }
  mocks.queue.splice(0)
  mocks.removeQueue.mockImplementation(index => mocks.queue.splice(index, 1))
  mocks.addQueue.mockImplementation(items => mocks.queue.push(...items))
  vi.stubGlobal('window', { lx: { isProd: true }, app_event: new EventEmitter() })
  session = await import('./session')
})
afterEach(() => { session.endSession(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('会话与播放队列竞态', () => {
  it('收台只删除推荐入队实例，保留用户手动加入的同 ID 项', async() => {
    mocks.explore.mockResolvedValueOnce(result('song'))
    await session.startSession()
    const manual = { listId: 'manual-list', musicInfo: mocks.queue[0].musicInfo }
    mocks.queue.push(manual)
    expect(session.sessionView.value.remaining).toBe(1)
    session.endSession()
    expect(mocks.queue).toEqual([manual])
  })

  it('重锚只清旧会话的推荐实例，保留手动项', async() => {
    mocks.explore.mockResolvedValueOnce(result('song'))
    await session.startSession()
    const manual = { listId: 'manual-list', musicInfo: mocks.queue[0].musicInfo }
    mocks.queue.push(manual)
    mocks.player.musicInfo = { id: 'new-anchor', singer: 'New Artist', name: 'New Anchor', meta: {} }
    mocks.explore.mockResolvedValueOnce(result('new-song'))
    await session.startSession()
    expect(mocks.queue).toContain(manual)
    expect(mocks.queue.map(item => item.musicInfo.id)).toEqual(['song', 'new-song'])
  })

  it('路径跳播优先消费推荐实例，不消费先到的手动同 ID 项', async() => {
    mocks.explore.mockResolvedValueOnce(result('song'))
    await session.startSession()
    const manual = { listId: 'manual-list', musicInfo: mocks.queue[0].musicInfo }
    mocks.queue.unshift(manual)
    session.playPathItem('song')
    expect(mocks.queue).toEqual([manual])
  })

  it('请求期间新增的手动同曲项在提交前去重，不登记为推荐归属', async() => {
    let resolvePlan!: (value: ExploreResult) => void
    mocks.explore.mockImplementationOnce(async() => new Promise(resolve => { resolvePlan = resolve }))
    const pending = session.startSession()
    const manual = { listId: 'manual-list', musicInfo: { id: 'tx_song', singer: 'Artist', name: 'song', source: 'tx', meta: {} } }
    mocks.queue.push(manual)
    resolvePlan(result('song'))
    await pending
    expect(mocks.queue).toEqual([manual])
    expect(session.sessionView.value.path).toEqual([])
    expect(session.sessionView.value.recommendedIds).toEqual([])
    expect(mocks.addQueue).not.toHaveBeenCalled()
  })

  it('旧计划返回后不入队，也不删除新会话同 id 的歌曲', async() => {
    let resolveOld!: (value: ExploreResult) => void
    mocks.explore.mockImplementationOnce(async() => new Promise(resolve => { resolveOld = resolve }))
    const oldPlan = session.startSession()
    const oldOptions = mocks.explore.mock.calls[0][0]
    expect(oldOptions.enqueue).toBe(false)
    session.endSession()
    mocks.player.musicInfo = { id: 'new-anchor', singer: 'New', name: 'New', meta: {} }
    mocks.explore.mockResolvedValueOnce(result('shared-song'))
    await session.startSession()
    expect(oldOptions.isCancelled()).toBe(true)
    resolveOld(result('shared-song'))
    await oldPlan
    expect(mocks.addQueue).toHaveBeenCalledTimes(1)
    expect(mocks.queue.map(item => item.musicInfo.id)).toEqual(['shared-song'])
    expect(mocks.removeQueue).not.toHaveBeenCalled()
  })

  it('请求途中多次修改约束，完成后仅补一次并采用最新约束', async() => {
    let resolveInitial!: (value: ExploreResult) => void
    mocks.explore.mockImplementationOnce(async() => new Promise(resolve => { resolveInitial = resolve }))
    const pending = session.startSession()
    session.setInstruction('不要华语')
    await vi.advanceTimersByTimeAsync(1200)
    session.setInstruction('不要电子')
    await vi.advanceTimersByTimeAsync(1200)
    expect(mocks.explore).toHaveBeenCalledTimes(1)
    mocks.explore.mockResolvedValueOnce(result('new-song'))
    resolveInitial(result('first-song'))
    await pending
    await vi.advanceTimersByTimeAsync(1200)
    expect(mocks.explore).toHaveBeenCalledTimes(2)
    expect(mocks.explore.mock.calls[1][0].instruction).toContain('不要电子')
    expect(mocks.explore.mock.calls[1][0].reuseAnalysis).toBeUndefined()
  })

  it('手动操作触发的新计划成功后，旧失败重试定时器不会再补一批', async() => {
    mocks.explore.mockResolvedValueOnce(result('first-song'))
    await session.startSession()
    mocks.explore.mockRejectedValueOnce(new Error('unavailable'))
    session.setRadius(40)
    await vi.advanceTimersByTimeAsync(1200)
    expect(session.refillState.value).toBe('retrying')
    mocks.explore.mockResolvedValueOnce(result('next-song'))
    session.setRadius(45)
    await vi.advanceTimersByTimeAsync(1200)
    expect(session.refillState.value).toBe('idle')
    await vi.advanceTimersByTimeAsync(60000)
    expect(mocks.explore).toHaveBeenCalledTimes(3)
  })

  it('路径跳播先移除目标，保留其他待播项，已播曲可重播', async() => {
    mocks.explore.mockResolvedValueOnce(result('song'))
    await session.startSession()
    mocks.queue.push({ musicInfo: { id: 'manual' } })
    session.playPathItem('song')
    expect(mocks.playNow).toHaveBeenCalledWith(expect.objectContaining({ id: 'song' }), null, undefined)
    expect(mocks.queue.map(item => item.musicInfo.id)).toEqual(['manual'])
    session.playPathItem('song')
    expect(mocks.playNow).toHaveBeenCalledTimes(2)
    expect(mocks.queue).toHaveLength(1)
  })
})
