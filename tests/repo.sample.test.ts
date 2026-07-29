/**
 * 가입 즉시 데모 프로젝트 (스펙 §MVP).
 *
 * 신규 계정 첫 화면이 빈 상태 + 7필드 폼이면 첫 리포트까지 도달하지 못한다.
 * 샘플 선적 1건 + SKU 5건을 미리 넣어 클릭 한 번에 리포트가 뜨게 한다.
 */
import { describe, expect, it } from 'vitest'
import { createDemoRepo } from '../src/lib/repo/demo'
import { SAMPLE_ITEMS, SAMPLE_SHIPMENT_NAME } from '../src/lib/repo/sampleShipment'
import { isReviewed } from '../src/lib/classify/status'

describe('ensureSampleShipment', () => {
  it('첫 방문이면 샘플 선적을 만든다', async () => {
    const repo = createDemoRepo()
    expect(await repo.listShipments()).toHaveLength(0)

    const created = await repo.ensureSampleShipment()
    expect(created).not.toBeNull()
    expect(created!.name).toBe(SAMPLE_SHIPMENT_NAME)
    expect(await repo.listShipments()).toHaveLength(1)
  })

  it('두 번 호출해도 하나만 만든다 (멱등)', async () => {
    const repo = createDemoRepo()
    await repo.ensureSampleShipment()
    const second = await repo.ensureSampleShipment()
    expect(second).toBeNull()
    expect(await repo.listShipments()).toHaveLength(1)
  })

  it('선적이 이미 있으면 만들지 않는다', async () => {
    const repo = createDemoRepo()
    await repo.createShipment({
      name: 'My own shipment',
      freight_usd: 0, insurance_usd: 0, mode: 'ocean', allocation_basis: 'value',
      target_margin: 0.3, channel_fee_pct: 0.15, rate_as_of: '2026-07-29',
    })
    expect(await repo.ensureSampleShipment()).toBeNull()
    expect(await repo.listShipments()).toHaveLength(1)
  })

  it('SKU 5건이 HTS 확정 상태로 들어간다 — 분류를 기다리지 않고 바로 리포트가 나와야 한다', async () => {
    const repo = createDemoRepo()
    const s = await repo.ensureSampleShipment()
    const items = await repo.listItems(s!.id)

    expect(items).toHaveLength(SAMPLE_ITEMS.length)
    for (const it of items) {
      expect(it.hts_final, `${it.sku} 에 HTS 가 없다`).toBeTruthy()
      expect(isReviewed(it.classification_status), `${it.sku} 가 확정 상태가 아니다`).toBe(true)
    }
  })

  /**
   * 원산지는 중국이다. 레거시 301 을 8자리로 적재해 완결 표시가 가능해졌고,
   * 백팩(List 3)과 머그(List 4B 정지)가 같은 화면에서 다르게 나오는 것이
   * 첫 인상에서 보여야 할 것이다.
   */
  it('샘플 원산지는 중국이다 (301 리스트가 첫 화면에서 갈리는 걸 보여준다)', () => {
    expect(new Set(SAMPLE_ITEMS.map((i) => i.origin_country))).toEqual(new Set(['CN']))
  })

  it('모든 샘플 SKU 에 현재가가 있어야 마진·권장가 컬럼이 채워진다', () => {
    for (const i of SAMPLE_ITEMS) {
      expect(i.current_price_usd, `${i.sku} 에 current_price 가 없다`).toBeGreaterThan(0)
    }
  })
})

describe('비동기 분류 큐', () => {
  /**
   * 데모는 서버가 없으므로 큐잉이 불가능하다. null 을 돌려줘야 호출부가
   * 동기 mock 경로로 폴백한다 — 여기서 빈 문자열이나 가짜 id 를 주면
   * 화면이 오지 않을 결과를 영원히 기다린다.
   */
  it('데모 저장소는 큐잉을 지원하지 않는다고 알린다', async () => {
    const repo = createDemoRepo()
    expect(await repo.enqueueClassification('any-shipment')).toBeNull()
    expect(await repo.classificationProgress('any-job')).toBeNull()
  })
})
