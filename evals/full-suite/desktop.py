"""Detached benchmark supervisor and read-only progress report. No model credentials copied."""
import argparse, collections, contextlib, datetime, hashlib, json, os, pathlib, shutil, subprocess, sys, time

FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

def read(path, default=None):
    try:
        return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))
    except FileNotFoundError:
        return default

def save(path, value):
    path = pathlib.Path(path)
    tmp = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf8')
    os.replace(tmp, path)

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def alive(pid):
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return ctypes.get_last_error() == 5  # inaccessible is not proof of death
        code = ctypes.c_ulong()
        try:
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

@contextlib.contextmanager
def ownership(path):
    with open(path, 'a+b') as f:
        f.seek(0); f.write(b'0'); f.flush(); f.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise RuntimeError('Benchmark controller already running')
        try:
            yield
        finally:
            f.seek(0)
            if os.name == 'nt':
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f, fcntl.LOCK_UN)

def profile_signature(settings, profile_id):
    p = next(p for p in settings['profiles'] if p['id'] == profile_id)
    return {k: p.get(k) for k in ['id', 'model', 'baseUrl', 'transport', 'reasoning']}

def report(config):
    root = pathlib.Path(config['root']); rows = []; unknown = []; unreadable = []
    def live(path, default=None):
        try: return read(path, default)
        except (json.JSONDecodeError, PermissionError):
            unreadable.append(str(path)); return default
    for group in ['text', 'gaia']:
        out = root / group
        queue = read(out / 'queue.json', [])
        stats = collections.defaultdict(lambda: dict(expected=0, completed=0, errors=0, unknown=0, graded=0, passed=0, judgeErrors=0, inputTokens=0, outputTokens=0, cachedInputTokens=0, unknownUsageCalls=0, elapsedMs=0))
        grades = {}
        for track in ['bfcl', 'gaia']:
            data = live(out / track / 'grades.json', [])
            if isinstance(data, dict): data = data.get('grades', [])
            grades.update({(track, g['id'], g['arm']): g for g in data})
        for item in queue:
            track, arm = item['track'], item['arm']; s = stats[(track, arm)]; s['expected'] += 1
            folder = pathlib.Path(item['directory']); result = live(folder / 'result.json')
            if (folder / 'process.json').exists() and result is not None:
                s['completed'] += 1; s['errors'] += bool(result.get('error'))
                s['elapsedMs'] += result.get('elapsedMs', 0) or 0
                usages = [result.get('usage')] if 'requests' not in result else [r.get('result', {}).get('usage') or r.get('usage') for r in result['requests']]
                usages += [r.get('usage') for r in result.get('auxiliary', [])]
                for usage in usages:
                    if not usage or not usage.get('measured'):
                        s['unknownUsageCalls'] += 1; continue
                    for key, field in [('inputTokens','input'),('outputTokens','output'),('cachedInputTokens','cached')]:
                        s[key] += usage.get(field, 0) or 0
                grade = live(folder / 'judge.json') if track.startswith('longmem') else grades.get((track, item['id'], arm))
                if grade:
                    passed = grade.get('passed', grade.get('grade', {}).get('valid'))
                    if passed is not None:
                        s['graded'] += 1; s['passed'] += bool(passed)
                    else: s['judgeErrors'] += 1
            elif (folder / 'started.json').exists():
                # Includes currently running work: do not label it a failed answer.
                s['unknown'] += 1; unknown.append({'track': track, 'arm': arm, 'id': item['id'], 'directory': str(folder)})
        rows += [dict(track=t, arm=a, **s) for (t, a), s in stats.items()]
    result = {'updatedAt': now(), 'controller': read(root / 'status.json'), 'rows': rows, 'inFlightOrUnresolved': unknown, 'unreadableOrBeingWritten': unreadable}
    save(root / 'summary.json', result)
    lines = ['# Amadeus Benchmark', '', 'Updated (UTC): ' + result['updatedAt'], '',
        '| Track | Agent | Expected | Completed | Graded | Passed | Runtime errors | In flight / unresolved |',
        '|---|---|---:|---:|---:|---:|---:|---:|']
    for r in rows:
        lines.append('| ' + ' | '.join(str(r[k]) for k in ['track','arm','expected','completed','graded','passed','errors','unknown']) + ' |')
    lines += ['', 'Completed includes failed executions, not only correct answers. Unscored work is not a failure or a pass.',
        'LongMemEval uses supplied history, not persistent Memory/RAG. Its DeepSeek rubric judge is not the official GPT-4o score.',
        'BFCL is first-decision tool selection. GAIA uses three native arms; no SWE-bench environments are downloaded.',
        'Token counts in summary.json are measured lower bounds; cached input is part of input, and judge costs are not included. Unknown unit prices are not zero cost.',
        'Original responses are preserved. In-flight/unresolved attempts are never silently replayed. See summary.json and per-track logs.']
    (root / 'SUMMARY.md').write_text('\n'.join(lines), encoding='utf8')
    return result

