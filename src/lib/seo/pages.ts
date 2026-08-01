/**
 * HTS 코드 페이지 색인 정책 — 판정 로직 단일 소스.
 *
 * ── 왜 코드로 있는가 ────────────────────────────────────────────
 * 정책을 문서로만 두면 어겨진다 (README: "산문으로만 남은 규칙은 어겨진다").
 * 여기서 어겨지면 되돌리는 비용이 비대칭이다 — 잘못 발행한 페이지는 구글
 * 캐시에 남고, 색인 제거는 발행보다 훨씬 느리다. 11,000 장 규모에서 그 차이는
 * 도메인 전체 품질 평가로 번진다. 그래서 "무엇을 색인 가능한 페이지로 낼
 * 것인가" 는 이 파일 한 곳에서만 결정하고, 테스트로 고정한다.
 *
 * 정책 전문과 근거: docs/seo-indexing-policy.md
 */

import { normalizeHts } from '../calc/rates'

export const SITE_ORIGIN = 'https://www.landediq.app'

/**
 * 발행 단위는 8자리다.
 *
 * HTSUS 에서 법정 세율은 8자리에서 정해지고 9·10 번째 자리는 통계 접미사다.
 * 즉 한 8자리의 10자리 자식들은 **세율이 같다.** 10자리로 페이지를 내면 같은
 * 숫자를 담은 near-duplicate 를 8,000 장 더 찍는 것이고, 그게 정확히 thin
 * content 판정의 대상이다.
 */
export const PAGE_CODE_LENGTH = 8

/** 의미 없는 말단 설명. "Other > Other" 만 남는 라인은 검색 의도에 답할 수 없다. */
const GENERIC_SEGMENT = /^(other|others|n\.?e\.?s\.?o\.?i\.?)$/i

/** 게이트 G2 기준: 일반어를 걷어낸 뒤 남는 설명 길이 */
export const MIN_MEANINGFUL_DESCRIPTION = 25

/** Tier A 는 실측 수요 상위 N 개까지. 웨이브 1 의 크기와 같다. */
export const TIER_A_DEMAND_RANK = 200

export const MAX_TITLE = 60
export const MAX_META_DESCRIPTION = 155

/** 색인 자격 판정에 필요한 최소 입력. 카탈로그에서 왔든 원장에서 왔든 이 형태로 넣는다. */
export interface PageInput {
  /** 숫자만 8자리 */
  code: string
  /** 조상 설명을 이어붙인 문장 ("부모 > 자식"), `hts_lines.description` 과 같은 형태 */
  description: string
  /** 종가세로 해석된 MFN. 종량세·복합세면 null */
  adValorem: number | null
  /** 이 코드에 붙는 프로그램 (`duty_programs.code`, 예: '301-list3') */
  programs: string[]
  /** 실측 검색 수요 순위. 1 이 가장 높다. 데이터가 없으면 null */
  demandRank: number | null
}

/**
 * A 실측 수요가 있는 코드 — 사람이 눈으로 확인하고 가장 먼저 낸다
 * B 프로그램 레이어가 붙는 코드 — 요율 스택이 있어 페이지에 담을 내용이 많다
 * C 나머지 색인 가능 코드
 * D 색인하지 않는다 (noindex). 페이지는 존재하되 사이트맵에 넣지 않는다
 */
export type Tier = 'A' | 'B' | 'C' | 'D'

export interface PageDecision {
  indexable: boolean
  tier: Tier
  /** noindex 사유. indexable 이면 빈 배열 */
  blockers: string[]
}

/**
 * 색인 자격 판정.
 *
 * 원칙 하나로 요약된다: **자기가 노릴 검색어에 답할 수 없는 페이지는 내지
 * 않는다.** 답하지 못하는 페이지를 대량으로 내면 구글이 도메인 단위로 평가를
 * 낮추고, 그 도메인에 앱이 얹혀 있다.
 */
export function decidePage(input: PageInput): PageDecision {
  const blockers: string[] = []
  const code = normalizeHts(input.code)

  // G1 형식 — 발행 단위가 아닌 것은 페이지가 되지 않는다
  if (code.length !== PAGE_CODE_LENGTH) {
    blockers.push(`code-not-${PAGE_CODE_LENGTH}-digit`)
  }

  // G2 세율 확정 — 종량세·복합세 라인은 화면에 "unresolved" 밖에 못 띄운다.
  // 세율을 묻는 검색어로 들어온 사람에게 세율이 없는 페이지를 주는 것이라
  // 체류 실패가 확정된 페이지다. 사용자에게는 계속 보여주되 색인은 막는다.
  if (input.adValorem === null) {
    blockers.push('rate-unresolved')
  }

  // G3 설명 밀도 — "Other > Other" 는 무엇에 대한 페이지인지 자체가 없다
  if (meaningfulDescription(input.description).length < MIN_MEANINGFUL_DESCRIPTION) {
    blockers.push('description-too-thin')
  }

  if (blockers.length > 0) return { indexable: false, tier: 'D', blockers }

  if (input.demandRank !== null && input.demandRank <= TIER_A_DEMAND_RANK) {
    return { indexable: true, tier: 'A', blockers: [] }
  }
  if (input.programs.length > 0) return { indexable: true, tier: 'B', blockers: [] }
  return { indexable: true, tier: 'C', blockers: [] }
}

