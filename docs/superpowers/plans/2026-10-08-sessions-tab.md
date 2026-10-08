# Onglet « Sessions » — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un onglet « Sessions » dans le dock de `focus-pane` qui liste en direct les sessions Claude Code qui bossent ou attendent, sur le PC et sur le VPS, avec leurs sous-agents en cours.

**Architecture:** chaque session publie un battement JSON sur sa machine ; un script Python (`scripts/live_snapshot.py`) fusionne le registre du moteur et ces battements en un instantané ; un service systemd sur le PC (`scripts/live-sync.sh`) échange les instantanés avec le VPS par SSH ; l'onglet lit l'instantané de sa machine (le script) et ceux des autres (fichiers synchronisés). La logique pure de l'onglet vit dans `hooks/sessions.ts`, testée seule.

**Tech Stack:** TypeScript (module de hooks Claude Code, kit `claude-code/testing`), Python 3 stdlib (`unittest`), Bash, systemd utilisateur, SSH.

**Spec:** `docs/superpowers/specs/2026-10-08-sessions-tab-design.md` (à lire avant toute tâche).

**Cartographie du dépôt :** `.exploration-agents.md` (hors git), sections 1–3 et D : gates, modèles à imiter, pièges.

## Global Constraints

- Les `import` montrés au milieu d'un bloc de test vont **en tête du fichier**, fusionnés avec les imports existants du même module.

- Dépôt `~/.claude/mods/focus-pane`, branche `main`, base `c634770`. Baseline : `claude plugin validate .` ✔ ; `bunx --package typescript tsc -p .` sans `error TS` ; `claude plugin test .` → **101 pass, 0 fail**.
- Aucune dépendance nouvelle : Python 3 standard uniquement, aucun paquet npm.
- Textes affichés en français, exactement ceux de la spec et de ce plan.
- Le module de hooks n'a ni DOM ni Node : `$.env.get("HOME")` (littéral), `$.clock.now()`, `$.fs`, `$.process`. Pas de `import()` dynamique.
- Un hook `ui.render` n'écrit jamais d'état (`$.state.set` y est refusé) ; il peut démarrer un timer.
- `update()` écrit **toujours**, même si `fn` rend la valeur d'origine : comparer avant d'appeler si l'on veut éviter une écriture.
- Ne jamais nommer une variable `next` dans un hook (le chargeur refuse, « hooks module did not load »).
- Le hook `turn.step` reste un générateur async ; tout travail après `yield*` dans un try/catch silencieux.
- La synchro ne lit et n'écrit que dans `~/.cache/focus-pane` des deux machines.
- Toute écriture du battement est best effort : une erreur n'interrompt jamais la session.
- Ne pas pousser, ne pas installer le service, ne pas toucher au VPS sans accord explicite de l'utilisateur (Tâche 5).

## Review Focus

1. **Beaucoup de sessions** (le VPS en fait tourner des dizaines) : une session = une rangée, jamais de retour à la ligne (`wrap="truncate-end"`) ; l'onglet défile. → test en Tâche 4 (25 sessions, noms de 120 caractères).
2. **Horloges décalées entre PC et VPS** : un `takenAt` ou un `statusUpdatedAt` dans le futur ne doit ni afficher de durée négative ni marquer « en retard ». → tests en Tâche 2 (âge négatif) et Tâche 4 (`statusUpdatedAt` futur → `0s`).
3. **Nom de session vide ou absent** (worker sans nom) : la rangée montre le projet, sinon les 8 premiers caractères de l'id. → test en Tâche 4.
4. **Pas de `HOME` ou écriture refusée** : aucune exception ne remonte, le lancement d'un sous-agent marche toujours. → test en Tâche 3.
5. **Battement lu pendant son écriture** (JSON tronqué) : sauté pour ce tour, la session reste listée sans sous-agents. → test en Tâche 1.

---

### Task 1: `scripts/live_snapshot.py`, l'instantané d'une machine

**Files:**
- Create: `scripts/live_snapshot.py`
- Create: `scripts/test_live_snapshot.py`

**Interfaces:**
- Consumes: le registre `~/.claude/sessions/<pid>.json` (champs `pid`, `sessionId`, `name`, `cwd`, `status`, `statusUpdatedAt`, `entrypoint`) ; les battements `~/.cache/focus-pane/live/<sessionId>.json` (format du §2.2 de la spec).
- Produces: `python3 scripts/live_snapshot.py [--label L] [--home H] [--proc P]` imprime une ligne JSON `{"v":1,"host","label","takenAt","sessions":[LiveSession…]}` ; fonctions importables `snapshot(home, proc_root, label, now) -> dict`, `label_of(home, asked) -> str`, `main(argv=None) -> int`. `LiveSession` = `{sessionId, pid, name, cwd, origin: 'desktop'|'cli'|'worker', status: 'busy'|'waiting'|'idle', statusUpdatedAt, main: dict|None, agents: list}`.

- [ ] **Step 1: Écrire les tests (rouges)**

`scripts/test_live_snapshot.py` :

