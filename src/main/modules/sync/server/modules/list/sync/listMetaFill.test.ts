import { describe, expect, it } from 'vitest'
import { fillMetaField, fillUserListMeta } from './listMetaFill'

const buildList = (meta: { cover?: string | null, desc?: string | null, author?: string | null }): LX.List.UserListInfo => ({
  id: 'kg_abc123',
  name: '我的歌单',
  source: 'kg',
  sourceListId: 'abc123',
  locationUpdateTime: 1700000000,
  ...meta,
})

describe('fillMetaField - 单字段空值保留', () => {
  it('source 非空时保留 source', () => {
    // act & assert
    expect(fillMetaField('https://img/cover.jpg', 'https://img/local.jpg')).toBe('https://img/cover.jpg')
  })

  it('source 为 null/undefined/空串时回退 target', () => {
    // act & assert
    expect(fillMetaField(null, 'https://img/local.jpg')).toBe('https://img/local.jpg')
    expect(fillMetaField(undefined, 'https://img/local.jpg')).toBe('https://img/local.jpg')
    expect(fillMetaField('', 'https://img/local.jpg')).toBe('https://img/local.jpg')
  })

  it('两侧都为空时得到 null', () => {
    // act & assert
    expect(fillMetaField(null, undefined)).toBeNull()
    expect(fillMetaField('', '')).toBe('')
  })
})

describe('fillUserListMeta - 首次同步保留本地列表元数据', () => {
  it('来源侧空字段从目标侧填充', () => {
    // arrange
    const source = buildList({ cover: null, desc: undefined, author: '' })
    const target = buildList({ cover: 'https://img/cover.jpg', desc: '本地简介', author: '本地作者' })

    // act
    fillUserListMeta(source, target)

    // assert
    expect(source.cover).toBe('https://img/cover.jpg')
    expect(source.desc).toBe('本地简介')
    expect(source.author).toBe('本地作者')
  })

  it('来源侧非空字段不被目标侧覆盖', () => {
    // arrange
    const source = buildList({ cover: 'https://img/remote.jpg', desc: '远端简介', author: '远端作者' })
    const target = buildList({ cover: 'https://img/local.jpg', desc: '本地简介', author: '本地作者' })

    // act
    fillUserListMeta(source, target)

    // assert
    expect(source.cover).toBe('https://img/remote.jpg')
    expect(source.desc).toBe('远端简介')
    expect(source.author).toBe('远端作者')
  })
})
