import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { DisclaimerBar } from './Disclaimer'

export function Layout({
  email,
  demo,
  onSignOut,
  children,
}: {
  email: string | null
  demo: boolean
  onSignOut: () => void
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col pb-16">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="rounded-md bg-indigo-600 px-2 py-1 text-sm font-bold text-white">LIQ</span>
            <span className="text-lg font-semibold tracking-tight">LandedIQ</span>
            {demo && (
              <span
                className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800"
                title="Create an account to keep your shipments"
              >
                Trial — not saved
              </span>
            )}
          </Link>
          {email && (
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <span className="hidden sm:inline">{email}</span>
              <button
                onClick={onSignOut}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</main>
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-col justify-between gap-4 px-4 py-6 text-xs leading-5 text-slate-500 md:flex-row">
          <div>
            <p className="font-semibold text-slate-700">LandedIQ</p>
            <p>LandedIQ is operated by MTL Co., Ltd. · support@landediq.app</p>
          </div>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 md:justify-end" aria-label="Product and legal links">
            <a href="/" className="hover:text-indigo-600">Public site</a>
            <a href="/about" className="hover:text-indigo-600">About</a>
            <a href="/methodology" className="hover:text-indigo-600">Methodology</a>
            <a href="/privacy" className="hover:text-indigo-600">Privacy</a>
            <a href="/terms" className="hover:text-indigo-600">Terms</a>
            <a href="mailto:support@landediq.app" className="hover:text-indigo-600">Support</a>
          </nav>
        </div>
      </footer>
      <DisclaimerBar />
    </div>
  )
}