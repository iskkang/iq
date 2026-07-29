import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getRepo } from '../lib/repo'
import type { NewShipment, Shipment } from '../lib/repo/types'

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

  const reload = () => repo.listShipments().then(setShipments).catch((e) => setErr(String(e)))
  useEffect(() => {
    reload()
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
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }

  const set = <K extends keyof NewShipment>(k: K, v: NewShipment[K]) => setForm((f) => ({ ...f, [k]: v }))

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <section>
        <h1 className="mb-4 text-xl font-semibold">선적 (Shipments)</h1>
        {shipments.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
            아직 선적이 없습니다. 오른쪽에서 첫 선적을 만들고 CSV를 업로드하세요.
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
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-slate-500">
                      {s.mode} · freight ${s.freight_usd} + ins ${s.insurance_usd} · 배부: {s.allocation_basis} · rates as of {s.rate_as_of}
                    </div>
                  </div>
                  <span className="text-sm text-indigo-600">열기 →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="h-fit rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 font-medium">새 선적</h2>
        <form onSubmit={create} className="space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-slate-500">이름</span>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="예: 2026-08 Ningbo LCL"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">총 운임 (USD)</span>
              <input
                type="number" min={0} step="0.01" required
                value={form.freight_usd}
                onChange={(e) => set('freight_usd', Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">보험료 (USD)</span>
              <input
                type="number" min={0} step="0.01"
                value={form.insurance_usd}
                onChange={(e) => set('insurance_usd', Number(e.target.value))}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">운송 모드</span>
              <select
                value={form.mode}
                onChange={(e) => set('mode', e.target.value as NewShipment['mode'])}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              >
                <option value="ocean">Ocean (HMF 적용)</option>
                <option value="air">Air</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">운임 배부 기준</span>
              <select
                value={form.allocation_basis}
                onChange={(e) => set('allocation_basis', e.target.value as NewShipment['allocation_basis'])}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              >
                <option value="value">가액 (value)</option>
                <option value="weight">중량 (weight) — 없으면 가액</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">목표 마진 (%)</span>
              <input
                type="number" min={0} max={99} step="0.1" required
                value={Math.round(form.target_margin * 1000) / 10}
                onChange={(e) => set('target_margin', Number(e.target.value) / 100)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">채널 수수료 (%) 예: Amazon 15</span>
              <input
                type="number" min={0} max={99} step="0.1" required
                value={Math.round(form.channel_fee_pct * 1000) / 10}
                onChange={(e) => set('channel_fee_pct', Number(e.target.value) / 100)}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-slate-500">Rate 기준일 (원장 조회 기준)</span>
            <input
              type="date" required
              value={form.rate_as_of}
              onChange={(e) => set('rate_as_of', e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            />
          </label>
          {err && <p className="text-xs text-rose-600">{err}</p>}
          <button
            disabled={creating}
            className="w-full rounded-md bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {creating ? '생성 중…' : '선적 생성'}
          </button>
        </form>
      </section>
    </div>
  )
}
