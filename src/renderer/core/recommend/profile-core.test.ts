/**
 * 本地用户画像状态机的纯逻辑测试（TP-1）。
 *
 * 覆盖：信号归并（reduceProfileSignal：loves/completes/skips 单调总计数、≤500 滚动事件缓冲 FIFO、
 * 艺人表 Top200 截断、垃圾值不污染、不可变转移）、听完判定（isCompleteListen 90% 界点与未知时长）、
 * 背书判定（decideEndorsement：id/同曲变体命中、skip 恒否）、画像加成（localBonus 方向与 ±10 收敛）、
 * 摘要条件（summaryDue）与提示词构建（buildSummaryPrompt 输入口径与 D12 措辞约束）、
 * 宽松水合（hydrateProfile：有效保留、垃圾缺省、重启续增）。
 * 编排（profile.ts，依赖事件桥/落盘/播放器）不在本文件测试范围（集成层，见 TP-2）。
 */
import { describe, expect, it } from 'vitest'
import {
  COMPLETE_LISTEN_RATIO,
  MAX_ARTISTS,
  MAX_EVENTS,
  PROFILE_BONUS_LIMIT,
  SUMMARY_DUE_DELTA,
  buildSummaryPrompt,
  createProfileState,
  decideEndorsement,
  hydrateProfile,
  isCompleteListen,
  isDuplicateLoveSignal,
  localBonus,
  reduceProfileSignal,
  summaryDue,
} from './profile-core'
import type { ArtistCounts, ProfileEvent, ProfileSignal, ProfileState } from './profile-core'

/** 构造分信号计数条目。 */
const counts = (love = 0, complete = 0, skip = 0): ArtistCounts => ({ love, complete, skip })

/** 构造指定艺人单类信号的画像状态（directly seed，不走 reducer 以降低测试间耦合）。 */
const stateWithArtist = (artist: string, entry: ArtistCounts): ProfileState => ({
  ...createProfileState(),
  artistCounts: { [artist]: entry },
})

const loveSignal = (artist: string, extra?: Partial<ProfileSignal>): ProfileSignal => ({ kind: 'love', artist, ...extra })

