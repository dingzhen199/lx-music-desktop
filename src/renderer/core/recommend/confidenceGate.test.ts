/**
 * 低置信全半径拦截守门纯逻辑测试（探索电台 TT-3 新增，对应 AC6）。
 *
 * 覆盖：shouldBlockLowConfidence 谓词语义——低置信（'low' 及其大小写变体）
 * 在任意半径等价的调用下均拦（谓词不携带半径参数，三档半径即同一调用，
 * 以此钉死"全半径拦"）；高/中置信、空串、null/undefined、非字符串一律放行。
 */
import { describe, expect, it } from 'vitest'
import { shouldBlockLowConfidence } from './confidenceGate'

describe('shouldBlockLowConfidence - 低置信全半径拦截', () => {
  it("'low' → true（近距档：旧口径 radius<=45 唯一会拦的一档）", () => {
    // act & assert
    expect(shouldBlockLowConfidence('low')).toBe(true)
  })

  it("'low' → true（中距档：旧口径放行，AC6 要求同谓词拦截）", () => {
    // act & assert
    expect(shouldBlockLowConfidence('low')).toBe(true)
  })

  it("'low' → true（远距档：旧口径放行，AC6 要求同谓词拦截）", () => {
    // act & assert
    expect(shouldBlockLowConfidence('low')).toBe(true)
  })

  it("'LOW'（全大写）→ true", () => {
    // act & assert
    expect(shouldBlockLowConfidence('LOW')).toBe(true)
  })

  it("'Low'（大小写混合）→ true", () => {
    // act & assert
    expect(shouldBlockLowConfidence('Low')).toBe(true)
  })

  it("'high' → false", () => {
    // act & assert
    expect(shouldBlockLowConfidence('high')).toBe(false)
  })

  it("'medium'（引擎缺省置信口径）→ false", () => {
    // act & assert
    expect(shouldBlockLowConfidence('medium')).toBe(false)
  })

  it('空串 → false', () => {
    // act & assert
    expect(shouldBlockLowConfidence('')).toBe(false)
  })

  it('null → false', () => {
    // act & assert
    expect(shouldBlockLowConfidence(null)).toBe(false)
  })

  it('undefined → false', () => {
    // act & assert
    expect(shouldBlockLowConfidence(undefined)).toBe(false)
  })

  it('非字符串（数字/布尔/对象）→ false', () => {
    // act & assert
    expect(shouldBlockLowConfidence(0)).toBe(false)
    expect(shouldBlockLowConfidence(false)).toBe(false)
    expect(shouldBlockLowConfidence({ level: 'low' })).toBe(false)
  })
})
