import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorMessage, signIn, signUp, validatePassword, validateUsername } from '../lib/auth'

export default function LoginPage() {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'error' | 'notice'; text: string } | null>(null)
  const navigate = useNavigate()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setMsg(null)
    const u = username.trim().toLowerCase()
    if (!validateUsername(u)) {
      setMsg({ kind: 'error', text: 'Username: 3-20 chars, lowercase letters, numbers or _ only.' })
      return
    }
    if (!validatePassword(password)) {
      setMsg({ kind: 'error', text: 'Password must be at least 6 characters.' })
      return
    }
    if (mode === 'up' && password !== confirm) {
      setMsg({ kind: 'error', text: 'Passwords do not match.' })
      return
    }
    setBusy(true)
    try {
      if (mode === 'up') await signUp(u, password)
      else await signIn(u, password)
      navigate('/', { replace: true })
    } catch (e) {
      setMsg({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <div className="auth">
        <div>
          <div className="logo brand">Teen Patti Points</div>
          <div className="sub">Local points tracker for physical-card games</div>
        </div>

        <div className="tabs">
          <button className={mode === 'in' ? 'on' : ''} onClick={() => setMode('in')} type="button">
            Sign in
          </button>
          <button className={mode === 'up' ? 'on' : ''} onClick={() => setMode('up')} type="button">
            Create account
          </button>
        </div>

        <form className="card" onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="field">
            <label>Username</label>
            <input
              className="input"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. rahul_7"
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Password (min 6 characters)</label>
            <input
              className="input"
              type="password"
              value={password}
              autoComplete={mode === 'up' ? 'new-password' : 'current-password'}
              placeholder="••••••"
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {mode === 'up' && (
            <div className="field">
              <label>Confirm password</label>
              <input
                className="input"
                type="password"
                value={confirm}
                autoComplete="new-password"
                placeholder="••••••"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}

          {msg && <div className={msg.kind}>{msg.text}</div>}

          <button className="btn primary big block" disabled={busy} type="submit">
            {busy ? <span className="spin" /> : mode === 'up' ? 'Create account' : 'Sign in'}
          </button>

          <p className="tiny center" style={{ margin: 0 }}>
            {mode === 'up'
              ? 'Points come from the table you sit at — your account just tracks what you win or lose.'
              : 'Your net points and game history are stored with your account.'}
          </p>
        </form>
      </div>
    </div>
  )
}
