/**
 * HTS 코드 정규화·표기 유틸.
 *
 * 레이어 조회(lookupLayerRate/lookupDutyLayers/expectedLayers)는 제거했다 —
 * 관세 적용은 전부 programs.ts 의 resolvePrograms 한 경로로만 간다.
 * 두 경로가 공존하면 골든이 제품이 실제로 쓰는 경로를 재지 못한다.
 */

/** HTS 코드 정규화: 숫자만 남긴다. '*'(전 품목)는 그대로. */
export function normalizeHts(code: string): string {
  if (code === '*') return '*'
  return code.replace(/\D/g, '')
}

/** 10자리 형식 검사 (사용자 수동 입력 검증용) */
export function isValidHts10(code: string): boolean {
  return /^\d{10}$/.test(normalizeHts(code))
}

/** 표시용 6912.00.4810 형식 */
export function formatHts(code: string | null): string {
  if (!code) return '—'
  const d = normalizeHts(code)
  if (d.length < 4) return d
  const parts = [d.slice(0, 4), d.slice(4, 6), d.slice(6, 10)].filter(Boolean)
  return parts.join('.')
}
