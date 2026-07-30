/**
 * §4 관세 계산 엔진 — 스펙 수식 그대로, 결정론적 코드 (스펙 §1-1).
 *
 *   duty_rate_total = Σ additive 프로그램 → top_up_to_total 로 상한 보정 (programs.ts)
 *   duty_usd        = unit_cost × duty_rate_total
 *   freight_unit    = (총운임+보험) × 배부비중
 *   mpf_unit        = min·max 캡 적용한 선적 MPF(0.3464%)를 가액 비중으로 배부
 *   hmf_unit        = ocean일 때만 가액 0.125%
 *   landed_cost     = unit_cost + duty + freight + mpf + hmf
 *   true_margin     = (price − landed − price×channel_fee) / price
 *   recommended     = landed ÷ (1 − target_margin − channel_fee)
 */
import type {
  AllocationBasis,
  CalcItem,
  CalcShipment,
  FeeSettings,
  RateRow,
  ShipmentResult,
  SkuResult,
} from './types'
import { clamp } from './money'
import { normalizeHts } from './rates'
import { programBreakdownLabel, resolvePrograms } from './programs'
import type { DutyProgram, ProgramExclusion } from './programs'

export function trueMargin(
  currentPrice: number,
  landedCost: number,
  channelFeePct: number,
): number {
  return (currentPrice - landedCost - currentPrice * channelFeePct) / currentPrice
}

/** landed ÷ (1 − target − fee). 분모 ≤ 0 이면 null. */
export function recommendedPrice(
  landedCost: number,
  targetMargin: number,
  channelFeePct: number,
): number | null {
  const denom = 1 - targetMargin - channelFeePct
  if (denom <= 1e-9) return null // 부동소수점 오차 포함 0 나눗셈 가드
  return landedCost / denom
}

/**
 * 관세 프로그램 참조 데이터 — **필수**.
 *
 * 구 레이어 폴백은 제거했다. 두 경로가 공존하면 골든이 제품이 실제로 쓰는
 * 경로를 재지 못한다 (pipeline.ts 를 한 벌로 유지하는 것과 같은 이유).
 * 발효일·적용범위·상한보정은 전부 여기 데이터가 결정한다.
 */
export interface ProgramContext {
  programs: DutyProgram[]
  exclusions: ProgramExclusion[]
}

