import { useCallback, useEffect, useRef, useState } from 'react'
import { trackEvent } from '../analytics'
import { isActive, PLAN, type Subscription } from './plan'
import { getRepo } from '../repo'

/**
 * 결제 상태를 읽고, 결제 후 돌아왔을 때 활성화를 기다린다.
 *
 * ── 왜 기다려야 하는가 ────────────────────────────────────────────
 * Stripe 는 결제 직후 사용자를 우리에게 돌려보내지만, 우리 DB 를 바꾸는 것은
 * **웹훅**이라 몇 초 늦게 도착한다. 돌아온 순간 한 번만 조회하면 거의 항상
 * "아직 무료" 로 보이고, 방금 $29 를 낸 사람이 잠긴 화면을 본다.
 */
const ACTIVATION_POLL_MS = 1500
const ACTIVATION_TIMEOUT_MS = 20_000

export interface PlanState {
  paid: boolean
  loaded: boolean
  activating: boolean
}

export function usePlan(): PlanState & { refresh: () => void } {
  const repo = getRepo()
  const [sub, setSub] = useState<Subscription | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [activating, setActivating] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(() => {
    return repo
      .getSubscription()
      .then(setSub)
      .catch(() => setSub(null))
      .finally(() => setLoaded(true))
  }, [repo])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 결제 창에서 돌아왔는가. 쿼리는 한 번만 읽고 즉시 지운다 —
  // 남겨 두면 새로고침마다 전환이 다시 기록된다.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const outcome = params.get('checkout')
    if (!outcome) return

    params.delete('checkout')
    const rest = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''))

    if (outcome === 'cancelled') {
      trackEvent('checkout_abandoned')
      return
    }
    if (outcome !== 'success') return

    // 이 이벤트가 이 광고그룹의 전환이다.
    trackEvent('subscription_started', { price_usd: PLAN.priceUsd })
    ;(window as Window & { trackConversion?: (w: string, v?: number) => void }).trackConversion?.(
      'subscribe',
      PLAN.priceUsd,
    )

    setActivating(true)
    const startedAt = Date.now()
    timer.current = setInterval(async () => {
      const next = await repo.getSubscription().catch(() => null)
      setSub(next)
      if (isActive(next) || Date.now() - startedAt > ACTIVATION_TIMEOUT_MS) {
        if (timer.current) clearInterval(timer.current)
        setActivating(false)
        // 시간 안에 안 켜졌다는 것은 웹훅이 안 왔다는 뜻이다. 사용자에겐
        // 아래 배너가 안내하고, 우리는 집계로 안다.
        if (!isActive(next)) trackEvent('subscription_activation_slow')
      }
    }, ACTIVATION_POLL_MS)

    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [repo])

  return { paid: isActive(sub), loaded, activating, refresh }
}
