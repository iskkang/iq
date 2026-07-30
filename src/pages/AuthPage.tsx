import { useState } from 'react'
import { DisclaimerBar } from '../components/Disclaimer'
import { trackEvent } from '../lib/analytics'
import { getRepo } from '../lib/repo'

export function AuthPage({ onSignedIn }: { onSignedIn: () => void }) {
  const repo = getRepo()
  const demo = repo.mode === 'demo'
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    if (mode === 'signup') trackEvent('signup_started')
    try {
      if (mode === 'signin') {
        await repo.signIn(email, password)
        trackEvent('signin_completed')
        onSignedIn()
      } else {
        const { needsEmailConfirm } = await repo.signUp(email, password)
        trackEvent('signup_completed', { needs_email_confirm: needsEmailConfirm })
        if (needsEmailConfirm) setMsg('Confirmation email sent. Verify your address, then sign in.')
        else onSignedIn()
      }
    } catch (err) {
      trackEvent(mode === 'signup' ? 'signup_failed' : 'signin_failed', {
        reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      })
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 pb-20 pt-8">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <a href="/" className="mb-5 flex items-center gap-2">
            <span className="rounded-md bg-indigo-600 px-2 py-1 text-sm font-bold text-white">LIQ</span>
            <span className="text-lg font-semibold">LandedIQ</span>
          </a>
          <p className="mb-1 text-sm font-medium text-slate-700">Landed cost, true margin & recommended price — per SKU</p>
          <p className="mb-4 text-xs leading-5 text-slate-500">Built by logistics operators around practical import workflows.</p>

          {demo ? (
            <>
              <p className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">
                Try it with any email — no password, nothing to install. Your work stays in this browser tab until you create an account.
              </p>
              <form onSubmit={submit} className="space-y-3">
                <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                <button disabled={busy} className="w-full rounded-md bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">Try it now</button>
              </form>
            </>
          ) : (
            <>
              <div className="mb-4 flex rounded-md bg-slate-100 p-1 text-sm">
                {(['signin', 'signup'] as const).map((m) => (
                  <button key={m} onClick={() => { setMode(m); if (m === 'signup') trackEvent('signup_tab_opened') }} className={`flex-1 rounded-md py-1.5 ${mode === m ? 'bg-white font-medium shadow-sm' : 'text-slate-500'}`}>
                    {m === 'signin' ? 'Sign in' : 'Sign up'}
                  </button>
                ))}
              </div>
              <form onSubmit={submit} className="space-y-3">
                <input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                <input type="password" required minLength={6} placeholder="Password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                <button disabled={busy} className="w-full rounded-md bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
                </button>
              </form>
            </>
          )}
          {msg && <p className="mt-3 text-xs text-rose-600">{msg}</p>}
          <div className="mt-5 border-t border-slate-200 pt-4 text-[11px] leading-5 text-slate-500">
            <p>LandedIQ is operated by MTL Co., Ltd.</p>
            <p>
              <a href="/about" className="hover:text-indigo-600">About</a>
              {' · '}
              <a href="/methodology" className="hover:text-indigo-600">Methodology</a>
              {' · '}
              <a href="/privacy" className="hover:text-indigo-600">Privacy</a>
              {' · '}
              <a href="/terms" className="hover:text-indigo-600">Terms</a>
            </p>
          </div>
        </div>
      </div>
      <DisclaimerBar />
    </div>
  )
}