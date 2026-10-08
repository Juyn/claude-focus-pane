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
    except (OSError, ValueError):
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
