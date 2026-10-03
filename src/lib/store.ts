import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  where,
} from 'firebase/firestore'
import { db } from './firebase'
import { applyAction, generateCode, makeTable, type SideEffect } from './engine'
import {
  DEFAULT_CONFIG,
  HISTORY_LIMIT,
  type Action,
  type HistoryEntry,
  type TableConfig,
  type TableDoc,
  type UserDoc,
} from './types'

function tableRef(code: string) {
  return doc(db!, 'tables', code.toUpperCase())
}
function userRef(username: string) {
  return doc(db!, 'users', username)
}

function guard() {
  if (!db) throw new Error('App is not configured yet.')
}

/** Actions that need every seated player's balance before the rules run. */
const NEEDS_BALANCES: ReadonlySet<Action['type']> = new Set([
  'beginRound',
  'autoStart',
  'startNow',
])

export function watchTable(code: string, cb: (t: TableDoc | null) => void, onErr: (e: Error) => void) {
  guard()
  return onSnapshot(
    tableRef(code),
    (snap) => cb(snap.exists() ? (snap.data() as TableDoc) : null),
    (e) => onErr(e)
  )
}

export function watchProfile(username: string, cb: (u: UserDoc | null) => void, onErr: (e: Error) => void) {
  guard()
  return onSnapshot(
    userRef(username),
    (snap) => cb(snap.exists() ? (snap.data() as UserDoc) : null),
    (e) => onErr(e)
  )
}

/** Current account balance for each username, read once on demand. */
export async function getBalances(usernames: string[]): Promise<Record<string, number>> {
  guard()
  const out: Record<string, number> = {}
  for (const u of usernames) {
    const d = await getDoc(userRef(u))
    if (d.exists()) out[u] = (d.data() as UserDoc).balance
  }
  return out
}

/** Every table this account has a seat at, live. */
export function watchMyTables(
  username: string,
  cb: (tables: TableDoc[]) => void,
  onErr: (e: Error) => void
) {
  guard()
  const q = query(collection(db!, 'tables'), where('memberUids', 'array-contains', username))
  return onSnapshot(
    q,
    (snap) => cb(snap.docs.map((d) => d.data() as TableDoc)),
    (e) => onErr(e)
  )
}

const COLLISION = 'code-collision'

export async function createTable(
  name: string,
  creator: string,
  config: TableConfig = DEFAULT_CONFIG
): Promise<string> {
  guard()
  const me = await getDoc(userRef(creator))
  if (!me.exists()) throw new Error('Your account could not be found.')

  for (let i = 0; i < 25; i++) {
    const code = generateCode()
    try {
      await runTransaction(db!, async (tx) => {
        const ref = tableRef(code)
        const snap = await tx.get(ref)
        if (snap.exists()) throw new Error(COLLISION)

        const mine = await tx.get(userRef(creator))
        if (!mine.exists()) throw new Error('Your account could not be found.')

        const table = makeTable(code, name.trim() || `${creator}'s table`, creator, config)
        const profile = mine.data() as UserDoc
        profile.balance += config.joinerPoints
        profile.stats.totalAllocated += config.joinerPoints
        tx.set(userRef(creator), profile)
        tx.set(ref, { ...table })
      })
      return code
    } catch (e) {
      if (e instanceof Error && e.message === COLLISION) continue
      throw e
    }
  }
  throw new Error('Could not allocate a table code. Try again.')
}

/** Runs an action in a transaction and applies balance/history side effects. */
export async function dispatch(code: string, action: Action): Promise<string | null> {
  guard()
  try {
    return await runTransaction(db!, async (tx) => {
      const ref = tableRef(code)
      const snap = await tx.get(ref)
      if (!snap.exists()) return 'Table not found.'
      const current = snap.data() as TableDoc

      const profiles = new Map<string, UserDoc>()
      const balances: Record<string, number> = {}

      if (NEEDS_BALANCES.has(action.type)) {
        for (const p of current.players) {
          if (p.status === 'left') continue
          const d = await tx.get(userRef(p.username))
          if (!d.exists()) continue
          const profile = d.data() as UserDoc
          profiles.set(p.username, profile)
          balances[p.uid] = profile.balance
        }
      }

      const { table, effects, error } = applyAction(current, action, balances)
      if (error) return error

      const touched = new Set<string>()
      for (const e of effects) collectUsers(e, touched)

      for (const u of touched) {
        if (profiles.has(u)) continue
        const p = await tx.get(userRef(u))
        if (!p.exists()) return `Account @${u} not found.`
        profiles.set(u, p.data() as UserDoc)
      }

      if (!validateEffects(effects, profiles)) return 'Account not found.'

      for (const e of effects) applyEffect(e, profiles)
      for (const [u, profile] of profiles) tx.set(userRef(u), profile)

      tx.set(ref, { ...table })
      return null
    })
  } catch (e) {
    return e instanceof Error ? e.message : 'Something went wrong.'
  }
}

export function collectUsers(e: SideEffect, out: Set<string>) {
  if (e.type === 'grant') for (const x of e.entries) out.add(x.username)
  else for (const p of e.players) out.add(p.username)
}

export function validateEffects(effects: SideEffect[], profiles: Map<string, UserDoc>): boolean {
  for (const e of effects) {
    if (e.type === 'grant') {
      for (const x of e.entries) if (!profiles.get(x.username)) return false
      continue
    }
    for (const p of e.players) if (!profiles.get(p.username)) return false
  }
  return true
}

export function applyEffect(e: SideEffect, profiles: Map<string, UserDoc>) {
  if (e.type === 'grant') {
    for (const x of e.entries) {
      const p = profiles.get(x.username)
      if (!p) continue
      p.stats.totalAllocated += x.amount
      if (x.creditBalance) p.balance += x.amount
    }
    return
  }

  const headcount = e.players.length
  for (const row of e.players) {
    const p = profiles.get(row.username)
    if (!p) continue
    p.balance += row.delta
    p.stats.gamesPlayed += 1
    if (row.delta > 0) {
      p.stats.gamesWon += 1
      p.stats.totalWon += row.delta
    } else if (row.delta < 0) {
      p.stats.gamesLost += 1
      p.stats.totalLost += -row.delta
    }
    const entry: HistoryEntry = {
      tableCode: e.tableCode,
      tableName: e.tableName,
      at: Date.now(),
      delta: row.delta,
      result: row.result,
      pot: e.pot,
      players: headcount,
      round: e.round,
    }
    p.history = [entry, ...p.history].slice(0, HISTORY_LIMIT)
  }
}
