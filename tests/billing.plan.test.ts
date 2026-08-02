import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isActive, PLAN, type Subscription } from '../src/lib/billing/plan'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION = join(root, 'supabase/migrations/20260802150000_subscriptions.sql')

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  status: 'active',
  current_period_end: null,
  cancel_at_period_end: false,
  ...over,
})

describe('isActive', () => {
  it('구독이 없으면 false', () => {
    expect(isActive(null)).toBe(false)
  })

  it('active · trialing 은 유료', () => {
    expect(isActive(sub({ status: 'active' }))).toBe(true)
    expect(isActive(sub({ status: 'trialing' }))).toBe(true)
  })

  it('결제가 밀렸거나 해지된 상태는 유료가 아니다', () => {
    for (const status of ['past_due', 'canceled', 'unpaid', 'incomplete', 'paused']) {
      expect(isActive(sub({ status }))).toBe(false)
    }
  })

  /**
   * status 만 보면 안 되는 이유. Stripe 는 결제가 실패해도 재시도 기간 동안
   * active 를 유지하는 설정이 가능하고, 주기가 끝난 뒤 상태 전이가 늦게 올 수도
   * 있다. 만료 시각이 지났으면 그 사이는 무료로 취급한다.
   */
  it('주기가 이미 끝났으면 status 가 active 여도 유료가 아니다', () => {
    const now = new Date('2026-08-02T00:00:00Z')
    expect(isActive(sub({ current_period_end: '2026-08-01T23:59:00Z' }), now)).toBe(false)
    expect(isActive(sub({ current_period_end: '2026-08-02T00:01:00Z' }), now)).toBe(true)
  })

  it('해지 예약이 걸려 있어도 주기가 남아 있으면 유료다', () => {
    const now = new Date('2026-08-02T00:00:00Z')
    expect(isActive(sub({ cancel_at_period_end: true, current_period_end: '2026-09-01T00:00:00Z' }), now)).toBe(true)
  })
})

/**
 * ── 화면 한도와 서버 한도가 갈라지지 않게 ─────────────────────────
 * 무료 한도는 두 곳에 있다: PLAN.free (화면 안내·업그레이드 유도) 와
 * DB 트리거 (실제 강제). 한쪽만 고치면 "화면은 막는데 API 는 뚫리거나",
 * "화면은 권하는데 서버가 거부하는" 상태가 되고 둘 다 조용히 벌어진다.
 */
describe('무료 한도는 SQL 과 TS 가 같은 값이어야 한다', () => {
  const sql = readFileSync(MIGRATION, 'utf-8')

  it.each([
    ['free_shipments', PLAN.free.shipments],
    ['free_items', PLAN.free.items],
  ])('%s = %i', (name, expected) => {
    const m = sql.match(new RegExp(`${name}\\s+constant\\s+integer\\s*:=\\s*(\\d+)`))
    expect(m, `${name} 선언을 마이그레이션에서 못 찾았다`).not.toBeNull()
    expect(Number(m![1])).toBe(expected)
  })

  it('DB 의 유료 판정 상태 목록이 ACTIVE_STATUSES 와 같다', () => {
    const fn = sql.slice(sql.indexOf('function public.workspace_is_paid'))
    const m = fn.match(/status in \(([^)]*)\)/)
    expect(m, 'workspace_is_paid 의 status 목록을 못 찾았다').not.toBeNull()
    const inSql = m![1].split(',').map((s) => s.trim().replace(/'/g, ''))
    expect(inSql.sort()).toEqual(['active', 'trialing'])
  })
})

describe('PLAN', () => {
  it('label 은 priceUsd 와 일치한다', () => {
    expect(PLAN.label).toBe(`$${PLAN.priceUsd}/mo`)
  })
})
