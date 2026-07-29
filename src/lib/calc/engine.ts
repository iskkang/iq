/**
 * §4 관세 계산 엔진 — 스펙 수식 그대로, 결정론적 코드 (스펙 §1-1).
 *
 *   duty_rate_total = base_mfn + section301 + ieepa_reciprocal   (원장 조회, 없으면 0)
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
import { LAYER_LABEL } from './types'
import { clamp } from './money'
import { expectedLayers, lookupDutyLayers, normalizeHts } from './rates'

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

export function computeShipment(
  shipment: CalcShipment,
  items: CalcItem[],
  ledger: RateRow[],
  fees: FeeSettings,
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
    let dutyLayers = lookupDutyLayers(ledger, hts ?? '', it.origin_country, shipment.rate_as_of)
    let dutyRateTotal = 0
    if (hts) {
      dutyRateTotal = dutyLayers.reduce((a, l) => a + l.rate, 0)
      if (dutyLayers.every((l) => l.matched_hts === null)) {
        warnings.push('HTS not found in rate ledger — duty calculated as $0')
      } else {
        // 부분 미스는 조용히 과소계상된다 — 레이어별로 경고한다.
        // 단 그 원산지에 애초에 적용되지 않는 레이어(비중국산의 301 등)는 제외.
        const expected = expectedLayers(ledger, it.origin_country, shipment.rate_as_of)
        for (const l of dutyLayers) {
          if (l.matched_hts === null && expected.has(l.layer)) {
            warnings.push(
              `No ${LAYER_LABEL[l.layer]} rate for this HTS in the rate ledger — treated as 0%, duty may be understated`,
            )
          }
        }
      }
    } else {
      dutyLayers = dutyLayers.map((l) => ({ ...l, rate: 0, matched_hts: null }))
      warnings.push('HTS not confirmed — duty calculated as $0')
    }
    const dutyUsd = it.unit_cost_usd * dutyRateTotal

    // 배부 (단위당)
    const freightPerUnit = units > 0 ? (freightPool * allocShare) / units : 0
    // MPF는 스펙상 항상 가액 비중 배부
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
      duty_layers: dutyLayers,
      duty_rate_total: dutyRateTotal,
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

/** 리포트 'Duty % 내역' 문자열: "MFN 6.5% + 301 25% + IEEPA 10%" (스펙 §4) */
export function dutyBreakdownLabel(result: SkuResult): string {
  const parts = result.duty_layers
    .filter((l) => l.rate > 0)
    .map((l) => {
      const label = { base_mfn: 'MFN', section301: '301', ieepa_reciprocal: 'IEEPA' }[l.layer]
      return `${label} ${(l.rate * 100).toFixed(l.rate * 100 % 1 === 0 ? 0 : 1)}%`
    })
  return parts.length > 0 ? parts.join(' + ') : '0%'
}
