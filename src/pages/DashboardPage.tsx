import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { createTable, watchMyTables } from '../lib/store'
import { DEFAULT_CONFIG, minBalanceToPlay, type TableConfig, type TableDoc, type UserDoc } from '../lib/types'

interface Props {
  username: string
  profile: UserDoc | null
  onLogout: () => void
}

export default function DashboardPage({ username, profile, onLogout }: Props) {
  const [name, setName] = useState('')
  const [joinerPoints, setJoinerPoints] = useState(DEFAULT_CONFIG.joinerPoints)
  const [boot, setBoot] = useState(DEFAULT_CONFIG.boot)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [tables, setTables] = useState<TableDoc[]>([])
  const navigate = useNavigate()

  useEffect(() => {
    try {
      return watchMyTables(username, setTables, () => {})
    } catch {
      /* not configured */
    }
  }, [username])

  function config(): TableConfig {
    const b = Math.max(0, Math.floor(Number(boot) || 0))
    const j = Math.max(1, Math.floor(Number(joinerPoints) || 0))
    return { ...DEFAULT_CONFIG, boot: b, joinerPoints: j }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const cfg = config()
    const floor = minBalanceToPlay(cfg)
    if (cfg.joinerPoints < floor) {
      setErr(
        `Points for new joiners must be at least ${floor} — boot ${cfg.boot} + 2 × point ${cfg.baseUnit}.`
      )
      return
    }
    setBusy(true)
    try {
      const c = await createTable(name, username, cfg)
      navigate(`/t/${c}`)
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Could not create table.')
    } finally {
      setBusy(false)
    }
  }

  function onJoin(e: FormEvent) {
    e.preventDefault()
    setErr(null)
    const c = code.trim().toUpperCase().replace(/\D/g, '')
    if (c.length !== 6) {
      setErr('Enter the 6-digit table code.')
      return
    }
    navigate(`/t/${c}`)
  }

  const s = profile?.stats
  const balance = profile?.balance ?? 0
  const floor = minBalanceToPlay(config())

  const open = tables
    .filter(
      (t) =>
        t.game.phase !== 'closed' &&
        t.players.some((p) => p.uid === username && p.status !== 'left')
    )
    .sort((a, b) => b.createdAt - a.createdAt)
  const closed = tables
    .filter((t) => t.game.phase === 'closed' && t.adminUid === username)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand" style={{ fontSize: 17 }}>
          Teen Patti Points
        </span>
        <div className="grow" />
        <button className="btn ghost sm" onClick={onLogout}>
          Log out
        </button>
      </div>

      <div className="pad">
        <div className="balance">
          <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
            Hey, {username}
          </div>
          <div className="amt" style={{ color: balance >= 0 ? 'var(--accent)' : 'var(--red)' }}>
            {balance > 0 ? '+' : ''}
            {balance.toLocaleString()}
          </div>
          <div className="muted">points balance</div>
        </div>

        <div className="statgrid">
          <div className="stat">
            <div className="v">{s?.gamesPlayed ?? 0}</div>
            <div className="k">Games</div>
          </div>
          <div className="stat">
            <div className="v" style={{ color: 'var(--green)' }}>
              {s?.gamesWon ?? 0}
            </div>
            <div className="k">Won</div>
          </div>
          <div className="stat">
            <div className="v" style={{ color: 'var(--red)' }}>
              {s?.gamesLost ?? 0}
            </div>
            <div className="k">Lost</div>
          </div>
          <div className="stat">
            <div className="v" style={{ color: 'var(--accent)' }}>
              {(s?.totalAllocated ?? 0).toLocaleString()}
            </div>
            <div className="k">Points played</div>
          </div>
          <div className="stat">
            <div className="v" style={{ color: 'var(--green)' }}>
              {(s?.totalWon ?? 0).toLocaleString()}
            </div>
            <div className="k">Total won</div>
          </div>
          <div className="stat">
            <div className="v" style={{ color: 'var(--red)' }}>
              {(s?.totalLost ?? 0).toLocaleString()}
            </div>
            <div className="k">Total lost</div>
          </div>
        </div>

        {(open.length > 0 || closed.length > 0) && (
          <div className="card">
            <h3>Your tables</h3>
            {open.length === 0 && closed.length === 0 && (
              <div className="empty">Nothing here yet.</div>
            )}
            {open.map((t) => (
              <Link className="tablerow" key={t.code} to={`/t/${t.code}`}>
                <div className="grow">
                  <div style={{ fontWeight: 700 }}>{t.name}</div>
                  <div className="tiny">
                    {t.code} · {t.game.phase === 'playing' ? 'in play' : t.game.phase} ·{' '}
                    {t.players.filter((p) => p.status !== 'left').length}/{t.config.maxPlayers} seated
                    {t.game.paused ? ' · paused' : ''}
                  </div>
                </div>
                <span className="go">Open →</span>
              </Link>
            ))}
            {closed.map((t) => (
              <Link className="tablerow" key={t.code} to={`/t/${t.code}/insights`}>
                <div className="grow">
                  <div style={{ fontWeight: 700 }}>{t.name}</div>
                  <div className="tiny">
                    {t.code} · closed · {t.rounds} rounds · {t.stats.length} players
                  </div>
                </div>
                <span className="go">Insights →</span>
              </Link>
            ))}
          </div>
        )}

        <form className="card" onSubmit={onCreate}>
          <h3>Create a table</h3>
          <div className="field">
            <label>Table name</label>
            <input
              className="input"
              placeholder="e.g. Friday night"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="cfggrid" style={{ marginTop: 10 }}>
            <div className="field">
              <label>Points for new joiners</label>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                value={joinerPoints}
                onChange={(e) => setJoinerPoints(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label>Boot / dabba per round</label>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={0}
                value={boot}
                onChange={(e) => setBoot(Number(e.target.value))}
              />
            </div>
          </div>
          <p className="tiny">
            Everyone gets {joinerPoints} points on their account when they sit down, then each round
            hands out {joinerPoints} chips and {boot} of them drops into the centre. Anyone below{' '}
            {floor} points sits out until the admin tops them up.
          </p>
          <button className="btn primary block" disabled={busy} type="submit">
            {busy ? <span className="spin" /> : 'Create table'}
          </button>
        </form>

        <form className="card" onSubmit={onJoin}>
          <h3>Join a table</h3>
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input grow center"
              inputMode="numeric"
              maxLength={6}
              placeholder="6-digit code"
              style={{ letterSpacing: 6, fontWeight: 800, textAlign: 'center' }}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button className="btn go" type="submit">
              Join
            </button>
          </div>
        </form>

        {err && <div className="error">{err}</div>}

        <div className="card">
          <h3>Game history</h3>
          {!profile || profile.history.length === 0 ? (
            <div className="empty">No games yet. Create a table to get started.</div>
          ) : (
            <div className="histlist">
              {profile.history.map((h, i) => (
                <div className="histitem" key={`${h.at}-${i}`}>
                  <span className={`pill ${h.result}`}>{h.result}</span>
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{h.tableName}</div>
                    <div className="tiny">
                      {new Date(h.at).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}{' '}
                      · table {h.tableCode} · pot {h.pot} · {h.players} players
                    </div>
                  </div>
                  <span className={`delta ${h.delta >= 0 ? 'pos' : 'neg'}`}>
                    {h.delta >= 0 ? '+' : ''}
                    {h.delta}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
