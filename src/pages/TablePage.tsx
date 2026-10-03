import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { isAdmin, isClosed, minBetFor, sideShowTarget, seated } from '../lib/engine'
import { dispatch, getBalances, watchTable } from '../lib/store'
import {
  CLOCK_SKEW_MS,
  minBalanceToPlay,
  tableStatus,
  type Action,
  type Player,
  type TableConfig,
  type TableDoc,
  type Visibility,
} from '../lib/types'

interface Props {
  username: string
}

type Sheet =
  | null
  | 'admin'
  | 'stop'
  | 'config'
  | 'end'
  | 'sideshow'
  | 'show'
  | 'leave'
  | 'topup'
  | 'turn'
  | 'place'

interface Coin {
  id: number
  fx: string
  fy: string
  delay: number
}

function seatPosition(index: number, total: number) {
  const angle = Math.PI / 2 + (index * 2 * Math.PI) / total
  return { left: `${50 + 37 * Math.cos(angle)}%`, top: `${50 + 36 * Math.sin(angle)}%` }
}

function useCountdown(endsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!endsAt) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [endsAt])
  if (!endsAt) return 0
  return Math.max(0, Math.ceil((endsAt - now) / 1000))
}

export default function TablePage({ username }: Props) {
  const { code = '' } = useParams()
  const navigate = useNavigate()
  const [table, setTable] = useState<TableDoc | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const [bet, setBet] = useState(0)
  const [cfg, setCfg] = useState<TableConfig | null>(null)
  const [coins, setCoins] = useState<Coin[]>([])
  const [deals, setDeals] = useState<Coin[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [topupAmounts, setTopupAmounts] = useState<Record<string, number>>({})
  const lastErr = useRef<string | null>(null)
  const coinId = useRef(1)
  const dealId = useRef(1)
  const booted = useRef(false)
  const prevPhase = useRef<string | null>(null)
  const prevBetSeq = useRef(0)
  const prevSeen = useRef<Record<string, boolean>>({})
  const celebrated = useRef<number | null>(null)
  const [flipping, setFlipping] = useState<ReadonlySet<string>>(new Set())
  const [celebrate, setCelebrate] = useState(false)
  const [celebrateAt, setCelebrateAt] = useState(0)

  useEffect(() => {
    if (!code) return
    try {
      return watchTable(
        code,
        (t) => {
          setTable(t)
          setNotFound(!t)
        },
        (e) => setErr(e.message)
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Not configured.')
    }
  }, [code])

  const me: Player | undefined = useMemo(
    () => table?.players.find((p) => p.uid === username && p.status !== 'left'),
    [table, username]
  )
  const admin = table ? isAdmin(table, username) : false
  const players = useMemo(() => (table ? seated(table) : []), [table])
  /** Seats as *you* see them: your own avatar is always the one nearest you. */
  const displayOrder = useMemo(() => {
    if (players.length < 2) return players
    const meIdx = players.findIndex((p) => p.uid === username)
    if (meIdx <= 0) return players
    return [...players.slice(meIdx), ...players.slice(0, meIdx)]
  }, [players, username])
  const pendingPlace = useMemo(
    () => (table ? table.players.filter((p) => p.status !== 'left' && p.mustPlace) : []),
    [table]
  )
  const g = table?.game
  const phase = g?.phase ?? 'lobby'
  const paused = !!g?.paused
  const closed = phase === 'closed'
  const myTurn = phase === 'playing' && !paused && g?.turnUid === username && me?.status === 'active'
  const sittingOut = me?.status === 'sittingOut'

  const canSeeConfig = admin || table?.config.configVisibility === 'all'
  const canSeeChips = admin || table?.config.chipVisibility === 'all'

  const min = me && table && phase === 'playing' ? minBetFor(table, me) : 0
  const step = g?.unit ?? table?.config.baseUnit ?? 10
  const maxBet = me?.chips ?? 0
  const threshold = table ? minBalanceToPlay(table.config) : 0

  const seconds = useCountdown(g?.countdownEndsAt ?? g?.waitEndsAt ?? null)

  const lowPlayers = useMemo(
    () =>
      admin
        ? players.filter(
            (p) => typeof balances[p.uid] === 'number' && balances[p.uid] < threshold
          )
        : [],
    [admin, players, balances, threshold]
  )

  useEffect(() => {
    if (myTurn) setBet(clampBet(min))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myTurn, min, g?.turnUid, maxBet])

  // Pop the action sheet once each time the turn becomes yours, and never over
  // another sheet. Closing it keeps it closed for the rest of this turn.
  const hadTurn = useRef(false)
  useEffect(() => {
    if (!myTurn) {
      hadTurn.current = false
      return
    }
    if (hadTurn.current || sheet !== null) return
    hadTurn.current = true
    setSheet('turn')
  }, [myTurn, sheet])

  // Offer the seat picker as soon as somebody joins mid-game, and once more at
  // the end of a round — that is when the seats actually unlock again.
  const seenPlaced = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (phase === 'lobby' || phase === 'waiting') seenPlaced.current.clear()
  }, [phase])
  useEffect(() => {
    if (!admin || !pendingPlace.length) return
    const fresh = pendingPlace.filter((p) => !seenPlaced.current.has(p.uid))
    if (!fresh.length) return
    fresh.forEach((p) => seenPlaced.current.add(p.uid))
    if (sheet === null) setSheet('place')
  }, [admin, pendingPlace, sheet])

  // A sheet whose reason has gone away should not linger and block the next one.
  useEffect(() => {
    if (sheet === 'turn' && !myTurn) setSheet(null)
    else if (sheet === 'place' && !pendingPlace.length) setSheet(null)
  }, [sheet, myTurn, pendingPlace.length])

  useEffect(() => {
    if (!err || err === lastErr.current) return
    lastErr.current = err
    setToast(err)
    const t = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(t)
  }, [err])

  // §19 — a blind player who gets flipped over plays a one-shot badge transition.
  useEffect(() => {
    if (!table) return
    const next: Record<string, boolean> = {}
    const flipped: string[] = []
    for (const p of table.players) {
      if (p.status === 'left') continue
      next[p.uid] = p.seen
      if (prevSeen.current[p.uid] === false && p.seen) flipped.push(p.uid)
    }
    prevSeen.current = next
    if (!flipped.length) return
    setFlipping(new Set(flipped))
    const id = setTimeout(() => setFlipping(new Set()), 750)
    return () => clearTimeout(id)
  }, [table])

  // §31 — celebrate a freshly chosen winner, then get out of the way.
  useEffect(() => {
    const identity = g?.waitEndsAt ?? null
    if (phase !== 'waiting' || !g?.winnerUid || !identity) {
      celebrated.current = null
      return
    }
    if (celebrated.current === identity) return
    celebrated.current = identity
    setCelebrateAt(identity)
    setCelebrate(true)
    const id = setTimeout(() => setCelebrate(false), 6000)
    return () => clearTimeout(id)
  }, [phase, g?.winnerUid, g?.waitEndsAt])

  async function loadBalances(list: Player[] = players) {
    if (!list.length) return
    try {
      setBalances(await getBalances(list.map((p) => p.uid)))
    } catch {
      /* balances are informational only */
    }
  }

  useEffect(() => {
    if (closed || !(admin || sittingOut)) return
    void loadBalances(players)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, admin, sittingOut, players.length, closed])

  async function act(action: Action, quiet = false) {
    setErr(null)
    setBusy(true)
    try {
      const problem = await dispatch(code, action)
      if (problem) {
        if (!quiet) setErr(problem)
        return false
      }
      return true
    } catch (e) {
      if (!quiet) setErr(e instanceof Error ? e.message : 'Failed.')
      return false
    } finally {
      setBusy(false)
    }
  }

  function clampBet(v: number) {
    const lo = Math.min(min, maxBet)
    return Math.max(lo, Math.min(maxBet, v))
  }

  // Coin flight on bets + cards dealt when the round starts.
  useEffect(() => {
    if (!table) return
    const t = table.game

    if (!booted.current) {
      booted.current = true
      prevPhase.current = t.phase
      prevBetSeq.current = t.betSeq
      return
    }

    if (prevPhase.current === 'countdown' && t.phase === 'playing' && !t.paused) {
      const dealt = seated(table).filter((p) => p.status === 'active')
      spawn(dealt.map((p) => p.uid))
      dealCards(dealt.map((p) => p.uid))
    } else if (t.phase === 'playing' && t.betSeq > prevBetSeq.current && t.lastBetBy) {
      spawn([t.lastBetBy])
    }

    prevPhase.current = t.phase
    prevBetSeq.current = t.betSeq
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table])

  /** Landing spots for `uids`, measured in your own view of the table. */
  function positionsFor(uids: string[], gap: number, nextId: () => number) {
    const next: Coin[] = []
    uids.forEach((uid, i) => {
      const idx = displayOrder.findIndex((p) => p.uid === uid)
      if (idx < 0) return
      const pos = seatPosition(idx, displayOrder.length)
      next.push({ id: nextId(), fx: pos.left, fy: pos.top, delay: i * gap })
    })
    return next
  }

  function spawn(uids: string[]) {
    const next = positionsFor(uids, 55, () => coinId.current++)
    if (next.length) setCoins((c) => [...c, ...next])
  }

  // §9 — three cards each, handed out one full pass at a time from the deck.
  function dealCards(uids: string[]) {
    const next: Coin[] = []
    uids.forEach((uid, i) => {
      const idx = displayOrder.findIndex((p) => p.uid === uid)
      if (idx < 0) return
      const pos = seatPosition(idx, displayOrder.length)
      for (let pass = 0; pass < 3; pass++)
        next.push({
          id: dealId.current++,
          fx: pos.left,
          fy: pos.top,
          delay: 240 + pass * 260 + i * 70,
        })
    })
    if (next.length) setDeals((d) => [...d, ...next])
  }

  // Any client can drive the timers; the transaction makes only one winner.
  // A countdown produces no new snapshot when it elapses, so the fire time is
  // scheduled explicitly instead of waiting for a re-render that never comes.
  useEffect(() => {
    if (!table) return
    const t = table.game
    if (t.paused) return
    const due =
      t.phase === 'countdown' ? t.countdownEndsAt : t.phase === 'waiting' ? t.waitEndsAt : null
    if (!due) return
    const action: Action =
      t.phase === 'countdown'
        ? { type: 'beginRound', uid: username }
        : { type: 'autoStart', uid: username }

    let alive = true
    let inFlight = false
    const fire = (attempt: number) => {
      if (!alive || inFlight) return
      inFlight = true
      dispatch(code, action)
        .catch((e) => `Network error — ${e instanceof Error ? e.message : 'try again.'}`)
        .then((problem) => {
          inFlight = false
          if (!problem) return
          // Our clock can race the deadline; a dropped connection may recover.
          // Anything else (permissions, validation) will never succeed on a retry.
          const transient = problem.startsWith('Too early') || problem.startsWith('Network error')
          const limit = problem.startsWith('Too early') ? 8 : 3
          if (alive && transient && attempt < limit) {
            setTimeout(() => fire(attempt + 1), 300)
            return
          }
          if (alive) setErr(problem)
        })
    }

    const id = setTimeout(() => fire(0), Math.max(0, due - CLOCK_SKEW_MS - Date.now()))
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [table, code, username])

  const canArrange = phase === 'lobby' || phase === 'waiting'

  const seatList = (
    <div className="plist">
      {players.map((p, i) => (
        <div className="pitem" key={p.uid}>
          <span className="av">{p.username.slice(0, 1).toUpperCase()}</span>
          <div className="grow">
            <div style={{ fontWeight: 700 }}>{p.uid === username ? 'You' : p.username}</div>
            <div className="tiny">
              seat {p.seat + 1}
              {p.mustPlace ? ' · waiting for a place' : ''}
            </div>
          </div>
          {admin && typeof balances[p.uid] === 'number' && (
            <span className={`tiny ${balances[p.uid] < threshold ? 'neg' : ''}`}>
              {balances[p.uid]} pts
            </span>
          )}
          {p.isAdmin && <span className="badge admin">ADMIN</span>}
          {p.mustPlace && <span className="badge pending">PLACE</span>}
          {admin && canArrange && (
            <span className="seatmove">
              <button
                className="btn sm"
                disabled={busy || i === 0}
                aria-label={`Move ${p.username} up`}
                onClick={() => void act({ type: 'reseat', uid: username, targetUid: p.uid, dir: -1 })}
              >
                ↑
              </button>
              <button
                className="btn sm"
                disabled={busy || i === players.length - 1}
                aria-label={`Move ${p.username} down`}
                onClick={() => void act({ type: 'reseat', uid: username, targetUid: p.uid, dir: 1 })}
              >
                ↓
              </button>
            </span>
          )}
          {admin && p.uid !== username && (
            <button
              className="btn danger sm"
              disabled={busy}
              onClick={() => void act({ type: 'kick', uid: username, targetUid: p.uid })}
            >
              Remove
            </button>
          )}
        </div>
      ))}
    </div>
  )

  if (notFound) {
    return (
      <div className="app">
        <div className="topbar">
          <Link to="/" className="btn ghost sm">
            ← Back
          </Link>
          <h1>Table {code}</h1>
        </div>
        <div className="pad">
          <div className="error">Table {code} does not exist.</div>
        </div>
      </div>
    )
  }

  if (!table || !g) {
    return (
      <div className="app">
        <div className="topbar">
          <Link to="/" className="btn ghost sm">
            ← Back
          </Link>
          <h1>Table {code}</h1>
        </div>
        <div className="pad">
          <div className="waiting">
            <span className="spin" /> Connecting…
          </div>
        </div>
      </div>
    )
  }

  if (isClosed(table)) {
    return (
      <div className="app">
        <div className="topbar">
          <Link to="/" className="btn ghost sm">
            ←
          </Link>
          <h1>
            {table.name}
            <span className="tiny" style={{ display: 'block', fontWeight: 400 }}>
              code {table.code} · stopped
            </span>
          </h1>
        </div>
        <div className="pad">
          <div className="card">
            <h3>Table stopped</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              {table.rounds} rounds played · {table.players.length} players · closed{' '}
              {table.closedAt ? new Date(table.closedAt).toLocaleString() : ''}
            </p>
          </div>
          {admin ? (
            <Link className="btn go block big" to={`/t/${table.code}/insights`}>
              Open insights
            </Link>
          ) : (
            <div className="notice">Only {table.adminUid} can open this table's insights.</div>
          )}
          <Link className="btn block" to="/">
            Back to dashboard
          </Link>
        </div>
      </div>
    )
  }

  if (!me) {
    return (
      <div className="app">
        <div className="topbar">
          <Link to="/" className="btn ghost sm">
            ←
          </Link>
          <h1>{table.name}</h1>
        </div>
        <div className="pad">
          <div className="card">
            <h3>Sit down</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              code {table.code} · {players.length}/{table.config.maxPlayers} seated
            </p>
            <p className="tiny">
              You'll be credited <b>{table.config.joinerPoints}</b> points on your account, and you
              need at least <b>{threshold}</b> to take a seat in each round.
              {phase === 'playing' && ' You are joining mid-round, so you sit out until the next one.'}
            </p>
          </div>
          {err && <div className="error">{err}</div>}
          <button
            className="btn go block big"
            disabled={busy || paused}
            onClick={() => act({ type: 'join', uid: username, username })}
          >
            {busy ? <span className="spin" /> : paused ? 'Table is paused' : 'Sit at this table'}
          </button>
          <button className="btn block" onClick={() => navigate('/')}>
            Back to dashboard
          </button>
        </div>
      </div>
    )
  }

  const winner = g.winnerUid ? players.find((p) => p.uid === g.winnerUid) : null
  const activePlayers = players.filter((p) => p.status === 'active')
  const sideTarget = myTurn ? sideShowTarget(table, username) : null
  const headsUp = activePlayers.length === 2
  const showBtn = myTurn && headsUp
  const sideBtn = myTurn && activePlayers.length >= 3 && table.config.sideshow
  const roundHistory = table.roundHistory || []
  const chaalHistory = table.actionHistory || []
  const lastRound = roundHistory.length ? roundHistory[roundHistory.length - 1] : null
  const canPickWinner = admin || g.endedBy === username
  const status = tableStatus(g)
  /** How many chips to draw in the dabba stack — purely decorative. */
  const dabbaStack =
    phase === 'playing' && g.pot > 0
      ? Math.min(6, Math.max(1, Math.round(g.pot / Math.max(10, g.unit * 2))))
      : 0
  const startStage =
    seconds >= 4 ? 'READY' : seconds > 0 ? String(seconds) : 'ROUND START'

  const hubTitle = paused
    ? 'Paused'
    : phase === 'countdown'
      ? 'Starting in'
      : phase === 'playing'
        ? 'Dabba'
        : phase === 'waiting'
          ? 'Winner pot'
          : 'Table'
  const hubValue = paused
    ? 'Hold'
    : phase === 'countdown'
      ? String(seconds)
      : phase === 'waiting'
        ? winner
          ? winner.uid === username
            ? 'You!'
            : winner.username
          : 'Round over'
        : phase === 'roundEnded'
          ? 'Round stopped'
          : phase === 'lobby'
            ? 'Waiting to start'
            : g.turnUid === username
              ? 'Your turn'
              : (players.find((p) => p.uid === g.turnUid)?.username ?? '—')

  const turnControls = (<>
      <div className="betbox">
        <button
          className="btn step"
          onClick={() => setBet((b) => clampBet(b - step))}
          disabled={bet - step < Math.min(min, maxBet)}
        >
          −
        </button>
        <div className="val">
          ₹{bet}
          <small>
            {me.seen ? 'SEEN' : 'BLIND'} · min ₹{min} · you have ₹{maxBet}
          </small>
        </div>
        <button
          className="btn step"
          onClick={() => setBet((b) => clampBet(b + step))}
          disabled={bet + step > maxBet}
        >
          +
        </button>
      </div>

      {maxBet < min && (
        <div className="notice">
          You have ₹{maxBet} left but the minimum chaal is ₹{min} — you can only fold.
        </div>
      )}

      <div className="actiongrid">
        <button
          className="btn primary big"
          disabled={busy || maxBet < min}
          onClick={() => act({ type: 'bet', uid: username, amount: bet })}
        >
          Chaal ₹{bet}
        </button>
        {!me.seen ? (
          <button
            className="btn warn big"
            disabled={busy}
            onClick={() => act({ type: 'setSeen', uid: username, seen: true })}
          >
            See my cards
          </button>
        ) : (
          <button className="btn ghost big" disabled>
            Seen · blind pays ₹{step}
          </button>
        )}
      </div>

      <div className="actiongrid">
        <button
          className="btn danger big"
          disabled={busy}
          onClick={() => act({ type: 'fold', uid: username })}
        >
          Leave game
        </button>
        {showBtn ? (
          <button className="btn warn big" disabled={busy} onClick={() => setSheet('show')}>
            Show
          </button>
        ) : sideBtn ? (
          <button
            className="btn warn big"
            disabled={busy || !sideTarget}
            onClick={() => setSheet('sideshow')}
          >
            Side show
          </button>
        ) : (
          <button className="btn ghost big" disabled>
            {table.config.sideshow ? 'Side show: 3+ left' : 'Side show off'}
          </button>
        )}
      </div>
  </>)

  return (
    <div className="app">
      <div className="topbar">
        <Link to="/" className="btn ghost sm">
          ←
        </Link>
        <h1>
          {table.name}
          <span className="tiny" style={{ display: 'block', fontWeight: 400 }}>
            code {table.code} · <b className={`statuspill s-${status.replace(/\s+/g, '').toLowerCase()}`}>{status}</b>
            {admin ? ' · you are admin' : ''}
            {sittingOut ? ' · you sit out this round' : ''}
          </span>
        </h1>
        {admin && <button className="btn sm" onClick={() => setSheet('admin')}>Admin</button>}
        {!admin && canSeeConfig && (phase === 'lobby' || phase === 'waiting') && (
          <button className="btn sm" onClick={() => setSheet('config')}>
            Config
          </button>
        )}
        <button className="btn ghost sm" onClick={() => setSheet('leave')}>
          Exit
        </button>
      </div>

      {paused && (
        <div className="pausebar">
          <span>Paused by {table.adminUid === username ? 'you' : table.adminUid} — timers and play are frozen.</span>
          {admin && (
            <button
              className="btn go sm"
              disabled={busy}
              onClick={() => act({ type: 'resume', uid: username })}
            >
              Resume
            </button>
          )}
        </div>
      )}

      {admin && !paused && lowPlayers.length > 0 && (
        <div className="warnbar">
          <span>
            {lowPlayers.map((p) => `${p.username} (${balances[p.uid]})`).join(', ')} below {threshold} —
            they'll sit out.
          </span>
          <button className="btn sm" onClick={() => setSheet('topup')}>
            Give points
          </button>
        </div>
      )}

      {admin && pendingPlace.length > 0 && (
        <div className="warnbar">
          <span>
            {pendingPlace.map((p) => p.username).join(', ')}{' '}
            {pendingPlace.length > 1 ? 'need' : 'needs'} a seat.
          </span>
          <button className="btn sm" onClick={() => setSheet('place')}>
            Place
          </button>
        </div>
      )}

      {phase === 'playing' && g.notice && (
        <div className="noticebar" role="status">
          {g.notice}
        </div>
      )}

      <div className="tablewrap">
        <div className="felt">
          {displayOrder.map((p, i) => {
            const pos = seatPosition(i, displayOrder.length)
            const isTurn = phase === 'playing' && !paused && g.turnUid === p.uid
            const isWinner = phase === 'waiting' && g.winnerUid === p.uid
            const low = admin && typeof balances[p.uid] === 'number' && balances[p.uid] < threshold
            const cls = [
              'seat',
              isTurn ? 'turn' : '',
              p.status === 'folded' || p.status === 'sittingOut' ? 'out' : '',
              isWinner ? 'winner' : '',
            ]
              .filter(Boolean)
              .join(' ')
            const showChip = (canSeeChips || p.uid === username) && p.buyIn > 0
            return (
              <div className={cls} key={p.uid} style={pos}>
                {phase === 'playing' && g.lastBetBy === p.uid && g.lastBet != null && g.betSeq > 0 && (
                  <span className="lastbet" key={`b${g.betSeq}`}>
                    −₹{g.lastBet}
                  </span>
                )}
                {isWinner && g.lastPot > 0 && (
                  <span className="winpot" key={`w${g.waitEndsAt}`}>
                    +₹{g.lastPot}
                  </span>
                )}
                <div className="avatar">
                  {p.username.slice(0, 1).toUpperCase()}
                  <span
                    className={`seenmark ${p.seen ? '' : 'hiddenmark'}${flipping.has(p.uid) ? ' flip' : ''}`}
                    onAnimationEnd={() =>
                      setFlipping((s) => {
                        if (!s.has(p.uid)) return s
                        const next = new Set(s)
                        next.delete(p.uid)
                        return next
                      })
                    }
                  >
                    {p.seen ? 'SEEN' : 'BLIND'}
                  </span>
                </div>
                <span className="nm">{p.uid === username ? 'You' : p.username}</span>
                {p.status === 'sittingOut' && <span className="badge">NEXT ROUND</span>}
                {p.status === 'folded' && <span className="badge folded">OUT</span>}
                {p.isAdmin && <span className="badge admin">ADMIN</span>}
                {low && <span className="badge low">LOW {balances[p.uid]}</span>}
                {showChip && <span className="chips">₹{p.chips}</span>}
                {!showChip && p.buyIn > 0 && (
                  <span className="chips" style={{ color: 'var(--muted)' }}>
                    •••
                  </span>
                )}
              </div>
            )
          })}

          <div className="hub">
            <span className="potk">{hubTitle}</span>
            {phase === 'playing' && (
              <span className="chiprow" aria-hidden>
                {Array.from({ length: dabbaStack }, (_, i) => (
                  <i key={i} />
                ))}
              </span>
            )}
            <span className="potv">
              {phase === 'playing'
                ? `₹${g.pot}`
                : phase === 'waiting'
                  ? `₹${g.lastPot}`
                  : '—'}
            </span>
            {phase === 'playing' && g.betSeq > 0 && g.lastBet != null && (
              <>
                <span className="potring" key={`r${g.betSeq}`} aria-hidden="true" />
                <span className="potflash" key={`p${g.betSeq}`}>
                  +₹{g.lastBet}
                </span>
              </>
            )}
            <span className="turnk">
              {phase === 'playing'
                ? 'Whose turn'
                : phase === 'countdown'
                  ? 'Seconds'
                  : phase === 'waiting'
                    ? 'Winner'
                    : 'Status'}
            </span>
            <span
              className="turnv"
              style={
                phase === 'countdown'
                  ? { fontSize: 'clamp(28px,11vw,44px)', color: 'var(--accent)' }
                  : paused
                    ? { color: 'var(--amber, #f0b429)' }
                    : undefined
              }
            >
              {hubValue}
            </span>
            <span className="meta">
              {phase === 'playing' && !paused && (
                <>
                  <span>
                    Round <b>{g.round}</b>
                  </span>
                  <span>
                    Point <b>₹{g.unit}</b>
                  </span>
                  <span>
                    Min <b>{min ? `₹${min}` : '—'}</b>
                  </span>
                  <span>
                    Seen <b>{activePlayers.filter((p) => p.seen).length}/{activePlayers.length}</b>
                  </span>
                </>
              )}
              {phase === 'waiting' && (
                <span>
                  Next round in <b>{paused ? 'paused' : `${seconds}s`}</b>
                </span>
              )}
              {phase === 'lobby' && (
                <span>
                  Boot <b>₹{table.config.boot}</b> · each round deals{' '}
                  <b>₹{table.config.joinerPoints}</b>
                </span>
              )}
            </span>
          </div>

          {coins.map((c) => (
            <span
              key={c.id}
              className="coin"
              style={{ ['--fx' as string]: c.fx, ['--fy' as string]: c.fy, animationDelay: `${c.delay}ms` }}
              onAnimationEnd={() => setCoins((list) => list.filter((x) => x.id !== c.id))}
            />
          ))}

          {deals.map((c) => (
            <span
              key={c.id}
              className="deal"
              style={{ ['--fx' as string]: c.fx, ['--fy' as string]: c.fy, animationDelay: `${c.delay}ms` }}
              onAnimationEnd={() => setDeals((list) => list.filter((x) => x.id !== c.id))}
            />
          ))}

          {phase === 'countdown' && !paused && (
            <div className="startover" aria-live="polite">
              <span className="stage" key={seconds}>
                {startStage}
              </span>
            </div>
          )}
        </div>

        {admin && canArrange && phase === 'waiting' && (
          <div className="pad" style={{ paddingTop: 0 }}>
            <details className="card">
              <summary>Arrange seats for the next round</summary>
              {seatList}
            </details>
          </div>
        )}

        {phase === 'lobby' && (
          <div className="pad" style={{ paddingTop: 0 }}>
            <div className="card">
              <h3>Share this code</h3>
              <div className="codebox">{table.code}</div>
              <p className="tiny center" style={{ marginBottom: 0 }}>
                {players.length}/{table.config.maxPlayers} seated · boot ₹{table.config.boot} ·
                each round deals ₹{table.config.joinerPoints} · need {threshold} points to play
              </p>
            </div>

            {seatList}

            {admin ? (
              <button
                className="btn go block big"
                disabled={busy || paused || players.length < 2}
                onClick={() => act({ type: 'start', uid: username })}
              >
                {players.length < 2 ? 'Need 2+ players' : paused ? 'Table is paused' : 'Start game'}
              </button>
            ) : (
              <div className="waiting">Waiting for the admin to start…</div>
            )}
          </div>
        )}

        {roundHistory.length > 0 && (
          <div className="pad" style={{ paddingTop: 0 }}>
            <details className="card">
              <summary>Round history ({roundHistory.length})</summary>
              <div className="histlist">
                {roundHistory
                  .slice()
                  .reverse()
                  .map((r) => (
                    <div className="histitem" key={`${r.round}-${r.endedAt}`}>
                      <span className="pill">{r.round}</span>
                      <span className="grow">
                        <b>{r.winnerName ?? 'No winner'}</b> took ₹{r.pot}
                      </span>
                      <span className="tiny">
                        {r.players
                          .map((p) => `${p.username} ${p.delta > 0 ? '+' : ''}${p.delta}`)
                          .join(' · ')}
                      </span>
                    </div>
                  ))}
              </div>
            </details>

            <details className="card">
              <summary>Chaal ledger ({chaalHistory.length})</summary>
              <div className="logs">
                {chaalHistory
                  .slice()
                  .reverse()
                  .map((a) => (
                    <div className="logline" key={a.n}>
                      <b>#{a.n}</b> · {a.username} · {a.kind}
                      {a.amount ? ` ₹${a.amount}` : ''} · dabba ₹{a.pot}
                    </div>
                  ))}
              </div>
            </details>
          </div>
        )}
      </div>

      {/* action dock */}
      {phase === 'playing' && (
        <div className="dock">
          {err && <div className="error">{err}</div>}

          {paused ? (
            <div className="waiting">Paused — the admin will resume shortly.</div>
          ) : sittingOut ? (
            <div className="waiting">
              You're sitting out this round{balanceHint(username, balances, threshold)} — you play
              from the next one.
            </div>
          ) : myTurn ? (
            turnControls
          ) : (
            <div className="waiting">
              <span className="spin" />
              Waiting for{' '}
              <b>
                {g.turnUid === username
                  ? 'you'
                  : (players.find((p) => p.uid === g.turnUid)?.username ?? '')}
              </b>
              …
            </div>
          )}

          {admin && !paused && g.turnUid !== username && !sittingOut && (
            <button className="btn warn block" disabled={busy} onClick={() => setSheet('end')}>
              End round…
            </button>
          )}
        </div>
      )}

      {phase === 'roundEnded' && (
        <div className="dock">
          {err && <div className="error">{err}</div>}
          <div className="waiting" style={{ fontWeight: 800, color: 'var(--accent)', fontSize: 16 }}>
            Round stopped — name who takes the ₹{g.pot} dabba
          </div>
          {canPickWinner ? (
            <div className="pickgrid">
              {activePlayers.map((p) => (
                <button
                  key={p.uid}
                  className="btn big"
                  style={{ textAlign: 'left' }}
                  disabled={busy}
                  onClick={() => void act({ type: 'selectWinner', uid: username, winnerUid: p.uid })}
                >
                  {p.uid === username ? 'You' : p.username}
                </button>
              ))}
            </div>
          ) : (
            <div className="waiting">
              <span className="spin" />
              Waiting for {g.endedBy || table.adminUid} to pick the winner…
            </div>
          )}
        </div>
      )}

      {phase === 'countdown' && (
        <div className="dock">
          <div className="waiting" style={{ fontSize: 16, fontWeight: 800 }}>
            {paused
              ? 'Paused — the countdown is on hold.'
              : `Round starts in ${seconds}s — boot ₹${table.config.boot} each`}
          </div>
        </div>
      )}

      {phase === 'waiting' && (
        <div className="dock">
          {err && <div className="error">{err}</div>}
          <div className="waiting">
            {winner ? (
              <>
                <b>{winner.uid === username ? 'You won' : `${winner.username} won`}</b> ₹{g.lastPot}
                {' · '}next round in {paused ? 'paused' : `${seconds}s`}
              </>
            ) : (
              <>Next round in {paused ? 'paused' : `${seconds}s`}</>
            )}
          </div>
          {admin && (
            <button
              className="btn go block"
              disabled={busy || paused || players.length < 2}
              onClick={() => act({ type: 'startNow', uid: username })}
            >
              Start next round now
            </button>
          )}
        </div>
      )}

      {sheet === 'turn' && myTurn && (
        <div className="sheetbg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Your turn</h3>
            {turnControls}
            <button
              className="btn ghost block"
              style={{ marginTop: 12 }}
              onClick={() => setSheet(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}

      {sheet === 'place' && (
        <div className="sheetbg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Pick a seat</h3>
            {!pendingPlace.length ? (
              <p className="muted" style={{ marginTop: 0 }}>
                Everyone has a seat.
              </p>
            ) : (
              <div className="stack">
                {pendingPlace.map((p) => (
                  <div key={p.uid}>
                    <p className="tiny" style={{ margin: '0 0 6px' }}>
                      Choose where <b>{p.username}</b> sits.
                    </p>
                    <div className="seatgrid">
                      {Array.from({ length: table.config.maxPlayers }, (_, seat) => {
                        const occ = players.find((x) => x.seat === seat && x.uid !== p.uid)
                        return (
                          <button
                            key={seat}
                            className={occ ? 'seatcell taken' : 'seatcell'}
                            disabled={busy || !canArrange}
                            onClick={() =>
                              void act({
                                type: 'assignSeat',
                                uid: username,
                                targetUid: p.uid,
                                seat,
                              })
                            }
                          >
                            <b>{seat + 1}</b>
                            <span className="tiny">{occ ? occ.username : 'open'}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))}
                {!canArrange && (
                  <div className="notice">Seats are locked until this round ends.</div>
                )}
                <button className="btn ghost block" onClick={() => setSheet(null)}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {sheet === 'admin' && (
        <div className="sheetbg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Admin</h3>
            <div className="stack">
              <button
                className="btn block"
                disabled={busy}
                onClick={() => {
                  setSheet(null)
                  void act({ type: paused ? 'resume' : 'pause', uid: username })
                }}
              >
                {paused ? 'Resume the table' : 'Pause the table'}
              </button>
              <button className="btn block" onClick={() => setSheet('topup')}>
                Give points to a player…
              </button>
              <button
                className="btn block"
                onClick={() => {
                  setCfg(table.config)
                  setSheet('config')
                }}
              >
                Table config…
              </button>
              <button
                className="btn danger block"
                disabled={busy}
                onClick={() => setSheet('stop')}
              >
                Stop this table…
              </button>
            </div>
            <button className="btn ghost block" style={{ marginTop: 12 }} onClick={() => setSheet(null)}>
              Close
            </button>
          </div>
        </div>
      )}

      {sheet === 'stop' && (
        <div className="sheetbg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Stop this table?</h3>
            <p className="muted">
              {phase === 'playing' || phase === 'countdown'
                ? 'A round is in progress — it will be abandoned and nobody scores. Insights unlock afterwards.'
                : 'The table closes for everyone. You can still open its insights from the dashboard.'}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn grow" onClick={() => setSheet(null)}>
                Keep playing
              </button>
              <button
                className="btn danger grow"
                disabled={busy}
                onClick={() => {
                  setSheet(null)
                  void act({ type: 'close', uid: username })
                }}
              >
                Stop table
              </button>
            </div>
          </div>
        </div>
      )}

      {sheet === 'topup' && (
        <div className="sheetbg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Give points</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Adds points straight to a player's account balance. They need {threshold} to stay in a
              round. Points added mid-round apply from the next round.
            </p>
            <div className="stack">
              {players.map((p) => {
                const bal = balances[p.uid]
                const short = typeof bal === 'number' ? Math.max(0, threshold - bal) : 0
                const amount = topupAmounts[p.uid] ?? (short || 10)
                return (
                  <div className="topuprow" key={p.uid}>
                    <div className="grow">
                      <div style={{ fontWeight: 700 }}>{p.uid === username ? 'You' : p.username}</div>
                      <div className={`tiny ${typeof bal === 'number' && bal < threshold ? 'neg' : ''}`}>
                        {typeof bal === 'number' ? `${bal} points` : '—'}
                      </div>
                    </div>
                    <input
                      className="input sm"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={amount}
                      onChange={(e) =>
                        setTopupAmounts((m) => ({ ...m, [p.uid]: Math.floor(Number(e.target.value) || 0) }))
                      }
                    />
                    <button
                      className="btn go sm"
                      disabled={busy || amount < 1}
                      onClick={async () => {
                        const ok = await act({ type: 'topup', uid: username, targetUid: p.uid, amount })
                        if (ok) await loadBalances()
                      }}
                    >
                      Add
                    </button>
                  </div>
                )
              })}
            </div>
            <button className="btn ghost block" style={{ marginTop: 12 }} onClick={() => setSheet(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {sheet === 'config' && (
        <ConfigSheet
          table={table}
          cfg={cfg ?? table.config}
          setCfg={setCfg}
          onClose={() => {
            setCfg(null)
            setSheet(null)
          }}
          onSave={(c) => {
            setCfg(null)
            setSheet(null)
            void act({ type: 'config', uid: username, config: c })
          }}
        />
      )}

      {sheet === 'end' && (
        <div className="sheetbg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Stop the round?</h3>
            <p className="muted">
              Betting halts and the table moves to <b>ROUND ENDED</b>. The winner is chosen as a
              separate step, so everyone can see the pot before it moves.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn grow" onClick={() => setSheet(null)}>
                Keep playing
              </button>
              <button
                className="btn warn grow"
                disabled={busy}
                onClick={() => {
                  setSheet(null)
                  void act({ type: 'endRound', uid: username })
                }}
              >
                Stop round
              </button>
            </div>
          </div>
        </div>
      )}

      {sheet === 'show' && (
        <PickSheet
          title="Show — who won?"
          players={activePlayers}
          username={username}
          onClose={() => setSheet(null)}
          onPick={(uid) => {
            setSheet(null)
            void act({ type: 'selectWinner', uid: username, winnerUid: uid })
          }}
        />
      )}

      {sheet === 'sideshow' && sideTarget && (
        <PickSheet
          title={`Side show vs ${sideTarget.username} — who lost?`}
          players={[me, sideTarget]}
          username={username}
          onClose={() => setSheet(null)}
          onPick={(uid) => {
            setSheet(null)
            void act({ type: 'sideshow', uid: username, loserUid: uid })
          }}
        />
      )}

      {sheet === 'leave' && (
        <div className="sheetbg" onClick={() => setSheet(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h3>Leave this table?</h3>
            <p className="muted">
              {phase === 'playing' && me.status === 'active' && !paused
                ? 'You are still in the round. Fold first, then you can leave.'
                : 'Your seat will be freed for someone else. Your history stays saved.'}
            </p>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn grow" onClick={() => setSheet(null)}>
                Stay
              </button>
              <button
                className="btn danger grow"
                disabled={busy}
                onClick={() => {
                  setSheet(null)
                  void act({ type: 'leave', uid: username })
                }}
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      {celebrate && winner && (
        <div className="celebrate" key={celebrateAt} role="status" onClick={() => setCelebrate(false)}>
          <svg className="trophy" viewBox="0 0 24 24" width="72" height="72" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19 4h-3V2H8v2H5c-1.1 0-2 .9-2 2v2c0 2.42 1.87 4.42 4.25 4.9.54 1.54 1.77 2.77 3.31 3.3V19H7v2h10v-2h-4v-2.8c1.54-.53 2.77-1.76 3.31-3.3C19.13 12.42 21 10.42 21 8V6c0-1.1-.9-2-2-2zM5 8V6h2v3.82C5.84 9.4 5 8.76 5 8zm14 0c0 .76-.84 1.4-2 1.82V6h2v2z"
            />
          </svg>
          <div className="cname">{winner.uid === username ? 'You win' : `${winner.username} wins`}</div>
          <div className="camt">+₹{g.lastPot}</div>
          {lastRound && (
            <div className="csum">
              {lastRound.players.map((p) => (
                <span key={p.uid} className={p.delta > 0 ? 'pos' : p.delta < 0 ? 'neg' : ''}>
                  {p.uid === username ? 'You' : p.username} {p.delta > 0 ? '+' : ''}₹{p.delta}
                </span>
              ))}
            </div>
          )}
          <span className="ctap">Round {lastRound ? lastRound.round : g.round} · tap to dismiss</span>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function balanceHint(uid: string, balances: Record<string, number>, threshold: number) {
  const bal = balances[uid]
  if (typeof bal !== 'number' || bal >= threshold) return ''
  return ` (you have ${bal}, need ${threshold})`
}

function PickSheet({
  title,
  players,
  username,
  onClose,
  onPick,
}: {
  title: string
  players: Player[]
  username: string
  onClose: () => void
  onPick: (uid: string) => void
}) {
  return (
    <div className="sheetbg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="pickgrid">
          {players.map((p) => (
            <button
              key={p.uid}
              className="btn big"
              onClick={() => onPick(p.uid)}
              style={{ textAlign: 'left' }}
            >
              {p.uid === username ? 'You' : p.username}
            </button>
          ))}
        </div>
        <button className="btn ghost block" style={{ marginTop: 12 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function ConfigSheet({
  table,
  cfg,
  setCfg,
  onClose,
  onSave,
}: {
  table: TableDoc
  cfg: TableConfig
  setCfg: (c: TableConfig | null) => void
  onClose: () => void
  onSave: (c: Partial<TableConfig>) => void
}) {
  const val = cfg
  const upd = (patch: Partial<TableConfig>) => setCfg({ ...val, ...patch })
  const num = (k: keyof TableConfig, label: string, minV = 0) => (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        type="number"
        inputMode="numeric"
        min={minV}
        value={String(val[k])}
        onChange={(e) => upd({ [k]: Number(e.target.value) } as Partial<TableConfig>)}
      />
    </div>
  )

  return (
    <div className="sheetbg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Table config</h3>
        <div className="cfggrid">
          {num('joinerPoints', 'Starting amount per round', 1)}
          {num('boot', 'Boot / dabba', 0)}
          {num('baseUnit', 'Base point', 1)}
          {num('doubleEveryRounds', 'Double every N rounds', 1)}
          {num('forcedSeenRounds', 'Blind closes after N rounds', 1)}
          {num('maxPlayers', 'Max players', 2)}

          <div className="field">
            <label>Side show</label>
            <select
              className="input"
              value={val.sideshow ? 'on' : 'off'}
              onChange={(e) => upd({ sideshow: e.target.value === 'on' })}
            >
              <option value="on">Allowed (3+ players)</option>
              <option value="off">Disabled</option>
            </select>
          </div>

          <div className="field">
            <label>Show chips to</label>
            <select
              className="input"
              value={val.chipVisibility}
              onChange={(e) => upd({ chipVisibility: e.target.value as TableConfig['chipVisibility'] })}
            >
              <option value="admin">Admin only</option>
              <option value="all">Everyone</option>
            </select>
          </div>

          <div className="field">
            <label>Show config to</label>
            <select
              className="input"
              value={val.configVisibility}
              onChange={(e) => upd({ configVisibility: e.target.value as Visibility })}
            >
              <option value="admin">Admin only</option>
              <option value="all">Everyone</option>
            </select>
          </div>
        </div>

        <p className="tiny" style={{ marginTop: 12 }}>
          Every round hands ₹{val.joinerPoints} to each eligible player and ₹{val.boot} of that goes
          to the dabba. A player needs at least {minBalanceToPlay(val)} to stay in. After{' '}
          {val.forcedSeenRounds} betting round{val.forcedSeenRounds === 1 ? '' : 's'} nobody may stay
          blind — everyone still hidden is flipped to SEEN. Changing config restarts the 10-second
          wait.
        </p>

        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn grow" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary grow"
            onClick={() => {
              const changed: Partial<TableConfig> = {}
              for (const k of Object.keys(val) as (keyof TableConfig)[]) {
                if (val[k] !== table.config[k]) (changed as Record<string, unknown>)[k] = val[k]
              }
              onSave(Object.keys(changed).length ? changed : val)
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
