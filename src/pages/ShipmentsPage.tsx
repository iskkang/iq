import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { PlanBanner } from '../components/PlanBanner'
import { trackEvent } from '../lib/analytics'
import { PLAN } from '../lib/billing/plan'
import { usePlan } from '../lib/billing/usePlan'
import { getRepo } from '../lib/repo'
import type { NewShipment, Shipment } from '../lib/repo/types'
import { SAMPLE_SHIPMENT_NAME } from '../lib/repo/sampleShipment'

const today = () => new Date().toISOString().slice(0, 10)

const DEFAULT_FORM: NewShipment = {
  name: '',
  freight_usd: 0,
  insurance_usd: 0,
  mode: 'ocean',
  allocation_basis: 'value',
  target_margin: 0.3,
  channel_fee_pct: 0.15,
  rate_as_of: today(),
}

export function ShipmentsPage() {
  const repo = getRepo()
  const nav = useNavigate()
  const [shipments, setShipments] = useState<Shipment[]>([])
  const [form, setForm] = useState<NewShipment>({ ...DEFAULT_FORM, rate_as_of: today() })
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const plan = usePlan()
  const locked = plan.loaded && !plan.paid && shipments.length >= PLAN.free.shipments

  const reload = () => repo.listShipments().then(setShipments).catch((e) => setErr(String(e)))

  // 첫 방문이면 샘플 선적을 만들어 둔다 (스펙 §MVP: 가입 즉시 데모 프로젝트).
  // 빈 화면 + 7필드 폼으로 시작하면 신규 사용자가 첫 리포트까지 도달하지 못한다.
  useEffect(() => {
    let cancelled = false
    repo
      .ensureSampleShipment()
      .catch(() => null) // 샘플 생성 실패가 목록 조회를 막지 않도록
      .then(() => {
        if (!cancelled) reload()
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setCreating(true)
    setErr(null)
    try {
      const s = await repo.createShipment({ ...form, name: form.name || `Shipment ${today()}` })
      nav(`/shipment/${s.id}`)
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      // 한도는 DB 트리거가 강제한다. 그 예외 문구가 그대로 나가면 사용자는
      // 'FREE_LIMIT_SHIPMENTS' 를 읽게 된다 — 무슨 일이 났는지 알 수 없다.
      if (raw.includes('FREE_LIMIT_SHIPMENTS')) {
        trackEvent('plan_limit_hit', { limit: 'shipments' })
        setErr(`The free plan covers ${PLAN.free.shipments} shipments. Subscribe (${PLAN.label}) to add more.`)
      } else {
        setErr(raw)
      }
    } finally {
      setCreating(false)
    }
  }

  const set = <K extends keyof NewShipment>(k: K, v: NewShipment[K]) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <section>
        <h1 className="mb-4 text-xl font-semibold">Shipments</h1>
        <PlanBanner plan={plan} shipmentCount={shipments.length} />
        {shipments.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            Setting up your sample shipment…
          </p>
        ) : (
          <ul className="space-y-2">
            {shipments.map((s) => (
              <li key={s.id}>
                <Link
                  to={`/shipment/${s.id}`}
                  className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-indigo-300 hover:shadow-sm"
                >
                  <div>
                    <div className="flex items-center gap-2 font-medium">
                      {s.name}
                      {s.name === SAMPLE_SHIPMENT_NAME && (
                        <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                          5 SKUs ready — open to see the report
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-slate-500">
                      {s.mode} · freight ${s.freight_usd} + ins ${s.insurance_usd} · allocation: {s.allocation_basis} · rates as of {s.rate_as_of}
                    </div>
                  </div>
                  <span className="text-sm text-indigo-600">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="h-fit rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-medium">New shipment</h2>
        <form onSubmit={create} className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-slate-500">Name</span>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. 2026-08 Ningbo LCL"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">Total freight (USD)</span>
              <input
                type="number" min={0} step="0.01" required
                value={form.freight_usd}
                onChange={(e) => set('freight_usd', Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Insurance (USD)</span>
              <input
                type="number" min={0} step="0.01"
                value={form.insurance_usd}
                onChange={(e) => set('insurance_usd', Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Transport mode</span>
              <select
                value={form.mode}
                onChange={(e) => set('mode', e.target.value as NewShipment['mode'])}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              >
                <option value="ocean">Ocean (HMF applies)</option>
                <option value="air">Air</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Freight allocation basis</span>
              <select
                value={form.allocation_basis}
                onChange={(e) => set('allocation_basis', e.target.value as NewShipment['allocation_basis'])}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              >
                <option value="value">Value</option>
                <option value="weight">Weight (falls back to value)</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Target margin (%)</span>
              <input
                type="number" min={0} max={99} step="0.1" required
                value={Math.round(form.target_margin * 1000) / 10}
                onChange={(e) => set('target_margin', Number(e.target.value) / 100)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Channel fee (%) e.g. Amazon 15</span>
              <input
                type="number" min={0} max={99} step="0.1" required
                value={Math.round(form.channel_fee_pct * 1000) / 10}
                onChange={(e) => set('channel_fee_pct', Number(e.target.value) / 100)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-slate-500">Rates as-of date (rate ledger lookup)</span>
            <input
              type="date" required
              value={form.rate_as_of}
              onChange={(e) => set('rate_as_of', e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <button
            disabled={creating || locked}
            className="w-full rounded-md bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {creating ? 'Creating…' : locked ? `Subscribe to add more — ${PLAN.label}` : 'Create shipment'}
          </button>
        </form>
      </section>
    </div>
  )
}
