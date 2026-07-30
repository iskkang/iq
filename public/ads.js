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

  // Ads → 도구 → 전환 에서 만든 전환 액션의 라벨.
  //
  // ── 왜 액션이 하나인가 ─────────────────────────────────────────
  // 폼을 나눠도 Google 쪽은 "가입 1건" 만 세면 된다. 입찰이 클릭수 최대화라
  // 전환 액션을 세분화해도 최적화에 쓰이지 않고, 유입 경로 구분은 leads 테이블의
  // UTM + page 필드로 이미 하고 있다. 액션을 늘리면 라벨 관리 지점만 늘어난다.
  var SIGNUP = 'lqxNCILG7NgcEOaBrrJE'
  var LABELS = { signup: SIGNUP, sample: SIGNUP }

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
    // **라벨 없이 보내지 않는다.** send_to 에 ID 만 넣으면 어느 전환 액션에도
    // 매핑되지 않아 기록 자체가 안 된다 — 리포트에는 전환 0 으로만 보이고,
    // 태그는 정상 동작 중이라 원인을 찾을 단서가 없다. 가장 나쁜 실패 모양이다.
    //
    // 그래서 조용한 no-op 을 금지한다: 콘솔 에러 + Plausible 이벤트로 남긴다.
    // 콘솔은 아무도 안 본다 — 우리가 실제로 보는 대시보드에 찍혀야 발견된다.
    if (!label) {
      console.error('[LandedIQ] 전환 라벨 미설정 (' + which + ') — 전송하지 않음. 이 전환은 기록되지 않습니다.')
      if (window.plausible) window.plausible('ads_label_missing', { props: { which: which } })
      return
    }
    fired[which] = true
    window.gtag('event', 'conversion', {
      send_to: ID + '/' + label,
      value: 1.0,
      currency: 'USD',
    })
  }
})()
