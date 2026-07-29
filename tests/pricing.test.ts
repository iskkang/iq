import { describe, expect, it } from 'vitest'
import { recommendedPrice, trueMargin } from '../src/lib/calc/engine'

describe('true margin (스펙 §4)', () => {
  it('(price − landed − price×fee) / price', () => {
    // price 100, landed 40, fee 15% → (100−40−15)/100 = 0.45
    expect(trueMargin(100, 40, 0.15)).toBeCloseTo(0.45, 10)
  })
  it('landed가 가격보다 크면 음수 마진', () => {
    expect(trueMargin(10, 12, 0.15)).toBeCloseTo((10 - 12 - 1.5) / 10, 10)
  })
})

describe('권장 판매가 = landed ÷ (1 − target − fee) (스펙 §2)', () => {
  it('landed 55, target 30%, fee 15% → 100', () => {
    expect(recommendedPrice(55, 0.3, 0.15)).toBeCloseTo(100, 10)
  })
  it('권장가로 팔면 실제 마진이 target과 일치 (역산 검증)', () => {
    const landed = 13.7571505
    const rec = recommendedPrice(landed, 0.3, 0.15)!
    expect(trueMargin(rec, landed, 0.15)).toBeCloseTo(0.3, 10)
  })
  it('target + fee ≥ 100% → null (0 나눗셈 가드)', () => {
    expect(recommendedPrice(55, 0.9, 0.15)).toBeNull()
    expect(recommendedPrice(55, 0.85, 0.15)).toBeNull()
  })
})
