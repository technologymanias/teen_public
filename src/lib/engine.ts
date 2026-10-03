import {
  ACTION_HISTORY_LIMIT,
  BLIND_TURN_LIMIT,
  CLOCK_SKEW_MS,
  DEFAULT_CONFIG,
  ROUND_HISTORY_LIMIT,
  START_DELAY_MS,
  WAIT_DELAY_MS,
  minBalanceToPlay,
  type Action,
  type ChaalKind,
  type ChaalRecord,
  type GameState,
  type HistoryResult,
  type Player,
  type RoundRecord,
  type TableConfig,
  type TableDoc,
} from './types'

export interface SettlePlayer {
  uid: string
  username: string
  delta: number
  result: HistoryResult
  buyIn: number
}

export type SideEffect =
  | { type: 'grant'; entries: { username: string; amount: number; creditBalance: boolean }[] }
  | {
      type: 'settle'
      tableCode: string
      tableName: string
      pot: number
      round: number
      players: SettlePlayer[]
    }

export function newGame(baseUnit: number): GameState {
  return {
    phase: 'lobby',
    paused: false,
    pausedAt: null,
    pot: 0,
    lastPot: 0,
    unit: baseUnit,
    lastBet: null,
    lastBetSeen: null,
    lastBetBy: null,
    betSeq: 0,
    turnUid: null,
    roundFirstUid: null,
    round: 1,
    turnsInRound: 0,
    winnerUid: null,
    countdownEndsAt: null,
    waitEndsAt: null,
    roundStartedAt: 0,
    endedBy: null,
    notice: null,
    pending: null,
    log: [],
  }
}

export function makeTable(
  code: string,
  name: string,
  creator: string,
  config: TableConfig = DEFAULT_CONFIG
): TableDoc {
  return {
    code,
    name,
    createdAt: Date.now(),
    createdBy: creator,
    adminUid: creator,
    memberUids: [creator],
    config,
    players: [
      {
        uid: creator,
        username: creator,
        seat: 0,
        chips: 0,
        buyIn: 0,
        seen: false,
        blindTurns: 0,
        status: 'active',
        isAdmin: true,
        joinedAt: Date.now(),
      },
    ],
    game: newGame(config.baseUnit),
    rounds: 0,
    stats: [],
    roundHistory: [],
    actionHistory: [],
    actionSeq: 0,
    closedAt: null,
  }
}

export function seated(table: TableDoc): Player[] {
  return table.players
    .filter((p) => p.status !== 'left')
    .slice()
    .sort((a, b) => a.seat - b.seat)
}

export function active(table: TableDoc): Player[] {
  return seated(table).filter((p) => p.status === 'active')
}

export function byUid(table: TableDoc, uid: string): Player | undefined {
  return table.players.find((p) => p.uid === uid && p.status !== 'left')
}

export function isAdmin(table: TableDoc, uid: string): boolean {
  return table.adminUid === uid
}

export function inWaitingRoom(table: TableDoc): boolean {
  return table.game.phase === 'lobby' || table.game.phase === 'waiting'
}

export function isClosed(table: TableDoc): boolean {
  return table.game.phase === 'closed'
}

/**
 * Minimum legal bet for a player, honouring:
 *  - seen players must put in 2x a blind player's bet
 *  - blind players put in half of a seen player's bet
 *  - the current point level (unit) never decreases and doubles every 3 rounds
 */
export function minBetFor(table: TableDoc, player: Player): number {
  const { unit, lastBet, lastBetSeen } = table.game
  if (lastBet == null) return player.seen ? unit * 2 : unit
  let value: number
  if (player.seen === lastBetSeen) value = lastBet
  else if (player.seen) value = lastBet * 2
  else value = Math.ceil(lastBet / 2)
  return Math.max(value, unit)
}

export function canAct(table: TableDoc, uid: string): boolean {
  const g = table.game
  if (g.paused || g.phase !== 'playing' || g.turnUid !== uid) return false
  // A pending show freezes everyone until the other player answers it.
  if (g.pending) return false
  const p = byUid(table, uid)
  return !!p && p.status === 'active'
}

