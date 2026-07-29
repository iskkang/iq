import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { classifyItems, type ClassifyBackend } from '../lib/classify/client'
import { CONFIDENCE_THRESHOLD } from '../lib/classify/types'
import { formatHts, isValidHts10, normalizeHts } from '../lib/calc/rates'
import { parseItemsCsv, REQUIRED_COLUMNS } from '../lib/csv/parseItems'
import { getRepo } from '../lib/repo'
import type { Item, Shipment } from '../lib/repo/types'
import { ReportView } from './ReportView'

const STATUS_CHIP: Record<Item['classification_status'], { label: string; cls: string }> = {
  pending: { label: 'Unclassified', cls: 'bg-slate-100 text-slate-600' },
  needs_review: { label: 'Needs review', cls: 'bg-amber-100 text-amber-800' },
  auto_confirmed: { label: 'Auto-confirmed', cls: 'bg-emerald-100 text-emerald-700' },
  user_confirmed: { label: 'Confirmed', cls: 'bg-indigo-100 text-indigo-700' },
}

export function ShipmentDetailPage() {
  const { id } = useParams<{ id: string }>()
  const repo = getRepo()
  const [shipment, setShipment] = useState<Shipment | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [tab, setTab] = useState<'items' | 'report'>('items')
  const [err, setErr] = useState<string | null>(null)
  const [csvErrors, setCsvErrors] = useState<string[]>([])
  const [classifying, setClassifying] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const reload = useCallback(async () => {
    if (!id) return
    try {
      const [s, its] = await Promise.all([repo.getShipment(id), repo.listItems(id)])
      setShipment(s)
      setItems(its)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [id, repo])

  useEffect(() => {
    reload()
  }, [reload])

  const onCsv = async (file: File) => {
    if (!id) return
    setCsvErrors([])
    const text = await file.text()
    const { items: rows, errors } = parseItemsCsv(text)
    setCsvErrors(errors)
    if (rows.length > 0) {
      await repo.addItems(id, rows)
      await reload()
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const runClassify = async () => {
    if (!id) return
    const targets = items.filter((it) => it.classification_status === 'pending')
    if (targets.length === 0) return
    setClassifying(`0/${targets.length}`)
    setErr(null)
    try {
      const backend: ClassifyBackend =
        repo.mode === 'demo'
          ? { kind: 'mock' }
          : { kind: 'edge', supabase: (repo as unknown as { client: never }).client }
      const batches = await classifyItems(
        backend,
        targets.map((it) => ({
          id: it.id,
          product_name: it.product_name,
          description_or_material: it.description_or_material,
          origin_country: it.origin_country,
        })),
        (done, total) => setClassifying(`${done}/${total}`),
      )
      await repo.saveClassification(id, batches)
      await reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setClassifying(null)
    }
  }

  const confirmCandidate = async (item: Item, hts: string, fromLlm: boolean) => {
    await repo.updateItem(item.id, {
      hts_final: normalizeHts(hts),
      hts_source: fromLlm ? 'llm' : 'manual',
      classification_status: 'user_confirmed', // manual/user pick overrides confidence (§5)
    })
    setExpanded(null)
    await reload()
  }

  if (err && !shipment) return <p className="text-sm text-rose-600">{err}</p>
  if (!shipment) return <p className="text-sm text-slate-500">Loading…</p>

  const pendingCount = items.filter((i) => i.classification_status === 'pending').length
  const reviewCount = items.filter((i) => i.classification_status === 'needs_review').length

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/" className="text-xs text-slate-500 hover:text-indigo-600">← All shipments</Link>
          <h1 className="text-xl font-semibold">{shipment.name}</h1>
          <p className="text-xs text-slate-500">
            {shipment.mode} · freight ${shipment.freight_usd} + ins ${shipment.insurance_usd} ·
            allocation {shipment.allocation_basis} · target {Math.round(shipment.target_margin * 100)}% ·
            fee {Math.round(shipment.channel_fee_pct * 100)}% · rates as of {shipment.rate_as_of}
          </p>
        </div>
        <div className="flex rounded-md bg-slate-100 p-1 text-sm">
          {(['items', 'report'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-4 py-1.5 ${tab === t ? 'bg-white font-medium shadow-sm' : 'text-slate-500'}`}
            >
              {t === 'items' ? `SKUs (${items.length})` : 'Report'}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{err}</p>}

      {tab === 'report' ? (
        <ReportView shipment={shipment} items={items} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && onCsv(e.target.files[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Upload CSV
            </button>
            <button
              onClick={runClassify}
              disabled={classifying !== null || pendingCount === 0}
              className="rounded-md border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-40"
            >
              {classifying ? `Estimating HTS… ${classifying}` : `Estimate HTS (${pendingCount} unclassified)`}
            </button>
            {reviewCount > 0 && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
                Needs review: {reviewCount} (confidence &lt; {CONFIDENCE_THRESHOLD})
              </span>
            )}
            <span className="ml-auto text-[11px] text-slate-400">
              Required columns: {REQUIRED_COLUMNS.join(', ')} (optional: weight_kg_per_unit, current_price_usd, hts_code)
            </span>
          </div>

          {csvErrors.length > 0 && (
            <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
              <p className="font-medium">CSV errors ({csvErrors.length}) — these rows were skipped:</p>
              <ul className="mt-1 list-inside list-disc">
                {csvErrors.slice(0, 10).map((e) => <li key={e}>{e}</li>)}
                {csvErrors.length > 10 && <li>… and {csvErrors.length - 10} more</li>}
              </ul>
            </div>
          )}

          <ManualAddForm shipmentId={shipment.id} onAdded={reload} />

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Product / material</th>
                  <th className="px-3 py-2 text-right">Unit cost</th>
                  <th className="px-3 py-2">Origin</th>
                  <th className="px-3 py-2 text-right">Units</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2">HTS</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-slate-400">
                      Upload a CSV or add SKUs manually below. (Sample: samples/sample_products.csv)
                    </td>
                  </tr>
                )}
                {items.map((it) => (
                  <Fragment key={it.id}>
                    <tr className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{it.sku}</td>
                      <td className="max-w-[220px] truncate px-3 py-2" title={`${it.product_name} — ${it.description_or_material}`}>
                        {it.product_name}
                        <span className="text-slate-400"> · {it.description_or_material}</span>
                      </td>
                      <td className="px-3 py-2 text-right">${it.unit_cost_usd}</td>
                      <td className="px-3 py-2">{it.origin_country}</td>
                      <td className="px-3 py-2 text-right">{it.units_per_shipment}</td>
                      <td className="px-3 py-2 text-right">{it.current_price_usd ? `$${it.current_price_usd}` : '—'}</td>
                      <td className="px-3 py-2 font-mono">{formatHts(it.hts_final)}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_CHIP[it.classification_status].cls}`}>
                          {STATUS_CHIP[it.classification_status].label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setExpanded(expanded === it.id ? null : it.id)}
                          className="mr-2 text-indigo-600 hover:underline"
                        >
                          {expanded === it.id ? 'Close' : 'Confirm HTS'}
                        </button>
                        <button
                          onClick={async () => {
                            await repo.deleteItem(it.id)
                            reload()
                          }}
                          className="text-slate-400 hover:text-rose-600"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                    {expanded === it.id && (
                      <tr>
                        <td colSpan={9} className="bg-slate-50 px-4 py-3">
                          <CandidatePicker item={it} onConfirm={confirmCandidate} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function CandidatePicker({
  item,
  onConfirm,
}: {
  item: Item
  onConfirm: (item: Item, hts: string, fromLlm: boolean) => Promise<void>
}) {
  const [manual, setManual] = useState('')
  const [manualErr, setManualErr] = useState<string | null>(null)

  return (
    <div className="space-y-3 text-xs">
      {item.candidates.length > 0 ? (
        <div className="space-y-1.5">
          <p className="font-medium text-slate-600">LLM candidates (pick one to confirm):</p>
          {item.candidates.map((c) => (
            <button
              key={c.hts_code}
              onClick={() => onConfirm(item, c.hts_code, true)}
              className="flex w-full items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-left hover:border-indigo-400"
            >
              <span className="font-mono font-medium">{formatHts(c.hts_code)}</span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  c.confidence >= CONFIDENCE_THRESHOLD ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'
                }`}
              >
                {(c.confidence * 100).toFixed(0)}%
              </span>
              <span className="flex-1 text-slate-500">{c.rationale}</span>
              <span className="text-indigo-600">Use this →</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-slate-500">No LLM candidates yet. Click "Estimate HTS" or enter a code manually below.</p>
      )}
      <div className="flex items-center gap-2">
        <span className="text-slate-600">Manual entry (10 digits):</span>
        <input
          value={manual}
          onChange={(e) => {
            setManual(e.target.value)
            setManualErr(null)
          }}
          placeholder="6912.00.4810"
          className="w-40 rounded-md border border-slate-300 px-2 py-1 font-mono"
        />
        <button
          onClick={() => {
            if (!isValidHts10(manual)) return setManualErr('Not a valid 10-digit HTS code')
            onConfirm(item, manual, false)
          }}
          className="rounded-md bg-slate-800 px-3 py-1 font-medium text-white hover:bg-slate-700"
        >
          Confirm manually (ignores confidence)
        </button>
        {manualErr && <span className="text-rose-600">{manualErr}</span>}
      </div>
    </div>
  )
}

function ManualAddForm({ shipmentId, onAdded }: { shipmentId: string; onAdded: () => void }) {
  const repo = getRepo()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({
    sku: '', product_name: '', description_or_material: '',
    unit_cost_usd: '', origin_country: '', units_per_shipment: '',
    current_price_usd: '', weight_kg_per_unit: '',
  })
  const [err, setErr] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const cost = Number(f.unit_cost_usd)
    const units = Number(f.units_per_shipment)
    if (!f.sku.trim() || !(cost > 0) || !Number.isInteger(units) || units <= 0 || !f.origin_country.trim()) {
      return setErr('sku, unit cost (positive), units (positive integer) and origin are required')
    }
    await repo.addItems(shipmentId, [
      {
        sku: f.sku.trim(),
        product_name: f.product_name.trim(),
        description_or_material: f.description_or_material.trim(),
        unit_cost_usd: cost,
        origin_country: f.origin_country.trim().toUpperCase(),
        units_per_shipment: units,
        weight_kg_per_unit: Number(f.weight_kg_per_unit) > 0 ? Number(f.weight_kg_per_unit) : null,
        current_price_usd: Number(f.current_price_usd) > 0 ? Number(f.current_price_usd) : null,
        hts_code: null,
      },
    ])
    setF({ sku: '', product_name: '', description_or_material: '', unit_cost_usd: '', origin_country: '', units_per_shipment: '', current_price_usd: '', weight_kg_per_unit: '' })
    setErr(null)
    onAdded()
  }

  if (!open)
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-indigo-600 hover:underline">
        + Add SKU manually
      </button>
    )

  const input = (key: keyof typeof f, ph: string, cls = 'w-28') => (
    <input
      value={f[key]}
      onChange={(e) => setF((s) => ({ ...s, [key]: e.target.value }))}
      placeholder={ph}
      className={`${cls} rounded-md border border-slate-300 px-2 py-1.5`}
    />
  )

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs">
      {input('sku', 'SKU *')}
      {input('product_name', 'Product name', 'w-36')}
      {input('description_or_material', 'Material / description', 'w-44')}
      {input('unit_cost_usd', 'Unit cost USD *', 'w-24')}
      {input('origin_country', 'Origin (CN) *', 'w-24')}
      {input('units_per_shipment', 'Units *', 'w-20')}
      {input('current_price_usd', 'Current price', 'w-24')}
      {input('weight_kg_per_unit', 'kg/unit', 'w-20')}
      <button className="rounded-md bg-slate-800 px-3 py-1.5 font-medium text-white hover:bg-slate-700">Add</button>
      <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">Close</button>
      {err && <span className="w-full text-rose-600">{err}</span>}
    </form>
  )
}