describe('reduceProfileSignal - 信号归并', () => {
  it('love 信号：loves+1、艺人 love 计数+1、事件缓冲追加，返回新对象', () => {
    // arrange
    const state = createProfileState()
    // act
    const next = reduceProfileSignal(state, { kind: 'love', artist: '陈奕迅', title: '富士山下', id: 'kw_1' })
    // assert
    expect(next).not.toBe(state)
    expect(next.loves).toBe(1)
    expect(next.completes).toBe(0)
    expect(next.skips).toBe(0)
    expect(next.artistCounts['陈奕迅']).toEqual({ love: 1, complete: 0, skip: 0 })
    expect(next.events).toEqual([{ kind: 'love', artist: '陈奕迅', title: '富士山下' }])
  })

  it('complete 信号：completes+1、艺人 complete 计数+1', () => {
    // act
    const next = reduceProfileSignal(createProfileState(), { kind: 'complete', artist: 'Adele', title: 'Hello' })
    // assert
    expect(next.completes).toBe(1)
    expect(next.artistCounts.Adele).toEqual({ love: 0, complete: 1, skip: 0 })
    expect(next.events).toEqual([{ kind: 'complete', artist: 'Adele', title: 'Hello' }])
  })

  it('skip 信号：skips+1、艺人 skip 计数+1', () => {
    // act
    const next = reduceProfileSignal(createProfileState(), { kind: 'skip', artist: '噪音艺人', title: '噪音曲' })
    // assert
    expect(next.skips).toBe(1)
    expect(next.artistCounts['噪音艺人']).toEqual({ love: 0, complete: 0, skip: 1 })
  })

  it('同一艺人多类信号在同一计数条目上累计', () => {
    // arrange
    let state = createProfileState()
    // act
    state = reduceProfileSignal(state, loveSignal('陈奕迅', { title: '富士山下' }))
    state = reduceProfileSignal(state, { kind: 'complete', artist: ' 陈奕迅 ', title: '富士山下' })
    state = reduceProfileSignal(state, { kind: 'skip', artist: '陈奕迅', title: '淘汰' })
    // assert
    expect(state.loves).toBe(1)
    expect(state.completes).toBe(1)
    expect(state.skips).toBe(1)
    expect(state.artistCounts['陈奕迅']).toEqual({ love: 1, complete: 1, skip: 1 })
    expect(Object.keys(state.artistCounts)).toHaveLength(1)
  })

  it('无效 kind 与空艺人信号原样返回（垃圾值不污染，总计数也不计）', () => {
    // arrange
    const state = reduceProfileSignal(createProfileState(), loveSignal('陈奕迅', { title: '富士山下' }))
    // act & assert
    expect(reduceProfileSignal(state, { kind: 'dance', artist: 'Adele' })).toBe(state)
    expect(reduceProfileSignal(state, { kind: '', artist: 'Adele' })).toBe(state)
    expect(reduceProfileSignal(state, loveSignal(''))).toBe(state)
    expect(reduceProfileSignal(state, loveSignal('   '))).toBe(state)
  })

  it('null/undefined 状态与信号防御：不抛错、可继续归并', () => {
    // act & assert
    expect(reduceProfileSignal(undefined, loveSignal('陈奕迅', { title: '富士山下' })).loves).toBe(1)
    expect(reduceProfileSignal(null, null).loves).toBe(0)
    const state = createProfileState()
    expect(reduceProfileSignal(state, undefined)).toBe(state)
  })

  it('不可变转移：不修改入参状态', () => {
    // arrange
    const state = reduceProfileSignal(createProfileState(), loveSignal('陈奕迅', { title: '富士山下' }))
    const snapshotBefore = JSON.parse(JSON.stringify(state))
    // act
    reduceProfileSignal(state, { kind: 'complete', artist: 'Adele', title: 'Hello' })
    // assert
    expect(state).toEqual(snapshotBefore)
  })

  it('滚动事件缓冲超过上限丢弃最旧（FIFO），缓冲长度恒不超过上限', () => {
    // arrange
    const events: ProfileEvent[] = Array.from({ length: MAX_EVENTS }, (_, i) => ({ kind: 'love', artist: `艺人${i}`, title: `作品${i}` }))
    const seeded: ProfileState = { ...createProfileState(), loves: MAX_EVENTS, events }
    // act
    const next = reduceProfileSignal(seeded, { kind: 'complete', artist: '新艺人', title: '新曲' })
    // assert
    expect(next.events).toHaveLength(MAX_EVENTS)
    expect(next.events[0]).toEqual({ kind: 'love', artist: '艺人1', title: '作品1' })
    expect(next.events[MAX_EVENTS - 1]).toEqual({ kind: 'complete', artist: '新艺人', title: '新曲' })
  })

  it('艺人表按证据量截断到上限（连续累计 250 位艺人后恒为 Top200），总计数不受影响', () => {
    // arrange & act
    let state = createProfileState()
    for (let i = 0; i < MAX_ARTISTS + 50; i++) {
      state = reduceProfileSignal(state, loveSignal(`艺人${i}`, { title: '作品' }))
    }
    // assert
    expect(Object.keys(state.artistCounts)).toHaveLength(MAX_ARTISTS)
    expect(state.loves).toBe(MAX_ARTISTS + 50)
  })

  it('艺人表截断淘汰证据量最低者：仅 1 条证据的新艺人淘汰于存量高证据表', () => {
    // arrange
    const seeded: ProfileState = {
      ...createProfileState(),
      loves: MAX_ARTISTS * 2,
      artistCounts: Object.fromEntries(Array.from({ length: MAX_ARTISTS }, (_, i) => [`存量艺人${i}`, counts(2)])),
    }
    // act
    const next = reduceProfileSignal(seeded, loveSignal('新艺人', { title: '新曲' }))
    // assert
    expect(Object.keys(next.artistCounts)).toHaveLength(MAX_ARTISTS)
    expect(next.artistCounts['新艺人']).toBeUndefined()
    expect(next.artistCounts['存量艺人0']).toEqual({ love: 2, complete: 0, skip: 0 })
    // 单调总计数器独立于被截断的艺人表继续累计（summaryDue 依赖总计数）
    expect(next.loves).toBe(MAX_ARTISTS * 2 + 1)
  })
})

