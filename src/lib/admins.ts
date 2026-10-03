/**
 * Usernames allowed to fund accounts from the dashboard.
 *
 * Add your own username here (lowercase), or set `VITE_ADMIN_USERNAMES` in
 * `.env` as a comma-separated list to grant it without editing this file.
 */
export const ADMIN_USERNAMES: readonly string[] = ['admin22']

export function isAppAdmin(username: string): boolean {
  const me = username.trim().toLowerCase()
  if (!me) return false
  if (ADMIN_USERNAMES.includes(me)) return true
  const extra = import.meta.env?.VITE_ADMIN_USERNAMES
  if (!extra) return false
  return String(extra)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(me)
}
