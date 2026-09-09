import { describe, expect, it } from 'vitest'
import { extractJsonChunks, extractRankingRows, looseParse, parseLooseJson } from './json'

describe('looseParse - 宽松 JSON 解析', () => {
  it('空输入返回 null', () => {
    // act & assert
    expect(looseParse('')).toBeNull()
    expect(looseParse('   \n ')).toBeNull()
  })

  it('标准 JSON 直接解析', () => {
    // act & assert
    expect(looseParse('{"a":1}')).toEqual({ a: 1 })
  })

  it('被前后解释文字包裹的 JSON 取首尾括号切片解析', () => {
    // act & assert
    expect(looseParse('分析结果如下：\n{"summary":"x"}\n以上。')).toEqual({ summary: 'x' })
  })

  it('完全无法解析时回退 {raw} 原样返回', () => {
    // act & assert
    expect(looseParse('今天天气不错')).toEqual({ raw: '今天天气不错' })
  })
})

describe('extractJsonChunks - 提取并解析文本内多个 JSON 块', () => {
  it('提取两个相邻 JSON 块', () => {
    // act & assert
    expect(extractJsonChunks('{"a":1}{"b":2}')).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('字符串内的花括号不干扰块边界', () => {
    // act & assert
    expect(extractJsonChunks('前置 {"s":"}{"} 后置')).toEqual([{ s: '}{' }])
  })

  it('无法解析的裸文本块被跳过', () => {
    // act & assert
    expect(extractJsonChunks('{"ok":1} 乱码文本 {bad}')).toEqual([{ ok: 1 }])
  })
})

describe('parseLooseJson - LLM 输出健壮解析入口', () => {
  it('纯文本回退 {raw}', () => {
    // act & assert
    expect(parseLooseJson('模型说：没有更多信息。')).toEqual({ raw: '模型说：没有更多信息。' })
  })

  it('整体直接可解析时返回对象', () => {
    // act & assert
    expect(parseLooseJson('{"ranking":[]}')).toEqual({ ranking: [] })
  })

  it('包在解释文字中的单块 JSON 返回该块', () => {
    // act & assert
    expect(parseLooseJson('好的，结果如下\n{"ranking":[{"candidate_id":0,"score":80}]}\n希望能帮助到你'))
      .toEqual({ ranking: [{ candidate_id: 0, score: 80 }] })
  })

  it('多个 JSON 块返回 {chunks}', () => {
    // act & assert
    expect(parseLooseJson('{"a":1} 然后 {"b":2}')).toEqual({ chunks: [{ a: 1 }, { b: 2 }] })
  })

  it('garbled 内容回退 {raw} 不抛错', () => {
    // act & assert
    expect(parseLooseJson('{"ranking":[{"candidate_id":0,] 残缺')).toEqual({ raw: '{"ranking":[{"candidate_id":0,] 残缺' })
  })
})

describe('extractRankingRows - 提取候选行', () => {
  it('直接数组原样返回', () => {
    // act & assert
    const input = [{ candidate_id: 0, score: 90 }, { candidate_id: 3, score: 70 }]
    expect(extractRankingRows(input)).toEqual(input)
  })

  it('{ranking:[…]} 提取数组', () => {
    // act & assert
    expect(extractRankingRows({ ranking: [{ candidate_id: 1, score: 80 }] })).toEqual([{ candidate_id: 1, score: 80 }])
  })

  it('{sequence:[…]} 提取数组', () => {
    // act & assert
    expect(extractRankingRows({ sequence: [{ candidate_id: 2, score: 60 }] })).toEqual([{ candidate_id: 2, score: 60 }])
  })

  it('{results:[…]} 提取数组', () => {
    // act & assert
    expect(extractRankingRows({ results: [{ candidate_id: 4, score: 55 }] })).toEqual([{ candidate_id: 4, score: 55 }])
  })

  it('双重编码：{ranking:"字符串编码的JSON"}', () => {
    // act & assert
    expect(extractRankingRows({ ranking: '[\n  {"candidate_id": 0, "score": 88},\n  {"candidate_id": 1, "score": 77}\n]' }))
      .toEqual([{ candidate_id: 0, score: 88 }, { candidate_id: 1, score: 77 }])
  })

  it('围栏 + 前后散文包裹', () => {
    // act & assert
    expect(extractRankingRows('以下是排序结果：\n```json\n{"ranking":[{"candidate_id":0,"score":91}]}\n```\n请查收。'))
      .toEqual([{ candidate_id: 0, score: 91 }])
  })

  it('{chunks:[…]} 多块拼接并去重', () => {
    // act & assert
    const content = {
      chunks: [
        { ranking: [{ candidate_id: 0, score: 50 }] },
        { ranking: [{ candidate_id: 0, score: 50 }, { candidate_id: 1, score: 60 }] },
      ],
    }
    expect(extractRankingRows(content)).toEqual([{ candidate_id: 0, score: 50 }, { candidate_id: 1, score: 60 }])
  })

  it('截断残缺输入返回 []', () => {
    // act & assert
    expect(extractRankingRows('{"ranking":[{"candidate_id":0,"score":50]')).toEqual([])
  })

  it('非对象/空对象行被过滤', () => {
    // act & assert
    expect(extractRankingRows({ ranking: [null, 42, 'x', {}, [], { candidate_id: 5, score: 33 }] }))
      .toEqual([{ candidate_id: 5, score: 33 }])
  })
})
