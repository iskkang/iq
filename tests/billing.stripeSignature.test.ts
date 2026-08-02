import { describe, expect, it } from 'vitest'
import {
  hmacSha256Hex,
  parseStripeSignature,
  SIGNATURE_TOLERANCE_SECONDS,
  timingSafeEqualHex,
  verifyStripeSignature,
} from '../src/lib/billing/stripeSignature'

const SECRET = 'whsec_test_2b8f1e0c9a7d4f63'
const BODY = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
const NOW = 1_785_600_000

async function signedHeader(body: string, secret: string, t: number): Promise<string> {
  return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${body}`)}`
}

describe('parseStripeSignature', () => {
  it('t 와 v1 을 읽는다', () => {
    expect(parseStripeSignature('t=123,v1=abc')).toEqual({ timestamp: 123, v1: ['abc'] })
  })

  it('v1 이 여러 개면 모두 모은다 (시크릿 교체 중)', () => {
    expect(parseStripeSignature('t=123,v1=aa,v0=zz,v1=bb')?.v1).toEqual(['aa', 'bb'])
  })

  it('t 가 없거나 v1 이 없으면 null', () => {
    expect(parseStripeSignature('v1=abc')).toBeNull()
    expect(parseStripeSignature('t=123')).toBeNull()
    expect(parseStripeSignature('t=nope,v1=abc')).toBeNull()
    expect(parseStripeSignature('')).toBeNull()
  })
})

describe('timingSafeEqualHex', () => {
  it('같으면 true, 다르면 false', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true)
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false)
  })

  it('길이가 다르면 false — 접두사가 같아도', () => {
    expect(timingSafeEqualHex('abc', 'abcd')).toBe(false)
  })
})

describe('verifyStripeSignature', () => {
  it('제대로 서명된 요청을 통과시킨다', async () => {
    const header = await signedHeader(BODY, SECRET, NOW)
    expect(await verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: NOW })).toEqual({ ok: true })
  })

  it('본문이 한 글자라도 바뀌면 거부한다', async () => {
    const header = await signedHeader(BODY, SECRET, NOW)
    const tampered = BODY.replace('cs_1', 'cs_2')
    expect(await verifyStripeSignature({ rawBody: tampered, header, secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  // 이게 이 파일의 존재 이유다. 검증이 없으면 아무나 이 본문을 보내
  // 결제 없이 유료 상태를 켤 수 있다.
  it('공격자가 만든 서명을 거부한다', async () => {
    const forged = await signedHeader(BODY, 'whsec_attacker_guess', NOW)
    expect(await verifyStripeSignature({ rawBody: BODY, header: forged, secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('허용 오차를 넘게 오래된 요청을 거부한다 (재전송)', async () => {
    const old = NOW - SIGNATURE_TOLERANCE_SECONDS - 1
    const header = await signedHeader(BODY, SECRET, old)
    expect(await verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    })
  })

  it('허용 오차 안이면 통과한다', async () => {
    const recent = NOW - SIGNATURE_TOLERANCE_SECONDS + 1
    const header = await signedHeader(BODY, SECRET, recent)
    expect(await verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: NOW })).toEqual({ ok: true })
  })

  it('미래로 조작한 타임스탬프도 거부한다', async () => {
    const future = NOW + SIGNATURE_TOLERANCE_SECONDS + 1
    const header = await signedHeader(BODY, SECRET, future)
    expect(await verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'timestamp_outside_tolerance',
    })
  })

  it('시크릿 교체 중 v1 이 여러 개면 하나만 맞아도 통과한다', async () => {
    const good = await hmacSha256Hex(SECRET, `${NOW}.${BODY}`)
    const header = `t=${NOW},v1=${'0'.repeat(good.length)},v1=${good}`
    expect(await verifyStripeSignature({ rawBody: BODY, header, secret: SECRET, nowSeconds: NOW })).toEqual({ ok: true })
  })

  it('헤더나 시크릿이 없으면 이유를 구분해서 거부한다', async () => {
    expect(await verifyStripeSignature({ rawBody: BODY, header: null, secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'missing_signature_header',
    })
    // 시크릿 미설정은 배포 사고다. 조용히 통과시키면 자물쇠가 없는 채로 돈다.
    expect(await verifyStripeSignature({ rawBody: BODY, header: 't=1,v1=a', secret: '', nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'missing_secret',
    })
  })

  it('헤더 모양이 깨져도 예외 대신 거부를 돌려준다', async () => {
    expect(await verifyStripeSignature({ rawBody: BODY, header: 'garbage', secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'malformed_signature_header',
    })
  })

  /**
   * 원문 바이트가 아니라 재직렬화한 문자열로 검증하면 항상 실패한다.
   * 이 실수는 "웹훅이 늘 401" 로만 보여서 원인을 찾기 어렵다 — 실패를
   * 테스트로 못박아 두면 다음 사람이 여기서 답을 찾는다.
   */
  it('JSON 을 재직렬화하면 서명이 깨진다', async () => {
    const spaced = JSON.stringify(JSON.parse(BODY), null, 2)
    const header = await signedHeader(BODY, SECRET, NOW)
    expect(await verifyStripeSignature({ rawBody: spaced, header, secret: SECRET, nowSeconds: NOW })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })
})