```python
"""Tests of live_snapshot: python3 -m unittest discover -s scripts -p 'test_*.py'"""
import contextlib
import io
import json
import os
import socket
import tempfile
import unittest

import live_snapshot as snap

NOW = 1_700_000_000_000
AGENT = {'id': 'a1', 'title': 'Recherche', 'model': 'claude-sonnet-5-5', 'effort': 'medium', 'startedAt': NOW - 5_000}


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = os.path.join(self.tmp.name, 'home')
        self.proc = os.path.join(self.tmp.name, 'proc')
        os.makedirs(os.path.join(self.home, '.claude', 'sessions'))
        os.makedirs(os.path.join(self.home, '.cache', 'focus-pane', 'live'))
        os.makedirs(self.proc)

    def tearDown(self):
        self.tmp.cleanup()

    def session(self, pid, status='busy', entrypoint='claude-desktop', alive=True, **over):
        entry = {
            'pid': pid, 'sessionId': f's{pid}', 'name': f'name {pid}', 'cwd': '/home/x/proj',
            'status': status, 'statusUpdatedAt': NOW - 1_000, 'entrypoint': entrypoint, 'kind': 'interactive', **over,
        }
        with open(os.path.join(self.home, '.claude', 'sessions', f'{pid}.json'), 'w', encoding='utf-8') as held:
            json.dump(entry, held)
        if alive:
            os.makedirs(os.path.join(self.proc, str(pid)))

    def beat(self, session_id, updated, agents=()):
        path = os.path.join(self.home, '.cache', 'focus-pane', 'live', f'{session_id}.json')
        with open(path, 'w', encoding='utf-8') as held:
            json.dump({'v': 1, 'sessionId': session_id, 'updatedAt': updated,
                       'main': {'model': 'claude-opus-5-5', 'effort': 'high', 'isRunning': True}, 'agents': list(agents)}, held)
        return path

    def take(self, label='PC'):
        return snap.snapshot(self.home, self.proc, label, NOW)

    def ids(self, taken):
        return [one['sessionId'] for one in taken['sessions']]

    def test_a_busy_live_session_is_listed_with_its_origin(self):
        self.session(1)
        taken = self.take()
        self.assertEqual(taken['v'], 1)
        self.assertEqual(taken['label'], 'PC')
        self.assertEqual(taken['takenAt'], NOW)
        self.assertEqual(taken['host'], socket.gethostname())
        self.assertEqual(taken['sessions'], [{
            'sessionId': 's1', 'pid': 1, 'name': 'name 1', 'cwd': '/home/x/proj', 'origin': 'desktop',
            'status': 'busy', 'statusUpdatedAt': NOW - 1_000, 'main': None, 'agents': [],
        }])

    def test_a_dead_process_is_not_listed(self):
        self.session(2, alive=False)
        self.assertEqual(self.ids(self.take()), [])

    def test_an_idle_session_is_listed_only_with_running_subagents(self):
        self.session(3, status='idle')
        self.session(4, status='idle')
        self.beat('s4', NOW - 2_000, [AGENT])
        taken = self.take()
        self.assertEqual(self.ids(taken), ['s4'])
        self.assertEqual(taken['sessions'][0]['agents'], [AGENT])
        self.assertEqual(taken['sessions'][0]['main'], {'model': 'claude-opus-5-5', 'effort': 'high', 'isRunning': True})

    def test_waiting_is_listed_and_origins_map(self):
        self.session(5, status='waiting', entrypoint='cli')
        self.session(6, entrypoint='sdk-cli')
        taken = {one['sessionId']: one for one in self.take()['sessions']}
        self.assertEqual(taken['s5']['status'], 'waiting')
        self.assertEqual(taken['s5']['origin'], 'cli')
        self.assertEqual(taken['s6']['origin'], 'worker')

    def test_a_stale_heartbeat_is_ignored_and_an_old_one_removed(self):
        self.session(7)
        self.beat('s7', NOW - 61_000, [AGENT])
        old = self.beat('gone', NOW - 11 * 60_000)
        taken = self.take()
        self.assertEqual(taken['sessions'][0]['main'], None)
        self.assertEqual(taken['sessions'][0]['agents'], [])
        self.assertFalse(os.path.exists(old))

    def test_corrupt_files_are_skipped(self):
        self.session(8)
        with open(os.path.join(self.home, '.claude', 'sessions', '9.json'), 'w', encoding='utf-8') as held:
            held.write('{"pid": 9, "sessi')
        os.makedirs(os.path.join(self.proc, '9'))
        with open(os.path.join(self.home, '.cache', 'focus-pane', 'live', 's8.json'), 'w', encoding='utf-8') as held:
            held.write('{"v": 1, "sessionId": "s8", "upda')
        taken = self.take()
        self.assertEqual(self.ids(taken), ['s8'])
        self.assertEqual(taken['sessions'][0]['main'], None)

    def test_the_label_is_asked_then_the_file_then_the_hostname(self):
        self.assertEqual(snap.label_of(self.home, 'VPS'), 'VPS')
        self.assertEqual(snap.label_of(self.home, ''), socket.gethostname())
        with open(os.path.join(self.home, '.cache', 'focus-pane', 'label'), 'w', encoding='utf-8') as held:
            held.write('PC\n')
        self.assertEqual(snap.label_of(self.home, ''), 'PC')

    def test_main_prints_one_json_line(self):
        self.session(10)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = snap.main(['--label', 'VPS', '--home', self.home, '--proc', self.proc])
        self.assertEqual(code, 0)
        printed = json.loads(out.getvalue())
        self.assertEqual(printed['label'], 'VPS')
        self.assertEqual([one['sessionId'] for one in printed['sessions']], ['s10'])


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 2: Lancer les tests, constater l'échec**

Run: `cd ~/.claude/mods/focus-pane && python3 -m unittest discover -s scripts -p 'test_*.py' -v`
Expected: ERROR `ModuleNotFoundError: No module named 'live_snapshot'`.

- [ ] **Step 3: Écrire le script**

`scripts/live_snapshot.py` :

```python
#!/usr/bin/env python3
"""The live snapshot of this machine: the Claude Code sessions that work or wait, with their subagents.

Reads the engine's registry (~/.claude/sessions/<pid>.json) and the heartbeats focus-pane publishes
(~/.cache/focus-pane/live/<sessionId>.json), and prints one JSON line. Standard library only.
"""
import argparse
import json
import os
import socket
import sys
import time

# A heartbeat older than this says nothing any more; older than PURGE_MS it is removed.
FRESH_MS = 60_000
PURGE_MS = 10 * 60_000
ORIGINS = {'claude-desktop': 'desktop', 'cli': 'cli'}
STATUSES = ('busy', 'waiting', 'idle')


def now_ms():
    return int(time.time() * 1000)


def read_json(path):
    """The file's JSON value, or None when it cannot be read or is not JSON (a file being written)."""
    try:
        with open(path, encoding='utf-8') as held:
            return json.load(held)
    except (OSError, ValueError):
        return None


def is_alive(pid, proc_root):
    return isinstance(pid, int) and pid > 0 and os.path.exists(os.path.join(proc_root, str(pid)))


def heartbeats(live_dir, now):
    """The fresh heartbeats by session id; the ones past PURGE_MS are removed on the way."""
    beats = {}
    try:
        names = os.listdir(live_dir)
    except OSError:
        return beats
    for name in names:
        if not name.endswith('.json'):
            continue
        path = os.path.join(live_dir, name)
        beat = read_json(path)
        updated = beat.get('updatedAt') if isinstance(beat, dict) else None
        if not isinstance(updated, (int, float)):
            continue
        if now - updated > PURGE_MS:
            try:
                os.remove(path)
            except OSError:
                pass
            continue
        if now - updated <= FRESH_MS and isinstance(beat.get('sessionId'), str):
            beats[beat['sessionId']] = beat
    return beats


def snapshot(home, proc_root, label, now):
    """The sessions that work or wait (or rest with subagents running), as one JSON-ready dict."""
    beats = heartbeats(os.path.join(home, '.cache', 'focus-pane', 'live'), now)
    registry = os.path.join(home, '.claude', 'sessions')
    try:
        names = sorted(os.listdir(registry))
    except OSError:
        names = []
    sessions = []
    for name in names:
        if not name.endswith('.json'):
            continue
        entry = read_json(os.path.join(registry, name))
        if not isinstance(entry, dict) or not is_alive(entry.get('pid'), proc_root):
            continue
        status = entry.get('status')
        if status not in STATUSES:
            continue
        beat = beats.get(entry.get('sessionId'))
        agents = beat.get('agents') if beat and isinstance(beat.get('agents'), list) else []
        if status == 'idle' and not agents:
            continue
        updated = entry.get('statusUpdatedAt')
        sessions.append({
            'sessionId': str(entry.get('sessionId') or ''),
            'pid': entry['pid'],
            'name': str(entry.get('name') or ''),
            'cwd': str(entry.get('cwd') or ''),
            'origin': ORIGINS.get(entry.get('entrypoint'), 'worker'),
            'status': status,
            'statusUpdatedAt': updated if isinstance(updated, (int, float)) else now,
            'main': beat.get('main') if beat else None,
            'agents': agents,
        })
    return {'v': 1, 'host': socket.gethostname(), 'label': label, 'takenAt': now, 'sessions': sessions}


