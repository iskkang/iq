import { DISCLAIMER_EN } from '../lib/disclaimer'

/** Estimates-only 고지 — 모든 화면·리포트 고정 노출 (스펙 §1-2) */
export function DisclaimerBar() {
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-200 bg-amber-50 px-4 py-2 text-center text-[11px] leading-snug text-amber-900">
      {DISCLAIMER_EN}
    </div>
  )
}

export function DisclaimerBlock() {
  return (
    <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-snug text-amber-900">
      {DISCLAIMER_EN}
    </p>
  )
}
