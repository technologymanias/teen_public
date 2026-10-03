import {
  applyAction,
  makeTable,
  minBetFor,
  byUid,
  active,
  seated,
} from '../src/lib/engine'
import {
  ACTION_HISTORY_LIMIT,
  DEFAULT_CONFIG,
  ROUND_HISTORY_LIMIT,
  START_DELAY_MS,
  WAIT_DELAY_MS,
  minBalanceToPlay,
  tableStatus,
  type Action,
  type TableDoc,
} from '../src/lib/types'

let fails = 0
function ok(cond: boolean, msg: string) {
  if (!cond) {
    fails++
    console.log('FAIL:', msg)
  } else console.log('ok  :', msg)
}

// A fake clock so timer-driven rules can be exercised without sleeping.
const realNow = Date.now.bind(Date)
let offset = 0
Date.now = () => realNow() + offset
const tick = (ms: number) => {
  offset += ms
}

function run(t: TableDoc, ...actions: Action[]): TableDoc {
  for (const a of actions) {
    const r = applyAction(t, a)
    if (r.error) throw new Error(`${a.type}: ${r.error}`)
    t = r.table
  }
  return t
}

function startRound(t: TableDoc, uid: string, balances?: Record<string, number>): TableDoc {
  tick(START_DELAY_MS + 10)
  const r = applyAction(t, { type: 'beginRound', uid }, balances)
  if (r.error) throw new Error(`beginRound: ${r.error}`)
  return r.table
}

function minOf(t: TableDoc, uid: string) {
  return minBetFor(t, byUid(t, uid)!)
}

