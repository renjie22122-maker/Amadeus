"""Read-only attempt reconciliation. Missing receipts never authorize a replay."""
import json
from pathlib import Path

def classify_attempt(directory, active=False):
    folder = Path(directory)
    values = {}
    for name in ('started.json', 'result.json', 'process.json'):
        path = folder / name
        if not path.exists():
            values[name] = None
            continue
        try:
            value = json.loads(path.read_text(encoding='utf-8-sig'))
            if not isinstance(value, dict):
                return 'invalid_receipt'
            values[name] = value
        except (ValueError, OSError):
            return 'unreadable_receipt'
    if values['result.json'] is not None and values['process.json'] is not None:
        return 'completed'
    if active:
        return 'in_flight'
    if values['result.json'] is not None:
        return 'result_without_exit_receipt'
    if values['process.json'] is not None:
        return 'exit_without_result'
    if values['started.json'] is not None:
        return 'interrupted_unknown'
    return 'not_started'

def completion_phase(queue):
    return 'finished_with_unresolved' if any(classify_attempt(i['directory']) != 'completed' for i in queue) else 'finished'