describe('reduceProfileSignal - love 幂等（同曲重复收藏不产生重复证据）', () => {
  it('同曲（artist+title）重复 love 第二次不动作：返回原状态引用、计数与事件均不增', () => {
    // arrange
    const state = reduceProfileSignal(createProfileState(), { kind: 'love', artist: '陈奕迅', title: '富士山下', id: 'kw_1' })
    // act
    const next = reduceProfileSignal(state, { kind: 'love', artist: '陈奕迅', title: '富士山下', id: 'kw_1' })
    // assert
    expect(next).toBe(state)
    expect(next.loves).toBe(1)
    expect(next.artistCounts['陈奕迅']).toEqual({ love: 1, complete: 0, skip: 0 })
    expect(next.events).toHaveLength(1)
  })

  it('同曲变体写法（艺人大小写/标题空白差异、id 不同）的重复 love 同样幂等——幂等与 id 无关', () => {
    // arrange
    const state = reduceProfileSignal(createProfileState(), { kind: 'love', artist: 'Eason Chan', title: ' 富士山下 ', id: 'kw_1' })
    // act
    const next = reduceProfileSignal(state, { kind: 'love', artist: 'eason chan', title: '富士山下', id: 'kg_9' })
    // assert
    expect(next).toBe(state)
    expect(state.loves).toBe(1)
  })

  it('不同歌的 love 正常计入（同艺人不同名 / 同名不同艺人）', () => {
    // arrange
    let state = reduceProfileSignal(createProfileState(), loveSignal('陈奕迅', { title: '富士山下' }))
    // act
    state = reduceProfileSignal(state, loveSignal('陈奕迅', { title: '淘汰' }))
    state = reduceProfileSignal(state, loveSignal('别的艺人', { title: '富士山下' }))
    // assert
    expect(state.loves).toBe(3)
    expect(state.events).toHaveLength(3)
    expect(state.artistCounts['陈奕迅'].love).toBe(2)
    expect(state.artistCounts['别的艺人'].love).toBe(1)
  })

  it('窗口语义：旧 love 事件被 FIFO 淘汰出缓冲后，同曲再收藏重新计入', () => {
    // arrange：缓冲塞满，旧 love 位于窗口最深处
    const filler: ProfileEvent[] = Array.from({ length: MAX_EVENTS - 1 }, (_, i) => ({ kind: 'complete', artist: `艺人${i}`, title: `曲${i}` }))
    const seeded: ProfileState = { ...createProfileState(), loves: 1, events: [{ kind: 'love', artist: '陈奕迅', title: '富士山下' }, ...filler] }
    // act：喂一条无关信号把旧 love 挤出窗口后再收藏同曲
    const pushed = reduceProfileSignal(seeded, { kind: 'skip', artist: '噪音艺人', title: '噪音曲' })
    expect(pushed.events).toHaveLength(MAX_EVENTS)
    expect(pushed.events.some(e => e.kind === 'love' && e.artist === '陈奕迅')).toBe(false)
    const next = reduceProfileSignal(pushed, loveSignal('陈奕迅', { title: '富士山下' }))
    // assert
    expect(next.loves).toBe(pushed.loves + 1)
    expect(next.artistCounts['陈奕迅']).toEqual({ love: 1, complete: 0, skip: 0 })
    expect(next.events.filter(e => e.kind === 'love')).toHaveLength(1)
  })

  it('complete/skip 重复信号不受幂等限制（重复听完/跳过是合法的重复证据）', () => {
    // arrange
    let state = createProfileState()
    // act
    state = reduceProfileSignal(state, { kind: 'complete', artist: '陈奕迅', title: '富士山下' })
    state = reduceProfileSignal(state, { kind: 'complete', artist: '陈奕迅', title: '富士山下' })
    state = reduceProfileSignal(state, { kind: 'skip', artist: '噪音艺人', title: '噪音曲' })
    state = reduceProfileSignal(state, { kind: 'skip', artist: '噪音艺人', title: '噪音曲' })
    // assert
    expect(state.completes).toBe(2)
    expect(state.skips).toBe(2)
    expect(state.events).toHaveLength(4)
    expect(state.artistCounts['陈奕迅']).toEqual({ love: 0, complete: 2, skip: 0 })
    expect(state.artistCounts['噪音艺人']).toEqual({ love: 0, complete: 0, skip: 2 })
  })
})

