import { useEffect, useMemo, useState } from 'react'
import { DisclaimerBlock } from '../components/Disclaimer'
import { computeShipment, dutyBreakdownLabel } from '../lib/calc/engine'
import type { ProgramContext } from '../lib/calc/engine'
import { fmtPct, fmtUsd, round2 } from '../lib/calc/money'
import { isReviewed, UNREVIEWED_LABEL } from '../lib/classify/status'
import { formatHts } from '../lib/calc/rates'
import type { CalcItem, FeeSettings, RateRow } from '../lib/calc/types'
import { buildReportCsv, downloadCsv } from '../lib/csv/exportReport'
import { getRepo } from '../lib/repo'
import type { Item, Shipment } from '../lib/repo/types'

/**
 * 미해결 SKU 의 숫자 칸.
 *
 * 대시(—)나 0 을 넣으면 "관세 없음" 과 구분되지 않는다. 화면에서 눈에 띄어야
 * 사용자가 이 줄을 통관사에게 물어본다 — 그게 이 상태의 목적이다.
 * 정확한 범위와 이유는 해당 행의 warnings 에 들어 있다.
 */
function UnresolvedCell() {
  return (
    <span
      className="rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-amber-200"
      title="Section 301 scope unconfirmed — see the warning for this SKU"
    >
      unresolved
    </span>
  )
}

export function ReportView({ shipment, items }: { shipment: Shipment; items: Item[] }) {
  const repo = getRepo()
  const [rates, setRates] = useState<RateRow[] | null>(null)
  const [fees, setFees] = useState<FeeSettings | null>(null)
  const [ctx, setCtx] = useState<ProgramContext | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([repo.getRates(), repo.getFees(shipment.rate_as_of), repo.getPrograms(), repo.getExclusions()])
      .then(([r, f, programs, exclusions]) => {
        setRates(r)
        setFees(f)
        setCtx({ programs, exclusions })
      })
      .catch((e) => setErr(String(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipment.rate_as_of])

  const result = useMemo(() => {
    if (!rates || !fees || !ctx) return null
    const calcItems: CalcItem[] = items.map((it) => ({
      sku: it.sku,
      unit_cost_usd: it.unit_cost_usd,
      origin_country: it.origin_country,
      units_per_shipment: it.units_per_shipment,
      weight_kg_per_unit: it.weight_kg_per_unit,
      current_price_usd: it.current_price_usd,
      hts_code: it.hts_final,
      provisional: !isReviewed(it.classification_status), // 사람 미확인 → unreviewed 표기
    }))
    return computeShipment(
      {
        freight_usd: shipment.freight_usd,
        insurance_usd: shipment.insurance_usd,
        mode: shipment.mode,
        allocation_basis: shipment.allocation_basis,
        target_margin: shipment.target_margin,
        channel_fee_pct: shipment.channel_fee_pct,
        rate_as_of: shipment.rate_as_of,
      },
      calcItems,
      rates,
      fees,
      ctx,
    )
  }, [rates, fees, ctx, items, shipment])

  if (err) return <p className="text-sm text-rose-600">{err}</p>
  if (!result) return <p className="text-sm text-slate-500">Loading rate ledger…</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-500">
          <span className="font-medium text-slate-700">Rates as of {result.rate_as_of}</span>
          {' · '}MPF (shipment) {fmtUsd(round2(result.totals.mpf_shipment))} · HMF (shipment){' '}
          {fmtUsd(round2(result.totals.hmf_shipment))} · Allocation basis: {result.totals.allocation_basis_used}
          {' · '}Shipment value {fmtUsd(round2(result.totals.total_value))}
        </div>
        <button
          onClick={() => downloadCsv(`landediq-report-${shipment.name}.csv`, buildReportCsv(result, shipment.name))}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Download CSV
        </button>
      </div>

      {result.items.some((r) => r.provisional) && (
        <p className="rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          ⚠ {result.items.filter((r) => r.provisional).length} of {result.items.length} SKUs are marked{' '}
          <b>{UNREVIEWED_LABEL}</b> — model suggestions no person has confirmed. The importer of record is
          responsible for the final classification.
        </p>
      )}

      {result.warnings.map((w) => (
        <p key={w} className="rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-800">⚠ {w}</p>
      ))}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full min-w-[1000px] text-right text-xs">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">HTS</th>
              <th className="px-3 py-2 text-left">Duty % breakdown</th>
              <th className="px-3 py-2">Duty $</th>
              <th className="px-3 py-2">Fees</th>
              <th className="px-3 py-2">Freight/unit</th>
              <th className="px-3 py-2">Unit cost</th>
              <th className="px-3 py-2">Landed cost</th>
              <th className="px-3 py-2">Current price</th>
              <th className="px-3 py-2">True margin</th>
              <th className="px-3 py-2">Recommended</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {result.items.map((r) => (
              <tr key={r.sku} className={r.warnings.length > 0 ? 'bg-amber-50/40' : ''}>
                <td className="px-3 py-2 text-left font-medium">{r.sku}</td>
                <td className="px-3 py-2 text-left font-mono">
                  {formatHts(r.hts_code)}
                  {r.provisional && (
                    <span
                      className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-medium text-amber-800"
                      title="Model suggestion — no person has confirmed this classification"
                    >
                      {UNREVIEWED_LABEL}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-left">{dutyBreakdownLabel(r)}</td>
                <td className="px-3 py-2">
                  {r.duty_usd === null ? <UnresolvedCell /> : fmtUsd(round2(r.duty_usd))}
                </td>
                <td className="px-3 py-2">{fmtUsd(round2(r.fees_per_unit))}</td>
                <td className="px-3 py-2">{fmtUsd(round2(r.freight_per_unit))}</td>
                <td className="px-3 py-2">{fmtUsd(round2(r.unit_cost))}</td>
                <td className="px-3 py-2 font-semibold">
                  {r.landed_cost === null ? <UnresolvedCell /> : fmtUsd(round2(r.landed_cost))}
                </td>
                <td className="px-3 py-2">{r.current_price !== null ? fmtUsd(round2(r.current_price)) : '—'}</td>
                <td className={`px-3 py-2 ${r.true_margin !== null && r.true_margin < 0 ? 'font-medium text-rose-600' : ''}`}>
                  {fmtPct(r.true_margin)}
                </td>
                <td className="px-3 py-2">{r.recommended_price !== null ? fmtUsd(round2(r.recommended_price)) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result.items.some((r) => r.warnings.length > 0) && (
        <div className="space-y-1 text-xs text-amber-800">
          {result.items
            .filter((r) => r.warnings.length > 0)
            .map((r) => (
              <p key={r.sku}>
                ⚠ <b>{r.sku}</b>: {r.warnings.join(' / ')}
              </p>
            ))}
        </div>
      )}

      <DisclaimerBlock />
    </div>
  )
}
