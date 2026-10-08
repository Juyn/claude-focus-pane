import { expect, test } from 'claude-code/testing'
import type { Drop, Taken } from '../types'
import { BAND_MS, bandDrops, HIGHLIGHTED, INBOX_KEPT, mentionOf, parseTaken, pathOf, sizeOf, stableDrops } from './inbox'

const NOW = 1_700_000_000_000
const seen = (name: string, size = 10, mtimeMs = NOW - 1_000) => ({ name, size, mtimeMs })

test('a file is a drop only once its size and date held still between two reads', () => {
  const before = [seen('done.pdf'), seen('growing.zip', 100), seen('touched.txt', 5, NOW - 9_000)]
  const after = [seen('done.pdf'), seen('growing.zip', 200), seen('touched.txt', 5, NOW - 2_000), seen('new.png')]

  expect(stableDrops(before, after).map(one => one.name)).toEqual(['done.pdf'])
})

test('hidden files never count, drops come newest first, at most INBOX_KEPT', () => {
  const many = Array.from({ length: INBOX_KEPT + 5 }, (_, at) => seen(`f${at}.txt`, 1, NOW - at * 1_000))
  const listing = [...many, seen('.rsync-partial', 0), seen('.secret', 3)]
  const drops = stableDrops(listing, listing)

  expect(drops).toHaveLength(INBOX_KEPT)
  expect(drops[0]?.name).toBe('f0.txt')
  expect(drops.some(one => one.name.startsWith('.'))).toBe(false)
  expect(HIGHLIGHTED).toBe(5)
})

test('the taken map is read from its JSON; anything else is empty', () => {
  const good: Record<string, Taken> = { 'a.pdf': { sessionId: 's1', name: 'Paiements', at: NOW } }

  expect(parseTaken(JSON.stringify(good))).toEqual(good)
  expect(parseTaken('{"a.pdf": {"sessionId": "s1", "na')).toEqual({})
  expect(parseTaken('[]')).toEqual({})
  expect(parseTaken(JSON.stringify({ 'a.pdf': { sessionId: 3 }, 'b.pdf': good['a.pdf'] }))).toEqual({ 'b.pdf': good['a.pdf'] })
})

test('the band offers what arrived in the last 10 minutes, taken by nobody, not set aside here', () => {
  const drops: Drop[] = [
    { name: 'fresh.pdf', size: 1, mtimeMs: NOW - 60_000 },
    { name: 'taken.pdf', size: 1, mtimeMs: NOW - 60_000 },
    { name: 'dismissed.pdf', size: 1, mtimeMs: NOW - 60_000 },
    { name: 'old.pdf', size: 1, mtimeMs: NOW - BAND_MS - 1 },
  ]
  const taken = { 'taken.pdf': { sessionId: 's', name: 'n', at: NOW } }

  expect(bandDrops(drops, taken, ['dismissed.pdf'], NOW).map(one => one.name)).toEqual(['fresh.pdf'])
})

test('a size reads in French units with a decimal comma', () => {
  expect(sizeOf(512)).toBe('512 o')
  expect(sizeOf(2_400)).toBe('2,3 Ko')
  expect(sizeOf(2_400_000)).toBe('2,3 Mo')
  expect(sizeOf(1_300_000_000)).toBe('1,2 Go')
})

test('the mention and the path keep an exotic name exactly', () => {
  const name = 'Relevé de compte : mars 2026 (v2).pdf'

  expect(pathOf('/home/ubuntu/inbox', name)).toBe(`/home/ubuntu/inbox/${name}`)
  expect(mentionOf('/home/ubuntu/inbox', name)).toBe(`@"/home/ubuntu/inbox/${name}" `)
  expect(mentionOf('/home/ubuntu/inbox', 'plain.pdf')).toBe('@/home/ubuntu/inbox/plain.pdf ')
})
