/**
 * Google Ads conversion reporting and the shared public-site shell.
 * Conversion labels stay centralized here; the public IA is also centralized so
 * the landing page, HTS tool and sample report cannot drift into separate products.
 */
;(function () {
  var ID = 'AW-18359222502'
  var SIGNUP = 'lqxNCILG7NgcEOaBrrJE'
  var LABELS = { signup: SIGNUP, sample: SIGNUP }
  var fired = {}

  window.trackConversion = function (which) {
    if (fired[which]) return
    if (typeof window.gtag !== 'function') {
      console.warn('[LandedIQ] gtag not loaded; ' + which + ' conversion was not recorded.')
      return
    }
    var label = LABELS[which]
    if (!label) {
      console.error('[LandedIQ] Missing conversion label for ' + which + '.')
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

  function addStyles() {
    if (document.getElementById('liq-shell-styles')) return
    var style = document.createElement('style')
    style.id = 'liq-shell-styles'
    style.textContent = `
      .liq-site-header,.liq-site-footer,.liq-product-bridge{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}
      .liq-site-header *,.liq-site-footer *,.liq-product-bridge *{box-sizing:border-box}
      .liq-site-header{position:relative;z-index:50;border-bottom:1px solid rgba(148,163,184,.18);background:#020617;color:#e2e8f0}
      .liq-nav-inner{max-width:1152px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:24px}
      .liq-brand{display:flex;align-items:center;gap:10px;color:#fff!important;text-decoration:none!important;font-size:18px;font-weight:750;white-space:nowrap}
      .liq-brand-mark{display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:#6366f1;color:#fff;padding:6px 9px;font-size:13px;font-weight:900;letter-spacing:-.02em}
      .liq-nav-links{display:flex;align-items:center;justify-content:flex-end;gap:22px;font-size:14px}
      .liq-nav-links a{color:#cbd5e1!important;text-decoration:none!important;white-space:nowrap}
      .liq-nav-links a:hover,.liq-nav-links a[aria-current="page"]{color:#fff!important}
      .liq-nav-links .liq-nav-primary{border-radius:9px;background:#6366f1;color:#fff!important;padding:9px 14px;font-weight:750}
      .liq-nav-links .liq-nav-secondary{font-weight:650}
      .liq-product-bridge{max-width:1152px;margin:0 auto;padding:64px 20px;color:#e2e8f0}
      .liq-bridge-card{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:38px;align-items:center;border:1px solid rgba(148,163,184,.2);border-radius:22px;background:linear-gradient(135deg,rgba(99,102,241,.13),rgba(15,23,42,.76));padding:34px}
      .liq-kicker{margin:0 0 10px;color:#a5b4fc;font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}
      .liq-product-bridge h2{margin:0;color:#fff;font-size:30px;line-height:1.18;letter-spacing:-.025em}
      .liq-product-bridge p{margin:13px 0 0;color:#94a3b8;font-size:15px;line-height:1.75}
      .liq-bridge-actions{display:flex;flex-wrap:wrap;gap:11px;margin-top:22px}
      .liq-bridge-actions a{display:inline-flex;align-items:center;justify-content:center;border-radius:10px;padding:11px 16px;text-decoration:none!important;font-weight:750}
      .liq-bridge-primary{background:#6366f1;color:#fff!important}
      .liq-bridge-secondary{border:1px solid #334155;color:#e2e8f0!important;background:#0f172a}
      .liq-flow{display:grid;gap:10px}
      .liq-flow-step{display:grid;grid-template-columns:34px 1fr;gap:12px;align-items:start;border:1px solid rgba(148,163,184,.16);border-radius:12px;background:rgba(2,6,23,.55);padding:13px}
      .liq-flow-step b{display:flex;width:30px;height:30px;align-items:center;justify-content:center;border-radius:9px;background:rgba(99,102,241,.18);color:#c7d2fe;font-size:12px}
      .liq-flow-step strong{display:block;color:#fff;font-size:14px}
      .liq-flow-step span{display:block;margin-top:2px;color:#94a3b8;font-size:12px;line-height:1.45}
      .liq-context-bar{border-bottom:1px solid rgba(148,163,184,.15);background:#0f172a;color:#cbd5e1}
      .liq-context-inner{max-width:1152px;margin:auto;padding:10px 20px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:12px;text-align:center}
      .liq-context-inner a{color:#c7d2fe!important;font-weight:700;text-decoration:none!important}
      .liq-site-footer{border-top:1px solid #1e293b;background:#020617;color:#94a3b8}
      .liq-footer-inner{max-width:1152px;margin:0 auto;padding:36px 20px}
      .liq-footer-main{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:32px;align-items:start}
      .liq-footer-copy{max-width:620px;font-size:12px;line-height:1.75}
      .liq-footer-copy strong{display:block;margin-bottom:7px;color:#fff;font-size:16px}
      .liq-footer-links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px 18px;font-size:12px}
      .liq-footer-links a{color:#cbd5e1!important;text-decoration:none!important}
      .liq-footer-legal{margin-top:24px;padding-top:20px;border-top:1px solid #1e293b;font-size:11px;line-height:1.7;color:#64748b}
      body.liq-sample-page{padding-top:0!important}
      body.liq-sample-page>.wrap{padding-top:32px}
      body.liq-sample-page .liq-site-header,body.liq-sample-page .liq-site-footer{margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw)}
      @media(max-width:800px){
        .liq-nav-inner{gap:12px}.liq-nav-links{gap:12px}.liq-nav-hide-mobile{display:none!important}
        .liq-bridge-card{grid-template-columns:1fr;padding:25px}.liq-product-bridge{padding:46px 20px}.liq-product-bridge h2{font-size:25px}
        .liq-footer-main{grid-template-columns:1fr}.liq-footer-links{justify-content:flex-start}
      }
      @media(max-width:480px){.liq-nav-links .liq-nav-secondary{display:none}.liq-brand{font-size:16px}.liq-nav-inner{padding:12px 16px}}
      @media print{.liq-site-header,.liq-site-footer,.liq-context-bar,.liq-product-bridge{display:none!important}}
    `
    document.head.appendChild(style)
  }

  function nav(path) {
    var current = path.indexOf('/hts') === 0 ? 'hts' : path.indexOf('/sample-report') === 0 ? 'sample' : path === '/' ? 'home' : ''
    var header = document.createElement('header')
    header.className = 'liq-site-header'
    header.innerHTML = '<div class="liq-nav-inner">' +
      '<a class="liq-brand" href="/"><span class="liq-brand-mark">LIQ</span><span>LandedIQ</span></a>' +
      '<nav class="liq-nav-links" aria-label="Primary navigation">' +
      '<a class="liq-nav-hide-mobile" href="/"'+(current==='home'?' aria-current="page"':'')+'>Product</a>' +
      '<a href="/hts"'+(current==='hts'?' aria-current="page"':'')+'>Free HTS Lookup</a>' +
      '<a class="liq-nav-hide-mobile" href="/sample-report.html"'+(current==='sample'?' aria-current="page"':'')+'>Sample Report</a>' +
      '<a class="liq-nav-secondary" href="/app">Sign in</a>' +
      '<a class="liq-nav-primary" href="/#signup">Join Beta</a>' +
      '</nav></div>'
    return header
  }

  function footer() {
    var el = document.createElement('footer')
    el.className = 'liq-site-footer'
    el.innerHTML = '<div class="liq-footer-inner"><div class="liq-footer-main">' +
      '<div class="liq-footer-copy"><strong>LandedIQ</strong>Working beta for U.S. import sellers. Look up duty layers, review a sample landed-cost report, and join the beta for product-level margin analysis.</div>' +
      '<nav class="liq-footer-links" aria-label="Footer navigation"><a href="/">Product</a><a href="/hts">Free HTS Lookup</a><a href="/sample-report.html">Sample Report</a><a href="/app">Sign in</a><a href="/privacy">Privacy</a><a href="mailto:support@landediq.app">Support</a></nav>' +
      '</div><div class="liq-footer-legal">Operated by MTL Co., Ltd. · 471 Gonghang-daero, Gangseo-gu, Seoul 07570, Republic of Korea<br>Estimates are not customs, legal, or tax advice. Final classification and duty liability remain with the importer of record. · © 2026 LandedIQ</div></div>'
    return el
  }

  function homeBridge() {
    var section = document.createElement('section')
    section.className = 'liq-product-bridge'
    section.setAttribute('aria-labelledby','free-tool-heading')
    section.innerHTML = '<div class="liq-bridge-card"><div><p class="liq-kicker">Start with the free tool</p><h2 id="free-tool-heading">Find the duty first. Then calculate what it does to your margin.</h2><p>The free HTS Lookup uses the same maintained tariff ledger that powers LandedIQ. Search an HTS code or product keyword, review MFN and additional duty layers, then continue to the product-level workflow.</p><div class="liq-bridge-actions"><a class="liq-bridge-primary" data-liq-event="landing_hts_bridge_click" href="/hts">Try Free HTS Lookup →</a><a class="liq-bridge-secondary" href="/sample-report.html">See the full output</a></div></div><div class="liq-flow"><div class="liq-flow-step"><b>1</b><div><strong>Look up the HTS duty</strong><span>MFN, Section 301 and other applicable layers.</span></div></div><div class="liq-flow-step"><b>2</b><div><strong>Review landed-cost output</strong><span>See fees, freight allocation and cost per SKU.</span></div></div><div class="liq-flow-step"><b>3</b><div><strong>Protect your margin</strong><span>Estimate true margin and the price you may need to charge.</span></div></div></div></div>'
    return section
  }

  function contextBar(text, linkText, href) {
    var el = document.createElement('div')
    el.className = 'liq-context-bar'
    el.innerHTML = '<div class="liq-context-inner"><span>'+text+'</span><a href="'+href+'">'+linkText+' →</a></div>'
    return el
  }

  function applyShell() {
    var path = location.pathname
    if (!(path === '/' || path.indexOf('/hts') === 0 || path.indexOf('/sample-report') === 0 || path === '/privacy')) return
    addStyles()

    if (path.indexOf('/sample-report') === 0) document.body.classList.add('liq-sample-page')

    var oldHeader = document.querySelector('body > header, body > .nav')
    if (oldHeader) oldHeader.remove()
    document.body.insertBefore(nav(path), document.body.firstChild)

    if (path.indexOf('/hts') === 0) {
      var h = document.querySelector('.liq-site-header')
      if (h) h.insertAdjacentElement('afterend', contextBar('Free HTS Lookup is part of the LandedIQ workflow.', 'See how landed cost and margin connect', '/#workflow'))
      var existingCta = document.getElementById('landed-cta')
      if (existingCta) {
        existingCta.textContent = 'Continue to LandedIQ Beta'
        existingCta.href = '/#signup'
      }
    }

    if (path.indexOf('/sample-report') === 0) {
      var hs = document.querySelector('.liq-site-header')
      if (hs) hs.insertAdjacentElement('afterend', contextBar('This report is the output of the same workflow as the free HTS Lookup.', 'Check an HTS code first', '/hts'))
      var sampleTitle = document.querySelector('.wrap h1')
      if (sampleTitle) sampleTitle.insertAdjacentHTML('beforebegin','<p style="margin:0 0 8px;color:#6366f1;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase">LandedIQ product workflow · Sample output</p>')
      var sampleButton = document.querySelector('#cta-form button')
      if (sampleButton) sampleButton.textContent = 'Join LandedIQ Beta'
    }

    if (path === '/') {
      var main = document.querySelector('main')
      if (main && !document.querySelector('.liq-product-bridge')) {
        var sections = main.querySelectorAll(':scope > section')
        var target = sections.length > 1 ? sections[1] : null
        var bridge = homeBridge()
        bridge.id = 'workflow'
        if (target) target.insertAdjacentElement('afterend', bridge)
        else main.appendChild(bridge)
      }
    }

    document.querySelectorAll('body > footer, body > .foot, .wrap > footer').forEach(function (f) {
      if (!f.classList.contains('liq-site-footer')) f.remove()
    })
    document.body.appendChild(footer())

    document.querySelectorAll('[data-liq-event]').forEach(function(el){
      el.addEventListener('click',function(){
        if(window.plausible) window.plausible(el.getAttribute('data-liq-event'))
      })
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyShell)
  else applyShell()
})()