export function computeShipment(
  shipment: CalcShipment,
  items: CalcItem[],
  ledger: RateRow[],
  fees: FeeSettings,
  ctx: ProgramContext,
): ShipmentResult {
  const shipmentWarnings: string[] = []

  // ── 선적 총계 ────────────────────────────────────────────────
  const values = items.map((it) => it.unit_cost_usd * it.units_per_shipment)
  const totalValue = values.reduce((a, b) => a + b, 0)

  // 배부 기준: weight 선택 시 전 SKU 중량 필요, 하나라도 없으면 가액 폴백 (스펙 §2)
  let basisUsed: AllocationBasis = shipment.allocation_basis
  let weights: number[] | null = null
  let totalWeight: number | null = null
  if (shipment.allocation_basis === 'weight') {
    const w = items.map((it) => (it.weight_kg_per_unit ?? 0) * it.units_per_shipment)
    if (items.length > 0 && w.every((x) => x > 0)) {
      weights = w
      totalWeight = w.reduce((a, b) => a + b, 0)
    } else {
      basisUsed = 'value'
      shipmentWarnings.push('Some SKUs are missing weight — freight allocated by value instead.')
    }
  }

  const freightPool = shipment.freight_usd + shipment.insurance_usd
  // MPF: 선적 단위 계산 후 min·max 캡 (스펙 §4)
  const mpfShipment = totalValue > 0 ? clamp(totalValue * fees.mpf_rate, fees.mpf_min_usd, fees.mpf_max_usd) : 0
  const hmfShipment = shipment.mode === 'ocean' ? totalValue * fees.hmf_rate : 0

  // ── SKU별 ────────────────────────────────────────────────────
  const results: SkuResult[] = items.map((it, i) => {
    const warnings: string[] = []
    const units = it.units_per_shipment
    const value = values[i]
    const valueShare = totalValue > 0 ? value / totalValue : 0
    const allocShare =
      basisUsed === 'weight' && weights && totalWeight ? weights[i] / totalWeight : valueShare

    // duty (HTS 미확정 → 0 + 경고)
    const hts = it.hts_code ? normalizeHts(it.hts_code) : null

    const { applied, total } = resolvePrograms(
      ledger,
      ctx.programs,
      ctx.exclusions,
      hts,
      it.origin_country,
      shipment.rate_as_of,
    )

    if (!hts) {
      warnings.push('HTS not confirmed — duty calculated as $0')
    } else {
      // 조용한 0 은 금지 (v2 에서 이미 당한 실패).
      // 원산지상 적용될 수 있는 프로그램인데 이 HTS 에 매칭되는 원장 행이 없으면
      // "0%" 가 아니라 "미확인" 이다 — duty 가 과소계상됐을 수 있다.
      const inForce = ctx.programs.filter(
        (p) => p.effective_from <= shipment.rate_as_of && (p.effective_to === null || p.effective_to > shipment.rate_as_of),
      )
      const org = it.origin_country.trim().toUpperCase()
      for (const p of inForce) {
        if (applied.some((a) => a.program_code === p.code)) continue
        // 그 원산지로 적용될 수 있는 행이 원장에 하나라도 있는 프로그램만 기대 대상
        const reachable = ledger.some((r) => {
          if (r.program_code !== p.code) return false
          const ro = r.origin_country ? r.origin_country.trim().toUpperCase() : null
          return ro === null || ro === org
        })
        // 열거가 완결된 프로그램은 부재 자체가 정보다 — 중국 301 리스트에 없는
        // 라인은 "미확인"이 아니라 "확인된 0%"다 (예: 정지된 List 4B 만 걸린 라인).
        if (reachable && p.coverage !== 'enumerated') {
          warnings.push(
            `${p.authority} (${p.code}) not confirmed for this HTS — treated as 0%, duty may be understated`,
          )
        }
      }
      for (const a of applied) {
        if (a.excluded) {
          warnings.push(`${a.authority} (${a.program_code}) is excluded for this HTS — treated as 0%`)
        } else if (a.exclusion === 'unverified') {
          // 미검증 면제는 세율을 낮추지 않는다. 문구가 확인된 면제와 달라야
          // 사용자가 "면제받았다"와 "면제받을 수도 있다"를 구분한다.
          warnings.push(
            `${a.authority} (${a.program_code}): an exclusion may apply here but is unconfirmed — ` +
              `duty charged in full, confirm with your broker`,
          )
        }
      }
      // 매칭은 됐지만 근거가 확정되지 않은 행 — 조용히 0 으로 통과시키지 않는다.
      // (2024 4년 재검토 인상 라인, note 의 8자리가 현행에서 재편된 라인)
      for (const r of ledger) {
        if (!r.source || !r.source.startsWith('UNVERIFIED')) continue
        if (r.origin_country && r.origin_country.trim().toUpperCase() !== org) continue
        if (!hts.startsWith(r.hts_code)) continue
        warnings.push(
          `Section 301 scope unresolved for this HTS (${r.source}) — treated as 0%, duty may be understated`,
        )
      }
    }

    const dutyUsd = it.unit_cost_usd * total

    // 배부 (단위당)
    const freightPerUnit = units > 0 ? (freightPool * allocShare) / units : 0
    // MPF 는 스펙상 항상 가액 비중 배부
    const mpfPerUnit = units > 0 ? (mpfShipment * valueShare) / units : 0
    const hmfPerUnit = units > 0 ? (hmfShipment * valueShare) / units : 0

    const landed = it.unit_cost_usd + dutyUsd + freightPerUnit + mpfPerUnit + hmfPerUnit
    const price = it.current_price_usd ?? null
    const margin = price && price > 0 ? trueMargin(price, landed, shipment.channel_fee_pct) : null
    const rec = recommendedPrice(landed, shipment.target_margin, shipment.channel_fee_pct)
    if (rec === null) warnings.push('target margin + channel fee ≥ 100% — recommended price unavailable')

    return {
      sku: it.sku,
      hts_code: hts,
      provisional: it.provisional ?? false,
      unit_cost: it.unit_cost_usd,
      units,
      applied_programs: applied,
      duty_rate_total: total,
      duty_usd: dutyUsd,
      freight_per_unit: freightPerUnit,
      mpf_per_unit: mpfPerUnit,
      hmf_per_unit: hmfPerUnit,
      fees_per_unit: mpfPerUnit + hmfPerUnit,
      landed_cost: landed,
      current_price: price,
      true_margin: margin,
      recommended_price: rec,
      warnings,
    }
  })

  return {
    items: results,
    totals: {
      total_value: totalValue,
      total_weight: totalWeight,
      freight_pool: freightPool,
      mpf_shipment: mpfShipment,
      hmf_shipment: hmfShipment,
      allocation_basis_used: basisUsed,
    },
    rate_as_of: shipment.rate_as_of,
    warnings: shipmentWarnings,
  }
}

/** 리포트 'Duty % 내역' 문자열: "MFN 9.8% + Section 301 12.5%" (스펙 §4) */
export function dutyBreakdownLabel(result: SkuResult): string {
  return programBreakdownLabel(result.applied_programs ?? [])
}
