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
  decideStatus,
  extractJson,
  normalizeForCache,
  parseStageA,
  parseStageB,
  stageBUser,
  tallyVotes,
} from '../supabase/functions/classify/pipeline'
import type { CatalogLine, ClassifyInput, Selection, StageAResult } from '../supabase/functions/classify/pipeline'
import { resolveStatus } from '../src/lib/classify/status'

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

describe('auto_confirmed = 만장일치 AND 원장 실존', () => {
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

  it('만장일치 + 원장 실존 → auto_confirmed', () => {
    expect(decideStatus(unanimous, true).status).toBe('auto_confirmed')
  })

  it('만장일치인데 원장에 없으면 needs_review', () => {
    const d = decideStatus(unanimous, false)
    expect(d.status).toBe('needs_review')
    expect(d.reason).toContain('원장')
  })

  it('원장에 있어도 표가 갈리면 needs_review', () => {
    expect(decideStatus(split, true).status).toBe('needs_review')
  })

  it('confidence 는 판정에 전혀 관여하지 않는다', () => {
    const lowConf = tallyVotes(
      item('a'),
      stageA,
      Array.from({ length: VOTES }, () => ({ selection: sel('a', '9617001000', 0.01), valid: true })),
    )
    const highConf = tallyVotes(
      item('a'),
      stageA,
      Array.from({ length: VOTES }, () => ({ selection: sel('a', '9617001000', 0.99), valid: true })),
    )
    expect(decideStatus(lowConf, true).status).toBe('auto_confirmed')
    expect(decideStatus(highConf, false).status).toBe('needs_review')
  })
})

describe('resolveStatus — consensus 없는 응답은 안전한 쪽으로', () => {
  it('consensus 가 없으면 confidence 가 높아도 needs_review', () => {
    expect(
      resolveStatus({ item_id: 'a', candidates: [{ hts_code: '9617001000', confidence: 0.99, rationale: '' }] }),
    ).toBe('needs_review')
  })

  it('후보가 없으면 pending', () => {
    expect(resolveStatus({ item_id: 'a', candidates: [] })).toBe('pending')
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

describe('프롬프트 조립', () => {
  const lines: CatalogLine[] = Array.from({ length: MAX_LINES_PER_HEADING + 20 }, (_, i) => ({
    code: String(9617000000 + i),
    heading: '9617',
    description: `line ${i}`,
  }))

  it('보기는 호당 상한까지만 넣는다 (프롬프트 폭주 방지)', () => {
    const u = stageBUser([item('a')], new Map([['a', stageA]]), new Map([['9617', lines]]))
    const shown = [...u.matchAll(/^ {2}(\d{10}) /gm)].length
    expect(shown).toBe(MAX_LINES_PER_HEADING)
  })

  it('보기 블록에 item_id 와 step-1 속성이 들어간다', () => {
    const u = stageBUser([item('a')], new Map([['a', stageA]]), new Map([['9617', lines]]))
    expect(u).toContain('item_id: a')
    expect(u).toContain('material=steel')
    expect(u).toContain('OPTIONS')
  })

  it('호 후보가 없으면 보기 없음을 명시한다', () => {
    const u = stageBUser([item('a')], new Map(), new Map())
    expect(u).toContain('(no options available)')
  })
})

describe('응답 파싱', () => {
  it('markdown 펜스를 벗겨낸다', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
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
