/**
 * 관세 프로그램 해석 — 발효일·적용범위·가산방식이 전부 데이터에 있다.
 *
 * 왜 레이어 enum 을 버렸는가: 2026년 5개월 동안 체계가 세 번 바뀌었다
 * (IEEPA → 무효 → Section 122 → 만료 → 강제노동 301). 그리고 USITC 공식
 * 관세표에는 **무효화된 조항이 그대로 남아 있다** — 관세표 텍스트는
 * "지금 시행 중"의 근거가 못 된다. 발효일이 데이터에 있어야 하고,
 * 프로그램 추가·종료가 마이그레이션 없이 되어야 한다.
 */
import type { RateRow } from './types.ts'
import { normalizeHts } from './rates.ts'

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
  /** 면제 발효일. 면제도 만료된다 — 대부분의 301 면제는 기간제다 */
  effective_from?: string
  /** null/미지정 = 현재 유효. 만료일 당일부터 미적용 (원장과 같은 규칙) */
  effective_to?: string | null
  /** 근거 인용. 'UNVERIFIED' 로 시작하면 확인 전이므로 면제를 적용하지 않는다 */
  source?: string | null
}

/**
 * 면제 판정 결과.
 *
 *   none        면제 없음 → 원장 세율 그대로
 *   confirmed   근거가 확인된 면제 → 0%
 *   unverified  면제 가능성은 있으나 근거 미확인 → **전액 부과 + 경고**
 *
 * unverified 를 0% 로 처리하지 않는 이유는 오차의 비대칭이다. 관세를 과대계상하면
 * 고객은 예산을 넉넉히 잡을 뿐이지만, 과소계상하면 가격을 잘못 매겨 마진을 잃는다 —
 * 이 제품이 없애준다고 약속한 바로 그 손해다. 확신이 없을 때는 부과하는 쪽으로 눕는다.
 */
export type ExclusionStatus = 'none' | 'confirmed' | 'unverified'

export interface AppliedProgram {
  program_code: string
  authority: string
  rate_type: RateType
  /** 실제로 duty_total 에 더해진 값 (top_up 은 차액) */
  applied_rate: number
  /** 원장 행에 적힌 값 (top_up 이면 목표 합계) */
  ledger_rate: number
  matched_hts: string | null
  /** **확인된** 면제로 0 이 된 경우. 미검증 면제는 여기 false 다 */
  excluded: boolean
  /** 면제 판정. unverified 면 부과하되 리포트에 다른 문구로 표시한다 */
  exclusion: ExclusionStatus
}

/**
 * 발효 구간 판정 — `[from, to)` 반열림. **만료일 당일부터 미적용.**
 *
 * 발효일을 가진 참조 테이블 전부가 이 규칙을 쓴다 (rate_ledger · duty_programs ·
 * program_exclusions · fee_settings). export 하는 이유는 규칙이 한 곳에만 있어야
 * 하고, 테스트가 그 한 곳에 닿을 수 있어야 하기 때문이다.
 */
export function inEffect(from: string, to: string | null, asOf: string): boolean {
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

/**
 * 면제 판정. **발효일을 존중하고, 미검증 면제는 적용하지 않는다.**
 *
 * 예전에는 날짜를 아예 보지 않아서, 만료된 면제가 들어와도 계속 세율을 0 으로
 * 만들었다 — 무효가 된 IEEPA 조항이 관세표에 남아 있던 것과 같은 구조다.
 */
export function exclusionStatus(
  exclusions: ProgramExclusion[],
  programCode: string,
  hts: string,
  asOf: string,
): ExclusionStatus {
  const hit = exclusions.filter(
    (e) =>
      e.program_code === programCode &&
      htsMatchLength(e.hts_code, normalizeHts(hts)) >= 0 &&
      inEffect(e.effective_from ?? '1900-01-01', e.effective_to ?? null, asOf),
  )
  if (hit.length === 0) return 'none'
  // 하나라도 확인된 면제가 있으면 면제다. 전부 미확인이면 부과하고 알린다.
  //
  // TODO(471개 적재 시): confirmed 가 8자리 광범위이고 unverified 가 10자리 정밀인
  // 중첩이 있으면, 덜 구체적인 행을 근거로 0% 를 적용하게 된다 — 비대칭 원칙과
  // 반대다. 적재 전에 실제 중첩 유무를 확인하고, 있으면 구체성 우선 → 검증 상태
  // 순으로 바꿀 것. (docs/rate-ledger-sop.md 열린 항목)
  return hit.some((e) => !(e.source ?? '').startsWith('UNVERIFIED')) ? 'confirmed' : 'unverified'
}

/** @deprecated exclusionStatus 를 쓸 것 — 날짜·미검증 구분이 없다 */
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
    // 미검증 면제는 세율을 낮추지 않는다 — 부과하고 경고만 남긴다 (오차 비대칭)
    const exStatus: ExclusionStatus = h !== null ? exclusionStatus(exclusions, code, h, asOf) : 'none'
    const excluded = exStatus === 'confirmed'
    const entry: AppliedProgram = {
      program_code: code,
      authority: prog.authority,
      rate_type: prog.rate_type,
      applied_rate: 0,
      ledger_rate: row.ad_valorem_rate,
      matched_hts: row.hts_code,
      exclusion: exStatus,
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
