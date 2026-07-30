/**
 * Google Ads 전환 보고 — **한 파일, 한 라벨.**
 *
 * ── 왜 공용 파일인가 ─────────────────────────────────────────────
 * 랜딩(히어로·하단 CTA), /sample-report, /hts 가 각자 send_to 를 갖고 있으면
 * 라벨이 바뀔 때 한 곳만 고치고 나머지를 잊는다. 그러면 전환은 계속 기록되는데
 * 액션 구분이 틀어지고, **그 상태는 조용하다** — 이 저장소가 반복해서 당한
 * 실패 방식이다. 그래서 라벨은 이 파일에만 있다.
 *
 * gtag 로더 자체는 각 페이지 <head> 에 그대로 둔다 (구글 표준 스니펫이고,
 * 페이지마다 한 번씩 있어야 한다). 여기서는 **전환 보고만** 맡는다.
 *
 * public/ 에 있으므로 Vite 의 %VITE_% 치환을 받지 않는다. 받을 필요도 없다 —
 * 전환 ID·라벨은 공개 값이고 환경별로 달라지지 않는다.
 */
;(function () {
  var ID = 'AW-18359222502'

  // Ads → 도구 → 전환 에서 만든 액션별 라벨.
  //   signup : 이메일 가입 (랜딩 히어로·하단 CTA, /sample-report, /hts 공통)
  //   sample : 랜딩의 "샘플 리포트 보내주세요" 폼. 별도 전환 액션이라 라벨이
  //            따로 필요하다. 비어 있으면 ID 만 보내 전환은 기록되고 액션
  //            구분만 빠진다 (조용히 0 이 되지는 않는다).
  var LABELS = { signup: 'lqxNCILG7NgcEOaBrrJE', sample: '' }

  // 한 번 보고한 액션은 다시 보고하지 않는다. 폼이 성공 후 자기 자신을 교체하긴
  // 하지만, 그건 화면 동작이지 보장이 아니다 — 이중 제출이 이중 전환이 되면
  // 입찰 최적화가 실제보다 좋은 신호를 받는다.
  var fired = {}

  /**
   * 전환 1건 보고. **제출이 성공한 뒤에만** 부른다.
   * 검증 실패·중복 제출·honeypot 경로에서는 부르지 않는다.
   *
   * Plausible 이벤트와는 별개다 — Plausible 은 우리가 보는 지표, 이쪽은 Ads
   * 입찰 최적화에 쓰인다.
   *
   * @param {'signup'|'sample'} which
   */
  window.trackConversion = function (which) {
    if (fired[which]) return
    if (typeof window.gtag !== 'function') {
      // 로더가 없으면 전환이 조용히 0 이 된다. 콘솔에 흔적을 남긴다.
      console.warn('[LandedIQ] gtag 미로드 — ' + which + ' 전환이 기록되지 않습니다.')
      return
    }
    var label = LABELS[which]
    fired[which] = true
    window.gtag('event', 'conversion', {
      send_to: label ? ID + '/' + label : ID,
      value: 1.0,
      currency: 'USD',
    })
    if (!label) console.info('[LandedIQ] 전환 라벨 미설정 — 액션 구분 없이 기록됩니다 (' + which + ')')
  }
})()
