/**
 * 리스트 배정 3값 — **미해결이 0% 로 계산되면 실패한다.**
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 301-china-unverified 5행은 세율이 0 이었다. 경고는 냈지만 **숫자는 이미 0 으로
 * 합산돼 있었다** — 경고를 읽지 않은 사용자에게는 "관세 없음" 과 구분되지 않는다.
 *
 * 우리가 세운 오차 비대칭 원칙과 방향이 반대다: 과대계상은 고객이 손해를 안
 * 보지만 과소계상은 마진을 무너뜨린다. 그렇다고 25% 로 부과할 수도 없다 —
 * 이 라인들은 정말로 0% 일 수도 있다.
 *
 * 확인되지 않은 것은 숫자가 아니라 **상태**다. 그래서 숫자를 만들지 않는다.
 *
 * 이 파일은 "0 으로 되돌아가지 않는다" 를 지키는 자리다. 누가 편의상
 * `?? 0` 을 넣는 순간 여기서 깨져야 한다.
 */
import { describe, it, expect } from 'vitest'
import { resolvePrograms } from '../src/lib/calc/programs'
import type { DutyProgram } from '../src/lib/calc/programs'
import type { RateRow, FeeSettings } from '../src/lib/calc/types'
import { computeShipment } from '../src/lib/calc/engine'

const AS_OF = '2026-07-29'

const PROGRAMS: DutyProgram[] = [
  {
    code: 'mfn',
    name: 'MFN',
    authority: 'MFN',
    rate_type: 'additive',
    scope_type: 'hts_list',
    coverage: 'enumerated',
    effective_from: '2025-01-01',
    effective_to: null,
  },
  {
    code: '301-china-unverified',
    name: 'Section 301 (China) — scope unresolved',
    authority: 'Section 301',
    rate_type: 'additive',
    scope_type: 'country_and_hts',
    coverage: 'partial',
    effective_from: '2018-07-06',
    effective_to: null,
  },
]

const MFN: RateRow = {
  program_code: 'mfn',
  hts_code: '91051940',
  origin_country: null,
  layer: 'base_mfn',
  ad_valorem_rate: 0.045,
  effective_from: '2025-01-01',
  effective_to: null,
} as RateRow

/** 실제 원장 모양 그대로: 세율이 **없다** (0 이 아니다) */
const UNRESOLVED: RateRow = {
  program_code: '301-china-unverified',
  hts_code: '91051940',
  origin_country: 'CN',
  layer: 'section301',
  ad_valorem_rate: null,
  resolution: 'unresolved',
  effective_from: '2018-07-06',
  effective_to: null,
  source: 'UNVERIFIED-RESTRUCTURED',
} as RateRow

describe('resolvePrograms — 미해결', () => {
  it('미해결 행은 applied 에 들어가지 않는다 (합산 후보가 아니다)', () => {
    const r = resolvePrograms([MFN, UNRESOLVED], PROGRAMS, [], '9105194000', 'CN', AS_OF)
    expect(r.applied.map((a) => a.program_code)).toEqual(['mfn'])
    expect(r.unresolved).toHaveLength(1)
    expect(r.unresolved[0].program_code).toBe('301-china-unverified')
  })

  it('가능한 값을 **나열**한다 — 범위로 쓰면 7.5% 가 사라진다', () => {
    const r = resolvePrograms([MFN, UNRESOLVED], PROGRAMS, [], '9105194000', 'CN', AS_OF)
    // List 4A(7.5%) 가 실재하므로 [최소, 최대] 로는 사실을 말할 수 없다
    expect(r.unresolved[0].rate_candidates).toEqual([0, 0.075, 0.25])
    expect(r.unresolved[0].source).toBe('UNVERIFIED-RESTRUCTURED')
  })

  it('원산지가 다르면 미해결이 아니다 (CN 전용 행이므로)', () => {
    const r = resolvePrograms([MFN, UNRESOLVED], PROGRAMS, [], '9105194000', 'VN', AS_OF)
    expect(r.unresolved).toHaveLength(0)
    expect(r.total).toBeCloseTo(0.045, 10)
  })
})

