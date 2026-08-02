/** Google tag setup and Google Ads conversion reporting. Page structure lives in each HTML file. */
;(function () {
  var ADS_ID = 'AW-18359222502'
  var GA4_ID = 'G-5H23Y883ZW'
  var SIGNUP = 'lqxNCILG7NgcEOaBrrJE'
  // Paid subscriptions currently share the signup label. Google Ads needs a
  // dedicated conversion action for them so bidding can optimise on revenue
  // rather than on email captures — see docs/pricing-29.md.
  var SUBSCRIBE = SIGNUP
  var LABELS = { signup: SIGNUP, sample: SIGNUP, watch: SIGNUP, section301: SIGNUP, subscribe: SUBSCRIBE }
  var fired = {}

  // The page-level Google Ads tag already creates gtag(). Add GA4 as a second destination.
  window.dataLayer = window.dataLayer || []
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments) }
  window.gtag('config', GA4_ID)

  window.trackConversion = function (which, value) {
    if (fired[which] || typeof window.gtag !== 'function' || !LABELS[which]) return
    fired[which] = true
    window.gtag('event', 'conversion', {
      send_to: ADS_ID + '/' + LABELS[which],
      value: typeof value === 'number' ? value : 1.0,
      currency: 'USD'
    })
  }
})()
