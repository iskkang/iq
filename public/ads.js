/** Google tag setup and Google Ads conversion reporting. Page structure lives in each HTML file. */
;(function () {
  var ADS_ID = 'AW-18359222502'
  var GA4_ID = 'G-5H23Y883ZW'
  var SIGNUP = 'lqxNCILG7NgcEOaBrrJE'
  var LABELS = { signup: SIGNUP, sample: SIGNUP, watch: SIGNUP, section301: SIGNUP }
  var fired = {}

  // The page-level Google Ads tag already creates gtag(). Add GA4 as a second destination.
  window.dataLayer = window.dataLayer || []
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments) }
  window.gtag('config', GA4_ID)

  window.trackConversion = function (which) {
    if (fired[which] || typeof window.gtag !== 'function' || !LABELS[which]) return
    fired[which] = true
    window.gtag('event', 'conversion', {
      send_to: ADS_ID + '/' + LABELS[which],
      value: 1.0,
      currency: 'USD'
    })
  }
})()
