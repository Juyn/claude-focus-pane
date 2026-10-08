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

    def stat(self, pid, comm, start):
        fields = ['S'] + ['0'] * 18 + [str(start)] + ['0'] * 5  # state is field 3, starttime field 22
        with open(os.path.join(self.proc, str(pid), 'stat'), 'w', encoding='utf-8') as held:
            held.write(f'{pid} ({comm}) ' + ' '.join(fields) + '\n')

    def test_a_reused_pid_is_not_listed(self):
        self.session(5, procStart='1000')
        self.stat(5, 'claude', 2000)
        self.assertEqual(self.ids(self.take()), [])

    def test_the_same_process_is_listed_even_when_its_name_has_spaces_and_parentheses(self):
        self.session(6, procStart='1000')
        self.stat(6, 'a b) c', 1000)
        self.assertEqual(self.ids(self.take()), ['s6'])

    def test_an_unreadable_stat_falls_back_to_the_directory(self):
        self.session(7, procStart='1000')
        self.assertEqual(self.ids(self.take()), ['s7'])

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

    def test_an_undecodable_label_file_falls_back_to_the_hostname(self):
        with open(os.path.join(self.home, '.cache', 'focus-pane', 'label'), 'wb') as held:
            held.write(b'\xff\xfe')
        self.assertEqual(snap.label_of(self.home, ''), socket.gethostname())


if __name__ == '__main__':
    unittest.main()