describe('isDuplicateLoveSignal - 收藏幂等谓词（reducer 幂等判定与编排层背书广播共用口径）', () => {
  it('事件缓冲已有同曲 love 时为真（含变体写法）；不同曲为否', () => {
    // arrange
    const state = reduceProfileSignal(createProfileState(), { kind: 'love', artist: 'Eason Chan', title: ' 富士山下 ' })
    // act & assert
    expect(isDuplicateLoveSignal(state, { kind: 'love', artist: 'eason chan', title: '富士山下' })).toBe(true)
    expect(isDuplicateLoveSignal(state, { kind: 'love', artist: '陈奕迅', title: '淘汰' })).toBe(false)
  })

  it('kind 非 love 恒否（complete/skip 的重复信号是合法证据，不受幂等保护）', () => {
    // arrange
    const state = reduceProfileSignal(createProfileState(), loveSignal('陈奕迅', { title: '富士山下' }))
    // act & assert
    expect(isDuplicateLoveSignal(state, { kind: 'complete', artist: '陈奕迅', title: '富士山下' })).toBe(false)
    expect(isDuplicateLoveSignal(state, { kind: 'skip', artist: '陈奕迅', title: '富士山下' })).toBe(false)
  })

  it('空艺人/空状态/空信号为否；空曲名不受幂等保护（sameSong 对空 title 恒否，保守承接边界）', () => {
    // arrange：含空曲名 love 事件的状态
    const state: ProfileState = { ...createProfileState(), events: [{ kind: 'love', artist: '陈奕迅', title: '' }] }
    // act & assert
    expect(isDuplicateLoveSignal(state, loveSignal(''))).toBe(false)
    expect(isDuplicateLoveSignal(null, loveSignal('陈奕迅', { title: '富士山下' }))).toBe(false)
    expect(isDuplicateLoveSignal(state, null)).toBe(false)
    expect(isDuplicateLoveSignal(state, { kind: 'love', artist: '陈奕迅', title: '' })).toBe(false)
  })
})

