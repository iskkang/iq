import { describe, expect, it } from 'vitest'
import { parseItemsCsv } from '../src/lib/csv/parseItems'

const HEADER = 'sku,product_name,description_or_material,unit_cost_usd,origin_country,units_per_shipment'

describe('CSV 파싱 (스펙 §2 컬럼)', () => {
  it('정상 행 파싱 + 타입 변환', () => {
    const csv = `${HEADER}\nMUG-01,Ceramic Mug,"ceramic, stoneware 12oz",$2.50,cn,1000`
    const { items, errors } = parseItemsCsv(csv)
    expect(errors).toEqual([])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sku: 'MUG-01',
      unit_cost_usd: 2.5,
      origin_country: 'CN',
      units_per_shipment: 1000,
      weight_kg_per_unit: null,
      hts_code: null,
    })
  })

  it('선택 컬럼(중량·현재가·hts_code) 지원', () => {
    const csv = `${HEADER},weight_kg_per_unit,current_price_usd,hts_code\nA,Item,steel,10,CN,50,0.75,19.99,6912.00.4810`
    const { items } = parseItemsCsv(csv)
    expect(items[0].weight_kg_per_unit).toBe(0.75)
    expect(items[0].current_price_usd).toBe(19.99)
    expect(items[0].hts_code).toBe('6912004810')
  })

  it('필수 컬럼 누락 시 전체 거부', () => {
    const { items, errors } = parseItemsCsv('sku,unit_cost_usd\nA,1')
    expect(items).toEqual([])
    expect(errors[0]).toContain('필수 컬럼 누락')
  })

  it('불량 행은 오류로 수집하고 정상 행만 통과', () => {
    const csv = [
      HEADER,
      'A,Good,plastic,2.5,CN,100',
      ',NoSku,x,1,CN,10',
      'B,BadCost,x,-3,CN,10',
      'C,BadUnits,x,1,CN,2.5',
      'D,NoOrigin,x,1,,10',
    ].join('\n')
    const { items, errors } = parseItemsCsv(csv)
    expect(items.map((i) => i.sku)).toEqual(['A'])
    expect(errors).toHaveLength(4)
  })

  it('10자리가 아닌 hts_code는 무시(null)', () => {
    const csv = `${HEADER},hts_code\nA,Item,x,1,CN,10,691200`
    const { items } = parseItemsCsv(csv)
    expect(items[0].hts_code).toBeNull()
  })
})
