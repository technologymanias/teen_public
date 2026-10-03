import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore'
import { auth, db } from './firebase'
import { STARTING_BALANCE, type UserDoc } from './types'

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/

function toEmail(username: string) {
  return `${username}@teenpatti.local`
}

export function validateUsername(u: string) {
  return USERNAME_RE.test(u.trim().toLowerCase())
}

export function validatePassword(p: string) {
  return p.length >= 6
}

export function prettyError(code: string): string {
  switch (code) {
    case 'auth/email-already-in-use':
      return 'That username is already taken.'
    case 'auth/invalid-email':
      return 'Invalid username.'
    case 'auth/weak-password':
      return 'Password must be at least 6 characters.'
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in is switched off in Firebase.'
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.'
    case 'auth/unauthorized-domain':
      return 'This domain is not allowed in Firebase Auth settings.'
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Wrong username or password.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Try again later.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

/** Firebase folds the machine-readable code into the message — pull it back out. */
export function errorMessage(e: unknown): string {
  if (!(e instanceof Error)) return 'Something went wrong. Please try again.'
  const code = e.message.match(/\((auth\/[a-z0-9-]+)\)/)?.[1]
  if (code) return prettyError(code)
  if (/Missing or insufficient permissions/.test(e.message))
    return 'Your account could not be saved. Check the Firestore rules.'
  return e.message
}

export async function signUp(username: string, password: string) {
  const u = username.trim().toLowerCase()
  if (!validateUsername(u)) {
    throw new Error('Username: 3-20 chars, lowercase letters, numbers or _ only.')
  }
  if (!validatePassword(password)) {
    throw new Error('Password must be at least 6 characters.')
  }
  if (!password.startsWith('MM')) {
    throw new Error('Cannot create account.')
  }
  if (!auth || !db) throw new Error('App is not configured yet.')

  const profile: UserDoc = {
    username: u,
    balance: STARTING_BALANCE,
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

  let isNew = true
  try {
    await createUserWithEmailAndPassword(auth, toEmail(u), password)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code !== 'auth/email-already-in-use') {
      throw new Error(code ? prettyError(code) : errorMessage(e))
    }
    // An earlier attempt made the login but never finished the profile — reuse
    // it when the password matches, otherwise this username belongs to someone.
    isNew = false
    try {
      await signInWithEmailAndPassword(auth, toEmail(u), password)
    } catch (inner) {
      const innerCode = (inner as { code?: string }).code
      if (innerCode === 'auth/invalid-credential' || innerCode === 'auth/user-not-found' || innerCode === 'auth/wrong-password') {
        throw new Error('That username is already taken.')
      }
      throw new Error(innerCode ? prettyError(innerCode) : errorMessage(inner))
    }
  }

  if (isNew) {
    // Straight write — no read first. A read with no cached doc rejects outright
    // when Firestore is still connecting, which used to break every sign-up.
    await saveProfile(db, u, profile)
  } else {
    // Only fill in a profile that is genuinely missing; never reset someone's stats.
    let missing = false
    try {
      missing = !(await getDoc(doc(db, 'users', u))).exists()
    } catch {
      // Can't confirm while offline — assume it exists and leave it alone.
    }
    if (missing) await saveProfile(db, u, profile)
  }

  return { uid: auth.currentUser?.uid ?? '', username: u }
}

async function saveProfile(database: Firestore, u: string, profile: UserDoc) {
  try {
    await setDoc(doc(database, 'users', u), { ...profile, createdAtTs: serverTimestamp() })
  } catch (e) {
    if (auth) await signOut(auth).catch(() => {})
    throw new Error(
      /offline|unavailable|network/i.test(e instanceof Error ? e.message : '')
        ? 'Cannot reach the server. Check your internet connection, then try again.'
        : 'Could not save your profile. Check the Firestore database and rules in the Firebase console.'
    )
  }
}

export async function signIn(username: string, password: string) {
  const u = username.trim().toLowerCase()
  if (!validateUsername(u)) throw new Error('Invalid username.')
  if (!auth) throw new Error('App is not configured yet.')
  try {
    await signInWithEmailAndPassword(auth, toEmail(u), password)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'auth/invalid-credential' || code === 'auth/user-not-found' || code === 'auth/wrong-password') {
      throw new Error('Wrong username or password.')
    }
    if (code) throw new Error(prettyError(code))
    throw e
  }
}

export function authUidFromUser(user: User | null): string | null {
  if (!user?.email) return null
  return user.email.split('@')[0] || null
}

export function watchAuth(cb: (username: string | null) => void) {
  if (!auth) {
    cb(null)
    return () => {}
  }
  return onAuthStateChanged(auth, (user) => cb(authUidFromUser(user)))
}

export function logOut() {
  if (auth) return signOut(auth)
  return Promise.resolve()
}
