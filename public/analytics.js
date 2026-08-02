/**
 * 정적 공개 페이지용 퍼널 계측.
 *
 * ── 왜 생겼는가 ──────────────────────────────────────────────────
 * 계측은 이미 있었다 — public.analytics_events 테이블과 src/lib/analytics.ts.
 * 그런데 그건 React 번들 안이라 /app 에서만 돈다. **광고 트래픽은 전부 정적
 * 공개 페이지(/ · /hts · /section-301)로 떨어지는데 그 페이지들에는 퍼널
 * 이벤트가 하나도 없었다.**
 *
 * 결과: 광고 리포트가 "63 클릭 · 전환 0" 을 보여줘도 어디서 죽었는지 알 수
 * 없다. 조회를 아예 안 했는지, 조회가 실패했는지, 답을 얻고 만족해서 떠났는지,
 * 폼까지 갔다가 그만뒀는지, 폼 저장이 실패했는지 — 전부 같은 "0" 으로 보인다.
 * 특히 폼 저장 실패는 화면에도 조용해서(버튼만 원복) 사용자도 우리도 모른다.
 *
 * 그래서 클릭과 전환 사이를 채운다. 다음 광고비는 해석 가능한 데이터를 남긴다.
 *
 * 설계 제약: public/ 은 Vite 가 복사만 하므로 %VITE_*% 치환이 안 된다. 그래서
 * 자격증명을 여기 넣지 않고 **호출 시점에** window.CONFIG 를 읽는다 (각 페이지가
 * 치환된 값으로 정의한다). ads.js 와 같은 이유·같은 방식이다.
 */
;(function () {
  function cfg() {
    var c = window.CONFIG
    if (!c || !c.SUPABASE_URL || c.SUPABASE_URL.indexOf('%VITE_') === 0) return null
    return c
  }

  function id(store, key) {
    try {
      var v = store.getItem(key)
      if (!v) {
        v = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random()
        store.setItem(key, v)
      }
      return v
    } catch {
      return null // 프라이빗 모드 등 — 계측 실패가 페이지를 막지 않는다
    }
  }

  /**
   * 이벤트 하나를 남긴다. 실패는 삼킨다 — 계측이 제품 동작을 막으면 안 된다.
   * 이름은 src/lib/analytics.ts 와 같은 테이블·같은 형태를 쓴다.
   */
  window.track = function (eventName, properties) {
    var c = cfg()
    if (!c) return
    var p = new URLSearchParams(location.search)
    var props = properties || {}
    props.utm_source = p.get('utm_source')
    props.utm_medium = p.get('utm_medium')
    props.utm_campaign = p.get('utm_campaign')
    props.utm_term = p.get('utm_term')
    props.utm_content = p.get('utm_content')
    props.device = matchMedia('(max-width: 767px)').matches ? 'mobile' : 'desktop'

    try {
      fetch(c.SUPABASE_URL + '/rest/v1/analytics_events', {
        method: 'POST',
        keepalive: true, // 이탈 직전 이벤트도 나가야 한다
        headers: {
          'Content-Type': 'application/json',
          apikey: c.SUPABASE_ANON_KEY,
          Authorization: 'Bearer ' + c.SUPABASE_ANON_KEY,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          event_name: eventName,
          page: location.pathname,
          session_id: id(sessionStorage, 'landediq_session_id'),
          visitor_id: id(localStorage, 'landediq_visitor_id'),
          properties: props
        })
      }).catch(function () {})
    } catch { /* 계측 실패는 삼킨다 */ }

    if (typeof window.plausible === 'function') window.plausible(eventName, { props: props })
  }

  // 유입 자체를 남긴다. 이게 있어야 이후 단계의 분모가 생긴다.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.track('page_view') })
  } else {
    window.track('page_view')
  }
})()