def label_of(home, asked):
    """The machine's label: the one asked, else ~/.cache/focus-pane/label, else the hostname."""
    if asked:
        return asked
    try:
        with open(os.path.join(home, '.cache', 'focus-pane', 'label'), encoding='utf-8') as held:
            said = held.read().strip()
        if said:
            return said
    except OSError:
        pass
    return socket.gethostname()


def main(argv=None):
    parser = argparse.ArgumentParser(description='Prints the live snapshot of this machine as one JSON line.')
    parser.add_argument('--label', default='')
    parser.add_argument('--home', default=os.path.expanduser('~'))
    parser.add_argument('--proc', default='/proc')
    args = parser.parse_args(argv)
    taken = snapshot(args.home, args.proc, label_of(args.home, args.label), now_ms())
    sys.stdout.write(json.dumps(taken, separators=(',', ':')) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 4: Lancer les tests, constater le vert**

Run: `cd ~/.claude/mods/focus-pane && python3 -m unittest discover -s scripts -p 'test_*.py' -v`
Expected: `Ran 8 tests` … `OK`.

Puis un essai réel : `python3 scripts/live_snapshot.py --label PC | python3 -m json.tool | head -20` → un JSON avec `"v": 1` et au moins la session courante (`busy`).

- [ ] **Step 5: Commit**

```bash
cd ~/.claude/mods/focus-pane
chmod +x scripts/live_snapshot.py
git add scripts/live_snapshot.py scripts/test_live_snapshot.py
git commit -m "feat: live_snapshot.py prints the sessions of this machine that work or wait, with their subagents"
```

---

### Task 2: `hooks/sessions.ts`, la logique pure de l'onglet

**Files:**
- Modify: `types/index.d.ts` (nouveaux types + clé `sessionsView` du contrat)
- Create: `hooks/sessions.ts`
- Create: `hooks/sessions.test.ts`

**Interfaces:**
- Consumes: `AgentRow`, `Effort` de `types/index.d.ts`.
- Produces (types, dans `types/index.d.ts`) : `BeatAgent`, `Heartbeat`, `LiveSession`, `Snapshot`, `SessionsView`, et `sessionsView: SessionsView` sous `PluginState['focus-pane']`.
- Produces (fonctions, `hooks/sessions.ts`) :
  - `STALE_MS = 15_000`
  - `type HostBlock = { host: string; label: string; age: number | null; isStale: boolean; waiting: LiveSession[]; working: LiveSession[] }`
  - `heartbeatOf(sessionId: string, now: number, main: { model: string | null; effort: Effort | null }, isRunning: boolean, agents: readonly AgentRow[]): Heartbeat`
  - `contentOf(beat: Heartbeat): string`
  - `parseSnapshot(text: string): Snapshot | null`
  - `blocksOf(own: Snapshot | null, others: readonly Snapshot[], now: number): HostBlock[]`
  - `titleOf(block: HostBlock): string`
  - `projectOf(cwd: string): string`

- [ ] **Step 1: Ajouter les types au contrat**

Dans `types/index.d.ts`, après le type `MainLoop`, ajouter :

```ts
/** One running subagent, as a session's heartbeat publishes it. */
export type BeatAgent = { id: string; title: string; model: string | null; effort: Effort | null; startedAt: number }

/** What a session publishes about itself in ~/.cache/focus-pane/live/<sessionId>.json. */
export type Heartbeat = {
  v: 1
  sessionId: string
  updatedAt: number
  main: { model: string | null; effort: Effort | null; isRunning: boolean }
  agents: BeatAgent[]
}

/** One session that works or waits, as a machine's snapshot lists it. */
export type LiveSession = {
  sessionId: string
  pid: number
  name: string
  cwd: string
  origin: 'desktop' | 'cli' | 'worker'
  status: 'busy' | 'waiting' | 'idle'
  statusUpdatedAt: number
  main: Heartbeat['main'] | null
  agents: BeatAgent[]
}

/** A machine's live snapshot, as scripts/live_snapshot.py prints it. */
export type Snapshot = { v: 1; host: string; label: string; takenAt: number; sessions: LiveSession[] }

/** What the Sessions tab draws from: the snapshots last read, raw; ages are worked out when drawn. */
export type SessionsView = {
  /** This machine's snapshot; null when the script gave none. */
  own: Snapshot | null
  /** The other machines' snapshots, as the sync left them in ~/.cache/focus-pane/hosts. */
  others: Snapshot[]
  /** This session's id, to mark its row (ici). */
  here: string
  /** When they were read; null before the first read. */
  readAt: number | null
}
```

et, dans `PluginState['focus-pane']` (à côté de `mainLoop: MainLoop`) : `sessionsView: SessionsView`.

- [ ] **Step 2: Écrire les tests (rouges)**

`hooks/sessions.test.ts` :

```ts
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
  expect(titleOf({ ...base, isStale: false, working: [live({}), live({})], waiting: [live({})] })).toBe('VPS · 2 bossent · 1 attend')
  expect(titleOf({ ...base, isStale: false, waiting: [live({}), live({})] })).toBe('VPS · 2 attendent')
  expect(titleOf({ ...base, isStale: false, age: null })).toBe('VPS')
})

test('the project is the last folder of the working directory', () => {
  expect(projectOf('/home/ubuntu/Sites/unlocker-api/')).toBe('unlocker-api')
  expect(projectOf('/home/xavier')).toBe('xavier')
  expect(projectOf('')).toBe('')
})
```

- [ ] **Step 3: Lancer les tests, constater l'échec**

Run: `cd ~/.claude/mods/focus-pane && claude plugin test . 2>&1 | tail -15`
Expected: les tests de `hooks/sessions.test.ts` échouent (module `./sessions` introuvable) ; les 101 autres passent.

- [ ] **Step 4: Écrire le module**

`hooks/sessions.ts` :

```ts
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

  return !!agent && typeof agent.id === 'string' && typeof agent.title === 'string' && typeof agent.startedAt === 'number'
}

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
    sessions: taken.sessions.filter(isLiveSession).map(one => ({ ...one, agents: one.agents.filter(isBeatAgent) })),
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
```

- [ ] **Step 5: Lancer les gates, constater le vert**

Run:
```bash
cd ~/.claude/mods/focus-pane
claude plugin validate . 2>&1 | tail -1
bunx --package typescript tsc -p . 2>&1 | grep -c "error TS"
claude plugin test . 2>&1 | grep -E "^\(fail\)|pass$|fail$"
```
Expected : `✔ Validation passed` ; `0` ; `109 pass`, `0 fail` (101 + 8).

- [ ] **Step 6: Commit**

```bash
git add types/index.d.ts hooks/sessions.ts hooks/sessions.test.ts
git commit -m "feat: the Sessions tab's pure logic — heartbeats, snapshots, blocks and titles"
```

---

### Task 3: le battement publié par chaque session

**Files:**
- Modify: `hooks/register.tsx` (fonction `publishBeat`, timer, appels aux changements)
- Modify: `hooks/focus-pane.test.ts` (simulations `env.get`, `session.id`, `fs.*` dans `engine()` ; nouveaux tests)

**Interfaces:**
- Consumes: `heartbeatOf`, `contentOf` de `./sessions` ; atomes `mainLoop`, `turn`, `agents`.
- Produces: `publishBeat($: EngineInterface, isForced?: boolean): Promise<void>` (module-level dans `register.tsx`) ; le fichier `$HOME/.cache/focus-pane/live/<sessionId>.json`.

- [ ] **Step 1: Simuler `env.get`, `session.id` et `fs.*` dans `engine()`**

En tête de `hooks/focus-pane.test.ts`, à côté de `stepped` :

```ts
import type { FsEntry } from 'claude-code'

/** What the plugin wrote with $.fs.write, in order. */
const written: { path: string; text: string }[] = []
/** What $.fs.read answers, by path, and what $.fs.list answers, by directory. */
const files = new Map<string, string>()
const folders = new Map<string, FsEntry[]>()
```

(fusionner l'import de `FsEntry` dans l'import de types existant depuis `'claude-code'`), et dans `engine()`, après `spawned = 0` :

```ts
  written.length = 0
  files.clear()
  folders.clear()
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('session.id', () => ({ value: 'session-test' }))
  on('fs.write', (_$, e) => {
    written.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', (_$, e) => ({ value: folders.get(e.path) ?? [] }))
```

Run: `claude plugin test . 2>&1 | grep -E "pass$|fail$"` → toujours `109 pass`, `0 fail` (aucun test ne dépendait de ces opérations).

- [ ] **Step 2: Écrire les tests (rouges)**

Dans `hooks/focus-pane.test.ts`, après les tests de la ligne Principal :

```ts
import type { Heartbeat } from '../types'

const BEAT = '/home/test/.cache/focus-pane/live/session-test.json'
const beats = () => written.filter(one => one.path === BEAT).map(one => JSON.parse(one.text) as Heartbeat)

test('the session publishes its heartbeat at start, then at each real change only', async ($, on) => {
  await start($, on)
  expect(beats()).toHaveLength(1)
  expect(beats()[0]).toMatchObject({ v: 1, sessionId: 'session-test', agents: [], main: { isRunning: false } })

  const id = await launch($, 'Chercheur')
  expect(beats()).toHaveLength(2)
  expect(beats()[1]?.agents).toMatchObject([{ id, title: 'Chercheur' }])

  // The first step tells the agent's effort and model; a second, alike, only makes its context grow.
  await step($, id, SMALL)
  const told = beats().length
  await step($, id, SMALL)
  expect(beats()).toHaveLength(told)

  await finish($, id, 'answer')
  expect(beats()).toHaveLength(told + 1)
  expect(beats().at(-1)?.agents).toEqual([])
})

test('the heartbeat is written again every 15 s, changed or not', async ($, on) => {
  const clock = await start($, on)
  await clock.advance(15_000)

  expect(beats()).toHaveLength(2)
})

test('the main loop and its turn reach the heartbeat', async ($, on) => {
  await start($, on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'go', turnId: 'main' })
  await mainStep($, OPUS, 'high')

  expect(beats().at(-1)?.main).toEqual({ model: OPUS, effort: 'high', isRunning: true })
})

test('with no HOME nothing is written, and a subagent still starts', async ($, on) => {
  await start($, on)
  on('env.get', () => ({ value: undefined }))
  written.length = 0
  const id = await launch($, 'Sans maison')

  expect(id).not.toBe('')
  expect(beats()).toHaveLength(0)
})
```

(Si le kit refuse un second `on('env.get')` après `engine()`, remplacer ce dernier test par une variante de `engine()` paramétrée par `home: string | undefined`, sans toucher aux autres tests.)

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)|pass$|fail$"`
Expected: les 4 nouveaux tests en `(fail)` (aucun battement écrit).

