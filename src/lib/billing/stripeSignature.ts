/**
 * Stripe 웹훅 서명 검증 — 의존성 없이 Web Crypto 로.
 *
 * ── 왜 SDK 를 안 쓰는가 ──────────────────────────────────────────
 * 웹훅은 **인증 없이 열려 있는 엔드포인트**다. 여기서 오는 payload 를 그대로
 * 믿고 subscriptions 를 쓰면, 아무나 `status: active` 를 POST 해서 유료 기능을
 * 켤 수 있다. 서명 검증이 이 엔드포인트의 유일한 자물쇠다.
 *
 * 그 자물쇠를 npm 의존성 뒤에 두면 테스트할 수가 없다 — Edge Function 은
 * Deno 에서 돌고 vitest 는 Node 에서 돈다. 검증을 순수 함수로 꺼내 두면
 * 양쪽에서 같은 코드가 돌고, 위조·변조·만료를 **테스트로** 확인할 수 있다.
 * Web Crypto 는 Deno 와 Node 18+ 양쪽에 있다.
 *
 * 규격: `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`
 *   서명 대상 = `${t}.${rawBody}`
 *   알고리즘  = HMAC-SHA256(endpoint secret), hex
 *   v1 이 여러 개인 것은 시크릿 교체 중이라는 뜻이다 — 하나만 맞으면 통과다.
 */

/** Stripe 권장 허용 오차. 이보다 오래된 요청은 재전송 공격으로 본다 */
export const SIGNATURE_TOLERANCE_SECONDS = 300

export interface ParsedSignature {
  timestamp: number
  v1: string[]
}

export function parseStripeSignature(header: string): ParsedSignature | null {
  let timestamp = Number.NaN
  const v1: string[] = []
  for (const part of header.split(',')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === 't') timestamp = Number(value)
    else if (key === 'v1' && value) v1.push(value)
  }
  if (!Number.isFinite(timestamp) || v1.length === 0) return null
  return { timestamp, v1 }
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 길이가 같은 두 hex 문자열을 상수 시간에 비교한다.
 *
 * `a === b` 는 첫 다른 바이트에서 즉시 빠져나온다. 공격자가 응답 시간 차이로
 * 서명을 한 바이트씩 맞춰 나갈 수 있는 통로라, 서명 비교에서는 쓰지 않는다.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * 서명을 검증한다.
 *
 * `rawBody` 는 **바이트 그대로**여야 한다. `JSON.parse` 후 다시 `stringify`
 * 하면 키 순서·공백이 달라져 서명이 절대 맞지 않는다 — 이 실수는 "웹훅이
 * 항상 401" 로 나타나고 원인이 안 보인다.
 */
export async function verifyStripeSignature(opts: {
  rawBody: string
  header: string | null | undefined
  secret: string
  nowSeconds: number
  toleranceSeconds?: number
}): Promise<VerifyResult> {
  const { rawBody, header, secret, nowSeconds } = opts
  const tolerance = opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS

  if (!header) return { ok: false, reason: 'missing_signature_header' }
  if (!secret) return { ok: false, reason: 'missing_secret' }

  const parsed = parseStripeSignature(header)
  if (!parsed) return { ok: false, reason: 'malformed_signature_header' }

  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) return { ok: false, reason: 'timestamp_outside_tolerance' }

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`)
  const matched = parsed.v1.some((candidate) => timingSafeEqualHex(candidate, expected))
  return matched ? { ok: true } : { ok: false, reason: 'signature_mismatch' }
}