def run(config):
    root = pathlib.Path(config['root']); runtime = pathlib.Path(config['runtime'])
    if hashlib.sha256(pathlib.Path(config['dependencyLock']).read_bytes()).hexdigest() != config['dependencySha256']:
        raise RuntimeError('Node dependency lock changed; prepare a new run')
    with ownership(root / 'controller.lock'):
        # Resume only through an explicit start, not through a timer or model action.
        for folder in [root, root / 'text', root / 'gaia']:
            (folder / 'STOP').unlink(missing_ok=True)
        active = {}; phases = {}; attempted = set(); image = None; next_docker = 0; last_report = 0
        try:
            while True:
                stopping = (root / 'STOP').exists()
                for group in ['text', 'gaia']:
                    out = root / group
                    if stopping: (out / 'STOP').touch()
                    if group in active:
                        proc = active[group]
                        if proc.poll() is None: continue
                        phases[group] = read(out / 'progress.json', {}).get('phase', 'failed')
                        if proc.returncode: phases[group] = 'failed'
                        del active[group]
                    if group in attempted or stopping: continue
                    progress = read(out / 'progress.json', {})
                    if progress.get('phase') == 'finished':
                        phases[group] = 'finished'; attempted.add(group); continue
                    lock = out / 'runner.lock'
                    previous = read(lock)
                    if previous and alive(previous['pid']):
                        phases[group] = 'waiting_existing_runner'; continue
                    if previous:
                        lock.rename(out / ('runner-stale-' + str(time.time_ns()) + '.json'))
                    if group == 'gaia' and not image:
                        phases[group] = 'waiting_docker'
                        if time.monotonic() < next_docker: continue
                        next_docker = time.monotonic() + 30
                        try:
                            probe = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', config['image']], capture_output=True, text=True, timeout=15, creationflags=FLAGS)
                            if probe.returncode: continue
                            image = probe.stdout.strip()
                            if not image.startswith('sha256:'): raise RuntimeError('Invalid Docker image ID')
                            frozen = read(root / 'docker-image.json')
                            if frozen and frozen['image'] != image: raise RuntimeError('Docker image changed; choose a new run')
                            # Synthetic tools/attachments checks only; no paid model requests.
                            env = dict(os.environ, AMADEUS_EVAL_PYTHON=config['python'], AMADEUS_TEST_ANALYSIS_IMAGE=image, AMADEUS_TEST_NATIVE_IMAGE=image)
                            with (root / 'native-smoke.log').open('a', encoding='utf8') as log:
                                check = subprocess.run(['node', '--import', 'tsx', '--test', 'tests/shared-broker.test.ts'], cwd=runtime, env=env, stdout=log, stderr=log, timeout=300, creationflags=FLAGS)
                            if check.returncode: raise RuntimeError('Native Docker preflight failed; see native-smoke.log')
                            save(root / 'docker-image.json', {'image': image, 'checkedAt': now()})
                        except (subprocess.TimeoutExpired, FileNotFoundError):
                            image = None; continue
                    if profile_signature(read(config['settings']), config['profileId']) != config['profile']:
                        raise RuntimeError('Selected model connection changed. Restore it or prepare a new run.')
                    args = [config['python'], '-X', 'utf8', str(runtime / 'evals/full-suite/run.py'), str(out), str(runtime), config['python'], config['settings'], '--download', config['download'], '--prepare-python', config['dataPython'], '--concurrency', str(config.get('concurrency', 2)), '--profile-id', config['profileId']]
                    if group == 'gaia': args += ['--analysis-image', image]
                    with (out / 'runner.stdout.log').open('a', encoding='utf8') as stdout, (out / 'runner.stderr.log').open('a', encoding='utf8') as stderr:
                        active[group] = subprocess.Popen(args, cwd=runtime, stdout=stdout, stderr=stderr, creationflags=FLAGS)
                    attempted.add(group); phases[group] = 'running'
                save(root / 'status.json', {'pid': os.getpid(), 'updatedAt': now(), 'phase': 'stopping' if stopping else 'running', 'groups': phases, 'children': {g:p.pid for g,p in active.items()}})
                if time.monotonic() - last_report > 60:
                    report(config); last_report = time.monotonic()
                if stopping and not active: break
                if len(attempted) == 2 and not active: break
                time.sleep(3)
            save(root / 'status.json', {'updatedAt': now(), 'phase': 'paused' if stopping else ('finished' if all(v == 'finished' for v in phases.values()) else 'needs_attention'), 'groups': phases})
            report(config)
        except Exception as e:
            # Stop scheduling; already-running attempts keep their receipts and settle.
            for group in ['text', 'gaia']: (root / group / 'STOP').touch()
            save(root / 'status.json', {'updatedAt': now(), 'phase': 'failed', 'error': str(e), 'children': {g:p.pid for g,p in active.items()}})
            report(config)
            raise

def main():
    p = argparse.ArgumentParser(); p.add_argument('action', choices=['start','run','stop','report']); p.add_argument('config'); a = p.parse_args()
    config = read(a.config); root = pathlib.Path(config['root'])
    if a.action == 'run': run(config)
    elif a.action == 'stop':
        for folder in [root, root / 'text', root / 'gaia']: (folder / 'STOP').touch()
        print('Stop requested. Current attempts will finish; no new tasks will start. Use Start to resume.')
    elif a.action == 'report':
        report(config); print(root / 'SUMMARY.md')
        if os.name == 'nt': os.startfile(root / 'SUMMARY.md')
    else:
        # Check ownership before detaching; the child acquires it again (double-click safe).
        with ownership(root / 'controller.lock'): pass
        with (root / 'controller.stdout.log').open('a', encoding='utf8') as stdout, (root / 'controller.stderr.log').open('a', encoding='utf8') as stderr:
            kwargs = {'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
            child = subprocess.Popen([config['python'], '-X', 'utf8', str(pathlib.Path(__file__).resolve()), 'run', str(pathlib.Path(a.config).resolve())], cwd=config['runtime'], stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, **kwargs)
        print('Detached benchmark controller started:', child.pid)
        print('Closing Codex is safe. Keep this computer awake and connected. Output:', root)

if __name__ == '__main__': main()
