import type { ClaimRecord } from './local-config'

/**
 * Days from `now` until `iso`, rounded up, and negative once it has passed.
 *
 * Rounding up is the point: a token minted seconds ago with a 14-day life is
 * "14 days", not the 13.99 that flooring would print. §4's output promises
 * fourteen and the first thing a reader does is check that it says so.
 */
export function daysUntil(iso: string, now: Date): number | undefined {
  const target = Date.parse(iso)
  if (Number.isNaN(target)) return undefined
  const remaining = target - now.getTime()
  return remaining <= 0 ? -1 : Math.ceil(remaining / 86_400_000)
}

/** `2026-08-21` — the date alone; the time of day is noise here. */
export function isoDate(iso: string): string {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? iso : (new Date(parsed).toISOString().split('T')[0] ?? iso)
}

export function claimStatus(claim: ClaimRecord, now: Date): string {
  const days = daysUntil(claim.expiresAt, now)
  if (days === undefined) return `expires ${claim.expiresAt}`
  if (days < 0) return `EXPIRED ${isoDate(claim.expiresAt)}`
  return `expires in ${pluralise(days, 'day')}, ${isoDate(claim.expiresAt)}`
}

/** §4's closing block, reused verbatim by `init` and `claim`. */
export function claimLines(claim: ClaimRecord, now: Date): string[] {
  return ['', `Owner claim link (${claimStatus(claim, now)}):`, `  ${claim.url}`, '']
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? `1 ${singular}` : `${String(count)} ${plural ?? `${singular}s`}`
}