/** 일반어 마디를 걷어낸 설명. 게이트 G3 와 제목 생성이 같은 기준을 쓰게 한다. */
export function meaningfulDescription(description: string): string {
  return segments(description)
    .filter((s) => !GENERIC_SEGMENT.test(s))
    .join(' ')
    .trim()
}

function segments(description: string): string[] {
  return description
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 표시용 6912.00.44 */
export function dotted(code: string): string {
  const d = normalizeHts(code)
  return [d.slice(0, 4), d.slice(4, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join('.')
}

/**
 * 페이지 경로. 숫자만 쓴다 — `hts.html` 의 기존 딥링크가 이미 숫자 형태이고
 * (`/hts/69120044`), 표기가 둘이면 같은 페이지가 두 URL 로 갈린다.
 */
export function pagePath(code: string): string {
  return `/hts/${normalizeHts(code)}`
}

export function canonicalUrl(code: string): string {
  return `${SITE_ORIGIN}${pagePath(code)}`
}

/**
 * 10 자리 코드가 들어오면 부모 8 자리를 돌려준다.
 *
 * 10 자리 URL 은 페이지를 갖지 않고 부모로 canonical 만 건다. 통계 접미사만
 * 다른 URL 들을 각각 색인시키면 우리가 우리 페이지끼리 경쟁시키는 꼴이다.
 */
export function parentPageCode(code: string): string | null {
  const d = normalizeHts(code)
  if (d.length < PAGE_CODE_LENGTH) return null
  if (d.length === PAGE_CODE_LENGTH) return null
  return d.slice(0, PAGE_CODE_LENGTH)
}

/** 장(chapter) 번호. 사이트맵 분할 단위. */
export function chapterOf(code: string): string {
  return normalizeHts(code).slice(0, 2)
}

/**
 * 사이트맵을 장 단위로 쪼갠다.
 *
 * 11,000 URL 은 한 파일에 들어가지만(상한 50,000), 한 덩어리로 내면 Search
 * Console 에서 "얼마나 색인됐나" 가 전체 평균으로만 보인다. 장 단위로 쪼개면
 * 어느 영역이 색인에 실패하는지가 바로 보이고, 그 신호가 웨이브 게이트의
 * 입력이다. 진단 가능성을 위해 쪼개는 것이지 크기 때문이 아니다.
 */
export function sitemapFor(code: string): string {
  return `/sitemaps/hts-ch${chapterOf(code)}.xml`
}

/** 제목. 60 자를 넘기면 검색 결과에서 잘린다. */
export function pageTitle(input: PageInput): string {
  const tail = ' | LandedIQ'
  const head = `HTS ${dotted(input.code)}`
  const subject = shortSubject(input.description)
  const body = subject ? `${head} ${subject} duty rate` : `${head} duty rate`
  return clamp(body, MAX_TITLE - tail.length) + tail
}

/**
 * meta description. 원장 값만으로 조립한다 — LLM 산문을 넣지 않는다.
 *
 * 11,000 장에 검증되지 않은 문장을 넣는 순간 이 제품이 파는 정확성과 구글이
 * 보는 대량 생성 신호가 동시에 문제가 된다. 여기서 나오는 문장은 전부 숫자와
 * 프로그램명에서 파생된다.
 */
export function pageDescription(input: PageInput): string {
  const parts = [`U.S. duty for HTS ${dotted(input.code)}`]
  parts.push(input.adValorem === null ? 'base rate unresolved' : `${pct(input.adValorem)} MFN`)
  if (input.programs.length > 0) parts.push(`plus ${input.programs.join(', ')}`)
  const lead = parts.join(': ').replace(': plus', ' plus')
  return clamp(`${lead}. Effective dates, origin comparison and a landed-cost example.`, MAX_META_DESCRIPTION)
}

function shortSubject(description: string): string {
  const meaningful = segments(description).filter((s) => !GENERIC_SEGMENT.test(s))
  return meaningful.length > 0 ? meaningful[meaningful.length - 1] : ''
}

function pct(rate: number): string {
  const v = rate * 100
  return `${v % 1 === 0 ? v : v.toFixed(1)}%`
}

/** 자르되 단어 중간에서 끊지 않는다. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()
}
