/**
 * 探索会话状态机的纯逻辑测试（T-B2）。
 *
 * 覆盖：半径加减界、艺人去重、remaining 阈值、path 追加顺序、反馈后的续补指令拼接。
 * 会话编排（session.ts，依赖播放器/事件/引擎）不在本文件测试范围，见 T-B2 报告。
 */
import { describe, expect, it } from 'vitest'
import { negativeFromInstruction } from './judgment'
import {
  RADIUS_DEFAULT,
  RADIUS_MAX,
  RADIUS_MIN,
  addRecommendedIds,
  appendToPath,
  applyFeedback,
  buildReplanInstruction,
  clampRadius,
  computeRefillNeed,
  createSession,
  toView,
  updateInstruction,
  updateRadius,
} from './session-core'
import type { SessionAnchor, SessionState } from './session-core'

const anchor: SessionAnchor = {
  id: 'anchor-1',
  artist: '陈奕迅',
  title: '富士山下',
  album: "What's Going On…?",
  pic: 'https://example.com/pic.jpg',
}

const create = (): SessionState => createSession(anchor)

const plannedItem = (id: string, artist: string, title: string) => ({
  id,
  artist,
  title,
  album: '',
  reason: '它接住了起点没有说完的那一部分',
  journeyRole: 'open',
  state: 'planned' as const,
})

describe('clampRadius - 探索距离边界', () => {
  it('小于下限的值收敛到 10', () => {
    // act & assert
    expect(clampRadius(0)).toBe(RADIUS_MIN)
    expect(clampRadius(-5)).toBe(RADIUS_MIN)
  })

  it('大于上限的值收敛到 90', () => {
    // act & assert
    expect(clampRadius(100)).toBe(RADIUS_MAX)
    expect(clampRadius(120)).toBe(RADIUS_MAX)
  })

  it('范围内的值保持不变', () => {
    // act & assert
    expect(clampRadius(35)).toBe(35)
    expect(clampRadius(10)).toBe(10)
    expect(clampRadius(90)).toBe(90)
  })

  it('非数值回退默认 35', () => {
    // act & assert
    expect(clampRadius(Number.NaN)).toBe(RADIUS_DEFAULT)
  })
})

describe('createSession - 创建会话', () => {
  it('默认半径 35，反馈列表与前提交为空，active 为 true', () => {
    // act
    const state = create()
    // assert
    expect(state.active).toBe(true)
    expect(state.radius).toBe(RADIUS_DEFAULT)
    expect(state.anchor).toEqual(anchor)
    expect(state.instruction).toBe('')
    expect(state.positiveArtists).toEqual([])
    expect(state.negativeArtists).toEqual([])
    expect(state.recommendedIds).toEqual([])
    expect(state.path).toEqual([])
  })

  it('支持自定义初始半径与指令', () => {
    // act
    const state = createSession(anchor, { radius: 60, instruction: '更冷一点' })
    // assert
    expect(state.radius).toBe(60)
    expect(state.instruction).toBe('更冷一点')
  })
})

describe('updateRadius/updateInstruction - 滑杆与约束更新', () => {
  it('更新半径时按 10-90 收敛', () => {
    // act
    const state = updateRadius(create(), 5)
    // assert
    expect(state.radius).toBe(RADIUS_MIN)
  })

  it('更新指令后原样保留', () => {
    // act
    const state = updateInstruction(create(), '不要华语')
    // assert
    expect(state.instruction).toBe('不要华语')
  })
})

describe('applyFeedback - 反馈转移', () => {
  it('far：半径减 8（下限 10），当前艺人进入 negativeArtists', () => {
    // act
    const state = applyFeedback(create(), 'far', '陈奕迅')
    // assert
    expect(state.radius).toBe(RADIUS_DEFAULT - 8)
    expect(state.negativeArtists).toEqual(['陈奕迅'])
    expect(state.positiveArtists).toEqual([])
  })

  it('far 反复应用：半径不越过下限 10', () => {
    // arrange
    let state = createSession(anchor, { radius: 12 })
    // act
    state = applyFeedback(state, 'far', '陈奕迅')
    state = applyFeedback(state, 'far', 'Michael Jackson')
    // assert
    expect(state.radius).toBe(RADIUS_MIN)
  })

  it('good：半径不变，当前艺人进入 positiveArtists', () => {
    // act
    const state = applyFeedback(create(), 'good', '陈奕迅')
    // assert
    expect(state.radius).toBe(RADIUS_DEFAULT)
    expect(state.positiveArtists).toEqual(['陈奕迅'])
    expect(state.negativeArtists).toEqual([])
  })

  it('同一艺人重复反馈只保留一条（去重）', () => {
    // act
    let state = create()
    state = applyFeedback(state, 'far', 'Adele')
    state = applyFeedback(state, 'far', 'Adele')
    state = applyFeedback(state, 'good', 'Adele')
    state = applyFeedback(state, 'good', 'Adele')
    // assert
    expect(state.negativeArtists).toEqual(['Adele'])
    expect(state.positiveArtists).toEqual(['Adele'])
  })

  it('反馈不影响 path 与 recommendedIds（不跳过当前歌）', () => {
    // arrange
    let state = create()
    state = addRecommendedIds(state, ['r1'])
    state = appendToPath(state, plannedItem('r1', 'Adele', 'Hello'))
    // act
    state = applyFeedback(state, 'far', 'Adele')
    // assert
    expect(state.path).toHaveLength(1)
    expect(state.path[0].state).toBe('planned')
    expect(state.recommendedIds).toEqual(['r1'])
  })
})

