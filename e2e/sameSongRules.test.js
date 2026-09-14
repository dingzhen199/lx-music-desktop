/**
 * e2e 同曲规则副本一致性测试（E1）。
 *
 * e2e/sameSongRules.js 是刻意独立于 src 的 oracle（独立才能发现实现本身的 bug），
 * 本测试用共享语料逐例比对两侧判定，防止两份规则悄悄漂移：
 * 任何一侧改了行为而另一侧没跟上，这里都会红。
 * 语料覆盖：真实世界 artist 变体（HANDOFF §2.12）、全部分隔符、空艺人、
 * 大小写/空白差异、(Live) 版本、同名异曲。
 */
import { describe, expect, it } from 'vitest'
import { sameSong } from '../src/renderer/core/recommend/sameSong'
import { sameSongText } from './sameSongRules.js'

/** 分隔符全集（与两侧实现的分隔符类 [,、，/&;；|] 对应）。 */
const SEPARATORS = [',', '、', '，', '/', '&', ';', '；', '|']

/** 共享语料：a/b 为两条曲目引用，expected 为人工判定的同曲结果。 */
const corpus = [
  {
    name: '真实变体：artist 顺序不同 + 多一个合作者',
    a: { artist: 'Benjamin, Laco, 薄野弘之', title: 'Möbius' },
    b: { artist: 'mpi, Laco, Benjamin, 薄野弘之', title: 'Möbius' },
    expected: true,
  },
  {
    name: '同 artist 串但 id 不同（平台重复条目）',
    a: { id: 'id-1', artist: '周杰伦', title: '晴天' },
    b: { id: 'id-2', artist: '周杰伦', title: '晴天' },
    expected: true,
  },
  ...SEPARATORS.map(sep => ({
    name: `分隔符「${sep}」：token 顺序不同`,
    a: { artist: `Adele${sep}Someone`, title: 'Hello' },
    b: { artist: `Someone${sep}Adele`, title: 'Hello' },
    expected: true,
  })),
  {
    name: '全角/半角分隔符混用',
    a: { artist: 'Adele, Someone', title: 'Hello' },
    b: { artist: 'Adele、Someone', title: 'Hello' },
    expected: true,
  },
  {
    name: '双方 artist 均为空、title 相同',
    a: { artist: '', title: '纯音乐' },
    b: { artist: '', title: '纯音乐' },
    expected: true,
  },
  {
    name: '单方 artist 为空、另一方非空',
    a: { artist: '', title: '晴天' },
    b: { artist: '周杰伦', title: '晴天' },
    expected: false,
  },
  {
    name: '标题大小写/首尾空白差异',
    a: { artist: '  Adele ', title: ' Hello  ' },
    b: { artist: 'adele', title: 'hello' },
    expected: true,
  },
  {
    name: '标题内部多余空白折叠',
    a: { artist: 'Adele', title: 'Hello   World' },
    b: { artist: 'Adele', title: 'Hello World' },
    expected: true,
  },
  {
    name: '(Live) 版本对',
    a: { artist: 'Adele', title: 'Hello' },
    b: { artist: 'Adele', title: 'Hello (Live)' },
    expected: false,
  },
  {
    name: '同名不同艺人（无 token 交集）',
    a: { artist: '周杰伦', title: '晴天' },
    b: { artist: '王菲', title: '晴天' },
    expected: false,
  },
  {
    name: '不同标题同一艺人',
    a: { artist: 'Adele', title: 'Hello' },
    b: { artist: 'Adele', title: 'Someone Like You' },
    expected: false,
  },
]

describe('e2e sameSongRules 与 src sameSong 一致性（含语义 oracle）', () => {
  for (const c of corpus) {
    it(c.name, () => {
      // act
      const e2eResult = sameSongText(c.a, c.b)
      const srcResult = sameSong(c.a, c.b)
      // assert：两侧都必须命中人工判定，且互相一致
      expect(e2eResult).toBe(c.expected)
      expect(srcResult).toBe(c.expected)
      expect(e2eResult).toBe(srcResult)
    })
  }
})
