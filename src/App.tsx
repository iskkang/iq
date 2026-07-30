import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { trackEvent } from './lib/analytics'
import { getRepo } from './lib/repo'
import { AuthPage } from './pages/AuthPage'
import { ShipmentDetailPage } from './pages/ShipmentDetailPage'
import { ShipmentsPage } from './pages/ShipmentsPage'

export default function App() {
  const repo = getRepo()
  const [email, setEmail] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const refresh = () =>
      repo.getUserEmail().then((e) => {
        setEmail(e)
        setReady(true)
        if (e && !localStorage.getItem('landediq_verified_account_tracked')) {
          trackEvent('email_verified')
          localStorage.setItem('landediq_verified_account_tracked', '1')
        }
      })
    refresh()
    return repo.onAuthChange(refresh)
  }, [repo])

  if (!ready) return null
  if (!email) return <AuthPage onSignedIn={() => repo.getUserEmail().then(setEmail)} />

  return (
    <BrowserRouter basename="/app">
      <Layout email={email} demo={repo.mode === 'demo'} onSignOut={() => repo.signOut().then(() => setEmail(null))}>
        <Routes>
          <Route path="/" element={<ShipmentsPage />} />
          <Route path="/shipment/:id" element={<ShipmentDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  )
}
