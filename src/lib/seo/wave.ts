/**
 * 웨이브 1 코드 선정.
 *
 * ── 왜 실측 수요로 못 뽑는가 ────────────────────────────────────
 * 정책(§5)은 Tier A 를 "실측 검색 수요 상위 200" 으로 정의했다. 광고 검색어
 * 리포트를 받아 확인한 결과 **그 200 개가 존재하지 않는다** — 4 일간 노출 194,
 * 그중 숫자 코드가 들어간 검색어는 12 노출뿐이고 고유 코드는 9 개다. 게다가 그
 * 9 개 중 7 개는 "hsn code" 질의로 인도 HSN 을 찾는 트래픽이다.
 *
 * 그리고 이건 데이터가 모자란 게 아니라 **닭과 달걀**이다. 코드 페이지가 색인된
 * 적이 없으니(고정 canonical 이 전부 /hts 로 합치고 있었다) Search Console 에
 * 코드 단위 질의가 쌓일 수가 없다. 관측을 기다리면 영원히 못 낸다.
 *
 * 그래서 웨이브 1 은 **구조적 우선순위**로 뽑고, 관측은 웨이브 2 부터 쓴다.
 * 웨이브 1 의 실제 목적이 트래픽이 아니라 "이 도메인의 코드 페이지가 색인될
 * 만한가" 를 재는 것이므로, 측정에 쓸 표본으로서 좋으면 된다.
 */

import { decidePage, meaningfulDescription, chapterOf, type PageInput } from './pages'

export interface WaveCandidate extends PageInput {
  /** 이 코드에 붙는 활성 프로그램 세율 합 (301 리스트 등). 없으면 0 */
  programRate: number
}

export interface WaveOptions {
  size: number
  /**
   * 한 장(chapter)에서 뽑을 수 있는 최대 개수.
   *
   * 없으면 웨이브 1 이 한두 장에 몰린다 — 3921·5210 처럼 리스트가 두꺼운 장이
   * 상위를 쓸어간다. 그러면 색인률이 나와도 "그 장이 색인된다" 는 뜻이지
   * "우리 코드 페이지가 색인된다" 는 뜻이 아니다. 게이트의 입력으로 쓰려면
   * 표본이 카탈로그를 닮아야 한다.
   */
  maxPerChapter: number
}

/** 관측된 코드는 접두어로 들어온다 (질의가 "711319 hs code" 처럼 6 자리다) */
export function isSeed(code: string, seedPrefixes: readonly string[]): boolean {
  return seedPrefixes.some((p) => code.startsWith(p))
}

/**
 * 점수 순 정렬 후 장별 상한을 지키며 채운다.
 *
 * 정렬 키는 전부 결정론적이다 — 같은 입력이면 같은 목록이 나와야 웨이브 결과를
 * 나중에 재현하고 비교할 수 있다.
 */
export function selectWave(
  candidates: readonly WaveCandidate[],
  seedPrefixes: readonly string[],
  opts: WaveOptions,
): WaveCandidate[] {
  const eligible = candidates.filter((c) => decidePage(c).indexable)

  const ranked = [...eligible].sort((a, b) => {
    const seedDiff = Number(isSeed(b.code, seedPrefixes)) - Number(isSeed(a.code, seedPrefixes))
    if (seedDiff !== 0) return seedDiff
    if (b.programRate !== a.programRate) return b.programRate - a.programRate
    const dl = meaningfulDescription(b.description).length - meaningfulDescription(a.description).length
    if (dl !== 0) return dl
    return a.code.localeCompare(b.code)
  })

  const perChapter = new Map<string, number>()
  const out: WaveCandidate[] = []
  for (const c of ranked) {
    if (out.length >= opts.size) break
    const ch = chapterOf(c.code)
    const n = perChapter.get(ch) ?? 0
    if (n >= opts.maxPerChapter) continue
    perChapter.set(ch, n + 1)
    out.push(c)
  }
  return out
}

/** 뽑힌 목록이 한쪽으로 쏠렸는지 — 사람이 눈으로 확인할 때 쓴다 */
export function chapterSpread(selected: readonly WaveCandidate[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of selected) m.set(chapterOf(c.code), (m.get(chapterOf(c.code)) ?? 0) + 1)
  return m
}