describe('isCompleteListen - 听完判定（≥90% 时长）', () => {
  it('播放恰好 90% 时长为听完（浮点边界安全）', () => {
    // act & assert
    expect(isCompleteListen(90, 100)).toBe(true)
    expect(isCompleteListen(135, 150)).toBe(true)
    expect(isCompleteListen(COMPLETE_LISTEN_RATIO * 200, 200)).toBe(true)
  })

  it('播放不足 90% 不算听完', () => {
    // act & assert
    expect(isCompleteListen(89.99, 100)).toBe(false)
    expect(isCompleteListen(0, 100)).toBe(false)
  })

  it('播放超出时长（拖拽进度等异常累计）按听完处理', () => {
    // act & assert
    expect(isCompleteListen(120, 100)).toBe(true)
  })

  it('时长未知（0/负数/非有限数）恒不判定为听完', () => {
    // act & assert
    expect(isCompleteListen(90, 0)).toBe(false)
    expect(isCompleteListen(90, -10)).toBe(false)
    expect(isCompleteListen(90, Number.NaN)).toBe(false)
    expect(isCompleteListen(90, Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('播放秒数垃圾值按 0 处理', () => {
    // act & assert
    expect(isCompleteListen(Number.NaN, 100)).toBe(false)
    expect(isCompleteListen(-5, 100)).toBe(false)
  })
})

describe('decideEndorsement - 背书判定', () => {
  const recommended = [
    { id: 'kw_1', artist: '陈奕迅', title: '富士山下' },
    { id: 'wy_2', artist: 'mpi, Laco, Benjamin, 薄野弘之', title: 'Möbius' },
  ]

  it('love 信号 id 命中推荐集 → 返回艺人名', () => {
    // act & assert
    expect(decideEndorsement(recommended, { kind: 'love', id: 'kw_1', artist: '陈奕迅', title: '富士山下' })).toBe('陈奕迅')
  })

  it('complete 信号同曲变体命中（id 不同、title 相同且艺人 token 有交集）→ 返回推荐集侧艺人名', () => {
    // act & assert
    expect(decideEndorsement(recommended, { kind: 'complete', id: 'kg_x', artist: 'Benjamin, Laco', title: 'Möbius' })).toBe('mpi, Laco, Benjamin, 薄野弘之')
  })

  it('skip 信号即使命中推荐集也恒否（跳过只进画像降权，不构成背书）', () => {
    // act & assert
    expect(decideEndorsement(recommended, { kind: 'skip', id: 'kw_1', artist: '陈奕迅', title: '富士山下' })).toBeNull()
  })

  it('love 信号未命中推荐集（id 与 sameSong 均不中）→ null，只进画像', () => {
    // act & assert
    expect(decideEndorsement(recommended, loveSignal('宇多田光', { id: 'kw_9', title: 'First Love' }))).toBeNull()
  })

  it('同名不同艺人的曲目不算同曲命中', () => {
    // act & assert
    expect(decideEndorsement(recommended, loveSignal('别的艺人', { title: '富士山下' }))).toBeNull()
  })

  it('空艺人信号恒否（背书须可归因艺人）', () => {
    // act & assert
    expect(decideEndorsement(recommended, { kind: 'love', id: 'kw_1', artist: ' ', title: '富士山下' })).toBeNull()
  })

  it('推荐集条目仅携 id 时 id 命中回退信号侧艺人名', () => {
    // act & assert
    expect(decideEndorsement([{ id: 'kw_1' }], { kind: 'love', id: 'kw_1', artist: '陈奕迅', title: '富士山下' })).toBe('陈奕迅')
  })

  it('推荐集或信号为 null/undefined → null', () => {
    // act & assert
    expect(decideEndorsement(null, loveSignal('陈奕迅', { title: '富士山下' }))).toBeNull()
    expect(decideEndorsement(undefined, undefined)).toBeNull()
    expect(decideEndorsement(recommended, null)).toBeNull()
  })
})

describe('localBonus - 画像排序加成（[-10, +10]）', () => {
  it('无记录的艺人、空艺人名、null 状态均为 0', () => {
    // arrange
    const state = stateWithArtist('陈奕迅', counts(1))
    // act & assert
    expect(localBonus(state, 'Adele')).toBe(0)
    expect(localBonus(state, ' ')).toBe(0)
    expect(localBonus(null, '陈奕迅')).toBe(0)
    expect(localBonus(undefined, undefined)).toBe(0)
  })

  it('loves 重于 completes：同为 1 条证据时 love 加分更高，complete 为正', () => {
    // act & assert
    expect(localBonus(stateWithArtist('X', counts(1)), 'X')).toBeGreaterThan(localBonus(stateWithArtist('X', counts(0, 1)), 'X'))
    expect(localBonus(stateWithArtist('X', counts(0, 1)), 'X')).toBeGreaterThan(0)
  })

  it('skips 为负向（降分）', () => {
    // act & assert
    expect(localBonus(stateWithArtist('X', counts(0, 0, 1)), 'X')).toBeLessThan(0)
  })

  it('正向证据叠加封顶 +10', () => {
    // act & assert
    expect(localBonus(stateWithArtist('X', counts(3)), 'X')).toBe(PROFILE_BONUS_LIMIT)
    expect(localBonus(stateWithArtist('X', counts(10)), 'X')).toBe(PROFILE_BONUS_LIMIT)
    expect(localBonus(stateWithArtist('X', counts(0, 50)), 'X')).toBe(PROFILE_BONUS_LIMIT)
  })

  it('负向证据叠加下限 -10', () => {
    // act & assert
    expect(localBonus(stateWithArtist('X', counts(0, 0, 10)), 'X')).toBe(-PROFILE_BONUS_LIMIT)
  })

  it('正负净额合成：重 love 覆盖轻 skip 后仍为正', () => {
    // act & assert
    expect(localBonus(stateWithArtist('X', counts(3, 0, 2)), 'X')).toBeGreaterThan(0)
    expect(localBonus({ ...createProfileState(), artistCounts: { X: { love: 5, complete: 4, skip: 3 } } }, 'X')).toBe(PROFILE_BONUS_LIMIT)
  })
})

describe('summaryDue - 摘要重写条件（≥20 新正向事件）', () => {
  it('全新状态未达阈值', () => {
    // act & assert
    expect(summaryDue(createProfileState())).toBe(false)
  })

  it('无摘要时 basedOnCount 按 0 计：累计 20 个正向事件触发首轮', () => {
    // arrange
    let state = createProfileState()
    for (let i = 0; i < SUMMARY_DUE_DELTA - 1; i++) state = reduceProfileSignal(state, loveSignal(`艺人${i}`, { title: '曲' }))
    state = reduceProfileSignal(state, { kind: 'complete', artist: '陈奕迅', title: '富士山下' })
    // act & assert
    expect(state.loves + state.completes).toBe(SUMMARY_DUE_DELTA)
    expect(state.summary).toBeNull()
    expect(summaryDue(state)).toBe(true)
  })

  it('累计 19 个正向事件不触发', () => {
    // arrange
    let state = createProfileState()
    for (let i = 0; i < SUMMARY_DUE_DELTA - 1; i++) state = reduceProfileSignal(state, loveSignal(`艺人${i}`, { title: '曲' }))
    // act & assert
    expect(summaryDue(state)).toBe(false)
  })

  it('已有摘要时按 basedOnCount 增量判定：+19 不触发、+20 触发', () => {
    // arrange
    const base: ProfileState = { ...createProfileState(), loves: 40, completes: 10, summary: { text: '偏爱华语流行与摇滚。', basedOnCount: 31 } }
    // act & assert
    expect(summaryDue(base)).toBe(false)
    expect(summaryDue({ ...base, loves: 41 })).toBe(true)
  })

  it('skips 不计入正向增量', () => {
    // arrange
    const state: ProfileState = { ...createProfileState(), loves: SUMMARY_DUE_DELTA - 1, skips: 500 }
    // act & assert
    expect(summaryDue(state)).toBe(false)
  })
})

describe('buildSummaryPrompt - 摘要提示词构建（D7/D12）', () => {
  it('返回 llmComplete 可消费的消息序列（system + user，content 非空）', () => {
    // arrange
    const state = reduceProfileSignal(createProfileState(), loveSignal('陈奕迅', { title: '富士山下' }))
    // act
    const messages = buildSummaryPrompt(state)
    // assert
    expect(Array.isArray(messages)).toBe(true)
    expect(messages.map(message => message.role)).toEqual(['system', 'user'])
    for (const message of messages) {
      expect(typeof message.content).toBe('string')
      expect(message.content.length).toBeGreaterThan(0)
    }
  })

  it('user 消息含 Top 艺人计数明细与最近事件描述', () => {
    // arrange
    let state = createProfileState()
    state = reduceProfileSignal(state, loveSignal('陈奕迅', { title: '富士山下' }))
    state = reduceProfileSignal(state, { kind: 'skip', artist: '噪音艺人', title: '噪音曲' })
    // act
    const messages = buildSummaryPrompt(state)
    const user = messages[1].content
    // assert
    expect(user).toContain('陈奕迅')
    expect(user).toContain('收藏')
    expect(user).toContain('噪音艺人')
  })

  it('艺人输入口径为 Top50：证据量 51 名开外不进提示词', () => {
    // arrange
    const artistCounts = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`计数艺人${String(i).padStart(3, '0')}`, counts(i + 1)]))
    const state: ProfileState = { ...createProfileState(), artistCounts }
    // act
    const user = buildSummaryPrompt(state)[1].content
    // assert
    expect(user).toContain('计数艺人059')
    expect(user).toContain('计数艺人010')
    expect(user).not.toContain('计数艺人009')
  })

  it('事件输入口径为最近 100 条：更早的事件不进提示词', () => {
    // arrange
    const events: ProfileEvent[] = Array.from({ length: 120 }, (_, i) => ({ kind: 'love', artist: `事件艺人${String(i).padStart(3, '0')}`, title: '曲' }))
    const state: ProfileState = { ...createProfileState(), events }
    // act
    const user = buildSummaryPrompt(state)[1].content
    // assert
    expect(user).not.toContain('事件艺人019')
    expect(user).toContain('事件艺人020')
    expect(user).toContain('事件艺人119')
  })

  it('提示词含 D12 措辞约束：只正向描述偏好、不含指令式措辞、不超过 200 字', () => {
    // act
    const system = buildSummaryPrompt(createProfileState())[0].content
    // assert
    expect(system).toContain('只正向描述偏好')
    expect(system).toContain('指令式措辞')
    expect(system).toContain('200')
  })

  it('零态输入仍产出结构完整消息（编排层按 summaryDue 门控，本函数不防御性拒绝）', () => {
    // act
    const messages = buildSummaryPrompt(createProfileState())
    // assert
    expect(messages.map(message => message.role)).toEqual(['system', 'user'])
  })
})

describe('hydrateProfile - 快照宽松水合', () => {
  it('null/数组/非对象 → 零态', () => {
    // act & assert
    expect(hydrateProfile(null)).toEqual(createProfileState())
    expect(hydrateProfile(undefined)).toEqual(createProfileState())
    expect(hydrateProfile([])).toEqual(createProfileState())
    expect(hydrateProfile('junk')).toEqual(createProfileState())
  })

  it('完整快照 JSON round-trip 水合后一致（重启延续，AC6）', () => {
    // arrange
    let state = createProfileState()
    state = reduceProfileSignal(state, loveSignal('陈奕迅', { title: '富士山下', id: 'kw_1' }))
    state = reduceProfileSignal(state, { kind: 'complete', artist: '陈奕迅', title: '富士山下' })
    state = reduceProfileSignal(state, { kind: 'skip', artist: '噪音艺人', title: '噪音曲' })
    state = { ...state, summary: { text: '偏爱华语流行。', basedOnCount: 2 } }
    // act
    const hydrated = hydrateProfile(JSON.parse(JSON.stringify(state)))
    // assert
    expect(hydrated).toEqual(state)
  })

  it('计数器垃圾值归一：非数/负数/无穷按 0，浮点取整', () => {
    // act
    const hydrated = hydrateProfile({ loves: 'abc', completes: -3, skips: Number.POSITIVE_INFINITY })
    // assert
    expect(hydrated.loves).toBe(0)
    expect(hydrated.completes).toBe(0)
    expect(hydrated.skips).toBe(0)
    expect(hydrateProfile({ loves: 2.9 }).loves).toBe(2)
  })

  it('艺人表垃圾条目剔除、空白同名归并、全零条目不保留', () => {
    // act
    const hydrated = hydrateProfile({
      artistCounts: {
        陈奕迅: { love: 2, complete: 1, skip: 0 },
        ' 陈奕迅 ': { love: 1 },
        ' ': { love: 5 },
        ' Adele': { love: 'junk', complete: 3 },
        幽灵: counts(0, 0, 0),
        噪音: 'not-an-object',
      },
    })
    // assert
    expect(hydrated.artistCounts['陈奕迅']).toEqual({ love: 3, complete: 1, skip: 0 })
    expect(hydrated.artistCounts.Adele).toEqual({ love: 0, complete: 3, skip: 0 })
    expect(Object.keys(hydrated.artistCounts).sort()).toEqual(['Adele', '陈奕迅'])
  })

  it('艺人表超出上限水合时截断并保留高证据量艺人', () => {
    // arrange
    const artistCounts = Object.fromEntries(Array.from({ length: MAX_ARTISTS + 50 }, (_, i) => [`艺人${String(i).padStart(3, '0')}`, counts(i + 1)]))
    // act
    const hydrated = hydrateProfile({ artistCounts })
    // assert
    expect(Object.keys(hydrated.artistCounts)).toHaveLength(MAX_ARTISTS)
    expect(hydrated.artistCounts['艺人249']).toEqual({ love: 250, complete: 0, skip: 0 })
    expect(hydrated.artistCounts['艺人000']).toBeUndefined()
  })

  it('事件缓冲超出上限仅保留最近部分', () => {
    // arrange
    const valid = (i: number): ProfileEvent => ({ kind: 'complete', artist: `艺人${i}`, title: `曲${i}` })
    const events = Array.from({ length: MAX_EVENTS + 10 }, (_, i) => valid(i))
    // act
    const hydrated = hydrateProfile({ events })
    // assert
    expect(hydrated.events).toHaveLength(MAX_EVENTS)
    expect(hydrated.events[0]).toEqual(valid(10))
    expect(hydrated.events[MAX_EVENTS - 1]).toEqual(valid(MAX_EVENTS + 9))
  })

  it('事件缓冲垃圾条目剔除（非法 kind / 空艺人 / 非对象条目）', () => {
    // act
    const hydrated = hydrateProfile({
      events: [
        { kind: 'dance', artist: 'Adele', title: 'Hello' },
        { kind: 'love', artist: '', title: 'Hello' },
        'junk-array-item',
        { kind: 'love', artist: '陈奕迅' },
      ],
    })
    // assert
    expect(hydrated.events).toEqual([{ kind: 'love', artist: '陈奕迅', title: '' }])
  })

  it('summary：文本缺失/非串 → null；basedOnCount 垃圾按 0（摘要文本保留）', () => {
    // act & assert
    expect(hydrateProfile({ summary: { text: '', basedOnCount: 5 } }).summary).toBeNull()
    expect(hydrateProfile({ summary: { text: 123, basedOnCount: 5 } }).summary).toBeNull()
    expect(hydrateProfile({ summary: 'not-object' }).summary).toBeNull()
    expect(hydrateProfile({ summary: { text: '偏爱摇滚', basedOnCount: 'junk' } }).summary).toEqual({ text: '偏爱摇滚', basedOnCount: 0 })
    expect(hydrateProfile({ summary: { text: '偏爱摇滚', basedOnCount: 7.9 } }).summary).toEqual({ text: '偏爱摇滚', basedOnCount: 7 })
  })

  it('水合结果可继续归并（计数在旧值上续增）', () => {
    // arrange
    const hydrated = hydrateProfile({ loves: 10, artistCounts: { 陈奕迅: { love: 2 } } })
    // act
    const next = reduceProfileSignal(hydrated, loveSignal('陈奕迅', { title: '十年' }))
    // assert
    expect(next.loves).toBe(11)
    expect(next.artistCounts['陈奕迅']).toEqual({ love: 3, complete: 0, skip: 0 })
  })
})
