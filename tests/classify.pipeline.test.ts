/**
 * 2단계 선택형 분류 파이프라인 (골든 v2 실패에 대한 대응의 회귀 방지).
 *
 * 지키려는 것:
 *   - 보기 밖 코드는 무효표로 처리된다 (자유 생성 금지)
 *   - auto_confirmed 는 만장일치 AND 원장 실존일 때만
 *   - confidence 는 판정에 관여하지 않는다 (v2 에서 오답에 85~91% 를 줬다)
 *   - 정규화 해시가 표기 차이를 흡수해 같은 상품이 같은 키를 갖는다
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_LINES_PER_HEADING,
  VOTES,
  cacheKey,
  assessSuggestion,
  extractJson,
  normalizeForCache,
  parseStageA,
  parseStageB,
  stageBPrompt,
  tallyVotes,
} from '../supabase/functions/classify/pipeline'
import type { CatalogLine, ClassifyInput, Selection, StageAResult } from '../supabase/functions/classify/pipeline'
import { isReviewed, resolveStatus } from '../src/lib/classify/status'
import { coverageOfTopN, rankReviewQueue } from '../src/lib/classify/reviewQueue'

const item = (id: string): ClassifyInput => ({
  id,
  product_name: 'Insulated tumbler 20oz',
  description_or_material: 'Double-wall vacuum insulated stainless steel tumbler with lid',
  origin_country: 'CN',
})

const sel = (id: string, code: string, confidence = 0.9): Selection => ({
  item_id: id,
  hts_code: code,
  rationale: 'r',
  confidence,
})

const stageA: StageAResult = {
  item_id: 'a',
  attributes: { material: 'steel', use: 'household', construction: 'vacuum' },
  headings: ['9617'],
}

describe('보기 밖 코드 = 무효표 (자유 생성 금지)', () => {
  it('세 표 모두 유효하고 같으면 만장일치', () => {
    const o = tallyVotes(
      item('a'),
      stageA,
      [sel('a', '9617001000'), sel('a', '9617001000'), sel('a', '9617001000')].map((s) => ({
        selection: s,
        valid: true,
      })),
    )
    expect(o.unanimous).toBe(true)
    expect(o.consensus).toBe('9617001000')
    expect(o.out_of_options).toBe(0)
  })

  it('한 표가 보기 밖이면 만장일치가 깨진다', () => {
    const o = tallyVotes(item('a'), stageA, [
      { selection: sel('a', '9617001000'), valid: true },
      { selection: sel('a', '9999999999'), valid: false },
      { selection: sel('a', '9617001000'), valid: true },
    ])
    expect(o.unanimous).toBe(false)
    expect(o.consensus).toBeNull()
    expect(o.out_of_options).toBe(1)
    expect(o.votes).toEqual(['9617001000', null, '9617001000'])
  })

  it('표가 갈리면 만장일치가 아니다', () => {
    const o = tallyVotes(item('a'), stageA, [
      { selection: sel('a', '9617001000'), valid: true },
      { selection: sel('a', '9617003000'), valid: true },
      { selection: sel('a', '9617001000'), valid: true },
    ])
    expect(o.unanimous).toBe(false)
    expect(o.consensus).toBeNull()
  })

  it('응답이 아예 없는 표도 무효로 센다', () => {
    const o = tallyVotes(item('a'), stageA, [
      { selection: sel('a', '9617001000'), valid: true },
      { selection: undefined, valid: false },
      { selection: sel('a', '9617001000'), valid: true },
    ])
    expect(o.unanimous).toBe(false)
    expect(o.out_of_options).toBe(1)
  })
})

describe('자동확정 없음 — 확인 전에는 전부 suggested (v3)', () => {
  const unanimous = tallyVotes(
    item('a'),
    stageA,
    Array.from({ length: VOTES }, () => ({ selection: sel('a', '9617001000'), valid: true })),
  )
  const split = tallyVotes(item('a'), stageA, [
    { selection: sel('a', '9617001000'), valid: true },
    { selection: sel('a', '9617003000'), valid: true },
    { selection: sel('a', '9617001000'), valid: true },
  ])

  it('만장일치 + 원장 실존이어도 auto_confirmed 가 되지 않는다', () => {
    expect(
      resolveStatus({
        item_id: 'a',
        candidates: [{ hts_code: '9617001000', confidence: 0.99, rationale: '' }],
        consensus: {
          code: '9617001000',
          unanimous: true,
          votes: ['9617001000', '9617001000', '9617001000'],
          in_ledger: true,
          out_of_options: 0,
          reason: assessSuggestion(unanimous, true).reason,
        },
      }),
    ).toBe('suggested')
  })

  it('후보가 없으면 pending', () => {
    expect(resolveStatus({ item_id: 'a', candidates: [] })).toBe('pending')
  })

  it('user_confirmed 만 isReviewed 다 — 나머지는 리포트에 unreviewed', () => {
    expect(isReviewed('user_confirmed')).toBe(true)
    expect(isReviewed('suggested')).toBe(false)
    expect(isReviewed('pending')).toBe(false)
  })

  it('만장일치는 검토 사유에 "사람 확인 대기"로 남는다', () => {
    expect(assessSuggestion(unanimous, true).reason).toContain('사람 확인 대기')
  })

  it('투표가 갈리면 우선 검토 사유가 남는다', () => {
    expect(assessSuggestion(split, true).reason).toContain('우선 검토')
  })

  it('원장에 없으면 duty 계산 불가가 사유에 남는다', () => {
    const r = assessSuggestion(unanimous, false).reason
    expect(r).toContain('원장')
    expect(r).toContain('우선 검토')
  })
})

describe('리뷰 큐 정렬 — 모델 불일치 → 호 경합 → duty 금액', () => {
  const base = { consensus: null, reviewed: false }

  it('모델 불일치가 duty 금액보다 우선한다', () => {
    const ranked = rankReviewQueue([
      { ...base, sku: 'BIG', hts_code: '6912004810', cross_check_code: '6912004810', duty_per_unit: 10, units: 1000 },
      { ...base, sku: 'DISAGREE', hts_code: '9617001000', cross_check_code: '7323930060', duty_per_unit: 0.1, units: 10 },
    ])
    expect(ranked[0].sku).toBe('DISAGREE')
    expect(ranked[0].models_disagree).toBe(true)
    expect(ranked[0].reasons[0]).toContain('모델 불일치')
  })

  it('6자리가 같으면 통계 suffix 가 달라도 불일치가 아니다', () => {
    const ranked = rankReviewQueue([
      { ...base, sku: 'A', hts_code: '6912004810', cross_check_code: '6912002000', duty_per_unit: 1, units: 1 },
    ])
    expect(ranked[0].models_disagree).toBe(false)
  })

  it('호 후보 2개 이상이 duty 금액보다 우선한다', () => {
    const ranked = rankReviewQueue([
      { ...base, sku: 'BIG', hts_code: '1', headings: ['6912'], duty_per_unit: 10, units: 1000 },
      { ...base, sku: 'CONTESTED', hts_code: '2', headings: ['9617', '7323'], duty_per_unit: 0.1, units: 10 },
    ])
    expect(ranked[0].sku).toBe('CONTESTED')
    expect(ranked[0].heading_contested).toBe(true)
  })

  it('같은 조건이면 duty 총액이 큰 순', () => {
    const ranked = rankReviewQueue([
      { ...base, sku: 'SMALL', hts_code: '1', duty_per_unit: 1, units: 10 },
      { ...base, sku: 'LARGE', hts_code: '2', duty_per_unit: 1, units: 5000 },
      { ...base, sku: 'MID', hts_code: '3', duty_per_unit: 1, units: 100 },
    ])
    expect(ranked.map((r) => r.sku)).toEqual(['LARGE', 'MID', 'SMALL'])
  })

  it('이미 확인한 건은 큐에서 빠진다', () => {
    const ranked = rankReviewQueue([
      { ...base, sku: 'DONE', hts_code: '1', duty_per_unit: 100, units: 100, reviewed: true },
      { ...base, sku: 'TODO', hts_code: '2', duty_per_unit: 1, units: 1 },
    ])
    expect(ranked.map((r) => r.sku)).toEqual(['TODO'])
  })

  it('교차검증 미실행(null)이면 불일치로 치지 않는다', () => {
    const ranked = rankReviewQueue([
      { ...base, sku: 'A', hts_code: '6912004810', cross_check_code: null, duty_per_unit: 1, units: 1 },
    ])
    expect(ranked[0].models_disagree).toBe(false)
  })

  it('상위 N건 커버리지를 계산한다 (금액 노출 집중도)', () => {
    const items = [
      { ...base, sku: 'A', hts_code: '1', duty_per_unit: 30, units: 1000 },
      { ...base, sku: 'B', hts_code: '2', duty_per_unit: 30, units: 1000 },
      { ...base, sku: 'C', hts_code: '3', duty_per_unit: 30, units: 1000 },
      ...Array.from({ length: 97 }, (_, i) => ({
        ...base, sku: `X${i}`, hts_code: '9', duty_per_unit: 0.1, units: 100,
      })),
    ]
    const cov = coverageOfTopN(rankReviewQueue(items), 3)
    expect(cov.pct).toBeGreaterThan(0.85)
    expect(cov.total_usd).toBeCloseTo(90000 + 970, 6)
  })
})

describe('정규화 해시 캐시 — 동일 입력 재호출 금지', () => {
  it('대소문자·구두점·공백 차이를 흡수한다', () => {
    const a = { id: '1', product_name: 'Yoga Mat 6mm', description_or_material: 'PVC foam, exercise', origin_country: 'CN' }
    const b = { id: '2', product_name: 'yoga  mat 6mm', description_or_material: 'pvc foam exercise', origin_country: 'cn' }
    expect(normalizeForCache(a)).toBe(normalizeForCache(b))
  })

  it('원산지가 다르면 다른 키 (301·IEEPA 가 달라진다)', () => {
    const cn = { id: '1', product_name: 'X', description_or_material: 'Y', origin_country: 'CN' }
    const vn = { ...cn, origin_country: 'VN' }
    expect(normalizeForCache(cn)).not.toBe(normalizeForCache(vn))
  })

  it('설명이 다르면 다른 키', () => {
    const a = { id: '1', product_name: 'X', description_or_material: 'cotton', origin_country: 'CN' }
    const b = { ...a, description_or_material: 'polyester' }
    expect(normalizeForCache(a)).not.toBe(normalizeForCache(b))
  })

  it('키는 item_id 에 의존하지 않는다 (같은 상품이면 같은 캐시)', async () => {
    const a = { id: 'row-1', product_name: 'X', description_or_material: 'Y', origin_country: 'CN' }
    const b = { ...a, id: 'row-999' }
    expect(await cacheKey(a, 'm')).toBe(await cacheKey(b, 'm'))
  })

  it('모델이 다르면 다른 키', async () => {
    const a = { id: '1', product_name: 'X', description_or_material: 'Y', origin_country: 'CN' }
    expect(await cacheKey(a, 'claude-haiku-4-5')).not.toBe(await cacheKey(a, 'claude-sonnet-4-6'))
  })
})

describe('프롬프트 조립 — 캐시 프리픽스 분리', () => {
  const lines: CatalogLine[] = Array.from({ length: MAX_LINES_PER_HEADING + 20 }, (_, i) => ({
    code: String(9617000000 + i),
    heading: '9617',
    description: `line ${i}`,
  }))
  const other: CatalogLine[] = [{ code: '4202923120', heading: '4202', description: 'backpack' }]

  it('보기는 호당 상한까지만 넣는다 (프롬프트 폭주 방지)', () => {
    const { catalog } = stageBPrompt([item('a')], new Map([['a', stageA]]), new Map([['9617', lines]]))
    expect([...catalog.matchAll(/^ {2}(\d{10}) /gm)].length).toBe(MAX_LINES_PER_HEADING)
  })

  it('카탈로그와 질문이 분리된다 — 상품 정보는 캐시 경계 뒤로', () => {
    const { catalog, questions } = stageBPrompt([item('a')], new Map([['a', stageA]]), new Map([['9617', lines]]))
    // 캐시 프리픽스에는 상품별 정보가 들어가면 안 된다 (배치마다 달라져 캐시가 깨진다)
    expect(catalog).not.toContain('item_id')
    expect(catalog).not.toContain('Insulated tumbler')
    expect(questions).toContain('item_id: a')
    expect(questions).toContain('material=steel')
    expect(questions).toContain('allowed catalog sections: 9617')
  })

  it('같은 호 집합이면 카탈로그가 바이트 동일하다 (캐시 히트 조건)', () => {
    const byHeading = new Map([['9617', lines], ['4202', other]])
    const batch1 = stageBPrompt([item('a')], new Map([['a', stageA]]), byHeading)
    const batch2 = stageBPrompt([item('zzz')], new Map([['zzz', { ...stageA, item_id: 'zzz' }]]), byHeading)
    // 상품이 달라도 호가 같으면 프리픽스가 같아야 캐시가 걸린다
    expect(batch1.catalog).toBe(batch2.catalog)
    expect(batch1.questions).not.toBe(batch2.questions)
  })

  it('호 순서가 달라도 카탈로그는 같다 (정렬로 프리픽스 정렬)', () => {
    const byHeading = new Map([['9617', lines], ['4202', other]])
    const a1 = stageBPrompt(
      [item('a')],
      new Map([['a', { ...stageA, headings: ['9617', '4202'] }]]),
      byHeading,
    )
    const a2 = stageBPrompt(
      [item('a')],
      new Map([['a', { ...stageA, headings: ['4202', '9617'] }]]),
      byHeading,
    )
    expect(a1.catalog).toBe(a2.catalog)
    // 오름차순이므로 4202 섹션이 먼저 온다
    expect(a1.catalog.indexOf('[heading 4202]')).toBeLessThan(a1.catalog.indexOf('[heading 9617]'))
  })

  it('호 후보가 없으면 빈 카탈로그와 안내 문구', () => {
    const { catalog, questions } = stageBPrompt([item('a')], new Map(), new Map())
    expect(catalog).not.toContain('[heading')
    expect(questions).toContain('(none — no heading proposed)')
  })
})

describe('응답 파싱', () => {
  it('markdown 펜스를 벗겨낸다', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('모델이 스스로 정정해 오브젝트를 두 번 내면 마지막(정정본)을 쓴다', () => {
    // bench 실측에서 실제로 터졌던 형태
    const raw = [
      '{"results":[{"item_id":"a","hts_code":"9999999999"}]}',
      '— I need to correct the backpack entry. Let me resubmit properly:',
      '{"results":[{"item_id":"a","hts_code":"4202923120"}]}',
    ].join('\n')
    const out = extractJson(raw) as { results: Array<{ hts_code: string }> }
    expect(out.results[0].hts_code).toBe('4202923120')
  })

  it('산문이 앞뒤로 붙어도 파싱된다', () => {
    expect(extractJson('Here you go:\n{"results":[]}\nLet me know!')).toEqual({ results: [] })
  })

  it('문자열 안의 중괄호·이스케이프에 속지 않는다', () => {
    const raw = String.raw`{"results":[{"rationale":"uses {braces} and \" quotes"}]}`
    const out = extractJson(raw) as { results: Array<{ rationale: string }> }
    expect(out.results[0].rationale).toContain('{braces}')
  })

  it('results 없는 오브젝트만 있으면 파싱 가능한 것을 쓴다', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('JSON 이 전혀 없으면 던진다', () => {
    expect(() => extractJson('sorry, I cannot help with that')).toThrow()
  })

  it('stage A: 4자리가 아닌 호는 버린다', () => {
    const m = parseStageA({
      results: [{ item_id: 'a', attributes: { material: 'm' }, headings: ['9617', '96170', '12', '4202'] }],
    })
    expect(m.get('a')!.headings).toEqual(['9617', '4202'])
  })

  it('stage A: 호는 3개까지', () => {
    const m = parseStageA({ results: [{ item_id: 'a', headings: ['1111', '2222', '3333', '4444'] }] })
    expect(m.get('a')!.headings).toHaveLength(3)
  })

  it('stage B: 10자리가 아닌 코드는 버린다', () => {
    const m = parseStageB({
      results: [
        { item_id: 'a', hts_code: '9617', confidence: 0.9 },
        { item_id: 'b', hts_code: '9617.00.10.00', confidence: 0.9 },
      ],
    })
    expect(m.has('a')).toBe(false)
    expect(m.get('b')!.hts_code).toBe('9617001000')
  })

  it('stage B: confidence 는 0~1 로 클램프', () => {
    const m = parseStageB({ results: [{ item_id: 'a', hts_code: '9617001000', confidence: 5 }] })
    expect(m.get('a')!.confidence).toBe(1)
  })
})
