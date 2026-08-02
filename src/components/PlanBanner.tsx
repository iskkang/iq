import { useState } from 'react'
import { trackEvent } from '../lib/analytics'
import { PLAN } from '../lib/billing/plan'
import type { PlanState } from '../lib/billing/usePlan'
import { getRepo } from '../lib/repo'

export function PlanBanner({ plan, shipmentCount }: { plan: PlanState; shipmentCount: number }) {
  const repo = getRepo()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const upgrade = async () => {
    setBusy(true)
    setErr(null)
    trackEvent('checkout_started', { shipments: shipmentCount })
    try {
      window.location.href = await repo.startCheckout()
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e)
      trackEvent('checkout_failed', { reason: reason.slice(0, 120) })
      setErr(reason)
      setBusy(false)
    }
  }

  if (!plan.loaded) return null

  if (plan.activating) {
    return (
      <div className="mb-4 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
        Payment received — activating your workspace…
      </div>
    )
  }

  if (plan.paid) {
    return (
      <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
        <span className="font-medium">Pro · {PLAN.label}</span> — unlimited shipments and SKUs.
      </div>
    )
  }

  const atLimit = shipmentCount >= PLAN.free.shipments

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="font-medium">Free plan</span>
          <span className="text-slate-500">
            {' '}
            — {shipmentCount} of {PLAN.free.shipments} shipments, up to {PLAN.free.items} SKUs.
          </span>
          {atLimit && (
            <div className="mt-1 text-slate-700">
              You have used the free plan. Subscribe to add more shipments.
            </div>
          )}
        </div>
        <button
          onClick={upgrade}
          disabled={busy}
          className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {busy ? 'Opening checkout…' : `Subscribe — ${PLAN.label}`}
        </button>
      </div>
      {err && <p className="mt-2 text-xs text-rose-600">{err}</p>}
    </div>
  )
}
