export type ChipVisibility = 'admin' | 'all'
export type Visibility = 'admin' | 'all'

export interface TableConfig {
  boot: number
  joinerPoints: number
  baseUnit: number
  doubleEveryRounds: number
  /** Blind play is forced off once this many full betting rounds have passed. */
  forcedSeenRounds: number
  sideshow: boolean
  chipVisibility: ChipVisibility
  configVisibility: Visibility
  maxPlayers: number
}

export type PlayerStatus = 'active' | 'folded' | 'left' | 'sittingOut'

export interface Player {
  uid: string
  username: string
  seat: number
  chips: number
  buyIn: number
  seen: boolean
  status: PlayerStatus
  isAdmin: boolean
  joinedAt: number
  /** True once this seat has been credited its one-time joiner grant. */
  funded: boolean
  /** True while the admin still has to pick this player's seat. */
  mustPlace?: boolean
  /** Blind chaals taken this round; the third one flips the player to SEEN. */
  blindTurns: number
}

export type Phase = 'lobby' | 'countdown' | 'playing' | 'roundEnded' | 'waiting' | 'closed'

export interface LogEntry {
  at: number
  text: string
}

export interface GameState {
  phase: Phase
  paused: boolean
  pausedAt: number | null
  pot: number
  lastPot: number
  unit: number
  lastBet: number | null
  lastBetSeen: boolean | null
  lastBetBy: string | null
  betSeq: number
  turnUid: string | null
  roundFirstUid: string | null
  round: number
  turnsInRound: number
  winnerUid: string | null
  countdownEndsAt: number | null
  waitEndsAt: number | null
  /** When the current round was dealt, for the round record. */
  roundStartedAt: number
  /** Whoever stopped a round from `playing`; they — or the admin — pick the winner. */
  endedBy: string | null
  /** One-shot table-wide announcement (e.g. "ALL PLAYERS ARE NOW SEEN"). */
  notice: string | null
  log: LogEntry[]
}

/** One player's line in a finished round. */
export interface RoundPlayerRecord {
  uid: string
  username: string
  seat: number
  blindTurns: number
  folded: boolean
  delta: number
  chips: number
}

/** A completed round, kept on the table document for the history panel. */
export interface RoundRecord {
  round: number
  startedAt: number
  endedAt: number
  pot: number
  winnerUid: string | null
  winnerName: string | null
  players: RoundPlayerRecord[]
}

export type ChaalKind = 'boot' | 'blind' | 'seen' | 'fold' | 'sideshow' | 'saw'

/** A single movement of chips (or a status change) inside a round. */
export interface ChaalRecord {
  /** Monotonic sequence number within the table. */
  n: number
  round: number
  at: number
  uid: string
  username: string
  kind: ChaalKind
  amount: number
  pot: number
}

/** Per-player scoreboard accumulated across the lifetime of one table. */
export interface TablePlayerStats {
  username: string
  gamesPlayed: number
  gamesWon: number
  gamesLost: number
  totalWon: number
  totalLost: number
}

export interface TableDoc {
  code: string
  name: string
  createdAt: number
  createdBy: string
  adminUid: string
  memberUids: string[]
  config: TableConfig
  players: Player[]
  game: GameState
  rounds: number
  stats: TablePlayerStats[]
  /** Finished rounds, newest last. Capped at ROUND_HISTORY_LIMIT. */
  roundHistory: RoundRecord[]
  /** Per-chaal ledger for the current and recent rounds. Capped at ACTION_HISTORY_LIMIT. */
  actionHistory: ChaalRecord[]
  actionSeq: number
  closedAt: number | null
}

export type Action =
  | { type: 'join'; uid: string; username: string }
  | { type: 'leave'; uid: string }
  | { type: 'config'; uid: string; config: Partial<TableConfig> }
  | { type: 'kick'; uid: string; targetUid: string }
  | { type: 'reseat'; uid: string; targetUid: string; dir: 1 | -1 }
  | { type: 'assignSeat'; uid: string; targetUid: string; seat: number }
  | { type: 'start'; uid: string }
  | { type: 'beginRound'; uid: string }
  | { type: 'autoStart'; uid: string }
  | { type: 'startNow'; uid: string }
  | { type: 'bet'; uid: string; amount: number }
  | { type: 'setSeen'; uid: string; seen: boolean }
  | { type: 'fold'; uid: string }
  | { type: 'sideshow'; uid: string; loserUid: string }
  /** Stops play and moves the table to `roundEnded`. No winner is chosen yet. */
  | { type: 'endRound'; uid: string }
  /** Names the winner and settles. Legal from `roundEnded`, or in a heads-up show. */
  | { type: 'selectWinner'; uid: string; winnerUid: string }
  | { type: 'topup'; uid: string; targetUid: string; amount: number }
  | { type: 'pause'; uid: string }
  | { type: 'resume'; uid: string }
  | { type: 'close'; uid: string }

export type HistoryResult = 'won' | 'lost' | 'folded' | 'busted'

export interface HistoryEntry {
  tableCode: string
  tableName: string
  at: number
  delta: number
  result: HistoryResult
  pot: number
  players: number
  round: number
}

export interface UserStats {
  gamesPlayed: number
  gamesWon: number
  gamesLost: number
  totalAllocated: number
  totalWon: number
  totalLost: number
}

export interface UserDoc {
  username: string
  balance: number
  createdAt: number
  stats: UserStats
  history: HistoryEntry[]
}

export const DEFAULT_CONFIG: TableConfig = {
  boot: 10,
  joinerPoints: 100,
  baseUnit: 10,
  doubleEveryRounds: 3,
  forcedSeenRounds: 3,
  sideshow: true,
  chipVisibility: 'admin',
  configVisibility: 'admin',
  maxPlayers: 6,
}

/**
 * Minimum balance to take part in a round: boot + two minimum chaals.
 * boot 10 with a min chaal of 10 => 30.
 */
export function minBalanceToPlay(config: TableConfig): number {
  return Math.max(0, Math.floor(config.boot)) + 2 * Math.max(1, Math.floor(config.baseUnit))
}

export const STARTING_BALANCE = 0
export const HISTORY_LIMIT = 100
export const START_DELAY_MS = 5000
export const WAIT_DELAY_MS = 10000
export const CLOCK_SKEW_MS = 700
/** Blind chaals a player may take before they are flipped to SEEN. */
export const BLIND_TURN_LIMIT = 3
export const ROUND_HISTORY_LIMIT = 20
export const ACTION_HISTORY_LIMIT = 150

/** Spec statuses, derived from the phase — never stored, so they cannot drift. */
export function tableStatus(g: GameState): string {
  switch (g.phase) {
    case 'playing':
      return 'RUNNING'
    case 'roundEnded':
      return 'ROUND ENDED'
    case 'waiting':
      return g.winnerUid ? 'WINNER SELECTED' : 'WAITING'
    case 'closed':
      return 'COMPLETED'
    default:
      return 'WAITING'
  }
}