/** The player a side show can be requested from: nearest active player before `uid`. */
export function sideShowTarget(table: TableDoc, uid: string): Player | null {
  const order = seated(table).filter((p) => p.status === 'active')
  const idx = order.findIndex((p) => p.uid === uid)
  if (idx < 0 || order.length < 3) return null
  const prev = order[(idx - 1 + order.length) % order.length]
  return prev && prev.uid !== uid ? prev : null
}

function log(g: GameState, text: string) {
  g.log = [...g.log, { at: Date.now(), text }].slice(-60)
}

/** Appends one line to the table's per-chaal ledger (§41), keeping it bounded. */
function pushChaal(table: TableDoc, kind: ChaalKind, uid: string, username: string, amount: number) {
  const seq = (table.actionSeq || 0) + 1
  table.actionSeq = seq
  const rec: ChaalRecord = {
    n: seq,
    round: table.game.round,
    at: Date.now(),
    uid,
    username,
    kind,
    amount,
    pot: table.game.pot,
  }
  table.actionHistory = [...(table.actionHistory || []), rec].slice(-ACTION_HISTORY_LIMIT)
}

/**
 * §20 — once `forcedSeenRounds` full betting rounds have gone by, blind play is
 * no longer allowed at this table and everyone still hidden is flipped over.
 */
function forceAllSeen(table: TableDoc, completedBettingRounds: number) {
  const need = table.config.forcedSeenRounds || DEFAULT_CONFIG.forcedSeenRounds
  if (completedBettingRounds < need) return
  const blinds = active(table).filter((p) => !p.seen)
  if (!blinds.length) return
  table.players = table.players.map((p) =>
    p.status === 'active' && !p.seen ? { ...p, seen: true, blindTurns: p.blindTurns || 0 } : p
  )
  table.game.notice = 'ALL PLAYERS ARE NOW SEEN'
  log(
    table.game,
    `All players are now seen — blind play closed after ${completedBettingRounds} betting rounds.`
  )
}

function nextFreeSeat(table: TableDoc): number {
  const taken = new Set(seated(table).map((p) => p.seat))
  let seat = 0
  while (taken.has(seat)) seat++
  return seat
}

function advance(table: TableDoc, countRound: boolean) {
  const g = table.game
  const order = seated(table)
  if (order.length === 0) return
  const idx = order.findIndex((p) => p.uid === g.turnUid)
  if (idx < 0) {
    const first = order.find((p) => p.status === 'active')
    g.turnUid = first ? first.uid : null
    return
  }
  let nextUid: string | null = null
  for (let i = 1; i <= order.length; i++) {
    const j = (idx + i) % order.length
    if (order[j].status === 'active') {
      nextUid = order[j].uid
      break
    }
  }
  g.turnUid = nextUid

  if (!countRound || !nextUid) return
  g.turnsInRound++
  const starter = g.roundFirstUid
  if (!starter) {
    g.roundFirstUid = nextUid
    return
  }
  const starterPlayer = byUid(table, starter)
  if (!starterPlayer || starterPlayer.status !== 'active') {
    g.roundFirstUid = nextUid
    return
  }
  if (nextUid === starter) {
    g.round++
    g.turnsInRound = 0
    g.roundFirstUid = nextUid
    const done = g.round - 1
    if (done > 0 && done % table.config.doubleEveryRounds === 0) {
      g.unit *= 2
      log(g, `Point level doubled to ${g.unit} after ${done} rounds.`)
    }
    forceAllSeen(table, done)
  }
}

function checkForcedEnd(table: TableDoc, effects: SideEffect[]): boolean {
  const g = table.game
  if (g.phase !== 'playing') return false
  const act = active(table)
  if (act.length > 1) return false
  if (act.length === 1) settleInternal(table, act[0].uid, effects)
  else log(g, 'No players left in the round.')
  return true
}