- [ ] **Step 3: Implémenter `publishBeat`**

Dans `hooks/register.tsx` :

1. Importer : `import { contentOf, heartbeatOf } from './sessions'`.
2. Près de `agentTicker`, au niveau du module :

```ts
/** The heartbeat's content last written, and the timer keeping it fresh: module values, a reload writes anew. */
let beatWritten = ''
let beatTimer: Timer | undefined

/** Publishes this session's heartbeat when what it says changed, or always when `isForced`. */
const publishBeat = async ($: EngineInterface, isForced = false) => {
  const home = await $.env.get('HOME')
  if (!home) return
  const id = await $.session.id()
  const beat = heartbeatOf(id, await $.clock.now(), await read($, mainLoop), (await read($, turn)).isRunning, await read($, agents))
  const content = contentOf(beat)
  if (!isForced && content === beatWritten) return
  beatWritten = content
  await $.fs.write(`${home}/.cache/focus-pane/live/${id}.json`, JSON.stringify(beat))
}
```

3. Dans `on('session.start', …)`, juste après `await tick($).catch(() => undefined)` :

```ts
    // The heartbeat: written now, then every 15 s as a sign of life; a reload drops the old timer.
    await publishBeat($, true).catch(() => undefined)
    try {
      beatTimer?.cancel()
    } catch {
      // A timer of an engine long gone.
    }
    beatTimer = $.clock.every(15_000, () => {
      void publishBeat($, true).catch(() => undefined)
    })
```

4. Appeler `await publishBeat($).catch(() => undefined)` (sans `isForced`) :
   - dans `on('agent.spawn', …)`, juste après `await tick($)` ;
   - à la fin de `endAgent` et de `reconcileAgents`, après leur `await tick($)` ;
   - à la fin de `noteStep`, après son `await tick($)` (une rangée peut y naître) ;
   - dans `on('turn.start', …)`, juste après l'`update($, turn, …)` ;
   - dans `on('turn.complete', …)`, branche principale, juste après l'`update($, turn, …)` ;
   - dans la branche principale de `turn.step`, dans le try, après l'éventuel `update($, mainLoop, …)`.

   Ne pas l'appeler depuis la commande `demo` : les agents de démonstration ne se publient pas.

