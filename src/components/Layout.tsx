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
    <div className="min-h-screen pb-16">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <span className="rounded-md bg-indigo-600 px-2 py-1 text-sm font-bold text-white">LIQ</span>
            <span className="text-lg font-semibold tracking-tight">LandedIQ</span>
            {demo && (
              <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                DEMO MODE — data resets on refresh
              </span>
            )}
          </Link>
          {email && (
            <div className="flex items-center gap-3 text-sm text-slate-600">
              <span>{email}</span>
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
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
      <DisclaimerBar />
    </div>
  )
}
