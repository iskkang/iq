/**
 * 코드 페이지 렌더러 테스트.
 *
 * ── 왜 있는가 ────────────────────────────────────────────────────
 * 이 함수 하나가 수천 장을 찍는다. 템플릿 버그는 한 장이 아니라 **발행 전량에
 * 복제되고**, 색인된 뒤에 발견되면 되돌리는 데 발행보다 오래 걸린다.
 *
 * 특히 관세 숫자는 여기서 다시 계산하지 않고 앱과 같은 엔진을 부른다. 그 연결이
 * 끊어져도 페이지는 멀쩡히 나가므로 — 숫자만 틀린 채로 — 여기서 못박는다.
 */
import { describe, it, expect } from 'vitest'
import { renderCodePage, dutyExample, type CodePagePayload, type RenderContext } from '../src/lib/seo/codePage'

const FEES = { mpf_rate: 0.003464, mpf_min_usd: 33.58, mpf_max_usd: 651.5, hmf_rate: 0.00125, effective_from: '2025-10-01' }
const CTX: RenderContext = { fees: FEES, asOf: '2026-07-29', exampleValueUsd: 10000, exampleUnits: 1000 }
const DISC = 'Estimates only — not customs, legal, or tax advice.'

const PAGE: CodePagePayload = {
  code: '39269096',
  description: 'Articles of plastics > Other > Other',
  ad_valorem: 0.098,
  programs: [{ list: 'list3', rate: 0.25, provision: '9903.88.03', effective_from: '2019-05-10' }],
  siblings: ['39269010', '39269099'],
}

describe('관세 예시는 엔진이 계산한다', () => {
  it('중국은 MFN + 301 이 쌓인다', () => {
    // 9.8% + 25% = 34.8% → $10 단가에 $3.48
    const ex = dutyExample(PAGE, CTX)
    expect(ex.cn.duty_usd).toBeCloseTo(3.48, 2)
  })

  it('301 이 안 붙는 원산지는 MFN 만 낸다', () => {
    const ex = dutyExample(PAGE, CTX)
    expect(ex.other.duty_usd).toBeCloseTo(0.98, 2)
  })

  it('301 이 없는 코드는 두 원산지가 같다', () => {
    const ex = dutyExample({ ...PAGE, programs: [] }, CTX)
    expect(ex.cn.duty_usd).toBeCloseTo(ex.other.duty_usd!, 6)
  })

  it('세율이 미확정이면 0 으로 떨어지지 않는다', () => {
    // 0 을 넣으면 "관세 없음" 으로 읽힌다. null 이어야 화면이 unresolved 를 말한다
    const ex = dutyExample({ ...PAGE, ad_valorem: null }, CTX)
    expect(ex.cn.duty_usd).toBeNull()
  })
})

describe('페이지 구성', () => {
  const html = renderCodePage(PAGE, CTX, DISC)

  it('canonical 이 자기 자신이다', () => {
    expect(html).toContain('<link rel="canonical" href="https://www.landediq.app/hts/39269096"')
  })

  it('요율 스택을 레이어별로 분리해 보여준다', () => {
    expect(html).toContain('Base MFN')
    expect(html).toContain('Section 301 — China List 3')
    expect(html).toContain('9903.88.03')
    expect(html).toContain('in effect since 2019-05-10')
  })

  it('형제 코드로 내부 링크를 건다', () => {
    expect(html).toContain('href="/hts/39269010"')
    expect(html).toContain('href="/hts/39269099"')
  })

  it('§1-2 고지를 싣는다', () => {
    expect(html).toContain(DISC)
  })

  it('계측과 전환 폼이 붙어 있다', () => {
    expect(html).toContain('/analytics.js')
    expect(html).toContain("ev('code_page_view'")
    expect(html).toContain('id="watch-form"')
  })

  it('설명의 HTML 은 텍스트로 나간다', () => {
    const evil = renderCodePage({ ...PAGE, description: '<img src=x onerror=alert(1)>' }, CTX, DISC)
    expect(evil).not.toContain('<img src=x')
    expect(evil).toContain('&lt;img src=x')
  })

  it('301 이 없으면 "없음" 을 확정으로 말한다', () => {
    // 리스트에 없다는 것은 모른다는 뜻이 아니라 확인된 0% 다
    expect(renderCodePage({ ...PAGE, programs: [] }, CTX, DISC)).toContain('confirmed 0%')
  })
})