/** Firestore refuses `undefined`, so no field of a table may ever hold it. */
function scanUndefined(v: unknown, path: string, out: string[]) {
  if (v === undefined) {
    out.push(path)
    return
  }
  if (Array.isArray(v)) v.forEach((x, i) => scanUndefined(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) scanUndefined(x, `${path}.${k}`, out)
}

function clean(label: string, t: TableDoc) {
  const bad: string[] = []
  scanUndefined(t, label, bad)
  ok(bad.length === 0, `${label}: no undefined fields${bad.length ? ` (${bad.join(', ')})` : ''}`)
}

// ============ config floor ============
ok(minBalanceToPlay(DEFAULT_CONFIG) === 30, 'boot 10 + 2 x chaal 10 = 30 to play')

// ============ setup: 3 players, generous stack ============
let t = makeTable('123456', 'Test', 'alice')
t = run(
  t,
  { type: 'config', uid: 'alice', config: { joinerPoints: 10000, boot: 10, baseUnit: 10 } },
  { type: 'join', uid: 'bob', username: 'bob' },
  { type: 'join', uid: 'carol', username: 'carol' },
  { type: 'start', uid: 'alice' }
)

ok(t.game.phase === 'countdown', 'start opens a countdown')
ok(!!applyAction(t, { type: 'beginRound', uid: 'alice' }).error, 'beginRound is too early at first')

t = startRound(t, 'alice')

ok(t.game.phase === 'playing', 'game starts playing')
ok(t.game.pot === 30, `boot 10 x3 into pot (got ${t.game.pot})`)
ok(byUid(t, 'alice')!.chips === 9990, 'alice has 9990 after 10 boot')
ok(t.game.turnUid === 'alice', 'alice acts first')
ok(t.game.unit === 10, 'unit starts at 10')

// --- min bet rules ---
ok(minOf(t, 'alice') === 10, 'blind min = unit = 10')

// --- seen costs double, blind pays half ---
t = run(t, { type: 'bet', uid: 'alice', amount: 10 })
ok(t.game.lastBet === 10 && t.game.lastBetBy === 'alice', 'alice bet recorded')
ok(t.game.turnUid === 'bob', 'turn moves to bob')

t = run(t, { type: 'setSeen', uid: 'bob', seen: true })
ok(minOf(t, 'bob') === 20, `seen min = 2x last blind (got ${minOf(t, 'bob')})`)
ok(!!applyAction(t, { type: 'bet', uid: 'bob', amount: 10 }).error, 'below-min bet rejected')

t = run(t, { type: 'bet', uid: 'bob', amount: 20 })
ok(t.game.pot === 60, `pot after bob (got ${t.game.pot})`)
ok(minOf(t, 'carol') === 10, `blind pays half of seen bet (got ${minOf(t, 'carol')})`)

// --- raising sets a new floor ---
t = run(t, { type: 'bet', uid: 'carol', amount: 10 })
ok(t.game.round === 2, `round increments when turn returns to starter (got ${t.game.round})`)
ok(t.game.turnUid === 'alice', 'turn wraps back to the round starter')
ok(t.game.unit === 10, 'unit unchanged after round 1')

t = run(t, { type: 'bet', uid: 'alice', amount: 30 })
ok(t.game.turnUid === 'bob', 'turn back to bob')
ok(minOf(t, 'bob') === 60, `seen pays 2x raised blind 30 (got ${minOf(t, 'bob')})`)
ok(minOf(t, 'carol') >= 15, `blind pays half of 30 (got ${minOf(t, 'carol')})`)

t = run(
  t,
  { type: 'bet', uid: 'bob', amount: minOf(t, 'bob') },
  { type: 'bet', uid: 'carol', amount: minOf(t, 'carol') }
)
ok(t.game.round === 3, `round 3 after completing round 2 (got ${t.game.round})`)
ok(t.game.unit === 10, 'unit still 10 after 2 rounds')

t = run(
  t,
  { type: 'bet', uid: 'alice', amount: minOf(t, 'alice') },
  { type: 'bet', uid: 'bob', amount: minOf(t, 'bob') },
  { type: 'bet', uid: 'carol', amount: minOf(t, 'carol') }
)
ok(t.game.round === 4, `now round 4 (got ${t.game.round})`)
ok(t.game.unit === 20, `unit doubled after 3 rounds (got ${t.game.unit})`)
ok(minOf(t, 'alice') >= 20, 'min never drops below doubled unit')
ok(t.game.log.some((l) => l.text.includes('doubled')), 'doubling is logged')

ok(
  !!applyAction(t, { type: 'bet', uid: 'alice', amount: 10 }).error,
  'stale low bet rejected after doubling'
)

// --- sideshow (3+ players, config on) ---
ok(active(t).length === 3, '3 active players')
t = run(t, { type: 'sideshow', uid: 'alice', loserUid: 'carol' })
ok(byUid(t, 'carol')!.status === 'folded', 'sideshow loser folds')
ok(active(t).length === 2, '2 players remain')

// --- ending a round is now two steps: stop it, then name the winner (§29/§30) ---
ok(!!applyAction(t, { type: 'selectWinner', uid: 'alice', winnerUid: 'alice' }).error,
  'cannot name a winner while the round is still running')
ok(!!applyAction(t, { type: 'endRound', uid: 'carol' }).error,
  'a folded player cannot stop the round')
t = run(t, { type: 'endRound', uid: 'alice' })
ok(t.game.phase === 'roundEnded', 'stopping the round moves it to roundEnded')
ok(t.game.endedBy === 'alice', 'the stopper is recorded')
ok(t.game.winnerUid === null, 'no winner is chosen yet')
ok(t.game.turnUid === null, 'the turn is released so nobody can still bet')
clean('a table in roundEnded', t)
ok(!!applyAction(t, { type: 'bet', uid: 'bob', amount: 10 }).error, 'no betting after the round is stopped')
ok(!!applyAction(t, { type: 'selectWinner', uid: 'bob', winnerUid: 'alice' }).error,
  'only the admin or the stopper may pick the winner')
ok(!!applyAction(t, { type: 'selectWinner', uid: 'alice', winnerUid: 'carol' }).error,
  'a folded player cannot be named the winner')
ok(!applyAction(t, { type: 'selectWinner', uid: 'alice', winnerUid: 'bob' }).error,
  'the admin can name an active player')
t = run(t, { type: 'selectWinner', uid: 'alice', winnerUid: 'alice' })
ok(t.game.phase === 'waiting', 'round settles into the wait window')
ok(t.game.winnerUid === 'alice', 'winner recorded')
ok(t.game.waitEndsAt !== null, 'auto-start timer armed')
ok(t.game.endedBy === null, 'the stopper is cleared once settled')
const aliceEnd = t.players.find((p) => p.uid === 'alice')!
ok(aliceEnd.buyIn === 0 && aliceEnd.chips === 0, 'chips reset after settle')
ok(t.rounds === 1, 'table round counter incremented')
ok(
  t.stats.length === 3 && t.stats.every((s) => s.gamesPlayed === 1),
  'per-table stats tallied for everyone who played'
)
ok(t.stats.find((s) => s.username === 'alice')!.gamesWon === 1, 'winner tallied as a win')

// --- round + chaal history (§33/§41) ---
ok(t.roundHistory.length === 1, 'the finished round is written to roundHistory')
const rec = t.roundHistory[0]
ok(rec.winnerUid === 'alice' && rec.winnerName === 'alice', 'round history records the winner')
ok(rec.pot > 0 && rec.endedAt >= rec.startedAt, 'round history records pot and timing')
ok(rec.players.length === 3, 'round history has a line per player')
ok(rec.players.find((p) => p.username === 'alice')!.delta > 0, 'winner delta is positive')
ok(t.actionHistory.length > 0, 'per-chaal ledger is populated')
ok(t.actionHistory.some((a) => a.kind === 'boot'), 'boot entries recorded')
ok(t.actionHistory.some((a) => a.kind === 'blind'), 'blind chaals recorded')
ok(t.actionHistory.some((a) => a.kind === 'seen'), 'seen chaals recorded')
ok(t.actionHistory.some((a) => a.kind === 'sideshow'), 'side shows recorded')
ok(
  t.actionHistory.every((a, i) => i === 0 || a.n > t.actionHistory[i - 1].n),
  'chaal ledger sequence numbers increase'
)
clean('after a settled round', t)

// --- auto-start fires after the wait, then a new round begins ---
ok(!!applyAction(t, { type: 'autoStart', uid: 'alice' }).error, 'autoStart is too early')
tick(WAIT_DELAY_MS + 10)
t = run(t, { type: 'autoStart', uid: 'alice' })
ok(t.game.phase === 'countdown', 'autoStart opens the next countdown')
t = startRound(t, 'alice')
ok(t.game.phase === 'playing' && t.game.round === 1, 'next round is in play')

// --- fold forces end when 1 left ---
let t2 = makeTable('999', 'T2', 'x')
t2 = run(t2, { type: 'join', uid: 'y', username: 'y' }, { type: 'start', uid: 'x' })
t2 = startRound(t2, 'x')
t2 = run(t2, { type: 'fold', uid: 'x' })
ok(t2.game.phase === 'waiting' && t2.game.winnerUid === 'y', 'last player standing wins')
ok(t2.players.find((p) => p.uid === 'y')!.chips === 0, 'chips reset on auto-win')

// --- admin transfer on leave ---
let t3 = makeTable('111', 'T3', 'admin1')
t3 = run(t3, { type: 'join', uid: 'p2', username: 'p2' }, { type: 'leave', uid: 'admin1' })
ok(t3.adminUid === 'p2', 'admin passes on leave')
ok(t3.players.find((p) => p.uid === 'p2')!.isAdmin, 'new admin flagged')

// --- guards ---
let t4 = makeTable('222', 'T4', 'a')
t4 = run(t4, { type: 'join', uid: 'b', username: 'b' }, { type: 'start', uid: 'a' })
t4 = startRound(t4, 'a')
ok(!!applyAction(t4, { type: 'config', uid: 'a', config: { boot: 50 } }).error, 'config locked mid-round')
ok(!!applyAction(t4, { type: 'start', uid: 'b' }).error, 'non-admin cannot start')
ok(!!applyAction(t4, { type: 'config', uid: 'b', config: { boot: 50 } }).error, 'non-admin cannot config')
ok(!!applyAction(t4, { type: 'topup', uid: 'b', targetUid: 'a', amount: 50 }).error, 'non-admin cannot top up')
ok(!!applyAction(t4, { type: 'pause', uid: 'b' }).error, 'non-admin cannot pause')

let t5 = makeTable('333', 'T5', 'a')
t5 = run(
  t5,
  { type: 'join', uid: 'b', username: 'b' },
  { type: 'join', uid: 'c', username: 'c' },
  { type: 'config', uid: 'a', config: { sideshow: false } },
  { type: 'start', uid: 'a' }
)
t5 = startRound(t5, 'a')
ok(!!applyAction(t5, { type: 'sideshow', uid: 'a', loserUid: 'b' }).error, 'sideshow blocked when disabled')
ok(seated(t5).length === 3, '3 seated at t5')
ok(!!applyAction(t5, { type: 'bet', uid: 'b', amount: 10 }).error, 'out-of-turn bet rejected')
ok(!!applyAction(t5, { type: 'bet', uid: 'a', amount: 99999 }).error, 'over-chips bet rejected')

// --- joining mid-round is allowed, but you sit out until the next round ---
const joinMid = applyAction(t5, { type: 'join', uid: 'd', username: 'd' })
ok(!joinMid.error, 'mid-round join is allowed')
ok(joinMid.table.players.find((p) => p.uid === 'd')!.status === 'sittingOut', 'mid-round joiner sits out')

// --- max players enforced ---
let t6 = makeTable('444', 'T6', 'a')
t6 = run(t6, { type: 'config', uid: 'a', config: { maxPlayers: 2 } }, { type: 'join', uid: 'b', username: 'b' })
ok(!!applyAction(t6, { type: 'join', uid: 'c', username: 'c' }).error, 'max players enforced')

// --- join credits the joiner exactly once ---
let tj = makeTable('666', 'TJ', 'admin')
const j1 = applyAction(tj, { type: 'join', uid: 'neo', username: 'neo' })
ok(
  j1.effects.some(
    (e) => e.type === 'grant' && e.entries.some((x) => x.username === 'neo' && x.creditBalance && x.amount === DEFAULT_CONFIG.joinerPoints)
  ),
  'join credits joinerPoints to the account'
)
tj = j1.table
tj = run(tj, { type: 'leave', uid: 'neo' })
const j2 = applyAction(tj, { type: 'join', uid: 'neo', username: 'neo' })
ok(
  j2.effects.every((e) => e.type !== 'grant' || !e.entries.some((x) => x.creditBalance)),
  'rejoining the same table does not credit again'
)

// --- low balance sits the player out when the round starts ---
let t8 = makeTable('777', 'T8', 'adm')
t8 = run(t8, { type: 'join', uid: 'rich', username: 'rich' }, { type: 'join', uid: 'poor', username: 'poor' })
t8 = run(t8, { type: 'start', uid: 'adm' })
tick(START_DELAY_MS + 10)
const lowRes = applyAction(
  t8,
  { type: 'beginRound', uid: 'adm' },
  { adm: 100, rich: 400, poor: 12 }
)
ok(!lowRes.error, 'round still starts when someone is short')
ok(lowRes.table.players.find((p) => p.uid === 'poor')!.status === 'sittingOut', 'poor sits out the round')
ok(lowRes.table.players.find((p) => p.uid === 'poor')!.buyIn === 0, 'sitting player pays no boot')
ok(lowRes.table.game.pot === 20, `only eligible players pay boot (got ${lowRes.table.game.pot})`)
ok(
  !lowRes.effects.some((e) => e.type === 'grant' && e.entries.some((x) => x.username === 'poor')),
  'sitting player is not granted chips'
)
ok(
  lowRes.table.game.log.some((l) => l.text.includes('low on points')),
  'sit-out is logged'
)
let t9 = makeTable('778', 'T9', 'adm')
t9 = run(t9, { type: 'join', uid: 'rich', username: 'rich' }, { type: 'join', uid: 'poor', username: 'poor' })
t9 = run(t9, { type: 'start', uid: 'adm' })
tick(START_DELAY_MS + 10)
const noBalances = applyAction(t9, { type: 'beginRound', uid: 'adm' })
ok(!noBalances.error, 'without balances everyone stays eligible')
ok(
  noBalances.table.players.find((p) => p.uid === 'poor')!.status === 'active',
  'unknown balance does not lock a player out'
)

// --- admin top-up ---
const topup = applyAction(lowRes.table, { type: 'topup', uid: 'adm', targetUid: 'poor', amount: 50 })
ok(!topup.error, 'admin can top up a seated player')
ok(
  topup.effects.some((e) => e.type === 'grant' && e.entries.some((x) => x.username === 'poor' && x.amount === 50 && x.creditBalance)),
  'top-up credits the account balance'
)
ok(!!applyAction(lowRes.table, { type: 'topup', uid: 'poor', targetUid: 'rich', amount: 50 }).error, 'only the admin tops up')
ok(!!applyAction(lowRes.table, { type: 'topup', uid: 'adm', targetUid: 'ghost', amount: 50 }).error, 'top-up needs a seated target')

// --- pause freezes the timers, resume shifts them ---
let tp = makeTable('888', 'TP', 'a')
tp = run(tp, { type: 'join', uid: 'b', username: 'b' }, { type: 'start', uid: 'a' })
tick(2000)
tp = run(tp, { type: 'pause', uid: 'a' })
ok(tp.game.paused, 'admin pauses the table')
const pausedFor = 9000
tick(pausedFor)
ok(!!applyAction(tp, { type: 'beginRound', uid: 'a' }).error, 'beginRound blocked while paused')
ok(!!applyAction(tp, { type: 'bet', uid: 'a', amount: 10 }).error, 'bets blocked while paused')
ok(!applyAction(tp, { type: 'join', uid: 'z', username: 'z' }).error, 'sitting down still works while paused')
ok(!!applyAction(tp, { type: 'resume', uid: 'b' }).error, 'only the admin resumes')
tp = run(tp, { type: 'resume', uid: 'a' })
ok(!tp.game.paused, 'admin resumes the table')
ok(!!applyAction(tp, { type: 'resume', uid: 'a' }).error, 'cannot resume twice')
ok(!!applyAction(tp, { type: 'beginRound', uid: 'a' }).error, 'remaining countdown preserved across the pause')
tick(START_DELAY_MS - 2000)
tp = run(tp, { type: 'beginRound', uid: 'a' })
ok(tp.game.phase === 'playing', 'round begins once the paused countdown elapses')

// --- stopping the table ---
let tc = makeTable('555', 'TC', 'a')
tc = run(tc, { type: 'join', uid: 'b', username: 'b' }, { type: 'start', uid: 'a' })
tc = startRound(tc, 'a')
ok(!!applyAction(tc, { type: 'close', uid: 'b' }).error, 'only the admin stops the table')
tc = run(tc, { type: 'close', uid: 'a' })
ok(tc.game.phase === 'closed', 'table closes')
ok(tc.closedAt !== null, 'close time recorded')
ok(!!applyAction(tc, { type: 'join', uid: 'c', username: 'c' }).error, 'closed table rejects joins')
ok(!!applyAction(tc, { type: 'beginRound', uid: 'a' }).error, 'closed table rejects play')
ok(!!applyAction(tc, { type: 'close', uid: 'a' }).error, 'cannot close twice')
ok(tc.players.every((p) => p.chips === 0 && p.buyIn === 0), 'stopping mid-round abandons the pot')

// ============ seat arranging ============
let st = makeTable('777777', 'Seats', 'alice')
st = run(
  st,
  { type: 'join', uid: 'bob', username: 'bob' },
  { type: 'join', uid: 'cat', username: 'cat' }
)
ok(!('mustPlace' in byUid(st, 'bob')!), 'a lobby join leaves out the mustPlace field entirely')
ok(
  byUid(st, 'alice')!.seat === 0 && byUid(st, 'bob')!.seat === 1 && byUid(st, 'cat')!.seat === 2,
  'seats assigned in join order'
)

ok(!!applyAction(st, { type: 'reseat', uid: 'bob', targetUid: 'cat', dir: -1 }).error,
  'only the admin arranges seats')
const rs = applyAction(st, { type: 'reseat', uid: 'alice', targetUid: 'cat', dir: -1 })
ok(!rs.error, 'admin can move a player up a seat')
ok(
  byUid(rs.table, 'alice')!.seat === 0 &&
    byUid(rs.table, 'cat')!.seat === 1 &&
    byUid(rs.table, 'bob')!.seat === 2,
  'reseat swaps the two seats'
)
const rs2 = applyAction(rs.table, { type: 'reseat', uid: 'alice', targetUid: 'alice', dir: -1 })
ok(!rs2.error && byUid(rs2.table, 'alice')!.seat === 0, 'moving up from the first seat is a no-op')
const rs3 = applyAction(rs2.table, { type: 'reseat', uid: 'alice', targetUid: 'bob', dir: 1 })
ok(!rs3.error && byUid(rs3.table, 'bob')!.seat === 2, 'moving down from the last seat is a no-op')

ok(!!applyAction(st, { type: 'assignSeat', uid: 'bob', targetUid: 'cat', seat: 0 }).error,
  'only the admin places players')
const as1 = applyAction(st, { type: 'assignSeat', uid: 'alice', targetUid: 'cat', seat: 0 })
ok(!as1.error, 'admin assigns a seat')
ok(byUid(as1.table, 'cat')!.seat === 0 && byUid(as1.table, 'alice')!.seat === 2,
  'assignSeat swaps with the occupant instead of evicting')
ok(!byUid(as1.table, 'cat')!.mustPlace, 'the placement flag is cleared')
clean('a lobby table', st)
clean('after reseat', rs3.table)
clean('after assignSeat', as1.table)
ok(!!applyAction(st, { type: 'assignSeat', uid: 'alice', targetUid: 'cat', seat: 99 }).error,
  'a seat beyond capacity is rejected')
ok(!!applyAction(st, { type: 'assignSeat', uid: 'alice', targetUid: 'nobody', seat: 1 }).error,
  'assignSeat rejects a player who is not at the table')

let mt = makeTable('888888', 'Mid', 'alice')
mt = run(
  mt,
  { type: 'join', uid: 'bob', username: 'bob' },
  { type: 'start', uid: 'alice' }
)
mt = startRound(mt, 'alice')
const mj = applyAction(mt, { type: 'join', uid: 'zoe', username: 'zoe' })
ok(!mj.error, 'joining mid-round is allowed')
ok(byUid(mj.table, 'zoe')!.mustPlace === true, 'a mid-round joiner needs seat placement')
ok(byUid(mj.table, 'zoe')!.status === 'sittingOut', 'a mid-round joiner sits out this round')
ok(!!applyAction(mj.table, { type: 'assignSeat', uid: 'alice', targetUid: 'zoe', seat: 1 }).error,
  'seats are locked while a round is in progress')
ok(!!applyAction(mj.table, { type: 'reseat', uid: 'alice', targetUid: 'zoe', dir: 1 }).error,
  'reseat is locked while a round is in progress')
clean('a mid-round join', mj.table)

// ============ §18 — three blind chaals flip a player over ============
let b1 = makeTable('200001', 'Blind', 'a')
b1 = run(b1, { type: 'join', uid: 'b', username: 'b' }, { type: 'start', uid: 'a' })
b1 = startRound(b1, 'a')
b1 = run(b1, { type: 'bet', uid: 'a', amount: minOf(b1, 'a') })
b1 = run(b1, { type: 'bet', uid: 'b', amount: minOf(b1, 'b') })
ok(b1.game.round === 2, 'one betting round complete')
ok(byUid(b1, 'a')!.blindTurns === 1 && !byUid(b1, 'a')!.seen, 'one blind chaal, still blind')
ok(b1.game.notice === null, 'no notice after a single betting round')

b1 = run(b1, { type: 'bet', uid: 'a', amount: minOf(b1, 'a') }, { type: 'bet', uid: 'b', amount: minOf(b1, 'b') })
ok(byUid(b1, 'a')!.blindTurns === 2 && !byUid(b1, 'a')!.seen, 'two blind chaals, still blind')
ok(b1.game.round === 3 && b1.game.notice === null, 'still nothing forced after two betting rounds')

b1 = run(b1, { type: 'bet', uid: 'a', amount: minOf(b1, 'a') })
ok(byUid(b1, 'a')!.blindTurns === 3, 'blind counter reaches the limit')
ok(byUid(b1, 'a')!.seen, 'the third blind chaal flips a to SEEN automatically')
ok(b1.game.log.some((l) => l.text.includes('now SEEN')), 'the automatic flip is logged')
ok(minOf(b1, 'b') === 10, 'the next blind player still pays the blind minimum')

b1 = run(b1, { type: 'bet', uid: 'b', amount: minOf(b1, 'b') })
ok(byUid(b1, 'b')!.seen, 'b flips on their own third blind chaal')
ok(b1.game.round === 4, 'three betting rounds complete')
ok(b1.game.notice === null, '§20 stays quiet when nobody is left blind')
ok(
  b1.actionHistory.filter((a) => a.kind === 'blind').length === 6,
  'each blind chaal is in the ledger'
)
clean('after the blind-limit sequence', b1)

// ============ §20 — forced seen after N betting rounds ============
ok(DEFAULT_CONFIG.forcedSeenRounds === 3, 'forcedSeenRounds defaults to 3')
let b2 = makeTable('200002', 'Force', 'a')
b2 = run(
  b2,
  { type: 'join', uid: 'b', username: 'b' },
  { type: 'config', uid: 'a', config: { forcedSeenRounds: 1 } },
  { type: 'start', uid: 'a' }
)
ok(b2.config.forcedSeenRounds === 1, 'the admin can set when blind play closes')
ok(
  !!applyAction(b2, { type: 'config', uid: 'b', config: { forcedSeenRounds: 1 } }).error,
  'only the admin changes that'
)
b2 = startRound(b2, 'a')
b2 = run(b2, { type: 'bet', uid: 'a', amount: minOf(b2, 'a') }, { type: 'bet', uid: 'b', amount: minOf(b2, 'b') })
ok(byUid(b2, 'a')!.seen && byUid(b2, 'b')!.seen, 'blind play closes once the limit is reached')
ok(b2.game.notice === 'ALL PLAYERS ARE NOW SEEN', 'table-wide notice is raised')
ok(b2.game.log.some((l) => l.text.includes('All players are now seen')), 'the closure is logged')
b2 = run(b2, { type: 'setSeen', uid: 'a', seen: true })
ok(byUid(b2, 'a')!.blindTurns === 0, 'seeing cards clears the blind counter')
ok(b2.game.notice !== null, 'the notice survives a later action')
clean('after the forced-seen sequence', b2)

// ============ status mapping (§ table statuses) ============
ok(tableStatus(makeTable('x', 'x', 'a').game) === 'WAITING', 'lobby reports WAITING')
ok(tableStatus({ ...t.game, phase: 'playing' }) === 'RUNNING', 'playing reports RUNNING')
ok(tableStatus({ ...t.game, phase: 'roundEnded' }) === 'ROUND ENDED', 'stopped round reports ROUND ENDED')
ok(tableStatus({ ...t.game, phase: 'waiting', winnerUid: 'alice' }) === 'WINNER SELECTED',
  'settled round reports WINNER SELECTED')
ok(tableStatus({ ...t.game, phase: 'closed' }) === 'COMPLETED', 'closed table reports COMPLETED')

// ============ history bounds ============
ok(t.roundHistory.length <= ROUND_HISTORY_LIMIT, 'round history stays within its cap')
ok(t.actionHistory.length <= ACTION_HISTORY_LIMIT, 'chaal ledger stays within its cap')
ok(t.actionHistory.every((a) => a.round >= 1 && a.amount >= 0), 'ledger rows are well formed')

// ============ documents written before these fields existed ============
const legacy = JSON.parse(JSON.stringify(makeTable('300001', 'Legacy', 'a'))) as TableDoc
const strip = (o: Record<string, unknown>, k: string) => delete o[k]
strip(legacy as unknown as Record<string, unknown>, 'roundHistory')
strip(legacy as unknown as Record<string, unknown>, 'actionHistory')
strip(legacy as unknown as Record<string, unknown>, 'actionSeq')
strip(legacy.game as unknown as Record<string, unknown>, 'notice')
strip(legacy.game as unknown as Record<string, unknown>, 'endedBy')
strip(legacy.game as unknown as Record<string, unknown>, 'roundStartedAt')
strip(legacy.config as unknown as Record<string, unknown>, 'forcedSeenRounds')
for (const p of legacy.players) strip(p as unknown as Record<string, unknown>, 'blindTurns')
const lr = applyAction(legacy, { type: 'join', uid: 'z', username: 'z' })
ok(!lr.error, `a legacy document without the new fields still works (${lr.error ?? 'ok'})`)
ok(lr.table.roundHistory.length === 0 && lr.table.actionHistory.length === 0, 'legacy history defaults to empty')
ok(lr.table.config.forcedSeenRounds === DEFAULT_CONFIG.forcedSeenRounds, 'legacy config gains the new default')
ok(lr.table.players.every((p) => p.blindTurns === 0), 'legacy players gain a blind counter')
clean('a legacy document', lr.table)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
