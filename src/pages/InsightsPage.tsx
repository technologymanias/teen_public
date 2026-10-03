import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { watchTable } from '../lib/store'
import { minBalanceToPlay, type TableDoc, type TablePlayerStats } from '../lib/types'

interface Props {
  username: string
}

interface Row {
  username: string
  gamesPlayed: number
  gamesWon: number
  gamesLost: number
  totalWon: number
  totalLost: number
  net: number
}

export default function InsightsPage({ username }: Props) {
  const { code = '' } = useParams()
  const [table, setTable] = useState<TableDoc | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!code) return
    try {
      return watchTable(
        code,
        (t) => {
          setTable(t)
          setLoaded(true)
        },
        (e) => {
          setErr(e.message)
          setLoaded(true)
        }
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Not configured.')
      setLoaded(true)
    }
  }, [code])

  const rows = useMemo<Row[]>(() => {
    if (!table) return []
    const byName = new Map<string, Row>()
    for (const p of table.players) {
      if (byName.has(p.username)) continue
      byName.set(p.username, {
        username: p.username,
        gamesPlayed: 0,
        gamesWon: 0,
        gamesLost: 0,
        totalWon: 0,
        totalLost: 0,
        net: 0,
      })
    }
    for (const s of table.stats as TablePlayerStats[]) {
      const row = byName.get(s.username) ?? {
        username: s.username,
        gamesPlayed: 0,
        gamesWon: 0,
        gamesLost: 0,
        totalWon: 0,
        totalLost: 0,
        net: 0,
      }
      row.gamesPlayed = s.gamesPlayed
      row.gamesWon = s.gamesWon
      row.gamesLost = s.gamesLost
      row.totalWon = s.totalWon
      row.totalLost = s.totalLost
      row.net = s.totalWon - s.totalLost
      byName.set(s.username, row)
    }
    return [...byName.values()].sort((a, b) => b.net - a.net)
  }, [table])

  const header = (
    <div className="topbar">
      <Link to="/" className="btn ghost sm">
        ←
      </Link>
      <h1>
        Insights
        <span className="tiny" style={{ display: 'block', fontWeight: 400 }}>
          table {code}
        </span>
      </h1>
    </div>
  )

  if (!loaded) {
    return (
      <div className="app">
        {header}
        <div className="pad">
          <div className="waiting">
            <span className="spin" /> Loading…
          </div>
        </div>
      </div>
    )
  }

  if (err || !table) {
    return (
      <div className="app">
        {header}
        <div className="pad">
          <div className="error">{err ?? `Table ${code} does not exist.`}</div>
        </div>
      </div>
    )
  }

  if (table.adminUid !== username) {
    return (
      <div className="app">
        {header}
        <div className="pad">
          <div className="card">
            <h3>Admin only</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Only {table.adminUid} can open this table's insights.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (table.game.phase !== 'closed') {
    return (
      <div className="app">
        {header}
        <div className="pad">
          <div className="card">
            <h3>Table still running</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Insights unlock once the admin stops the table.
            </p>
            <Link className="btn go block" to={`/t/${table.code}`}>
              Back to the table
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const winner = rows[0]

  return (
    <div className="app">
      {header}

      <div className="pad">
        <div className="card">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>
                {table.name}
              </div>
              <div style={{ fontWeight: 800, fontSize: 17 }}>
                {winner ? (winner.net > 0 ? `${winner.username} finished ahead` : 'No winner overall') : 'No players'}
              </div>
              <div className="tiny">
                {table.rounds} rounds played ·{' '}
                {table.closedAt ? new Date(table.closedAt).toLocaleString() : ''}
              </div>
            </div>
          </div>
          <p className="tiny" style={{ marginBottom: 0, marginTop: 12 }}>
            Boot {table.config.boot} · points for joiners {table.config.joinerPoints} · base point{' '}
            {table.config.baseUnit} · min balance to play {minBalanceToPlay(table.config)}
          </p>
        </div>

        <div className="card">
          <h3>Scoreboard</h3>
          {rows.length === 0 ? (
            <div className="empty">Nobody sat at this table.</div>
          ) : (
            <div className="insights">
              <div className="ihead">
                <span>Player</span>
                <span className="r">Games</span>
                <span className="r">Won</span>
                <span className="r">Lost</span>
                <span className="r">Points</span>
              </div>
              {rows.map((r) => (
                <div className="irow" key={r.username}>
                  <span className="iname">
                    {r.username === username ? 'You' : r.username}
                    {table.players.find((p) => p.username === r.username)?.isAdmin && (
                      <em className="badge admin">ADMIN</em>
                    )}
                  </span>
                  <span className="r">{r.gamesPlayed}</span>
                  <span className="r" style={{ color: 'var(--green)' }}>
                    {r.gamesWon}
                  </span>
                  <span className="r" style={{ color: 'var(--red)' }}>
                    {r.gamesLost}
                  </span>
                  <span className={`r delta ${r.net >= 0 ? 'pos' : 'neg'}`}>
                    {r.net > 0 ? '+' : ''}
                    {r.net}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3>Won vs lost</h3>
          <div className="statgrid">
            {rows.map((r) => (
              <div className="stat" key={r.username}>
                <div
                  className="v"
                  style={{ color: r.net >= 0 ? 'var(--green)' : 'var(--red)' }}
                >
                  {r.net > 0 ? '+' : ''}
                  {r.net}
                </div>
                <div className="k">{r.username === username ? 'You' : r.username}</div>
                <div className="tiny">
                  {r.totalWon} won · {r.totalLost} lost
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
