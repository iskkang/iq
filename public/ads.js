/** Google Ads conversion reporting only. Page structure lives in each HTML file. */
;(function () {
  var ID = 'AW-18359222502'
  var SIGNUP = 'lqxNCILG7NgcEOaBrrJE'
  var LABELS = { signup: SIGNUP, sample: SIGNUP, watch: SIGNUP, section301: SIGNUP }
  var fired = {}

  window.trackConversion = function (which) {
    if (fired[which] || typeof window.gtag !== 'function' || !LABELS[which]) return
    fired[which] = true
    window.gtag('event', 'conversion', {
      send_to: ID + '/' + LABELS[which],
      value: 1.0,
      currency: 'USD'
    })
  }
})()
