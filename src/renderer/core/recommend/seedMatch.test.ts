import { describe, expect, it } from 'vitest'
import { matchSeed, normalizeSeedTitle, parseIntervalSec } from './seedMatch'

const row = (over: Partial<Parameters<typeof matchSeed>[1][number]> = {}) => ({
  artist: '周杰伦',
  title: '晴天',
  album: '叶惠美',
  intervalSec: 269,
  ...over,
})

describe('跨平台种子定位（严格匹配）', () => {
  it('歌名+歌手+版本一致时匹配成功', () => {
    const target = { artist: '周杰伦', title: '晴天', album: '叶惠美', intervalSec: 269 }
    expect(matchSeed(target, [row()])).toEqual(row())
  })

  it('歌手大小写差异不影响匹配（Beyond vs BEYOND）', () => {
    const target = { artist: 'Beyond', title: '海阔天空', intervalSec: 320 }
    const rows = [row({ artist: 'BEYOND', title: '海阔天空', album: '乐与怒', intervalSec: 321 })]
    expect(matchSeed(target, rows)).toBeTruthy()
  })

  it('错版本（Live/DJ/伴奏标注）不匹配：清洗后同名但版本标记不同', () => {
    const target = { artist: '周杰伦', title: '晴天', intervalSec: 269 }
    const rows = [
      row({ title: '晴天 (Live)' }),
      row({ title: '晴天(DJ版)' }),
      row({ title: '晴天（伴奏）' }),
      row({ title: '晴天 (女声版)' }),
    ]
    expect(matchSeed(target, rows)).toBeNull()
  })

  it('同名不同歌（不同歌手）不匹配', () => {
    const target = { artist: '周杰伦', title: '晴天', intervalSec: 269 }
    const rows = [row({ artist: 'Lucky小爱', album: '晴天(深情版)', intervalSec: 279 })]
    expect(matchSeed(target, rows)).toBeNull()
  })

  it('起点歌手缺失时无匹配证据，不取搜索第一条充数', () => {
    const target = { artist: '', title: '晴天', intervalSec: 269 }
    expect(matchSeed(target, [row()])).toBeNull()
  })

  it('候选歌手缺失不匹配', () => {
    const target = { artist: '周杰伦', title: '晴天' }
    expect(matchSeed(target, [row({ artist: '' })])).toBeNull()
  })

  it('时长甄别：全部候选与起点时长差超容差视为版本不符', () => {
    const target = { artist: '周杰伦', title: '晴天', intervalSec: 269 }
    const rows = [row({ intervalSec: 400 }), row({ intervalSec: 120 })]
    expect(matchSeed(target, rows)).toBeNull()
  })

  it('时长容差内择优：优先专辑一致，其次时长最接近，最后搜索序', () => {
    const target = { artist: '周杰伦', title: '晴天', album: '叶惠美', intervalSec: 269 }
    const rows = [
      row({ album: '其他精选', intervalSec: 268 }),
      row({ album: '叶惠美', intervalSec: 271 }),
      row({ album: '叶惠美', intervalSec: 269 }),
    ]
    const matched = matchSeed(target, rows)
    expect(matched?.intervalSec).toBe(269)
  })

  it('起点时长未知时不做时长过滤，仅按主门禁+专辑择优', () => {
    const target = { artist: '周杰伦', title: '晴天', album: '叶惠美' }
    const rows = [row({ intervalSec: 500, album: '精选' }), row({ intervalSec: 269 })]
    const matched = matchSeed(target, rows)
    expect(matched?.album).toBe('叶惠美')
  })

  it('标题归一化：全角括号/空格差异不造成误拒', () => {
    expect(normalizeSeedTitle('晴天（Live）')).toBe(normalizeSeedTitle('晴天 (Live)'))
    expect(normalizeSeedTitle('晴天')).not.toBe(normalizeSeedTitle('晴天 (Live)'))
  })

  it('合作艺人：起点主艺人出现在候选合作列表中即通过', () => {
    const target = { artist: '米津玄師', title: '打上花火', intervalSec: 280 }
    const rows = [row({ artist: 'Daoko、米津玄師', title: '打上花火', intervalSec: 281 })]
    expect(matchSeed(target, rows)).toBeTruthy()
  })

  it('括号别名标注：候选 "冯沁苑(买辣椒也用券)" 命中起点 "买辣椒也用券"', () => {
    const target = { artist: '买辣椒也用券', title: '起风了', intervalSec: 326 }
    const rows = [row({ artist: '冯沁苑(买辣椒也用券)', title: '起风了', intervalSec: 326 })]
    expect(matchSeed(target, rows)).toBeTruthy()
  })

  it('括号别名标注：起点带别名时也能命中候选的纯名（双向）', () => {
    const target = { artist: '冯沁苑(买辣椒也用券)', title: '起风了', intervalSec: 326 }
    const rows = [row({ artist: '买辣椒也用券', title: '起风了', intervalSec: 326 })]
    expect(matchSeed(target, rows)).toBeTruthy()
  })
})

describe('parseIntervalSec', () => {
  it('mm:ss / h:mm:ss / 数字 / 垃圾值', () => {
    expect(parseIntervalSec('04:29')).toBe(269)
    expect(parseIntervalSec('1:02:03')).toBe(3723)
    expect(parseIntervalSec(269)).toBe(269)
    expect(parseIntervalSec('269')).toBe(269)
    expect(parseIntervalSec('')).toBeNull()
    expect(parseIntervalSec('abc')).toBeNull()
    expect(parseIntervalSec(null)).toBeNull()
    expect(parseIntervalSec(0)).toBeNull()
  })
})
