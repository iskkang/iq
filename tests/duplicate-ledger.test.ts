/**
 * 원장에 같은 행이 두 벌 들어갔을 때 엔진이 어떻게 되는가.
 *
 * ── 왜 재는가 ────────────────────────────────────────────────────
 * 시드를 반복 실행한 것만으로 122 만료 행이 두 개가 됐다 (`*_one_open` 인덱스는
 * effective_to IS NULL 인 행만 보므로 만료 행 중복을 막지 못했다). 앱에는
 * "Rates as-of date" 입력이 있어서 사용자가 기준일을 2026-02-24~07-24 로 잡으면
 * 두 행이 모두 매칭된다. 합산되면 10% 가 아니라 20% 가 된다.
 *
 * ── 실측 결과 ────────────────────────────────────────────────────
 * 합산되지 않는다. resolvePrograms 가 program_code 를 키로 Map 에 하나만 담기
 * 때문이다. 그래서 중복은 **이중 계상 버그가 아니었다.**
 *
 * 진짜 위험은 다른 데 있다: 키가 program_code 라 "어느 행이 이기는가" 가
 * 조용히 결정된다. 세율이 다른 중복이 들어오면 배열 순서(PostgREST 는 ORDER BY
 * 없이는 순서를 보장하지 않는다)에 따라 낮은 쪽이 이길 수 있고, 그건 관세를
 * 과소계상하는 방향이다 — 오차 비대칭 원칙상 가장 나쁜 실패다.
 *
 * 그래서 0021 의 전체 유니크 제약이 위생 문제가 아니라 **정확성 장치**다:
 * 세율이 다른 중복이 애초에 들어오지 못하게 한다.
 */
import { describe, it, expect } from 'vitest'
import { resolvePrograms } from '../src/lib/calc/programs'
import type { DutyProgram } from '../src/lib/calc/programs'
import type { RateRow } from '../src/lib/calc/types'

const PROGRAM_122: DutyProgram = {
  code: '122',
  name: 'Section 122 balance-of-payments surcharge',
  authority: 'Section 122',
  rate_type: 'additive',
  scope_type: 'all',
  coverage: 'partial',
  effective_from: '2026-02-24',
  effective_to: '2026-07-24',
} as DutyProgram

const row122 = (rate: number): RateRow =>
  ({
    program_code: '122',
    hts_code: '*',
    origin_country: null,
    layer: 'base_mfn',
    ad_valorem_rate: rate,
    effective_from: '2026-02-24',
    effective_to: '2026-07-24',
    source: 'HTSUS 9903.03.01',
  }) as RateRow

// 만료 전 기준일 — 두 행 모두 매칭되는 시점
const AS_OF = '2026-05-01'

describe('원장 중복 행', () => {
  it('같은 행이 두 벌이어도 합산되지 않는다 (10%, 20% 아님)', () => {
    const { applied, total } = resolvePrograms(
      [row122(0.1), row122(0.1)],
      [PROGRAM_122],
      [],
      '6912004400',
      'CN',
      AS_OF,
    )
    expect(applied.filter((a) => a.program_code === '122')).toHaveLength(1)
    expect(total).toBeCloseTo(0.1, 10)
  })

  it('만료 후에는 중복이든 아니든 적용되지 않는다', () => {
    const { total } = resolvePrograms([row122(0.1), row122(0.1)], [PROGRAM_122], [], '6912004400', 'CN', '2026-07-24')
    expect(total).toBe(0)
  })

  it('세율이 다른 중복은 어느 쪽이 이길지 배열 순서로 갈린다 — 0021 이 막아야 하는 이유', () => {
    const asc = resolvePrograms([row122(0.1), row122(0.25)], [PROGRAM_122], [], '6912004400', 'CN', AS_OF)
    const desc = resolvePrograms([row122(0.25), row122(0.1)], [PROGRAM_122], [], '6912004400', 'CN', AS_OF)
    // 순서만 뒤집었는데 답이 달라진다. 조용하고, 낮은 쪽이 이기면 과소계상이다.
    expect(asc.total).not.toBeCloseTo(desc.total, 10)
    // 엔진을 고쳐 "높은 쪽이 이긴다" 로 만들 수도 있지만, 그건 틀린 데이터를
    // 그럴듯하게 만드는 것이다. DB 가 중복을 거부하는 쪽이 맞다.
  })
})
