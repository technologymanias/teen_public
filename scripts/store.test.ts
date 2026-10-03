import { applyAction, makeTable } from '../src/lib/engine'
import { applyEffect, collectUsers, validateEffects } from '../src/lib/store'
import {
  DEFAULT_CONFIG,
  HISTORY_LIMIT,
  STARTING_BALANCE,
  START_DELAY_MS,
  minBalanceToPlay,
  type Action,
  type TableDoc,
  type UserDoc,
} from '../src/lib/types'

let fails = 0
function ok(cond: boolean, msg: string) {
  if (!cond) {
    fails++
    console.log('FAIL:', msg)
  } else console.log('ok  :', msg)
}

const realNow = Date.now.bind(Date)
let offset = 0
Date.now = () => realNow() + offset
const tick = (ms: number) => {
  offset += ms
}

function profile(name: string, balance: number): UserDoc {
  return {
    username: name,
    balance,
    createdAt: Date.now(),
    stats: {
      gamesPlayed: 0,
      gamesWon: 0,
      gamesLost: 0,
      totalAllocated: 0,
      totalWon: 0,
      totalLost: 0,
    },
    history: [],
  }
}

/**
 * Mirrors what the store transaction does for a single action:
 * read balances when the rules ask for them, run the rules, then apply effects.
 */
function applyWithProfiles(
  table: TableDoc,
  action: Action,
  profiles: Map<string, UserDoc>
): { table: TableDoc; effects: ReturnType<typeof applyAction>['effects']; profiles: Map<string, UserDoc> } {
  const needsBalances =
    action.type === 'beginRound' || action.type === 'autoStart' || action.type === 'startNow'

  const balances: Record<string, number> = {}
  if (needsBalances) {
    for (const p of table.players) {
      if (p.status === 'left') continue
      const prof = profiles.get(p.username) ?? profile(p.username, STARTING_BALANCE)
      profiles.set(p.username, prof)
      balances[p.uid] = prof.balance
    }
  }

  const { table: next, effects, error } = applyAction(table, action, balances)
  if (error) throw new Error(`${action.type}: ${error}`)

  const touched = new Set<string>()
  for (const e of effects) collectUsers(e, touched)
  for (const u of touched) if (!profiles.has(u)) profiles.set(u, profile(u, STARTING_BALANCE))

  const funded = validateEffects(effects, profiles)
  if (funded) for (const e of effects) applyEffect(e, profiles)
  return { table: next, effects, profiles }
}

function run(t: TableDoc, profiles: Map<string, UserDoc>, ...actions: Action[]): TableDoc {
  for (const a of actions) t = applyWithProfiles(t, a, profiles).table
  return t
}

// ============ a full 3-player game, alice wins ============
const profiles = new Map<string, UserDoc>()
let t = makeTable('111111', 'Table', 'alice')

// The store credits the creator the same way a seat-down does.
profiles.set('alice', profile('alice', STARTING_BALANCE))
profiles.get('alice')!.balance += DEFAULT_CONFIG.joinerPoints

t = run(t, profiles, { type: 'config', uid: 'alice', config: { joinerPoints: 100, boot: 10, baseUnit: 10 } })
t = run(t, profiles, { type: 'join', uid: 'bob', username: 'bob' })
t = run(t, profiles, { type: 'join', uid: 'carol', username: 'carol' })

ok(profiles.get('bob')!.balance === STARTING_BALANCE + 100, 'bob credited joiner points on sitting down')
ok(profiles.get('carol')!.balance === STARTING_BALANCE + 100, 'carol credited joiner points')
ok(profiles.get('bob')!.stats.totalAllocated === 100, 'join counts toward points played')

const startRes = applyWithProfiles(t, { type: 'start', uid: 'alice' }, profiles)
t = startRes.table
ok(t.game.phase === 'countdown', 'start opens the countdown')

tick(START_DELAY_MS + 10)
const beginRes = applyWithProfiles(t, { type: 'beginRound', uid: 'alice' }, profiles)
t = beginRes.table

ok(
  beginRes.effects.some((e) => e.type === 'grant' && e.entries.every((x) => !x.creditBalance)),
  'round chips are granted without touching the balance'
)
ok(t.game.pot === 30, `boot collected into the pot (got ${t.game.pot})`)
ok(profiles.get('bob')!.balance === STARTING_BALANCE + 100, 'grant does not move the balance')

// alice bets, bob folds, carol still active => alice stops the round then names herself
t = run(t, profiles, { type: 'bet', uid: 'alice', amount: 10 })
t = run(t, profiles, { type: 'fold', uid: 'bob' })
ok(t.game.phase === 'playing', 'still 2 active, round continues')

const stopRes = applyWithProfiles(t, { type: 'endRound', uid: 'alice' }, profiles)
t = stopRes.table
ok(t.game.phase === 'roundEnded', 'stopping the round does not settle it')
ok(stopRes.effects.length === 0, 'stopping moves no balance')

const endRes = applyWithProfiles(t, { type: 'selectWinner', uid: 'alice', winnerUid: 'alice' }, profiles)
t = endRes.table
ok(t.game.phase === 'waiting', 'settled into the wait window')

const a = profiles.get('alice')!
const b = profiles.get('bob')!
const c = profiles.get('carol')!

// alice: +100 to sit down, then round delta = +20 (bob 10 + carol 10 pot, alice paid 20 boot+bet but took 30)
ok(a.balance === STARTING_BALANCE + 100 + 20, `alice balance = 120 (got ${a.balance})`)
ok(a.stats.gamesPlayed === 1 && a.stats.gamesWon === 1, 'alice counted as a win')
ok(a.stats.totalWon === 20, `alice totalWon 20 (got ${a.stats.totalWon})`)
ok(a.history.length === 1 && a.history[0].result === 'won', 'alice history records won')

