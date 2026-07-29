/**
 * 관세 프로그램 해석 — 발효일·적용범위·가산방식이 전부 데이터에 있다.
 *
 * 왜 레이어 enum 을 버렸는가: 2026년 5개월 동안 체계가 세 번 바뀌었다
 * (IEEPA → 무효 → Section 122 → 만료 → 강제노동 301). 그리고 USITC 공식
 * 관세표에는 **무효화된 조항이 그대로 남아 있다** — 관세표 텍스트는
 * "지금 시행 중"의 근거가 못 된다. 발효일이 데이터에 있어야 하고,
 * 프로그램 추가·종료가 마이그레이션 없이 되어야 한다.
 */
import type { RateRow } from './types'
import { normalizeHts } from './rates'

export type RateType = 'additive' | 'top_up_to_total'
export type ScopeType = 'all' | 'country' | 'hts_list' | 'country_and_hts'

export interface DutyProgram {
  code: string
  name: string
  authority: string
  /**
   * additive        — duty_total 에 그대로 더한다
   * top_up_to_total — 가산분 합계가 목표에 못 미치면 **차액만** 더한다.
   *                   이때 rate 는 개별 세율이 아니라 **목표 합계**다.
   *                   (EU·대만 "MFN+301 합계 10%", 일본·한국·스위스 "합계 12.5%")
   */
  rate_type: RateType
  scope_type: ScopeType
  /**
   * 적용 대상이 원문에 전량 열거됐는가.
   *   enumerated : 부재 = 확인된 0% (경고하지 않는다)
   *   partial    : 부재 = 미확인 (경고한다)
   * 중국 301 리스트를 전량 적재하면 목록에 없는 중국산이 대부분인데, 그때마다
   * 경고를 내면 정작 중요한 신호가 묻힌다. 기본은 안전한 쪽인 partial 이다.
   */
  coverage?: 'enumerated' | 'partial'
  effective_from: string
  effective_to: string | null
  source?: string | null
  note?: string | null
}

/** 프로그램 면제 라인 (강제노동 301 의 471개 소호 등). hts_code 는 프리픽스 */
export interface ProgramExclusion {
  program_code: string
  hts_code: string
}

export interface AppliedProgram {
  program_code: string
  authority: string
  rate_type: RateType
  /** 실제로 duty_total 에 더해진 값 (top_up 은 차액) */
  applied_rate: number
  /** 원장 행에 적힌 값 (top_up 이면 목표 합계) */
  ledger_rate: number
  matched_hts: string | null
  /** 면제 목록에 걸려 0 이 된 경우 */
  excluded: boolean
}

function inEffect(from: string, to: string | null, asOf: string): boolean {
  if (from > asOf) return false
  if (to !== null && to <= asOf) return false // 만료일 당일부터 미적용
  return true
}

/** 프리픽스 매칭. '*' 는 전 품목 */
function htsMatchLength(rowHts: string, hts: string): number {
  const r = normalizeHts(rowHts)
  if (r === '*') return 0
  return hts.startsWith(r) ? r.length : -1
}

export function isExcluded(exclusions: ProgramExclusion[], programCode: string, hts: string): boolean {
  return exclusions.some(
    (e) => e.program_code === programCode && htsMatchLength(e.hts_code, normalizeHts(hts)) >= 0,
  )
}

/**
 * 한 SKU 에 적용되는 프로그램과 실제 가산율을 계산한다.
 *
 * 순서가 중요하다:
 *   1. additive 프로그램을 전부 더한다 (MFN 포함)
 *   2. top_up_to_total 프로그램은 그 합계를 보고 **부족분만** 더한다
 *
 * 현행 `duty_total = Σ layers` 는 2단계를 못 해서 EU·대만·일본·한국·스위스
 * 원산지에서 틀린 숫자를 냈다.
 */
export function resolvePrograms(
  ledger: RateRow[],
  programs: DutyProgram[],
  exclusions: ProgramExclusion[],
  hts: string | null,
  origin: string,
  asOf: string,
): { applied: AppliedProgram[]; total: number } {
  const h = hts ? normalizeHts(hts) : null
  const org = origin.trim().toUpperCase()
  const active = programs.filter((p) => inEffect(p.effective_from, p.effective_to, asOf))

  // 프로그램별로 가장 구체적인 원장 행 하나를 고른다
  const picked = new Map<string, { row: RateRow; matchLen: number }>()
  for (const row of ledger) {
    const code = row.program_code
    if (!code) continue
    const prog = active.find((p) => p.code === code)
    if (!prog) continue
    if (!inEffect(row.effective_from, row.effective_to, asOf)) continue

    const rowOrigin = row.origin_country ? row.origin_country.trim().toUpperCase() : null
    if (rowOrigin !== null && rowOrigin !== org) continue
    // 원산지 특정이 필요한 프로그램인데 전체(null) 행만 있으면 적용하지 않는다
    if ((prog.scope_type === 'country' || prog.scope_type === 'country_and_hts') && rowOrigin === null) continue

    let matchLen = 0
    if (prog.scope_type === 'hts_list' || prog.scope_type === 'country_and_hts') {
      if (h === null) continue
      matchLen = htsMatchLength(row.hts_code, h)
      if (matchLen < 0) continue
    }

    const cur = picked.get(code)
    if (!cur || matchLen > cur.matchLen || (matchLen === cur.matchLen && row.effective_from > cur.row.effective_from)) {
      picked.set(code, { row, matchLen })
    }
  }

  const applied: AppliedProgram[] = []
  const additive: AppliedProgram[] = []
  const topUps: AppliedProgram[] = []

  for (const [code, { row }] of picked) {
    const prog = active.find((p) => p.code === code)!
    const excluded = h !== null && isExcluded(exclusions, code, h)
    const entry: AppliedProgram = {
      program_code: code,
      authority: prog.authority,
      rate_type: prog.rate_type,
      applied_rate: 0,
      ledger_rate: row.ad_valorem_rate,
      matched_hts: row.hts_code,
      excluded,
    }
    if (prog.rate_type === 'additive') additive.push(entry)
    else topUps.push(entry)
    applied.push(entry)
  }

  // 1) 가산
  let total = 0
  for (const a of additive) {
    a.applied_rate = a.excluded ? 0 : a.ledger_rate
    total += a.applied_rate
  }

  // 2) 상한 보정 — 목표에 못 미치는 만큼만. 여러 개면 목표가 큰 쪽부터.
  topUps.sort((x, y) => y.ledger_rate - x.ledger_rate)
  for (const t of topUps) {
    t.applied_rate = t.excluded ? 0 : Math.max(0, t.ledger_rate - total)
    total += t.applied_rate
  }

  return { applied, total }
}

/** 리포트용 문자열: "MFN 9.8% + Section 301 12.5%" */
export function programBreakdownLabel(applied: AppliedProgram[]): string {
  const parts = applied
    .filter((a) => a.applied_rate > 0)
    .map((a) => {
      const pct = a.applied_rate * 100
      const num = pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)
      return a.rate_type === 'top_up_to_total'
        ? `${a.authority} ${num}% (to ${(a.ledger_rate * 100).toFixed(1)}% total)`
        : `${a.authority} ${num}%`
    })
  return parts.length > 0 ? parts.join(' + ') : '0%'
}
