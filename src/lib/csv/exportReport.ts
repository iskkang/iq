import Papa from 'papaparse'
import type { ShipmentResult } from '../calc/types'
import { dutyBreakdownLabel } from '../calc/engine'
import { formatHts } from '../calc/rates'
import { round2, round4 } from '../calc/money'
import { DISCLAIMER_EN } from '../disclaimer'
import { UNREVIEWED_LABEL } from '../classify/status'

/** 미해결 SKU 의 숫자 자리. 0·빈칸은 조용한 오해를 만든다 */
const UNRESOLVED_LABEL = 'UNRESOLVED — Section 301 scope unconfirmed'

/**
 * 리포트 CSV (스펙 §2 컬럼 + §4 레이어 내역·기준일 + §1-2 고지).
 */
export function buildReportCsv(result: ShipmentResult, shipmentName: string): string {
  const rows = result.items.map((r) => ({
    SKU: r.sku,
    'Unit cost (USD)': round2(r.unit_cost),
    HTS: formatHts(r.hts_code),
    'HTS status': r.provisional ? UNREVIEWED_LABEL : 'user confirmed',
    'Duty % breakdown': dutyBreakdownLabel(r),
    // 미해결은 숫자 자리에 0 이 아니라 문구를 넣는다. 빈칸으로 두면 스프레드시트에서
    // 0 으로 읽히고, 그게 정확히 우리가 막으려던 조용한 합산이다.
    'Duty $ (per unit)': r.duty_usd === null ? UNRESOLVED_LABEL : round4(r.duty_usd),
    'Fees (MPF+HMF, per unit)': round4(r.fees_per_unit),
    'Freight per unit': round4(r.freight_per_unit),
    'Landed cost (per unit)': r.landed_cost === null ? UNRESOLVED_LABEL : round4(r.landed_cost),
    'Current price': r.current_price !== null ? round2(r.current_price) : '',
    'True margin': r.true_margin !== null ? `${(r.true_margin * 100).toFixed(2)}%` : '',
    'Recommended price': r.recommended_price !== null ? round2(r.recommended_price) : '',
    Notes: r.warnings.join(' / '),
  }))

  const table = Papa.unparse(rows)
  const footer = [
    '',
    `"Shipment: ${shipmentName}"`,
    `"Rates as of: ${result.rate_as_of} (rate ledger snapshot)"`,
    `"MPF (shipment): $${round2(result.totals.mpf_shipment)} / HMF (shipment): $${round2(result.totals.hmf_shipment)} / Allocation basis: ${result.totals.allocation_basis_used}"`,
    `"Rows marked '${UNREVIEWED_LABEL}' are model suggestions that no person has confirmed. The importer of record is responsible for the final classification."`,
    `"${DISCLAIMER_EN}"`,
  ].join('\r\n')

  return `${table}\r\n${footer}\r\n`
}

export function downloadCsv(filename: string, csvText: string): void {
  const blob = new Blob([`﻿${csvText}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
