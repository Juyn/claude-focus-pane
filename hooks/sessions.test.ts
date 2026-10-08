import { expect, test } from 'claude-code/testing'
import type { AgentRow, LiveSession, Snapshot } from '../types'
import { blocksOf, contentOf, heartbeatOf, parseSnapshot, projectOf, STALE_MS, titleOf } from './sessions'

const NOW = 1_700_000_000_000

const row = (over: Partial<AgentRow>): AgentRow => ({
  id: 'a1', title: 'Recherche', type: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium', status: 'running',
  startedAt: NOW - 5_000, endedAt: null, context: 10, tokens: 10, usd: 0.1, ...over,
})

const live = (over: Partial<LiveSession>): LiveSession => ({
  sessionId: 's', pid: 1, name: 'n', cwd: '/home/x/proj', origin: 'cli', status: 'busy',
  statusUpdatedAt: NOW - 60_000, main: null, agents: [], ...over,
})

const snap = (over: Partial<Snapshot>): Snapshot => ({ v: 1, host: 'h', label: 'H', takenAt: NOW, sessions: [], ...over })

test('a heartbeat carries the main loop and the running subagents only', () => {
  const beat = heartbeatOf('sess', NOW, { model: 'claude-opus-5-5', effort: 'high' }, true, [
    row({ id: 'a1' }),
    row({ id: 'a2', status: 'completed', endedAt: NOW }),
  ])

  expect(beat).toEqual({
    v: 1,
    sessionId: 'sess',
    updatedAt: NOW,
    main: { model: 'claude-opus-5-5', effort: 'high', isRunning: true },
    agents: [{ id: 'a1', title: 'Recherche', model: 'claude-sonnet-5-5', effort: 'medium', startedAt: NOW - 5_000 }],
  })
})

test('the content of a heartbeat leaves its clock out', () => {
  const main = { model: null, effort: null }
  expect(contentOf(heartbeatOf('s', NOW, main, false, []))).toBe(contentOf(heartbeatOf('s', NOW + 15_000, main, false, [])))
  expect(contentOf(heartbeatOf('s', NOW, main, false, []))).not.toBe(contentOf(heartbeatOf('s', NOW, main, true, [])))
})

test('a snapshot is read from its JSON; anything else is none', () => {
  const good = snap({ host: 'claude-vps', label: 'VPS', sessions: [live({ sessionId: 'v1' })] })

  expect(parseSnapshot(JSON.stringify(good))).toEqual(good)
  expect(parseSnapshot('{"v": 1, "host": "x", "takenA')).toBeNull()
  expect(parseSnapshot(JSON.stringify({ ...good, v: 2 }))).toBeNull()
  expect(parseSnapshot('null')).toBeNull()
})

test('a malformed session is dropped, a missing label falls back to the host', () => {
  const text = JSON.stringify({ v: 1, host: 'claude-vps', takenAt: NOW, sessions: [live({ sessionId: 'ok' }), { sessionId: 3 }] })
  const read = parseSnapshot(text)

  expect(read?.label).toBe('claude-vps')
  expect(read?.sessions.map(one => one.sessionId)).toEqual(['ok'])
})

test('blocks: this machine first, the others by label; the waiting before the working, newest first', () => {
  const own = snap({ host: 'Rocinante', label: 'PC', sessions: [
    live({ sessionId: 'old', statusUpdatedAt: NOW - 90_000 }),
    live({ sessionId: 'wait', status: 'waiting', statusUpdatedAt: NOW - 120_000 }),
    live({ sessionId: 'new', statusUpdatedAt: NOW - 10_000 }),
  ] })
  const blocks = blocksOf(own, [
    snap({ host: 'zz', label: 'Z' }),
    snap({ host: 'Rocinante', label: 'PC (copie)' }),
    snap({ host: 'claude-vps', label: 'VPS', takenAt: NOW - 42_000 }),
  ], NOW)

  expect(blocks.map(one => one.host)).toEqual(['Rocinante', 'claude-vps', 'zz'])
  expect(blocks[0]?.waiting.map(one => one.sessionId)).toEqual(['wait'])
  expect(blocks[0]?.working.map(one => one.sessionId)).toEqual(['new', 'old'])
  expect(blocks[0]).toMatchObject({ age: null, isStale: false })
  expect(blocks[1]).toMatchObject({ age: 42_000, isStale: true })
})

test('a snapshot from a clock ahead is never said to lag', () => {
  const [block] = blocksOf(null, [snap({ takenAt: NOW + 5_000 })], NOW)

  expect(block).toMatchObject({ age: -5_000, isStale: false })
  expect(STALE_MS).toBe(15_000)
})

test('a title counts, omits what is zero, and says the lag', () => {
  const base = { host: 'h', label: 'VPS', age: 42_400, isStale: true, waiting: [] as LiveSession[], working: [] as LiveSession[] }

  expect(titleOf({ ...base, working: [live({})] })).toBe('VPS · 1 bosse · synchro en retard (42 s)')
  expect(titleOf({ ...base, isStale: false, working: [live({}), live({})] , waiting: [live({})] })).toBe('VPS · 2 bossent · 1 attend')
  expect(titleOf({ ...base, isStale: false, waiting: [live({}), live({})] })).toBe('VPS · 2 attendent')
  expect(titleOf({ ...base, isStale: false, age: null })).toBe('VPS')
})

test('the project is the last folder of the working directory', () => {
  expect(projectOf('/home/ubuntu/Sites/unlocker-api/')).toBe('unlocker-api')
  expect(projectOf('/home/xavier')).toBe('xavier')
  expect(projectOf('')).toBe('')
})