const FEES: FeeSettings = {
  mpf_rate: 0.003464,
  mpf_min_usd: 33.58,
  mpf_max_usd: 651.5,
  hmf_rate: 0.00125,
  effective_from: '2025-10-01',
}

const shipment = {
  freight_usd: 1000,
  insurance_usd: 0,
  mode: 'ocean' as const,
  allocation_basis: 'value' as const,
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: AS_OF,
}

const item = (sku: string, origin: string) => ({
  sku,
  hts_code: '9105194000',
  origin_country: origin,
  unit_cost_usd: 100,
  quantity: 10,
  units_per_shipment: 10,
  current_price_usd: 300,
})

describe('computeShipment — 미해결 SKU 는 숫자를 만들지 않는다', () => {
  const ctx = { programs: PROGRAMS, exclusions: [] }

  it('duty 를 0 으로 계산하면 실패 — null 이어야 한다', () => {
    const r = computeShipment(shipment, [item('WATCH-CN', 'CN')], [MFN, UNRESOLVED], FEES, ctx)
    const line = r.items[0]
    // **이 단언이 이 파일의 존재 이유다.** 0 으로 되돌아가면 여기서 깨진다.
    expect(line.duty_rate_total).not.toBe(0)
    expect(line.duty_usd).not.toBe(0)
    expect(line.duty_rate_total).toBeNull()
    expect(line.duty_usd).toBeNull()
  })

  it('랜디드 코스트·마진·권장가도 만들지 않는다 (조용한 합산 금지)', () => {
    const r = computeShipment(shipment, [item('WATCH-CN', 'CN')], [MFN, UNRESOLVED], FEES, ctx)
    const line = r.items[0]
    expect(line.landed_cost).toBeNull()
    expect(line.true_margin).toBeNull()
    expect(line.recommended_price).toBeNull()
  })

  it('SKU 를 미해결로 표시하고 범위를 문구에 담는다', () => {
    const r = computeShipment(shipment, [item('WATCH-CN', 'CN')], [MFN, UNRESOLVED], FEES, ctx)
    const line = r.items[0]
    expect(line.unresolved_programs).toHaveLength(1)
    const w = line.warnings.join(' | ')
    expect(w).toContain('unresolved')
    expect(w).toContain('0%, 7.5%, or 25%')
    expect(w).toContain('depends on which Section 301 list applies')
    expect(w).toContain('broker')
    // "treated as 0%" 로 되돌아가면 실패 — 그 문구가 곧 조용한 합산의 흔적이다
    expect(w).not.toContain('treated as 0%')
  })

  it('확정된 SKU 는 그대로 숫자가 나온다 (미해결이 다른 줄을 오염시키지 않는다)', () => {
    const r = computeShipment(
      shipment,
      [item('WATCH-CN', 'CN'), item('WATCH-VN', 'VN')],
      [MFN, UNRESOLVED],
      FEES,
      ctx,
    )
    const vn = r.items.find((x) => x.sku === 'WATCH-VN')!
    expect(vn.duty_rate_total).toBeCloseTo(0.045, 10)
    expect(vn.duty_usd).toBeCloseTo(4.5, 10)
    expect(vn.landed_cost).not.toBeNull()
    expect(r.items.find((x) => x.sku === 'WATCH-CN')!.duty_usd).toBeNull()
  })

  it('총계는 부분합임을 건수로 알린다 (Q2)', () => {
    const r = computeShipment(
      shipment,
      [item('WATCH-CN', 'CN'), item('WATCH-VN', 'VN')],
      [MFN, UNRESOLVED],
      FEES,
      ctx,
    )
    // 한 줄을 못 세면 나머지 합은 그 선적의 landed cost 가 아니라 부분합이다
    expect(r.totals.unresolved_skus).toBe(1)
  })

  it('전부 확정되면 총계는 온전하다 (건수 0)', () => {
    const r = computeShipment(shipment, [item('WATCH-VN', 'VN')], [MFN, UNRESOLVED], FEES, ctx)
    expect(r.totals.unresolved_skus).toBe(0)
  })
})
