import json, tempfile, unittest
from pathlib import Path
from attempt_state import classify_attempt, completion_phase

class AttemptStateTests(unittest.TestCase):
    def test_receipts_are_distinguished_without_replay_or_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)
            self.assertEqual(classify_attempt(p), 'not_started')
            (p/'started.json').write_text('{}')
            self.assertEqual(classify_attempt(p), 'interrupted_unknown')
            self.assertEqual(classify_attempt(p, True), 'in_flight')
            self.assertEqual(completion_phase([{'directory':tmp}]), 'finished_with_unresolved')
            (p/'result.json').write_text('{"answer":"x"}')
            self.assertEqual(classify_attempt(p), 'result_without_exit_receipt')
            (p/'process.json').write_text('{"exitCode":0}')
            self.assertEqual(classify_attempt(p), 'completed')
            self.assertEqual(completion_phase([{'directory':tmp}]), 'finished')
            (p/'result.json').write_text('{')
            self.assertEqual(classify_attempt(p), 'unreadable_receipt')
            self.assertEqual((p/'result.json').read_text(), '{')
            (p/'result.json').write_text('[]')
            self.assertEqual(classify_attempt(p), 'invalid_receipt')
            (p/'result.json').unlink()
            self.assertEqual(classify_attempt(p), 'exit_without_result')
if __name__ == '__main__': unittest.main()
