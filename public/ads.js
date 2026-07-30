/**
 * Google Ads conversion reporting and shared public-site funnel.
 */
;(function () {
  var ID = 'AW-18359222502'
  var SIGNUP = 'lqxNCILG7NgcEOaBrrJE'
  var LABELS = { signup: SIGNUP, sample: SIGNUP, watch: SIGNUP }
  var fired = {}

  window.trackConversion = function (which) {
    if (fired[which]) return
    if (typeof window.gtag !== 'function') return
    var label = LABELS[which]
    if (!label) return
    fired[which] = true
    window.gtag('event', 'conversion', { send_to: ID + '/' + label, value: 1.0, currency: 'USD' })
  }

  function addStyles() {
    if (document.getElementById('liq-shell-styles')) return
    var style = document.createElement('style')
    style.id = 'liq-shell-styles'
    style.textContent = `
      .liq-site-header,.liq-site-footer,.liq-product-bridge,.liq-pricing,.liq-watch-card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-sizing:border-box}
      .liq-site-header *,.liq-site-footer *,.liq-product-bridge *,.liq-pricing *,.liq-watch-card *{box-sizing:border-box}
      .liq-site-header{position:relative;z-index:50;border-bottom:1px solid rgba(148,163,184,.18);background:#020617;color:#e2e8f0}
      .liq-nav-inner{max-width:1152px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:24px}
      .liq-brand{display:flex;align-items:center;gap:10px;color:#fff!important;text-decoration:none!important;font-size:18px;font-weight:750;white-space:nowrap}
      .liq-brand-mark{display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:#6366f1;color:#fff;padding:6px 9px;font-size:13px;font-weight:900}
      .liq-nav-links{display:flex;align-items:center;justify-content:flex-end;gap:22px;font-size:14px}.liq-nav-links a{color:#cbd5e1!important;text-decoration:none!important;white-space:nowrap}.liq-nav-links a:hover,.liq-nav-links a[aria-current="page"]{color:#fff!important}
      .liq-nav-primary{border-radius:9px;background:#6366f1;color:#fff!important;padding:9px 14px;font-weight:750}.liq-nav-secondary{font-weight:650}
      .liq-context-bar{border-bottom:1px solid rgba(148,163,184,.15);background:#0f172a;color:#cbd5e1}.liq-context-inner{max-width:1152px;margin:auto;padding:10px 20px;display:flex;justify-content:center;gap:8px;font-size:12px;text-align:center}.liq-context-inner a{color:#c7d2fe!important;font-weight:700;text-decoration:none!important}
      .liq-product-bridge,.liq-pricing{max-width:1152px;margin:0 auto;padding:64px 20px;color:#e2e8f0}.liq-bridge-card{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(320px,.9fr);gap:38px;align-items:center;border:1px solid rgba(148,163,184,.2);border-radius:22px;background:linear-gradient(135deg,rgba(99,102,241,.13),rgba(15,23,42,.76));padding:34px}
      .liq-kicker{margin:0 0 10px;color:#a5b4fc;font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}.liq-product-bridge h2,.liq-pricing h2{margin:0;color:#fff;font-size:30px;line-height:1.18}.liq-product-bridge p,.liq-pricing p{margin:13px 0 0;color:#94a3b8;font-size:15px;line-height:1.75}
      .liq-bridge-actions{display:flex;flex-wrap:wrap;gap:11px;margin-top:22px}.liq-bridge-actions a{display:inline-flex;align-items:center;justify-content:center;border-radius:10px;padding:11px 16px;text-decoration:none!important;font-weight:750}.liq-bridge-primary{background:#6366f1;color:#fff!important}.liq-bridge-secondary{border:1px solid #334155;color:#e2e8f0!important;background:#0f172a}
      .liq-flow{display:grid;gap:10px}.liq-flow-step{display:grid;grid-template-columns:34px 1fr;gap:12px;border:1px solid rgba(148,163,184,.16);border-radius:12px;background:rgba(2,6,23,.55);padding:13px}.liq-flow-step b{display:flex;width:30px;height:30px;align-items:center;justify-content:center;border-radius:9px;background:rgba(99,102,241,.18);color:#c7d2fe;font-size:12px}.liq-flow-step strong{display:block;color:#fff;font-size:14px}.liq-flow-step span{display:block;margin-top:2px;color:#94a3b8;font-size:12px}
      .liq-price-card{max-width:720px;margin:auto;border:1px solid rgba(129,140,248,.45);border-radius:22px;background:#0f172a;padding:34px;box-shadow:0 20px 60px rgba(2,6,23,.35)}.liq-price-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px}.liq-price{color:#fff;font-size:48px;font-weight:850;letter-spacing:-.04em}.liq-price small{font-size:16px;color:#94a3b8;font-weight:600}.liq-price-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:28px 0;color:#cbd5e1;font-size:14px}.liq-price-list span:before{content:'✓';margin-right:8px;color:#34d399;font-weight:900}
      .liq-watch-card{max-width:760px;margin:28px auto;padding:26px;border:1px solid rgba(99,102,241,.35);border-radius:18px;background:linear-gradient(145deg,#0f172a,#111827);color:#e2e8f0;box-shadow:0 18px 50px rgba(2,6,23,.22)}.liq-watch-card h2{margin:0;color:#fff;font-size:24px}.liq-watch-card p{margin:9px 0;color:#94a3b8;line-height:1.6}.liq-watch-events{display:flex;flex-wrap:wrap;gap:8px;margin:15px 0}.liq-watch-events span{border-radius:999px;background:rgba(99,102,241,.13);padding:6px 10px;color:#c7d2fe;font-size:12px}.liq-watch-form{display:grid;grid-template-columns:minmax(180px,1.4fr) minmax(170px,1fr) auto;gap:10px;margin-top:18px}.liq-watch-form input,.liq-watch-form select{width:100%;border:1px solid #475569;border-radius:10px;background:#fff;padding:12px;color:#0f172a;font-size:14px}.liq-watch-form button{border:0;border-radius:10px;background:#6366f1;padding:12px 18px;color:#fff;font-weight:800;cursor:pointer}.liq-watch-note{font-size:11px!important;color:#64748b!important}.liq-watch-success{border-radius:10px;background:rgba(16,185,129,.12);padding:12px;color:#6ee7b7!important;font-weight:700}.liq-watch-upsell{margin-top:16px!important;padding-top:14px;border-top:1px solid #273449}.liq-watch-upsell a{color:#a5b4fc!important;font-weight:750;text-decoration:none!important}
      .liq-site-footer{border-top:1px solid #1e293b;background:#020617;color:#94a3b8}.liq-footer-inner{max-width:1152px;margin:0 auto;padding:36px 20px}.liq-footer-main{display:grid;grid-template-columns:minmax(240px,1fr) auto;gap:32px}.liq-footer-copy{max-width:650px;font-size:12px;line-height:1.75}.liq-footer-copy strong{display:block;margin-bottom:7px;color:#fff;font-size:16px}.liq-footer-links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px 18px;font-size:12px}.liq-footer-links a{color:#cbd5e1!important;text-decoration:none!important}.liq-footer-legal{margin-top:24px;padding-top:20px;border-top:1px solid #1e293b;font-size:11px;line-height:1.7;color:#64748b}
      body.liq-sample-page{padding-top:0!important}body.liq-sample-page>.wrap{padding-top:32px}body.liq-sample-page .liq-site-header,body.liq-sample-page .liq-site-footer{margin-left:calc(50% - 50vw);margin-right:calc(50% - 50vw)}
      @media(max-width:800px){.liq-nav-inner{gap:12px}.liq-nav-links{gap:12px}.liq-nav-hide-mobile{display:none!important}.liq-bridge-card{grid-template-columns:1fr;padding:25px}.liq-product-bridge,.liq-pricing{padding:46px 20px}.liq-price-list{grid-template-columns:1fr}.liq-watch-form{grid-template-columns:1fr}.liq-footer-main{grid-template-columns:1fr}.liq-footer-links{justify-content:flex-start}}
      @media(max-width:480px){.liq-nav-secondary{display:none}.liq-brand{font-size:16px}.liq-nav-inner{padding:12px 16px}.liq-price-head{display:block}.liq-price{margin-top:12px}}
      @media print{.liq-site-header,.liq-site-footer,.liq-context-bar,.liq-product-bridge,.liq-pricing,.liq-watch-card{display:none!important}}
    `
    document.head.appendChild(style)
  }

  function nav(path) {
    var current = path.indexOf('/hts') === 0 ? 'hts' : path.indexOf('/sample-report') === 0 ? 'sample' : path === '/' ? 'home' : ''
    var header = document.createElement('header')
    header.className = 'liq-site-header'
    header.innerHTML = '<div class="liq-nav-inner"><a class="liq-brand" href="/"><span class="liq-brand-mark">LIQ</span><span>LandedIQ</span></a><nav class="liq-nav-links" aria-label="Primary navigation"><a class="liq-nav-hide-mobile" href="/"'+(current==='home'?' aria-current="page"':'')+'>Product</a><a href="/hts"'+(current==='hts'?' aria-current="page"':'')+'>Free HTS Lookup</a><a class="liq-nav-hide-mobile" href="/sample-report.html"'+(current==='sample'?' aria-current="page"':'')+'>Sample Report</a><a class="liq-nav-hide-mobile" href="/#pricing">Pricing</a><a class="liq-nav-secondary" href="/app">Sign in</a><a class="liq-nav-primary" href="/#signup">Start Beta — $19/mo</a></nav></div>'
    return header
  }

  function footer() {
    var el = document.createElement('footer')
    el.className = 'liq-site-footer'
    el.innerHTML = '<div class="liq-footer-inner"><div class="liq-footer-main"><div class="liq-footer-copy"><strong>LandedIQ</strong><b>Free:</b> HTS lookup and HTS change alerts. &nbsp; <b>Starter Beta — $19/month:</b> landed-cost reports, margin analysis, pricing recommendations and CSV product uploads.</div><nav class="liq-footer-links"><a href="/">Product</a><a href="/hts">Free HTS Lookup</a><a href="/sample-report.html">Sample Report</a><a href="/#pricing">Pricing</a><a href="/app">Sign in</a><a href="/privacy">Privacy</a><a href="mailto:support@landediq.app">Support</a></nav></div><div class="liq-footer-legal">Operated by MTL Co., Ltd. · 471 Gonghang-daero, Gangseo-gu, Seoul 07570, Republic of Korea<br>Estimates are not customs, legal, or tax advice. Final classification and duty liability remain with the importer of record. · © 2026 LandedIQ</div></div>'
    return el
  }

  function contextBar(text, linkText, href) {
    var el = document.createElement('div'); el.className = 'liq-context-bar'
    el.innerHTML = '<div class="liq-context-inner"><span>'+text+'</span><a href="'+href+'">'+linkText+' →</a></div>'
    return el
  }

  function homeBridge() {
    var section = document.createElement('section'); section.className = 'liq-product-bridge'; section.id = 'workflow'
    section.innerHTML = '<div class="liq-bridge-card"><div><p class="liq-kicker">Free → useful → paid</p><h2>Find the duty first. Watch it for free. Then calculate what it does to your margin.</h2><p>Search an HTS code, get notified when its duty treatment changes, and move into product-level landed-cost and pricing analysis only when you need it.</p><div class="liq-bridge-actions"><a class="liq-bridge-primary" data-liq-event="landing_hts_bridge_click" href="/hts">Try Free HTS Lookup →</a><a class="liq-bridge-secondary" href="/sample-report.html">View Sample Report</a></div></div><div class="liq-flow"><div class="liq-flow-step"><b>1</b><div><strong>Look up an HTS code</strong><span>Review MFN, Section 301 and other duty layers.</span></div></div><div class="liq-flow-step"><b>2</b><div><strong>Watch changes for free</strong><span>Get an email when the code's duty treatment changes.</span></div></div><div class="liq-flow-step"><b>3</b><div><strong>Protect your margin</strong><span>Estimate landed cost, true margin and required selling price.</span></div></div></div></div>'
    return section
  }

  function pricing() {
    var section = document.createElement('section'); section.className = 'liq-pricing'; section.id = 'pricing'
    section.innerHTML = '<div class="liq-price-card"><div class="liq-price-head"><div><p class="liq-kicker">Starter Beta</p><h2>Full landed-cost intelligence for import sellers</h2></div><div class="liq-price">$19<small>/month</small></div></div><div class="liq-price-list"><span>Unlimited landed-cost reports</span><span>Margin analysis by SKU</span><span>Pricing recommendations</span><span>HTS monitoring</span><span>CSV product uploads</span><span>Early-access features</span></div><div class="liq-bridge-actions"><a class="liq-bridge-primary" href="#signup">Start Beta — $19/month</a><a class="liq-bridge-secondary" href="/sample-report.html">View Sample Report</a></div><p>No payment is collected during the current interest-validation stage. The planned Starter Beta price is $19/month.</p></div>'
    return section
  }

  function findCode() {
    var candidates = ['[data-hts-code]','.hts-code','#hts-code','.result-code','[name="hts_code"]','[name="code"]']
    for (var i=0;i<candidates.length;i++) { var n=document.querySelector(candidates[i]); if(n){var v=n.value||n.getAttribute('data-hts-code')||n.textContent;var m=String(v).match(/\b\d{4}(?:\.\d{2}){1,3}\b/);if(m)return m[0]} }
    var main=document.querySelector('main')||document.body; var match=(main.innerText||'').match(/\b\d{4}(?:\.\d{2}){1,3}\b/); return match?match[0]:'this HTS code'
  }

  function supabaseConfig() {
    try {
      var c = typeof CONFIG !== 'undefined' ? CONFIG : window.CONFIG
      if (!c || !c.SUPABASE_URL || c.SUPABASE_URL.indexOf('%VITE_') === 0) return null
      return c
    } catch (e) { return null }
  }

  async function saveWatch(email, code, bucket) {
    var c=supabaseConfig()
    if(!c) throw new Error('config')
    var body={email:email,intent:'hts_watch',variant:bucket,page:location.pathname+'?watch='+encodeURIComponent(code)}
    var r=await fetch(c.SUPABASE_URL+'/rest/v1/leads',{method:'POST',headers:{'Content-Type':'application/json',apikey:c.SUPABASE_ANON_KEY,Authorization:'Bearer '+c.SUPABASE_ANON_KEY,Prefer:'return=minimal'},body:JSON.stringify(body)})
    if(r.status!==409&&!r.ok) throw new Error('lead '+r.status)
  }

  function watchCard() {
    var card=document.createElement('section'); card.className='liq-watch-card'; card.id='watch-this-code'
    var code=findCode()
    card.innerHTML='<p class="liq-kicker">Free HTS change alert</p><h2>Watch <span class="liq-current-code">'+code+'</span></h2><p>Duty treatment can change with trade actions, expirations and enforcement updates. Get an email when this code changes again.</p><div class="liq-watch-events"><span>IEEPA updates</span><span>Section 122 changes</span><span>Section 301 changes</span><span>Exclusion updates</span></div><form class="liq-watch-form"><input type="email" name="email" required placeholder="you@company.com" aria-label="Email"><select name="bucket" required aria-label="How many products do you import?"><option value="">How many products do you import?</option><option value="1-10">1–10</option><option value="11-100">11–100</option><option value="101-1000">101–1,000</option><option value="1000+">1,000+</option></select><button type="submit">Watch this code</button></form><p class="liq-watch-note">Free alert. No payment required. We will only email you about relevant HTS or LandedIQ updates.</p><p class="liq-watch-upsell">Need landed cost, margin and recommended pricing too? <a href="/#pricing">See Starter Beta — $19/month →</a></p>'
    var form=card.querySelector('form')
    form.addEventListener('submit',async function(e){e.preventDefault();var btn=form.querySelector('button');var data=new FormData(form);var current=findCode();btn.disabled=true;btn.textContent='Saving…';try{await saveWatch(data.get('email'),current,data.get('bucket'));window.trackConversion('watch');if(window.plausible)window.plausible('hts_watch',{props:{code:current,bucket:data.get('bucket')}});form.outerHTML='<p class="liq-watch-success">You are watching '+current+'. We will email you when its duty treatment changes.</p>'}catch(err){btn.disabled=false;btn.textContent='Watch this code';alert('We could not save your alert. Please try again.')}})
    return card
  }

  function applyShell() {
    var path=location.pathname
    if (!(path==='/'||path.indexOf('/hts')===0||path.indexOf('/sample-report')===0||path==='/privacy')) return
    addStyles()
    if(path.indexOf('/sample-report')===0)document.body.classList.add('liq-sample-page')
    var oldHeader=document.querySelector('body > header, body > .nav'); if(oldHeader)oldHeader.remove()
    document.body.insertBefore(nav(path),document.body.firstChild)

    if(path.indexOf('/hts')===0){
      var h=document.querySelector('.liq-site-header'); if(h)h.insertAdjacentElement('afterend',contextBar('Free HTS lookup and code alerts are free.','Starter Beta adds landed cost and margin analysis for $19/month','/#pricing'))
      var existing=document.getElementById('landed-cta'); if(existing){existing.textContent='See Starter Beta — $19/month';existing.href='/#pricing'}
      var main=document.querySelector('main')||document.body; if(!document.getElementById('watch-this-code'))main.appendChild(watchCard())
    }

    if(path.indexOf('/sample-report')===0){
      var hs=document.querySelector('.liq-site-header'); if(hs)hs.insertAdjacentElement('afterend',contextBar('This is an example of the Starter Beta output.','Starter Beta — $19/month','/#pricing'))
      var title=document.querySelector('.wrap h1'); if(title)title.insertAdjacentHTML('beforebegin','<p style="margin:0 0 8px;color:#6366f1;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase">Starter Beta · $19/month · Sample output</p>')
      var button=document.querySelector('#cta-form button'); if(button)button.textContent='Start Beta — $19/month'
      var form=document.querySelector('#cta-form'); if(form){var note=document.createElement('p');note.style.cssText='margin:10px 0 0;font-size:12px;color:#64748b';note.textContent='Planned Starter Beta price: $19/month. No payment is collected during the current validation stage.';form.insertAdjacentElement('afterend',note)}
    }

    if(path==='/'){
      var mainHome=document.querySelector('main'); if(mainHome&&!document.querySelector('.liq-product-bridge'))mainHome.appendChild(homeBridge()); if(mainHome&&!document.querySelector('.liq-pricing'))mainHome.appendChild(pricing())
      document.querySelectorAll('.signup-form button').forEach(function(b){b.textContent='Start Beta — $19/month'})
      document.querySelectorAll('.form-note').forEach(function(n){n.textContent='Planned Starter Beta price: $19/month. No payment is collected during the current validation stage.'})
    }

    document.querySelectorAll('body > footer, body > .foot, .wrap > footer').forEach(function(f){if(!f.classList.contains('liq-site-footer'))f.remove()})
    document.body.appendChild(footer())
    document.querySelectorAll('[data-liq-event]').forEach(function(el){el.addEventListener('click',function(){if(window.plausible)window.plausible(el.getAttribute('data-liq-event'))})})
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',applyShell);else applyShell()
})()