ok(b.balance === STARTING_BALANCE + 100 - 10, `bob net -10 (got ${b.balance - STARTING_BALANCE})`)
ok(c.balance === STARTING_BALANCE + 100 - 10, `carol net -10 (got ${c.balance - STARTING_BALANCE})`)
ok(b.stats.gamesLost === 1 && b.stats.totalLost === 10, 'bob loss tracked')
ok(b.history[0].result === 'folded', 'bob history records folded')

// Every round's deltas net to zero, even though joining credits points.
const deltas = [a, b, c].map((p) => p.balance - (STARTING_BALANCE + DEFAULT_CONFIG.joinerPoints))
ok(
  deltas[0] + deltas[1] + deltas[2] === 0,
  `rounds are zero-sum (got ${deltas[0] + deltas[1] + deltas[2]})`
)

ok(t.stats.length === 3, 'table scoreboard covers everyone who played')
ok(t.rounds === 1, 'table counted one round')

// ============ admin top-up credits the account ============
const top = applyWithProfiles(t, { type: 'topup', uid: 'alice', targetUid: 'bob', amount: 40 }, profiles)
ok(top.effects.some((e) => e.type === 'grant' && e.entries.some((x) => x.creditBalance)), 'top-up credits balance')
ok(profiles.get('bob')!.balance === STARTING_BALANCE + 100 - 10 + 40, 'bob balance after top-up')

// ============ a player below the floor sits out ============
const shortProfiles = new Map<string, UserDoc>()
shortProfiles.set('adm', profile('adm', 100))
let s = makeTable('222222', 'Short', 'adm')
s = run(s, shortProfiles, { type: 'join', uid: 'rich', username: 'rich' })
s = run(s, shortProfiles, { type: 'join', uid: 'poor', username: 'poor' })
// They have been playing: one stack healthy, one drained below the floor.
shortProfiles.get('rich')!.balance = 400
shortProfiles.get('poor')!.balance = 12
s = run(s, shortProfiles, { type: 'start', uid: 'adm' })
tick(START_DELAY_MS + 10)
const shortRes = applyWithProfiles(s, { type: 'beginRound', uid: 'adm' }, shortProfiles)
ok(
  shortRes.table.players.find((p) => p.uid === 'poor')!.status === 'sittingOut',
  `poor sits out below ${minBalanceToPlay(DEFAULT_CONFIG)} (balance 12)`
)
ok(shortRes.table.game.pot === 20, 'only eligible players paid the boot')

// ============ missing accounts are rejected ============
ok(!validateEffects([{ type: 'grant', entries: [{ username: 'ghost', amount: 1, creditBalance: true }] }], new Map()), 'grant rejected when the account is missing')
ok(
  !validateEffects(
    [{ type: 'grant', entries: [{ username: 'dave', amount: 1, creditBalance: false }] }],
    new Map()
  ),
  'grant rejected when the account is missing'
)
ok(
  validateEffects(
    [{ type: 'grant', entries: [{ username: 'dave', amount: 999999, creditBalance: true }] }],
    new Map([['dave', profile('dave', 0)]])
  ),
  'a top-up never needs a balance check'
)

// ============ settle credit math ============
const p = profile('erin', 1000)
applyEffect(
  {
    type: 'settle',
    tableCode: '1',
    tableName: 'T',
    pot: 300,
    round: 2,
    players: [
      { uid: 'erin', username: 'erin', delta: 200, result: 'won', buyIn: 100 },
      { uid: 'frank', username: 'frank', delta: -100, result: 'lost', buyIn: 100 },
    ],
  },
  new Map([
    ['erin', p],
    ['frank', profile('frank', 500)],
  ])
)
ok(p.balance === 1200, `winner credited by delta only (got ${p.balance})`)
ok(p.stats.totalWon === 200 && p.stats.gamesWon === 1, 'winner stats')
ok(p.history[0].pot === 300 && p.history[0].players === 2, 'history carries pot + headcount')

// ============ history is capped ============
const heavy = profile('gina', 1000)
heavy.history = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({
  tableCode: '000000',
  tableName: 'x',
  at: i,
  delta: 0,
  result: 'lost' as const,
  pot: 0,
  players: 2,
  round: 1,
}))
applyEffect(
  {
    type: 'settle',
    tableCode: '2',
    tableName: 'T2',
    pot: 10,
    round: 1,
    players: [{ uid: 'gina', username: 'gina', delta: 0, result: 'lost', buyIn: 100 }],
  },
  new Map([['gina', heavy]])
)
ok(heavy.history.length === HISTORY_LIMIT, `history capped at ${HISTORY_LIMIT} (got ${heavy.history.length})`)
ok(heavy.history[0].tableCode === '2', 'newest entry is first')

// ============ stopping the table keeps balances where they are ============
let c2 = makeTable('333333', 'Close', 'admin')
const cp = new Map<string, UserDoc>([['admin', profile('admin', STARTING_BALANCE + 100)]])
c2 = run(c2, cp, { type: 'join', uid: 'p2', username: 'p2' }, { type: 'start', uid: 'admin' })
tick(START_DELAY_MS + 10)
c2 = run(c2, cp, { type: 'beginRound', uid: 'admin' })
const before = cp.get('admin')!.balance
c2 = run(c2, cp, { type: 'close', uid: 'admin' })
ok(c2.game.phase === 'closed', 'table closed')
ok(cp.get('admin')!.balance === before, 'an abandoned round never moves a balance')

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