function tally(table: TableDoc, rows: SettlePlayer[]) {
  for (const row of rows) {
    let s = table.stats.find((x) => x.username === row.username)
    if (!s) {
      s = { username: row.username, gamesPlayed: 0, gamesWon: 0, gamesLost: 0, totalWon: 0, totalLost: 0 }
      table.stats.push(s)
    }
    s.gamesPlayed++
    if (row.delta > 0) {
      s.gamesWon++
      s.totalWon += row.delta
    } else if (row.delta < 0) {
      s.gamesLost++
      s.totalLost += -row.delta
    }
  }
}

function settleInternal(table: TableDoc, winnerUid: string | null, effects: SideEffect[]) {
  const g = table.game
  if (winnerUid) {
    const winner = table.players.find((p) => p.uid === winnerUid && p.status !== 'left')
    if (winner) winner.chips += g.pot
  }
  g.lastPot = g.pot
  g.pot = 0
  g.winnerUid = winnerUid
  g.turnUid = null
  g.endedBy = null
  g.notice = null
  g.pending = null

  const scored = table.players.filter((p) => p.buyIn > 0)
  const rows: SettlePlayer[] = scored.map((p) => {
    const delta = p.chips - p.buyIn
    let result: HistoryResult
    if (p.uid === winnerUid) result = 'won'
    else if (p.chips <= 0) result = 'busted'
    else if (p.status === 'folded' || p.status === 'left') result = 'folded'
    else result = 'lost'
    return { uid: p.uid, username: p.username, delta, result, buyIn: p.buyIn }
  })

  const winnerRow = winnerUid ? rows.find((r) => r.uid === winnerUid) : undefined
  const record: RoundRecord = {
    round: table.rounds + 1,
    startedAt: g.roundStartedAt,
    endedAt: Date.now(),
    pot: g.lastPot,
    winnerUid,
    winnerName: winnerRow ? winnerRow.username : null,
    players: rows.map((r) => {
      const p = table.players.find((x) => x.uid === r.uid)!
      return {
        uid: p.uid,
        username: p.username,
        seat: p.seat,
        blindTurns: p.blindTurns || 0,
        folded: p.status === 'folded' || p.status === 'left',
        delta: r.delta,
        chips: p.chips,
      }
    }),
  }
  table.roundHistory = [...(table.roundHistory || []), record].slice(-ROUND_HISTORY_LIMIT)

  effects.push({
    type: 'settle',
    tableCode: table.code,
    tableName: table.name,
    pot: g.lastPot,
    round: g.round,
    players: rows,
  })
  tally(table, rows)
  table.rounds++

  table.players = table.players.map((pl) => ({ ...pl, chips: 0, buyIn: 0, blindTurns: 0 }))
  const w = winnerUid ? table.players.find((p) => p.uid === winnerUid) : null
  log(g, w ? `${w.username} wins ${g.lastPot} points.` : 'Round ended.')

  g.phase = 'waiting'
  g.waitEndsAt = Date.now() + WAIT_DELAY_MS
  g.countdownEndsAt = null
}

function beginCountdown(table: TableDoc) {
  const g = table.game
  g.phase = 'countdown'
  g.countdownEndsAt = Date.now() + START_DELAY_MS
  g.waitEndsAt = null
  log(g, `Next round starting in ${Math.round(START_DELAY_MS / 1000)}…`)
}

function tooEarly(endsAt: number | null): boolean {
  if (!endsAt) return true
  return Date.now() + CLOCK_SKEW_MS < endsAt
}

/** Actions an admin may still run while the table is paused. */
const PAUSE_SAFE: ReadonlySet<Action['type']> = new Set([
  'pause',
  'resume',
  'close',
  'topup',
  'join',
  'propose',
  'resolve',
])

