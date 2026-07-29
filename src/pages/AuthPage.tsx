import { useState } from 'react'
import { DisclaimerBar } from '../components/Disclaimer'
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
    try {
      if (mode === 'signin') {
        await repo.signIn(email, password)
        onSignedIn()
      } else {
        const { needsEmailConfirm } = await repo.signUp(email, password)
        if (needsEmailConfirm) setMsg('확인 메일을 보냈습니다. 메일의 링크로 인증 후 로그인하세요.')
        else onSignedIn()
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 pb-16">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <span className="rounded-md bg-indigo-600 px-2 py-1 text-sm font-bold text-white">LIQ</span>
          <span className="text-lg font-semibold">LandedIQ</span>
        </div>
        <p className="mb-4 text-sm text-slate-500">
          SKU별 landed cost · 실제 마진 · 권장 판매가 추정
        </p>

        {demo ? (
          <>
            <p className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">
              Supabase 환경변수가 없어 <b>데모 모드</b>로 실행 중입니다. 아무 이메일로 계속하세요
              (데이터는 브라우저 메모리에만 저장).
            </p>
            <form onSubmit={submit} className="space-y-3">
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                disabled={busy}
                className="w-full rounded-md bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                데모 시작
              </button>
            </form>
          </>
        ) : (
          <>
            <div className="mb-4 flex rounded-md bg-slate-100 p-1 text-sm">
              {(['signin', 'signup'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 rounded-md py-1.5 ${mode === m ? 'bg-white font-medium shadow-sm' : 'text-slate-500'}`}
                >
                  {m === 'signin' ? '로그인' : '가입'}
                </button>
              ))}
            </div>
            <form onSubmit={submit} className="space-y-3">
              <input
                type="email"
                required
                placeholder="이메일"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <input
                type="password"
                required
                minLength={6}
                placeholder="비밀번호 (6자 이상)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                disabled={busy}
                className="w-full rounded-md bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {busy ? '처리 중…' : mode === 'signin' ? '로그인' : '가입하기'}
              </button>
            </form>
          </>
        )}
        {msg && <p className="mt-3 text-xs text-rose-600">{msg}</p>}
      </div>
      <DisclaimerBar />
    </div>
  )
}
