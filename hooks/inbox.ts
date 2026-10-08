import type { Drop, Taken } from '../types'

/** How many files the Drops tab lists. */
export const INBOX_KEPT = 20
/** How many of them are set off as the latest. */
export const HIGHLIGHTED = 5
/** How long a file stays in the band above the prompt after it arrived. */
export const BAND_MS = 10 * 60_000

type Listed = { name: string; size: number; mtimeMs: number }

/** The files that held still between two reads (same size, same date), hidden ones out; newest first. */
export const stableDrops = (before: readonly Listed[], after: readonly Listed[]): Drop[] =>
  after
    .filter(one => !one.name.startsWith('.'))
    .filter(one => before.some(was => was.name === one.name && was.size === one.size && was.mtimeMs === one.mtimeMs))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
    .slice(0, INBOX_KEPT)
    .map(one => ({ name: one.name, size: one.size, mtimeMs: one.mtimeMs }))

const isTaken = (one: unknown): one is Taken => {
  const taken = one as Partial<Taken> | null

  return !!taken && typeof taken.sessionId === 'string' && typeof taken.name === 'string' && typeof taken.at === 'number'
}

/** Who took what, read from inbox-taken.json; a file that is not one counts as empty. */
export const parseTaken = (text: string): Record<string, Taken> => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, Taken] => entry[0] !== '__proto__' && isTaken(entry[1]))
  )
}

/** What the band offers: arrived less than BAND_MS ago, taken by nobody, not set aside in this session. */
export const bandDrops = (drops: readonly Drop[], taken: Record<string, Taken>, dismissed: readonly string[], now: number) =>
  drops.filter(one => now - one.mtimeMs < BAND_MS && !Object.hasOwn(taken, one.name) && !dismissed.includes(one.name))

/** A size as people read it, in French units: 512 o, 2,3 Ko, 2,3 Mo, 1,2 Go. */
export const sizeOf = (bytes: number) => {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  let value = bytes
  let at = 0
  while (value >= 1_024 && at < units.length - 1) {
    value /= 1_024
    at += 1
  }

  if (at === 0) {
    return `${bytes} o`
  }

  // Round to one decimal
  let rounded = Math.round(value * 10) / 10

  // If rounded value is >= 1024 and we can go higher, promote
  while (rounded >= 1_024 && at < units.length - 1) {
    rounded /= 1_024
    at += 1
    rounded = Math.round(rounded * 10) / 10
  }

  return `${rounded.toFixed(1).replace('.', ',')} ${units[at]}`
}

/** The file's absolute path. */
export const pathOf = (dir: string, name: string) => `${dir}/${name}`

/** The mention a prompt takes: quoted when the path holds any character outside the plain set. */
export const mentionOf = (dir: string, name: string) => {
  const path = pathOf(dir, name)

  return /[^A-Za-z0-9._/+-]/.test(path) ? `@"${path}" ` : `@${path} `
}