export function applyAction(
  input: TableDoc,
  action: Action,
  balances?: Record<string, number>
): { table: TableDoc; effects: SideEffect[]; error?: string } {
  const table: TableDoc = {
    ...input,
    // Merge over the defaults so documents written before a field existed still work.
    config: { ...DEFAULT_CONFIG, ...input.config },
    players: input.players.map((p) => ({ ...p, blindTurns: p.blindTurns || 0 })),
    game: {
      ...input.game,
      roundStartedAt: input.game.roundStartedAt || 0,
      endedBy: input.game.endedBy ?? null,
      notice: input.game.notice ?? null,
      pending: input.game.pending ?? null,
      log: [...input.game.log],
    },
    stats: input.stats.map((s) => ({ ...s })),
    roundHistory: (input.roundHistory || []).map((r) => ({ ...r, players: [...r.players] })),
    actionHistory: input.actionHistory ? [...input.actionHistory] : [],
    actionSeq: input.actionSeq || 0,
  }
  const effects: SideEffect[] = []
  const g = table.game
  const fail = (error: string) => ({ table: input, effects: [], error })

  if (g.phase === 'closed' && action.type !== 'close')
    return fail('This table has been closed.')
  if (g.paused && !PAUSE_SAFE.has(action.type))
    return fail('The table is paused by the admin.')

  /** A seated player only takes a seat in the next round if they can cover it. */
  const threshold = minBalanceToPlay(table.config)
  const canCover = (p: Player): boolean => {
    const bal = balances?.[p.uid]
    return bal === undefined || bal >= threshold
  }

  switch (action.type) {
    case 'join': {
      if (byUid(table, action.uid)) return fail('You are already seated.')
      const seatedCount = seated(table).length
      if (seatedCount >= table.config.maxPlayers)
        return fail(`Table is full (${table.config.maxPlayers}).`)
      const midRound = g.phase === 'playing'
      const player: Player = {
        uid: action.uid,
        username: action.username,
        seat: nextFreeSeat(table),
        chips: 0,
        buyIn: 0,
        seen: false,
        blindTurns: 0,
        status: midRound ? 'sittingOut' : 'active',
        isAdmin: false,
        joinedAt: Date.now(),
      }
      // Written only when true — Firestore rejects `undefined` field values.
      if (g.phase !== 'lobby') player.mustPlace = true
      table.players.push(player)
      if (!table.memberUids.includes(action.uid)) table.memberUids = [...table.memberUids, action.uid]
      log(
        g,
        midRound
          ? `${action.username} joined — they start next round.`
          : `${action.username} joined the table.`
      )
      return { table, effects }
    }

    case 'leave': {
      const p = byUid(table, action.uid)
      if (!p) return fail('Not at this table.')
      if (g.phase === 'playing' && p.status === 'active')
        return fail('Fold first before leaving the round.')
      table.players = table.players.map((x) =>
        x.uid === action.uid ? { ...x, status: 'left' as const } : x
      )
      log(g, `${p.username} left the table.`)
      if (table.adminUid === action.uid) {
        const next = seated(table).find((x) => x.uid !== action.uid)
        if (next) {
          table.adminUid = next.uid
          table.players = table.players.map((x) =>
            x.uid === next.uid ? { ...x, isAdmin: true } : { ...x, isAdmin: false })
          log(g, `${next.username} is now the table admin.`)
        }
      }
      if (g.phase === 'playing') checkForcedEnd(table, effects)
      return { table, effects }
    }

    case 'config': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can change config.')
      if (g.phase === 'playing' || g.phase === 'countdown')
        return fail('Config is locked during a round.')
      const allowed: (keyof TableConfig)[] = [
        'boot', 'joinerPoints', 'baseUnit', 'doubleEveryRounds', 'forcedSeenRounds',
        'sideshow', 'chipVisibility', 'configVisibility', 'maxPlayers',
      ]
      for (const k of allowed) {
        const v = action.config[k]
        if (v !== undefined) (table.config as unknown as Record<string, unknown>)[k] = v
      }
      const c = table.config
      c.boot = Math.max(0, Math.floor(c.boot))
      c.baseUnit = Math.max(1, Math.floor(c.baseUnit))
      c.doubleEveryRounds = Math.max(1, Math.floor(c.doubleEveryRounds))
      c.forcedSeenRounds = Math.max(1, Math.floor(c.forcedSeenRounds))
      c.maxPlayers = Math.max(2, Math.min(20, Math.floor(c.maxPlayers)))
      c.joinerPoints = Math.max(minBalanceToPlay(c), Math.floor(c.joinerPoints) || 1)
      if (seated(table).length > c.maxPlayers) c.maxPlayers = seated(table).length
      if (g.phase === 'waiting' && g.waitEndsAt) {
        g.waitEndsAt = Date.now() + WAIT_DELAY_MS
        log(g, 'Config changed — wait time restarted.')
      }
      return { table, effects }
    }

    case 'kick': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can remove players.')
      if (action.targetUid === action.uid) return fail('You cannot kick yourself.')
      if (!inWaitingRoom(table)) return fail('Cannot remove players during a round.')
      const t = byUid(table, action.targetUid)
      if (!t) return fail('Player not found.')
      table.players = table.players.map((x) =>
        x.uid === action.targetUid ? { ...x, status: 'left' as const } : x)
      log(g, `${t.username} was removed by the admin.`)
      return { table, effects }
    }

    case 'reseat': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can arrange seats.')
      if (!inWaitingRoom(table)) return fail('Seats can only be arranged before a round starts.')
      const order = seated(table)
      const i = order.findIndex((p) => p.uid === action.targetUid)
      if (i < 0) return fail('Player not found.')
      const j = i + action.dir
      if (j < 0 || j >= order.length) return { table, effects }
      const a = order[i]
      const b = order[j]
      table.players = table.players.map((p) =>
        p.uid === a.uid ? { ...p, seat: b.seat } : p.uid === b.uid ? { ...p, seat: a.seat } : p
      )
      log(g, `${a.username} and ${b.username} swapped seats.`)
      return { table, effects }
    }

    case 'assignSeat': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can place players.')
      if (!inWaitingRoom(table)) return fail('Seats are locked while a round is in progress.')
      const order = seated(table)
      const target = order.find((p) => p.uid === action.targetUid)
      if (!target) return fail('Player not found.')
      const wanted = Math.floor(action.seat)
      if (!Number.isFinite(wanted) || wanted < 0 || wanted >= table.config.maxPlayers)
        return fail('Choose an open seat.')
      const occupant = order.find((p) => p.uid !== target.uid && p.seat === wanted)
      table.players = table.players.map((p) => {
        if (p.uid === target.uid) return { ...p, seat: wanted, mustPlace: false }
        if (occupant && p.uid === occupant.uid) return { ...p, seat: target.seat }
        return p
      })
      log(g, occupant
        ? `${target.username} placed at seat ${wanted + 1} — swapped with ${occupant.username}.`
        : `${target.username} placed at seat ${wanted + 1}.`)
      return { table, effects }
    }

    case 'topup': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can hand out points.')
      const amount = Math.floor(action.amount)
      if (!Number.isFinite(amount) || amount < 1) return fail('Enter an amount of at least 1.')
      const t = byUid(table, action.targetUid)
      if (!t) return fail('That player is not at this table.')
      effects.push({
        type: 'grant',
        entries: [{ username: t.username, amount, creditBalance: true }],
      })
      log(g, `Admin added ${amount} points to ${t.username}.`)
      return { table, effects }
    }

    case 'propose': {
      const caller = byUid(table, action.uid)
      if (!caller) return fail('Not at this table.')
      if (g.pending) return fail('A result is already waiting to be confirmed.')
      if (g.phase !== 'playing') return fail('No round in progress.')
      if (!canAct(table, action.uid)) return fail('Not your turn.')
      const result = byUid(table, action.resultUid)
      if (!result || result.status !== 'active') return fail('Pick an active player.')

      let targetUid: string
      if (action.kind === 'show') {
        const inPlay = active(table)
        if (inPlay.length !== 2) return fail('A show only has two players left.')
        const other = inPlay.find((x) => x.uid !== action.uid)
        if (!other) return fail('Nobody to show against.')
        if (action.targetUid !== other.uid) return fail('You can only show against the other player.')
        if (result.uid !== action.uid && result.uid !== other.uid)
          return fail('Pick one of the two players.')
        targetUid = other.uid
      } else {
        if (!table.config.sideshow) return fail('Side show is disabled at this table.')
        const inPlay = active(table)
        if (inPlay.length < 3) return fail('Side show needs 3 or more players.')
        const target = sideShowTarget(table, action.uid)
        if (!target) return fail('No valid side show target.')
        if (action.targetUid !== target.uid)
          return fail('You can only side show with the previous player.')
        if (result.uid !== action.uid && result.uid !== target.uid)
          return fail('Pick one of the two players.')
        targetUid = target.uid
      }

      const target = byUid(table, targetUid)!
      g.pending = {
        kind: action.kind,
        by: action.uid,
        byName: caller.username,
        target: targetUid,
        targetName: target.username,
        resultUid: result.uid,
        resultName: result.username,
        at: Date.now(),
      }
      log(
        g,
        action.kind === 'show'
          ? `${caller.username} called a show — waiting on ${target.username}.`
          : `${caller.username} asked ${target.username} for a side show.`
      )
      return { table, effects }
    }

    case 'resolve': {
      const pending = g.pending
      if (!pending) return fail('There is nothing waiting to be confirmed.')
      const fromTarget = action.uid === pending.target
      const fromCaller = action.uid === pending.by
      if (!fromTarget && !fromCaller) return fail('You are not part of this.')
      // Only the player on the receiving end may accept; the caller may withdraw.
      if (fromCaller && action.accept) return fail('Only the other player can accept this.')

      if (!action.accept) {
        g.pending = null
        log(
          g,
          fromCaller
            ? `${pending.byName} withdrew the ${pending.kind === 'show' ? 'show' : 'side show'}.`
            : `${pending.targetName} declined the ${pending.kind === 'show' ? 'show' : 'side show'}.`
        )
        return { table, effects }
      }

      const inner: Action =
        pending.kind === 'show'
          ? { type: 'selectWinner', uid: pending.by, winnerUid: pending.resultUid }
          : { type: 'sideshow', uid: pending.by, loserUid: pending.resultUid }
      // Drop the hold first — `canAct` refuses to act while one is up.
      const res = applyAction(
        { ...table, game: { ...table.game, pending: null } },
        inner,
        balances
      )
      // Keep the offer up if the settlement itself could not go through.
      if (res.error) return { table, effects: [], error: res.error }
      return res
    }

    case 'pause': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can pause the table.')
      if (g.phase === 'roundEnded') return fail('Pick a winner before pausing the table.')
      if (g.paused) return fail('Already paused.')
      g.paused = true
      g.pausedAt = Date.now()
      log(g, 'Admin paused the table.')
      return { table, effects }
    }

    case 'resume': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can resume the table.')
      if (!g.paused) return fail('The table is not paused.')
      const pausedFor = g.pausedAt ? Math.max(0, Date.now() - g.pausedAt) : 0
      if (g.countdownEndsAt) g.countdownEndsAt += pausedFor
      if (g.waitEndsAt) g.waitEndsAt += pausedFor
      g.paused = false
      g.pausedAt = null
      log(g, 'Admin resumed the table.')
      return { table, effects }
    }

    case 'close': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can stop the table.')
      if (g.phase === 'closed') return fail('Already closed.')
      const abandoned =
        g.phase === 'playing' || g.phase === 'countdown' || g.phase === 'roundEnded'
      g.phase = 'closed'
      g.paused = false
      g.pausedAt = null
      g.pot = 0
      g.turnUid = null
      g.countdownEndsAt = null
      g.waitEndsAt = null
      g.pending = null
      table.players = table.players.map((p) => ({ ...p, chips: 0, buyIn: 0 }))
      table.closedAt = Date.now()
      log(g, abandoned ? 'Admin stopped the table — the round was abandoned.' : 'Admin stopped the table.')
      return { table, effects }
    }

    case 'start': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can start the game.')
      if (g.phase !== 'lobby') return fail('A round is already lined up.')
      if (seated(table).length < 2) return fail('Need at least 2 players.')
      beginCountdown(table)
      return { table, effects }
    }

    case 'startNow': {
      if (!isAdmin(table, action.uid)) return fail('Only the admin can start the round.')
      if (g.phase !== 'waiting') return fail('No round is waiting to start.')
      if (seated(table).length < 2) return fail('Need at least 2 players.')
      beginCountdown(table)
      return { table, effects }
    }

    case 'autoStart': {
      if (g.phase !== 'waiting') return fail('Not waiting on a round.')
      if (tooEarly(g.waitEndsAt)) return fail('Too early.')
      if (seated(table).length < 2) {
        g.phase = 'lobby'
        g.waitEndsAt = null
        log(g, 'Not enough players — waiting for the admin to start.')
        return { table, effects }
      }
      beginCountdown(table)
      return { table, effects }
    }

    case 'beginRound': {
      if (g.phase !== 'countdown') return fail('No round is counting down.')
      if (tooEarly(g.countdownEndsAt)) return fail('Too early.')
      const seatedPlayers = seated(table)
      if (seatedPlayers.length < 2) {
        g.phase = 'lobby'
        g.countdownEndsAt = null
        log(g, 'Not enough players — round cancelled.')
        return { table, effects }
      }

      const eligible = seatedPlayers.filter(canCover)
      const short = seatedPlayers.filter((p) => !canCover(p))
      if (eligible.length < 2) {
        g.phase = 'lobby'
        g.countdownEndsAt = null
        log(g, 'Not enough players with points — round cancelled.')
        return { table, effects }
      }

      const cfg = table.config
      effects.push({
        type: 'grant',
        entries: eligible.map((p) => ({
          username: p.username,
          amount: cfg.joinerPoints,
          creditBalance: false,
        })),
      })

      let pot = 0
      const boots: { uid: string; username: string; amount: number }[] = []
      table.players = table.players.map((p) => {
        if (p.status === 'left') return p
        if (short.includes(p))
          return {
            ...p,
            chips: 0,
            buyIn: 0,
            seen: false,
            blindTurns: 0,
            status: 'sittingOut' as const,
            isAdmin: p.uid === table.adminUid,
          }
        const pay = Math.min(cfg.boot, cfg.joinerPoints)
        pot += pay
        boots.push({ uid: p.uid, username: p.username, amount: pay })
        return {
          ...p,
          chips: cfg.joinerPoints - pay,
          buyIn: cfg.joinerPoints,
          seen: false,
          blindTurns: 0,
          status: 'active' as const,
          isAdmin: p.uid === table.adminUid,
        }
      })
      for (const p of short) log(g, `${p.username} is low on points — sitting out this round.`)

      g.phase = 'playing'
      g.pot = pot
      g.unit = cfg.baseUnit
      g.lastBet = null
      g.lastBetSeen = null
      g.lastBetBy = null
      g.betSeq = 0
      g.round = 1
      g.turnsInRound = 0
      g.winnerUid = null
      g.lastPot = 0
      g.countdownEndsAt = null
      g.waitEndsAt = null
      g.roundStartedAt = Date.now()
      g.endedBy = null
      g.notice = null
      g.pending = null
      for (const b of boots) pushChaal(table, 'boot', b.uid, b.username, b.amount)
      const first = seated(table).find((p) => p.status === 'active')
      g.turnUid = first ? first.uid : null
      g.roundFirstUid = g.turnUid
      log(g, `Round started. Boot ${cfg.boot} each — pot ${g.pot}.`)
      return { table, effects }
    }

    case 'setSeen': {
      if (!canAct(table, action.uid)) return fail('Not your turn.')
      const p = byUid(table, action.uid)!
      if (p.seen && !action.seen) return fail('You cannot go back to hidden.')
      table.players = table.players.map((x) =>
        x.uid === action.uid ? { ...x, seen: action.seen, blindTurns: action.seen ? 0 : x.blindTurns } : x)
      if (action.seen) {
        log(g, `${p.username} saw their cards.`)
        pushChaal(table, 'saw', p.uid, p.username, 0)
      }
      return { table, effects }
    }

    case 'bet': {
      if (!canAct(table, action.uid)) return fail('Not your turn.')
      const p = byUid(table, action.uid)!
      const min = minBetFor(table, p)
      const amount = Math.floor(action.amount)
      if (!Number.isFinite(amount) || amount < min) return fail(`Minimum bet is ${min}.`)
      if (amount > p.chips) return fail('You do not have that many points.')
      const wasBlind = !p.seen
      const blindTurns = wasBlind ? (p.blindTurns || 0) + 1 : p.blindTurns || 0
      table.players = table.players.map((x) =>
        x.uid === action.uid ? { ...x, chips: x.chips - amount, blindTurns } : x)
      g.pot += amount
      g.lastBet = amount
      g.lastBetSeen = p.seen
      g.lastBetBy = p.uid
      g.betSeq++
      log(g, `${p.username} ${p.seen ? '(seen)' : '(blind)'} put in ${amount}.`)
      pushChaal(table, wasBlind ? 'blind' : 'seen', p.uid, p.username, amount)

      // §18 — the third blind chaal flips this player over automatically.
      if (wasBlind && blindTurns >= BLIND_TURN_LIMIT) {
        table.players = table.players.map((x) =>
          x.uid === action.uid ? { ...x, seen: true } : x)
        log(g, `${p.username} has played blind ${blindTurns} times — now SEEN.`)
      }

      advance(table, true)
      return { table, effects }
    }

    case 'fold': {
      if (!canAct(table, action.uid)) return fail('Not your turn.')
      const p = byUid(table, action.uid)!
      table.players = table.players.map((x) =>
        x.uid === action.uid ? { ...x, status: 'folded' as const } : x)
      log(g, `${p.username} left the game.`)
      pushChaal(table, 'fold', p.uid, p.username, 0)
      if (!checkForcedEnd(table, effects)) advance(table, true)
      return { table, effects }
    }

    case 'sideshow': {
      if (!table.config.sideshow) return fail('Side show is disabled at this table.')
      if (!canAct(table, action.uid)) return fail('Not your turn.')
      const act = active(table)
      if (act.length < 3) return fail('Side show needs 3 or more players.')
      const target = sideShowTarget(table, action.uid)
      if (!target) return fail('No valid side show target.')
      if (action.loserUid !== action.uid && action.loserUid !== target.uid)
        return fail('You can only side show with the previous player.')
      const p = byUid(table, action.uid)!
      const loser = byUid(table, action.loserUid)
      if (!loser || loser.status !== 'active') return fail('That player is out.')
      table.players = table.players.map((x) =>
        x.uid === action.loserUid ? { ...x, status: 'folded' as const } : x)
      log(g, `${p.username} side showed ${loser.username} — ${loser.username} is out.`)
      pushChaal(table, 'sideshow', p.uid, p.username, 0)
      if (!checkForcedEnd(table, effects)) advance(table, true)
      return { table, effects }
    }

    case 'endRound': {
      if (g.phase === 'roundEnded') return fail('The round has already been stopped.')
      if (g.phase !== 'playing') return fail('No round in progress.')
      const p = byUid(table, action.uid)
      if (!p) return fail('Not at this table.')
      const isTurn = g.turnUid === action.uid
      const stillIn = active(table)
      if (!stillIn.length) return fail('Nobody is left in the round.')
      if (stillIn.length === 1) {
        settleInternal(table, stillIn[0].uid, effects)
        return { table, effects }
      }
      if (!isAdmin(table, action.uid) && !(isTurn && stillIn.length === 2))
        return fail('Only the admin can end the round.')
      g.phase = 'roundEnded'
      g.endedBy = action.uid
      g.turnUid = null
      g.pending = null
      log(g, `${p.username} stopped the round — the winner is still to be picked.`)
      return { table, effects }
    }

    case 'selectWinner': {
      const winner = byUid(table, action.winnerUid)
      if (!winner || winner.status !== 'active') return fail('Pick an active player.')
      if (g.phase === 'roundEnded') {
        if (!isAdmin(table, action.uid) && g.endedBy !== action.uid)
          return fail('Only the admin can pick the winner.')
        settleInternal(table, winner.uid, effects)
        return { table, effects }
      }
      if (g.phase === 'playing') {
        // Heads-up "Show": the player on turn reveals and names the winner.
        if (active(table).length !== 2) return fail('A show is only possible with two players left.')
        if (!canAct(table, action.uid)) return fail('Not your turn.')
        settleInternal(table, winner.uid, effects)
        return { table, effects }
      }
      return fail('No round is waiting for a winner.')
    }
  }

  return fail('Unknown action.')
}

export function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}
