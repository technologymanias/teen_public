import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { isFirebaseConfigured } from './lib/firebase'
import { logOut, watchAuth } from './lib/auth'
import { watchProfile } from './lib/store'
import type { UserDoc } from './lib/types'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import TablePage from './pages/TablePage'
import InsightsPage from './pages/InsightsPage'

export default function App() {
  const [username, setUsername] = useState<string | null>(null)
  const [profile, setProfile] = useState<UserDoc | null>(null)
  const [ready, setReady] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!isFirebaseConfigured) {
      setReady(true)
      return
    }
    return watchAuth((u) => {
      setUsername(u)
      setReady(true)
      if (!u) {
        setProfile(null)
        navigate('/login')
      }
    })
  }, [navigate])

  useEffect(() => {
    if (!username || !isFirebaseConfigured) return
    try {
      return watchProfile(
        username,
        (p) => setProfile(p),
        () => {}
      )
    } catch {
      /* ignore */
    }
  }, [username])

  async function doLogout() {
    await logOut()
    setUsername(null)
    setProfile(null)
    navigate('/login')
  }

  if (!isFirebaseConfigured) {
    return (
      <div className="app">
        <div className="pad" style={{ justifyContent: 'center', flex: 1 }}>
          <div className="card">
            <h3>Setup required</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Firebase is not configured. Copy <code>.env.example</code> to <code>.env</code>, fill
              in your Firebase web app keys, then restart the dev server.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="app">
        <div className="auth">
          <div className="center">
            <span className="spin" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          username ? (
            <DashboardPage username={username} profile={profile} onLogout={doLogout} />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/t/:code"
        element={username ? <TablePage username={username} /> : <Navigate to="/login" replace />}
      />
      <Route
        path="/t/:code/insights"
        element={username ? <InsightsPage username={username} /> : <Navigate to="/login" replace />}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
