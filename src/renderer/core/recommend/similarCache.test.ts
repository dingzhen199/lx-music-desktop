import { describe, expect, it } from 'vitest'
import { SimilarCandidateCache } from './similarCache'

const item = (id: string) => ({ musicInfo: { id } as unknown as LX.Music.MusicInfo, rank: 1 })

describe('相似候选缓存（TTL/容量/LRU）', () => {
  it('命中返回条目并刷新热度；未命中返回 null', () => {
    let now = 1000
    const cache = new SimilarCandidateCache(3, 1000, () => now)
    cache.set('wy', '123', [item('wy_1')])
    expect(cache.get('wy', '123')?.items).toHaveLength(1)
    expect(cache.get('wy', '456')).toBeNull()
    now += 999
    expect(cache.get('wy', '123')).not.toBeNull()
    now += 2
    expect(cache.get('wy', '123')).toBeNull()
    // 过期条目被淘汰
    expect(cache.size).toBe(0)
  })

  it('容量上限：LRU 淘汰最久未用条目', () => {
    let now = 0
    const cache = new SimilarCandidateCache(2, 10_000, () => now)
    cache.set('wy', '1', [])
    cache.set('wy', '2', [])
    // 触碰 1 → 2 变为最旧
    cache.get('wy', '1')
    cache.set('wy', '3', [])
    expect(cache.get('wy', '2')).toBeNull()
    expect(cache.get('wy', '1')).not.toBeNull()
    expect(cache.get('wy', '3')).not.toBeNull()
    expect(cache.size).toBe(2)
  })

  it('缓存键按平台+种子区分；账号上下文参与键', () => {
    const cache = new SimilarCandidateCache()
    cache.set('wy', '123', [item('wy_1')])
    cache.set('tx', '123', [item('tx_1')])
    expect(cache.get('wy', '123')?.items[0].musicInfo.id).toBe('wy_1')
    expect(cache.get('tx', '123')?.items[0].musicInfo.id).toBe('tx_1')
    cache.set('wy', '123', [item('wy_2')], 'account-b')
    expect(cache.get('wy', '123')?.items[0].musicInfo.id).toBe('wy_1')
    expect(cache.get('wy', '123', 'account-b')?.items[0].musicInfo.id).toBe('wy_2')
  })

  it('真实空列表可缓存（平台真实答案），读取返回空条目', () => {
    const cache = new SimilarCandidateCache()
    cache.set('wy', '777', [])
    expect(cache.get('wy', '777')?.items).toEqual([])
  })

  it('同键重写覆盖旧值', () => {
    const cache = new SimilarCandidateCache()
    cache.set('wy', '1', [item('a')])
    cache.set('wy', '1', [item('b')])
    expect(cache.get('wy', '1')?.items[0].musicInfo.id).toBe('b')
    expect(cache.size).toBe(1)
  })

  it('clear 清空全部', () => {
    const cache = new SimilarCandidateCache()
    cache.set('wy', '1', [])
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('wy', '1')).toBeNull()
  })
})
