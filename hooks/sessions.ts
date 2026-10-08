import type { AgentRow, BeatAgent, Effort, Heartbeat, LiveSession, Snapshot } from '../types'

/** Past this age a machine's snapshot is said to lag. */
export const STALE_MS = 15_000

/** A machine's sessions as the tab draws them: the waiting first, then the working, each newest first. */
export type HostBlock = {
  host: string
  label: string
  /** The snapshot's age in ms; null for this machine, read live. */
  age: number | null
  isStale: boolean
  waiting: LiveSession[]
  working: LiveSession[]
}

/** What this session publishes: its main loop, and its subagents still running. */
export const heartbeatOf = (
  sessionId: string,
  now: number,
  main: { model: string | null; effort: Effort | null },
  isRunning: boolean,
  agents: readonly AgentRow[],
): Heartbeat => ({
  v: 1,
  sessionId,
  updatedAt: now,
  main: { model: main.model, effort: main.effort, isRunning },
  agents: agents
    .filter(one => one.status === 'running')
    .map(one => ({ id: one.id, title: one.title, model: one.model, effort: one.effort, startedAt: one.startedAt })),
})

/** What a heartbeat says, its clock left out: the same content is no news. */
export const contentOf = (beat: Heartbeat) => JSON.stringify([beat.main, beat.agents])

const STATUSES: ReadonlySet<string> = new Set(['busy', 'waiting', 'idle'])
const ORIGINS: ReadonlySet<string> = new Set(['desktop', 'cli', 'worker'])

const isBeatAgent = (one: unknown): one is BeatAgent => {
  const agent = one as Partial<BeatAgent> | null

  return (
    !!agent &&
    typeof agent.id === 'string' &&
    typeof agent.title === 'string' &&
    typeof agent.startedAt === 'number' &&
    (typeof agent.model === 'string' || agent.model === null) &&
    (typeof agent.effort === 'string' || typeof agent.effort === 'number' || agent.effort === null)
  )
}

/** A line of text with its control characters turned into spaces: the engine refuses a tree holding them. */
const plain = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')

const isLiveSession = (one: unknown): one is LiveSession => {
  const session = one as Partial<LiveSession> | null

  return (
    !!session &&
    typeof session.sessionId === 'string' &&
    typeof session.name === 'string' &&
    typeof session.cwd === 'string' &&
    STATUSES.has(String(session.status)) &&
    ORIGINS.has(String(session.origin)) &&
    typeof session.statusUpdatedAt === 'number' &&
    Array.isArray(session.agents)
  )
}

/** A snapshot read from the script's or the sync's JSON, or null when the text is not one. */
export const parseSnapshot = (text: string): Snapshot | null => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const taken = value as Partial<Snapshot> | null
  if (!taken || taken.v !== 1 || typeof taken.host !== 'string' || typeof taken.takenAt !== 'number' || !Array.isArray(taken.sessions)) {
    return null
  }

  return {
    v: 1,
    host: taken.host,
    label: typeof taken.label === 'string' && taken.label !== '' ? taken.label : taken.host,
    takenAt: taken.takenAt,
    sessions: taken.sessions.filter(isLiveSession).map(one => ({
      ...one,
      name: plain(one.name),
      cwd: plain(one.cwd),
      agents: one.agents.filter(isBeatAgent).map(agent => ({ ...agent, title: plain(agent.title) })),
    })),
  }
}

const newest = (a: LiveSession, b: LiveSession) => b.statusUpdatedAt - a.statusUpdatedAt

/** The blocks the tab draws: this machine first, then the others by label; a copy of this machine is dropped. */
export const blocksOf = (own: Snapshot | null, others: readonly Snapshot[], now: number): HostBlock[] => {
  const block = (taken: Snapshot, age: number | null): HostBlock => ({
    host: taken.host,
    label: taken.label,
    age,
    isStale: age !== null && age > STALE_MS,
    waiting: taken.sessions.filter(one => one.status === 'waiting').sort(newest),
    working: taken.sessions.filter(one => one.status !== 'waiting').sort(newest),
  })
  const rest = others
    .filter(one => one.host !== own?.host)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(one => block(one, now - one.takenAt))

  return own === null ? rest : [block(own, null), ...rest]
}

/** A block's title: its label, its counts (none at zero), and its lag when it lags. */
export const titleOf = (block: HostBlock) =>
  [
    block.label,
    ...(block.working.length > 0 ? [`${block.working.length} ${block.working.length === 1 ? 'bosse' : 'bossent'}`] : []),
    ...(block.waiting.length > 0 ? [`${block.waiting.length} ${block.waiting.length === 1 ? 'attend' : 'attendent'}`] : []),
    ...(block.isStale && block.age !== null ? [`synchro en retard (${Math.round(block.age / 1000)} s)`] : []),
  ].join(' · ')

/** The last folder of a working directory: the project. */
export const projectOf = (cwd: string) => cwd.replace(/\/+$/, '').split('/').pop() ?? ''
