/**
 * 스크립트용 fee_settings 로더 — **DB 가 유일한 출처다.**
 *
 * 앱은 getFees 로 DB 를 읽는데 스크립트(골든·샘플·벤치)는 상수를 갖고 있었다.
 * FY2026 조정 때 값이 같아 계산 결과는 맞았지만 **리포트의 캡 표기가 틀린 값을
 * 인용**하고 있었다 — 숫자가 우연히 맞아 안 드러나는 종류다. FY2027(2026-10-01)
 * 에는 값이 실제로 갈라진다.
 *
 * 선택 규칙은 앱과 동일하다: effective_from <= asOf 이고
 * (effective_to is null 또는 effective_to > asOf) — `[from, to)` 반열림.
 *
 * **상수 폴백은 없다.** DB 에 닿지 못하면 명시적으로 실패한다. 폴백을 두면
 * "DB 를 읽는다고 선언됐지만 실제로는 상수" 상태가 다시 만들어진다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { FeeSettings } from '../../src/lib/calc/types'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function dotenv(): Record<string, string> {
  const f = join(root, '.env')
  if (!existsSync(f)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  return out
}

export async function loadFees(asOf: string): Promise<FeeSettings> {
  const env = dotenv()
  const url = process.env.VITE_SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'fee_settings 를 읽을 수 없다 — VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없다. ' +
        '상수로 폴백하지 않는다: 그러면 앱(DB)과 스크립트(상수)가 갈라진다.',
    )
  }

  const q =
    `${url}/rest/v1/fee_settings?select=*` +
    `&effective_from=lte.${asOf}` +
    `&or=(effective_to.is.null,effective_to.gt.${asOf})` +
    `&order=effective_from.desc&limit=1`
  const res = await fetch(q, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`fee_settings 조회 실패: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const rows = (await res.json()) as Array<Record<string, string | number>>

  if (rows.length === 0) {
    // 앱의 getFees 와 같은 두 갈래. 스크립트에서는 둘 다 실패지만 원인은 구분해 알린다.
    const all = await fetch(`${url}/rest/v1/fee_settings?select=effective_from&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    const any = ((await all.json()) as unknown[]).length > 0
    throw new Error(
      any
        ? `fee_settings 에 ${asOf} 를 덮는 행이 없다 (행은 존재). 기준일을 확인하거나 새 요율 행을 넣을 것.`
        : 'fee_settings 가 비어 있다 — 배포·설정 실패. 마이그레이션 적재 상태를 확인할 것.',
    )
  }

  const r = rows[0]
  return {
    mpf_rate: Number(r.mpf_rate),
    mpf_min_usd: Number(r.mpf_min_usd),
    mpf_max_usd: Number(r.mpf_max_usd),
    hmf_rate: Number(r.hmf_rate),
    effective_from: String(r.effective_from),
  }
}