describe('computeRefillNeed - 队列剩余阈值', () => {
  it('剩余 3 首时触发续补（<=3）', () => {
    // act & assert
    expect(computeRefillNeed(['a', 'b', 'c'])).toBe(true)
  })

  it('剩余 4 首时不触发', () => {
    // act & assert
    expect(computeRefillNeed(['a', 'b', 'c', 'd'])).toBe(false)
  })

  it('剩余 0 首（队列被清空）时触发', () => {
    // act & assert
    expect(computeRefillNeed([])).toBe(true)
  })

  it('阈值可自定义', () => {
    // act & assert
    expect(computeRefillNeed(['a', 'b', 'c', 'd'], 4)).toBe(true)
    expect(computeRefillNeed(['a', 'b', 'c', 'd'], 3)).toBe(false)
  })
})

describe('addRecommendedIds - 推荐 id 集合', () => {
  it('追加并去重', () => {
    // act
    let state = create()
    state = addRecommendedIds(state, ['r1', 'r2'])
    state = addRecommendedIds(state, ['r2', 'r3'])
    // assert
    expect(state.recommendedIds).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('appendToPath - 路径追加顺序', () => {
  it('按听过的顺序追加，state 为 played', () => {
    // arrange
    let state = create()
    state = appendToPath(state, { ...plannedItem('r1', 'Adele', 'Hello'), state: 'played' })
    state = appendToPath(state, { ...plannedItem('r2', 'Coldplay', 'Yellow'), state: 'played' })
    // assert
    expect(state.path.map(p => p.id)).toEqual(['r1', 'r2'])
    expect(state.path.every(p => p.state === 'played')).toBe(true)
  })

  it('同一 id 只保留一条（planned 更新为 played，位置不变）', () => {
    // arrange
    let state = create()
    state = appendToPath(state, plannedItem('r1', 'Adele', 'Hello'))
    // act
    state = appendToPath(state, { ...plannedItem('r1', 'Adele', 'Hello'), state: 'played' })
    // assert
    expect(state.path).toHaveLength(1)
    expect(state.path[0].state).toBe('played')
  })

  it('无 id 条目（历史兼容）按追加处理', () => {
    // arrange
    let state = create()
    // act
    state = appendToPath(state, { ...plannedItem('', 'Adele', 'Hello'), id: null, state: 'played' })
    // assert
    expect(state.path).toHaveLength(1)
  })

  it('同曲不同 id 变体合并为一条（位置不变，字段取后来传入的 item）', () => {
    // arrange（同一首歌两个平台变体：artist 串顺序不同、id 不同）
    let state = create()
    state = appendToPath(state, plannedItem('r1', 'mpi, Laco, Benjamin, 薄野弘之', 'Möbius'))
    state = appendToPath(state, plannedItem('r1-other', 'Adele', 'Hello'))
    // act
    state = appendToPath(state, plannedItem('r2', 'Benjamin, Laco, 薄野弘之', 'Möbius'))
    // assert（Möbius 变体合并为一条且位置不变，字段取后来传入的 item）
    expect(state.path).toHaveLength(2)
    expect(state.path[0].id).toBe('r2')
    expect(state.path[0].artist).toBe('Benjamin, Laco, 薄野弘之')
    expect(state.path[1].id).toBe('r1-other')
  })

  it('不同曲照常追加两条', () => {
    // arrange
    let state = create()
    // act
    state = appendToPath(state, plannedItem('r1', 'Adele', 'Hello'))
    state = appendToPath(state, plannedItem('r2', 'Coldplay', 'Yellow'))
    // assert
    expect(state.path.map(p => p.id)).toEqual(['r1', 'r2'])
  })
})

describe('buildReplanInstruction - 反馈拼接一句话', () => {
  it('positive 与 negative 都拼进续补指令（空格分隔，避免 negativeFromInstruction 粘词）', () => {
    // arrange
    let state = create()
    state = applyFeedback(state, 'good', 'Adele')
    state = applyFeedback(state, 'far', '陈奕迅')
    // act
    const instruction = buildReplanInstruction(state)
    // assert
    expect(instruction).toBe('近一点的方向：Adele；不要 陈奕迅')
  })

  it('negative 分词可被 negativeFromInstruction 正确提取（T-B0 兼容）', () => {
    // arrange
    let state = create()
    state = applyFeedback(state, 'far', 'Adele')
    state = applyFeedback(state, 'far', '陈奕迅')
    // act
    const tokens = negativeFromInstruction(`${buildReplanInstruction(state)}；更冷一点`)
    // assert（T-B0 按 [、/\s]+ 切词：空格分隔的复合名会被拆成多个词元，此处用单一词元艺人）
    expect(tokens.split(' ')).toEqual(['Adele', '陈奕迅'])
    expect(tokens).not.toContain('：')
  })

  it('无反馈时返回空串', () => {
    // act & assert
    expect(buildReplanInstruction(create())).toBe('')
  })
})

describe('toView - 页面视图', () => {
  it('输出路径条目带 isCurrent 标记与剩余计数', () => {
    // arrange
    let state = create()
    state = addRecommendedIds(state, ['r1'])
    state = appendToPath(state, { ...plannedItem('r1', 'Adele', 'Hello'), state: 'played' })
    // act
    const view = toView(state, { currentId: 'r1', remaining: 2 })
    // assert
    expect(view.remaining).toBe(2)
    expect(view.path).toHaveLength(1)
    expect(view.path[0].isCurrent).toBe(true)
    expect(view.anchor.title).toBe('富士山下')
  })

  it('非当前曲目 isCurrent 为 false', () => {
    // arrange
    let state = create()
    state = appendToPath(state, { ...plannedItem('r1', 'Adele', 'Hello'), state: 'played' })
    // act
    const view = toView(state, { currentId: 'other', remaining: 0 })
    // assert
    expect(view.path[0].isCurrent).toBe(false)
  })
})
