/** 표시·비교용 반올림 유틸. 내부 계산은 전 자리수 유지, 최종 출력에서만 반올림. */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}