- [ ] **Step 4: Lancer les gates, constater le vert**

Run:
```bash
claude plugin validate . 2>&1 | tail -1
bunx --package typescript tsc -p . 2>&1 | grep -c "error TS"
claude plugin test . 2>&1 | grep -E "^\(fail\)|pass$|fail$"
```
Expected : `✔ Validation passed` ; `0` ; `113 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add hooks/register.tsx hooks/focus-pane.test.ts
git commit -m "feat: each session publishes its heartbeat — main loop and running subagents — at each change and every 15 s"
```

---

### Task 4: l'onglet « Sessions »

**Files:**
- Modify: `hooks/register.tsx` (pane `SESSIONS`, atome `sessionsView`, lecture périodique, commande, bouton, rendu)
- Modify: `hooks/focus-pane.test.ts` (paramètre de `start()`, tests de l'onglet)

**Interfaces:**
- Consumes: `parseSnapshot`, `blocksOf`, `titleOf`, `projectOf`, type `HostBlock` de `./sessions` ; types `BeatAgent`, `LiveSession`, `Snapshot`, `SessionsView` de `../types` ; helpers existants `TONES`, `skin`, `quiet`, `chip`, `legend`, `cut`, `clock`, `span`, `tierOf`, `modelName`, `HEADER_CLEARANCE`.
- Produces: pane d'id `'sessions'` ; `/mission sessions` ; bouton `sessions:open` (hotkey `s`) dans le titre d'AGENTS ; clés de rendu `sessions:host:<host>`, `sessions:row:<sessionId>`, `sessions:agent:<agentId>`, `sessions:back`.

- [ ] **Step 1: Rendre `start()` paramétrable**

Dans `hooks/focus-pane.test.ts`, remplacer la simulation de `process.run` de `start()` :

```ts
type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const FAILED: Ran = { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
/** Every argv $.process.run was called with, in order. */
const runs: string[][] = []

const start = async ($: Engine, on: On, run: (argv: readonly string[]) => Ran = () => FAILED) => {
  const clock = engine(on)
  runs.length = 0
  // … (les autres simulations inchangées)
  on('process.run', ($$, e) => {
    runs.push([...e.argv])

    return { value: run(e.argv) }
  })
  // … (session.start inchangé)
}
```

Run: `claude plugin test . 2>&1 | grep -E "pass$|fail$"` → `113 pass`, `0 fail`.

- [ ] **Step 2: Écrire les tests (rouges)**

```ts
import type { LiveSession, Snapshot } from '../types'

const SESSIONS = 'sessions'
const T0 = 1_700_000_000_000

const live = (over: Partial<LiveSession>): LiveSession => ({
  sessionId: 's', pid: 1, name: 'n', cwd: '/home/x/proj', origin: 'cli', status: 'busy',
  statusUpdatedAt: T0 - 60_000, main: null, agents: [], ...over,
})
const OWN: Snapshot = {
  v: 1, host: 'Rocinante', label: 'PC', takenAt: T0,
  sessions: [
    live({
      sessionId: 'session-test', name: 'Mod Claude', origin: 'desktop', statusUpdatedAt: T0 - 5_000,
      agents: [{ id: 'ag1', title: 'Recherche API', model: 'claude-sonnet-5-5', effort: 'medium', startedAt: T0 - 30_000 }],
    }),
    live({ sessionId: 'w1', name: 'Attend', status: 'waiting', statusUpdatedAt: T0 - 120_000 }),
  ],
}
const REMOTE: Snapshot = { v: 1, host: 'claude-vps', label: 'VPS', takenAt: T0 - 42_000, sessions: [live({ sessionId: 'v1', name: 'Paiements', cwd: '/home/ubuntu/Sites' })] }
const HOSTS = '/home/test/.cache/focus-pane/hosts'

/** A started session whose snapshot script answers `own`, with `remote` left by the sync. */
const sessionsStart = async ($: Engine, on: On, own: Snapshot | null, remote: Snapshot[]) => {
  const clock = await start($, on, argv =>
    argv.some(one => one.endsWith('/scripts/live_snapshot.py')) && own !== null ? { ...FAILED, exitCode: 0, stdout: JSON.stringify(own) } : FAILED,
  )
  folders.set(HOSTS, remote.map((_, at) => ({ name: `h${at}.json`, kind: 'file' as const, size: 1 })))
  remote.forEach((one, at) => files.set(`${HOSTS}/h${at}.json`, JSON.stringify(one)))
  await $.command.run({ command: 'mission', args: 'sessions', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })

  return clock
}

const sessionsPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'focus-pane', surface, component: 'Pane', requestId: SESSIONS, props: { ...PROPS, bodyColumns: 100, placement: 'dock' as const } })

/** Every `sessions:` key of a drawn tree, in drawing order. */
const sessionKeys = (tree: unknown) => {
  const keys: string[] = []
  const walk = (node: unknown) => {
    const one = node as Drawn
    if (!one || typeof one !== 'object') return
    const key = String(one.props?.key ?? '')
    if (/^sessions:(host|row|agent):/.test(key)) keys.push(key)
    for (const child of one.children ?? []) walk(child)
  }
  walk(tree)

  return keys
}

test('/mission sessions opens the tab: this machine first, the waiting before the working, subagents under their session', async ($, on) => {
  await sessionsStart($, on, OWN, [REMOTE])
  const pane = await sessionsPane($)

  expect(sessionKeys(await pane.drawn())).toEqual([
    'sessions:host:Rocinante', 'sessions:row:w1', 'sessions:row:session-test', 'sessions:agent:ag1',
    'sessions:host:claude-vps', 'sessions:row:v1',
  ])
})

test('a row names the session, (ici), its project, origin and time; a subagent its tier and model', async ($, on) => {
  await sessionsStart($, on, OWN, [REMOTE])
  const pane = await sessionsPane($)
  const here = await pane.find({ key: 'sessions:row:session-test' })
  const agent = await pane.find({ key: 'sessions:agent:ag1' })

  expect(here?.text).toContain('Mod Claude (ici)')
  expect(here?.text).toContain('proj · desktop · 5s')
  expect(agent?.text).toContain('Recherche API')
  expect(agent?.text).toContain('medium')
  expect(agent?.text).toContain('Sonnet 5.5')
  expect((await pane.find({ key: 'sessions:row:w1' }))?.text).toContain('⏸')
})

test('each block says its counts, and a lagging machine its lag', async ($, on) => {
  await sessionsStart($, on, OWN, [REMOTE])
  const pane = await sessionsPane($)

  expect((await pane.find({ key: 'sessions:host:Rocinante' }))?.text).toContain('PC · 1 bosse · 1 attend')
  expect((await pane.find({ key: 'sessions:host:claude-vps' }))?.text).toContain('VPS · 1 bosse · synchro en retard (42 s)')
})

test('no snapshot from the script and no other machine: the tab says both', async ($, on) => {
  await sessionsStart($, on, null, [])
  const pane = await sessionsPane($)

  expect(await pane.find({ text: 'instantané indisponible (python3 ?)' })).toBeDefined()
  expect(await pane.find({ text: 'autre machine jamais synchronisée (install.sh --sync <alias>)' })).toBeDefined()
})

test('a machine with nothing running says so', async ($, on) => {
  await sessionsStart($, on, { ...OWN, sessions: [] }, [])
  const pane = await sessionsPane($)

  expect(await pane.find({ text: 'rien ne tourne' })).toBeDefined()
})

test('the tab reads again every 3 s while open', async ($, on) => {
  const clock = await sessionsStart($, on, OWN, [])
  const reads = () => runs.filter(argv => argv.some(one => one.endsWith('/scripts/live_snapshot.py'))).length
  const before = reads()
  await clock.advance(3_000)

  expect(reads()).toBe(before + 1)
})

test('the Focus pane offers s for the Sessions tab', async ($, on) => {
  await start($, on)
  const opened: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  const pane = await tallPane($)
  await pane.press({ key: 'sessions:open' })

  expect(opened).toContain('sessions')
})

test('many sessions with long names: one row each, cut, never wrapped', async ($, on) => {
  const many = Array.from({ length: 25 }, (_, at) => live({ sessionId: `m${at}`, name: 'x'.repeat(120), statusUpdatedAt: T0 - at * 1_000 }))
  await sessionsStart($, on, { ...OWN, sessions: many }, [])
  const pane = await sessionsPane($)

  expect(sessionKeys(await pane.drawn()).filter(key => key.startsWith('sessions:row:'))).toHaveLength(25)
  for (const at of [0, 24]) {
    const row = await pane.find({ key: `sessions:row:m${at}` })
    expect(row?.text.includes('\n')).toBe(false)
  }
})

test('a session with no name shows its project; a time from a clock ahead shows 0s', async ($, on) => {
  await sessionsStart($, on, { ...OWN, sessions: [live({ sessionId: 'nameless', name: '', cwd: '/srv/worker-7', statusUpdatedAt: T0 + 9_000 })] }, [])
  const row = await (await sessionsPane($)).find({ key: 'sessions:row:nameless' })

  expect(row?.text).toContain('worker-7')
  expect(row?.text).toContain('0s')
})

test('the Sessions tab draws on the desktop too', async ($, on) => {
  await sessionsStart($, on, OWN, [REMOTE])
  const pane = await sessionsPane($, 'desktop')

  expect(sessionKeys(await pane.drawn())).toHaveLength(6)
})
```

Notes pour l'implémenteur :
- Si `on('ui.open')` déjà posé par `start()` empêche la capture du dernier test, ajouter à `start()` un tableau module `opened: string[]` rempli par sa propre simulation de `ui.open`, au lieu d'un second `on`.
- Vérifier dans les types de `claude-code/testing` comment `find(...).text` agrège les textes (concaténation des enfants) ; ajuster les `toContain` au séparateur réel, jamais le texte affiché.

Run: `claude plugin test . 2>&1 | grep -E "^\(fail\)|pass$|fail$"` → les 10 nouveaux tests en `(fail)`.

- [ ] **Step 3: Implémenter l'état et la lecture**

Dans `hooks/register.tsx` :

1. Imports : `import { blocksOf, contentOf, heartbeatOf, parseSnapshot, projectOf, titleOf } from './sessions'` et `import type { HostBlock } from './sessions'` ; ajouter `BeatAgent, LiveSession, SessionsView, Snapshot` à l'import de types depuis `'../types'`.
2. À côté de `GALLERY` : `const SESSIONS = 'sessions'`.
3. À côté des atomes : `const sessionsView = atom({ plugin: 'focus-pane', key: 'sessionsView' } as const, { own: null, others: [], here: '', readAt: null })`.
4. Au niveau du module, près de `publishBeat` :

```ts
/** Refreshes the Sessions tab every 3 s while it is open: a module value, a reload drops it with its timer. */
let sessionsTimer: Timer | undefined

/** Reads this machine's snapshot (the script) and the others' (the sync's files) into the tab's atom. */
const readSessions = async ($: EngineInterface) => {
  const ran = await $.process.run(['python3', `${$.plugin.root}/scripts/live_snapshot.py`]).catch(() => null)
  const own = ran !== null && ran.exitCode === 0 ? parseSnapshot(ran.stdout) : null
  const others: Snapshot[] = []
  const home = await $.env.get('HOME')
  if (home) {
    const dir = `${home}/.cache/focus-pane/hosts`
    for (const one of await $.fs.list(dir).catch(() => [])) {
      if (one.kind !== 'file' || !one.name.endsWith('.json')) continue
      const text = await $.fs.read(`${dir}/${one.name}`).catch(() => '')
      const taken = typeof text === 'string' ? parseSnapshot(text) : null
      if (taken !== null && taken.host !== own?.host) others.push(taken)
    }
  }
  const here = await $.session.id().catch(() => '')
  const now = await $.clock.now()
  await update($, sessionsView, () => ({ own, others, here, readAt: now }))
}

/** Starts the 3 s refresh unless it runs already. */
const keepSessionsFresh = ($: EngineInterface) => {
  if (sessionsTimer !== undefined) return
  sessionsTimer = $.clock.every(3_000, () => {
    void readSessions($).catch(() => undefined)
  })
}

/** Stops the refresh: the tab was closed. */
const stopSessions = () => {
  try {
    sessionsTimer?.cancel()
  } catch {
    // A timer of an engine long gone.
  }
  sessionsTimer = undefined
}

/** Opens the Sessions tab, read once at once, then every 3 s. */
const openSessions = async ($: EngineInterface) => {
  await readSessions($).catch(() => undefined)
  const opened = await $.ui.open({ id: SESSIONS, title: 'Sessions', focus: true })
  keepSessionsFresh($)

  return opened
}
```

5. Dans `on('command.run', …)`, juste avant `const isMission = args.startsWith('mission ')` :

```ts
    if (args === 'sessions') {
      const opened = await openSessions($)

      return { text: opened.isPlaced ? 'Focus pane: onglet Sessions ouvert.' : "Focus pane: élargis le terminal pour l'onglet Sessions." }
    }
```

6. Après `on('ui.close', { id: PANE }, …)` :

```ts
  on('ui.close', { id: SESSIONS }, async ($, e, next) => {
    stopSessions()

    return next(e)
  })
```

7. Dans `on('ui.press', …)` : la garde devient `if (e.requestId !== PANE && e.requestId !== GALLERY && e.requestId !== SESSIONS) return next(e)`, et la chaîne de `else if` gagne :

```ts
    } else if (kind === 'sessions' && verb === 'open') {
      await openSessions($).catch(() => undefined)
    } else if (kind === 'sessions' && verb === 'back') {
      await $.ui.open({ id: PANE, title: 'Focus', focus: true }).catch(() => undefined)
```

- [ ] **Step 4: Le bouton `s` dans Focus**

Dans le rendu du pane Focus :
- rangée de titre d'AGENTS, dans la `Box` de droite, après le bouton `agents:fold` (toujours présent, même quand `isEmpty`) :
  `<Button key="sessions:open" plain hotkey="s" label="sessions" dimColor onPress={() => undefined} />`
- `titleRoom` retire aussi `'sessions'.length + 1` ;
- la légende `footer` gagne `['s', 'Sessions']` juste avant `['ctrl+x tab', 'Clavier']`.

Les tests existants qui comparent la légende ou la largeur du titre exactement peuvent rougir : ajuster leur attendu à l'entrée `s Sessions` / au bouton, rien d'autre ; tout autre changement de résultat est un bug à rapporter.

- [ ] **Step 5: Le rendu de l'onglet**

Après le rendu du pane `GALLERY` :

```tsx
  // The Sessions tab: what works now, on this machine and on the ones the sync mirrors.
  on('ui.render', { component: 'Pane', requestId: SESSIONS }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const tone = TONES[await read($, skin)]
    const parts: Elements = { Box, Text, Svg: e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined }
    const room = Math.max(24, e.props.bodyColumns) - 2
    const inner = room - 4
    const seen: SessionsView = await read($, sessionsView)
    const now = await $.clock.now()
    // After a reload the tab may be up with no timer behind it.
    keepSessionsFresh($)
    const blocks: HostBlock[] = blocksOf(seen.own, seen.others, now)

    const sessionRow = (one: LiveSession) => {
      const isWaiting = one.status === 'waiting'
      const name = `${one.name || projectOf(one.cwd) || one.sessionId.slice(0, 8)}${one.sessionId === seen.here ? ' (ici)' : ''}`
      const right = `${projectOf(one.cwd)} · ${one.origin} · ${span(now - one.statusUpdatedAt)}`

      return (
        <Box key={`sessions:row:${one.sessionId}`} flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
          <Text backgroundColor={tone.card} wrap="truncate-end">
            <Text color={isWaiting ? tone.bad : tone.mark} backgroundColor={tone.card}>{isWaiting ? '⏸' : '●'}</Text>
            <Text bold color={tone.text} backgroundColor={tone.card}>{` ${cut(name, Math.max(8, inner - right.length - 3))}`}</Text>
          </Text>
          <Text {...quiet(tone, tone.card)} wrap="truncate-end">{right}</Text>
        </Box>
      )
    }

    const agentRow = (one: BeatAgent) => {
      const tier = tierOf(one.effort)
      const right = [one.model === null ? '' : modelName(one.model), clock(now - one.startedAt)].filter(part => part !== '').join(' · ')

      return (
        <Box key={`sessions:agent:${one.id}`} flexDirection="row" width="100%" justifyContent="space-between" columnGap={1}>
          <Text {...quiet(tone, tone.card)} wrap="truncate-end">
            {`  ↳ ${cut(one.title, Math.max(8, inner - right.length - (tier?.length ?? 0) - 8))}`}
          </Text>
          <Text backgroundColor={tone.card} wrap="truncate-end">
            {tier !== null && <Text bold color={tone.tiers[tier]} backgroundColor={tone.card}>{tier}</Text>}
            <Text {...quiet(tone, tone.card)}>{`${tier === null ? '' : ' · '}${right}`}</Text>
          </Text>
        </Box>
      )
    }

    const blockNode = (block: HostBlock) => (
      <Box
        key={`sessions:host:${block.host}`}
        flexDirection="column"
        width="100%"
        borderStyle="round"
        borderColor={tone.frame}
        backgroundColor={tone.card}
        paddingX={1}
      >
        <Text bold color={block.isStale ? tone.bad : tone.text} backgroundColor={tone.card} wrap="truncate-end">
          {titleOf(block)}
        </Text>
        {block.waiting.length + block.working.length === 0 && <Text {...quiet(tone, tone.card)}>rien ne tourne</Text>}
        {[...block.waiting, ...block.working].flatMap(one => [sessionRow(one), ...one.agents.map(agentRow)])}
      </Box>
    )

    return (
      <Box flexDirection="column" width="100%" minHeight={e.props.scroll.bodyRows} paddingX={1} rowGap={1} backgroundColor={tone.panel}>
        <Box flexDirection="row" width="100%" justifyContent="space-between" columnGap={2} paddingRight={HEADER_CLEARANCE}>
          {chip(parts, 'SESSIONS', tone.liveBackground, tone.liveText)}
          <Button key="sessions:back" plain hotkey="b" label="retour" onPress={() => undefined} />
        </Box>
        {seen.readAt === null && <Text {...quiet(tone, tone.panel)}>lecture en cours…</Text>}
        {seen.readAt !== null && seen.own === null && (
          <Text color={tone.bad} backgroundColor={tone.panel}>instantané indisponible (python3 ?)</Text>
        )}
        {blocks.map(blockNode)}
        {seen.readAt !== null && seen.others.length === 0 && (
          <Text {...quiet(tone, tone.panel)}>autre machine jamais synchronisée (install.sh --sync &lt;alias&gt;)</Text>
        )}
        <Box flexGrow={1} />
        {legend(parts, tone, [
          ['b', 'Retour au focus'],
          ['ctrl+x tab', 'Clavier'],
          ['esc', 'Rendre la main'],
        ])}
      </Box>
    )
  })
```

Si `claude plugin validate .` ou un test signale une prop refusée (le moteur dessine alors le sien), lire la raison et corriger la prop — ne pas changer la structure.

- [ ] **Step 6: Lancer les gates, constater le vert**

Run:
```bash
claude plugin validate . 2>&1 | tail -1
bunx --package typescript tsc -p . 2>&1 | grep -c "error TS"
claude plugin test . 2>&1 | grep -E "^\(fail\)|pass$|fail$"
python3 -m unittest discover -s scripts -p 'test_*.py' 2>&1 | tail -1
```
Expected : `✔ Validation passed` ; `0` ; `123 pass`, `0 fail` ; `OK`.

- [ ] **Step 7: Commit**

```bash
git add hooks/register.tsx hooks/focus-pane.test.ts
git commit -m "feat: the Sessions tab — what works or waits now, on every machine the sync mirrors, subagents under their session"
```

---

### Task 5: la synchro PC ↔ VPS, l'installation et la recette

**Files:**
- Create: `scripts/live-sync.sh`
- Modify: `install.sh` (option `--sync <alias>`)
- Modify: `README.md` (section Sessions)

**Interfaces:**
- Consumes: `scripts/live_snapshot.py` (Tâche 1), présent dans `~/.claude/mods/focus-pane` des deux machines.
- Produces: `~/.cache/focus-pane/hosts/<alias>.json` sur le PC, `~/.cache/focus-pane/hosts/<hostname-PC>.json` sur le VPS, `~/.cache/focus-pane/label` des deux côtés ; le service `focus-pane-sync.service`.

- [ ] **Step 1: Écrire `scripts/live-sync.sh`**

```bash
#!/usr/bin/env bash
# Mirrors the live snapshots between this machine and one reached by SSH, every few seconds:
# theirs lands here in ~/.cache/focus-pane/hosts/<alias>.json, ours there in hosts/<hostname>.json.
# Runs on the machine that can reach the other (the PC). Touches nothing outside ~/.cache/focus-pane.
# Usage: live-sync.sh <ssh-alias> [local-label] [remote-label] [interval-seconds]
set -u

remote="${1:?usage: live-sync.sh <ssh-alias> [local-label] [remote-label] [interval]}"
local_label="${2:-PC}"
remote_label="${3:-VPS}"
interval="${4:-3}"
here="$(cd "$(dirname "$0")" && pwd)"
cache="$HOME/.cache/focus-pane"
local_host="$(hostname)"
ssh_cmd=(ssh -o BatchMode=yes -o ConnectTimeout=5 -o ControlMaster=auto -o ControlPersist=60
  -o "ControlPath=$cache/ssh-%C" "$remote")

mkdir -p "$cache/hosts" "$cache/live"
printf '%s\n' "$local_label" > "$cache/label"
"${ssh_cmd[@]}" "mkdir -p ~/.cache/focus-pane/hosts ~/.cache/focus-pane/live && printf '%s\n' '$remote_label' > ~/.cache/focus-pane/label" || true

while :; do
  # Ours, here and there.
  if python3 "$here/live_snapshot.py" > "$cache/hosts/$local_host.json.tmp" 2>/dev/null; then
    mv "$cache/hosts/$local_host.json.tmp" "$cache/hosts/$local_host.json"
    "${ssh_cmd[@]}" "cat > ~/.cache/focus-pane/hosts/$local_host.json.tmp && mv ~/.cache/focus-pane/hosts/$local_host.json.tmp ~/.cache/focus-pane/hosts/$local_host.json" \
      < "$cache/hosts/$local_host.json" 2>/dev/null || true
  fi
  # Theirs, here: only a complete answer replaces the last one.
  if "${ssh_cmd[@]}" 'python3 ~/.claude/mods/focus-pane/scripts/live_snapshot.py' > "$cache/hosts/$remote.json.tmp" 2>/dev/null \
    && [ -s "$cache/hosts/$remote.json.tmp" ]; then
    mv "$cache/hosts/$remote.json.tmp" "$cache/hosts/$remote.json"
  else
    rm -f "$cache/hosts/$remote.json.tmp"
  fi
  sleep "$interval"
done
```

Run: `chmod +x scripts/live-sync.sh && bash -n scripts/live-sync.sh && echo syntax-ok` (et `shellcheck scripts/live-sync.sh` s'il est installé : aucun avertissement de niveau error).

- [ ] **Step 2: `install.sh --sync <alias>`**

En tête de `install.sh`, après `set -eu` :

```sh
sync_alias=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sync) sync_alias="${2:?--sync needs an SSH alias}"; shift 2 ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done
```

Juste avant la dernière ligne (`echo "Start a NEW Claude Code session…"`) :

```sh
if [ -n "$sync_alias" ]; then
  command -v systemctl >/dev/null || { echo "install.sh: systemctl is required for --sync" >&2; exit 1; }
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  cat > "$unit_dir/focus-pane-sync.service" <<UNIT
[Unit]
Description=focus-pane: live sessions mirrored with $sync_alias
After=network-online.target

[Service]
ExecStart=$here/scripts/live-sync.sh $sync_alias
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now focus-pane-sync.service
  echo "sync: focus-pane-sync.service running against $sync_alias"
fi
```

Run: `sh -n install.sh && echo syntax-ok`.

- [ ] **Step 3: README**

Dans `README.md`, sous `## Use`, ajouter une ligne au tableau : `| /mission sessions (ou s dans le pane) | l'onglet Sessions : ce qui bosse ou attend, sur cette machine et sur celle que la synchro reflète, sous-agents compris |`, et une section :

```markdown
### Sessions on two machines

The Sessions tab reads this machine live (`scripts/live_snapshot.py`) and the other one from
`~/.cache/focus-pane/hosts/`, which `scripts/live-sync.sh` fills every 3 s over SSH. Run the sync on the
machine that can reach the other (here, the PC reaching the server's alias `factory`):

    ~/.claude/mods/focus-pane/install.sh --sync factory

It installs and starts the user service `focus-pane-sync.service`. The other machine needs this repo at
`~/.claude/mods/focus-pane` (kept up to date with `git pull`) and `python3`; nothing to install there.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/live-sync.sh install.sh README.md
git commit -m "feat: live-sync.sh mirrors the snapshots over SSH; install.sh --sync installs it as a user service"
```

- [ ] **Step 5: Point d'arrêt — accord de l'utilisateur**

Les étapes suivantes touchent l'extérieur du dépôt : **demander l'accord explicite** de l'utilisateur pour (a) pousser `main` sur GitHub, (b) `git pull` sur `factory`, (c) installer le service systemd sur le PC. Ne rien faire de (a)–(c) sans un oui.

- [ ] **Step 6: Déploiement et recette (après accord)**

```bash
cd ~/.claude/mods/focus-pane && git push origin main
ssh factory 'cd ~/.claude/mods/focus-pane && git pull --ff-only origin main && python3 scripts/live_snapshot.py --label VPS | head -c 300; echo'
timeout 8 scripts/live-sync.sh factory PC VPS 2; ls -la ~/.cache/focus-pane/hosts/
ssh factory 'ls -la ~/.cache/focus-pane/hosts/ && cat ~/.cache/focus-pane/label'
python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.cache/focus-pane/hosts/factory.json')));print(d['label'],len(d['sessions']))"
./install.sh --sync factory && systemctl --user is-active focus-pane-sync.service
```

Expected : le snapshot du VPS s'affiche ; `hosts/factory.json` (PC) et `hosts/Rocinante.json` (VPS) existent ; `label` vaut `VPS` sur le VPS ; le service est `active`. Puis, dans une session desktop locale **et** dans une session SSH sur `factory` : `/mission sessions` → les deux blocs, avec la session courante marquée `(ici)` et ses sous-agents. Couper le service (`systemctl --user stop focus-pane-sync.service`) → au bout de ~15 s, le bloc distant dit « synchro en retard » ; le relancer (`start`).
