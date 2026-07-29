import type { DutyLayerDetail, RateLayer, RateRow } from './types'
import { RATE_LAYERS } from './types'

/** HTS 코드 정규화: 숫자만 남긴다. '*'(전 품목)는 그대로. */
export function normalizeHts(code: string): string {
  if (code === '*') return '*'
  return code.replace(/\D/g, '')
}

/** 10자리 형식 검사 (사용자 수동 입력 검증용) */
export function isValidHts10(code: string): boolean {
  return /^\d{10}$/.test(normalizeHts(code))
}

/** 표시용 6912.00.4810 형식 */
export function formatHts(code: string | null): string {
  if (!code) return '—'
  const d = normalizeHts(code)
  if (d.length < 4) return d
  const parts = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 10)].filter(Boolean)
  return parts.join('.')
}

function inEffect(row: RateRow, asOf: string): boolean {
  if (row.effective_from > asOf) return false
  if (row.effective_to !== null && row.effective_to < asOf) return false
  return true
}

/**
 * 원장에서 레이어 1개의 적용 rate 조회 (스펙 §4: HTS × 원산지 × 발효일, 없으면 0).
 *
 * 우선순위:
 *  1. HTS 매칭 길이가 긴 행 (10 > 8 > 6 > '*')
 *  2. 원산지 특정 행 > 전체(null) 행
 *  3. effective_from 이 최신인 행
 */
export function lookupLayerRate(
  ledger: RateRow[],
  layer: RateLayer,
  hts10: string,
  origin: string,
  asOf: string,
): DutyLayerDetail {
  const hts = normalizeHts(hts10)
  const org = origin.trim().toUpperCase()

  let best: RateRow | null = null
  let bestLen = -1

  for (const row of ledger) {
    if (row.layer !== layer) continue
    if (!inEffect(row, asOf)) continue

    const rowOrigin = row.origin_country ? row.origin_country.trim().toUpperCase() : null
    if (rowOrigin !== null && rowOrigin !== org) continue

    const rowHts = normalizeHts(row.hts_code)
    const matchLen = rowHts === '*' ? 0 : hts.startsWith(rowHts) ? rowHts.length : -1
    if (matchLen < 0) continue

    if (
      best === null ||
      matchLen > bestLen ||
      (matchLen === bestLen && rowOrigin !== null && best.origin_country === null) ||
      (matchLen === bestLen &&
        (rowOrigin !== null) === (best.origin_country !== null) &&
        row.effective_from > best.effective_from)
    ) {
      best = row
      bestLen = matchLen
    }
  }

  if (!best) return { layer, rate: 0, matched_hts: null }
  return { layer, rate: best.ad_valorem_rate, matched_hts: best.hts_code }
}

/**
 * 해당 원산지에 "적용될 수 있는" 레이어 집합.
 *
 * 원장에 그 원산지로 적용 가능한 행(origin_country = 해당국 또는 null)이 기준일 기준
 * 하나라도 있는 레이어만 기대 대상으로 본다. 예를 들어 301 행이 CN 으로만 존재하면
 * VN·IN 에는 301 이 애초에 기대되지 않으므로 "원장에 없음" 경고를 내면 안 된다.
 *
 * 코드에 'CN' 같은 값을 하드코딩하지 않고 원장에서 유도한다 (스펙 §1-4).
 * 한계: 원장에 그 국가 행이 아예 없으면 "해당 없음"과 "관리자 미입력"을 구분할 수 없다.
 */
export function expectedLayers(ledger: RateRow[], origin: string, asOf: string): Set<RateLayer> {
  const org = origin.trim().toUpperCase()
  const out = new Set<RateLayer>()
  for (const row of ledger) {
    if (!inEffect(row, asOf)) continue
    const rowOrigin = row.origin_country ? row.origin_country.trim().toUpperCase() : null
    if (rowOrigin !== null && rowOrigin !== org) continue
    out.add(row.layer)
  }
  return out
}

/** 3개 레이어 전체 조회. duty_rate_total = Σ 레이어 (스펙 §4). */
export function lookupDutyLayers(
  ledger: RateRow[],
  hts10: string,
  origin: string,
  asOf: string,
): DutyLayerDetail[] {
  return RATE_LAYERS.map((layer) => lookupLayerRate(ledger, layer, hts10, origin, asOf))
}
