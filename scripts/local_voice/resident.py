"""One leased speech worker. No model imports or credential logging in the owner."""
import json
import math
import os
from pathlib import Path
import signal
import sys
import subprocess
import threading
import time


class ResidentWorker:
    def __init__(self):
        self.process = None
        self.key = None
        self.log = None
        self.guard = threading.RLock()
        self.timer = None
        self.last_used = 0
        self.loaded = False

    def close(self):
        with self.guard:
            if self.timer:
                self.timer.cancel()
                self.timer = None
            process, self.process = self.process, None
            self.loaded = False
            self.key = None
            if process:
                if process.poll() is None:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=10)
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
                process.stdin.close()
            if self.log:
                self.log.close()
                self.log = None

    def available(self):
        with self.guard:
            return self.loaded and self.process is not None and self.process.poll() is None

    @staticmethod
    def validate(config):
        idle = config.get('warmIdleSeconds', 60)
        reserve = config.get('warmReserveMiB', 1024)
        if isinstance(idle, bool) or not isinstance(idle, (int, float)) or not math.isfinite(idle) or not 0 <= idle <= 300:
            raise ValueError('warmIdleSeconds must be between 0 and 300')
        if isinstance(reserve, bool) or not isinstance(reserve, int) or reserve <= 0:
            raise ValueError('warmReserveMiB must be a positive integer')

    def admit(self, config, model, path, speech, probe):
        self.validate(config)
        with self.guard:
            python = config.get('ttsPython' if speech else 'whisperPython' if model == 'whisper' else 'asrPython', sys.executable)
            compatible = (self.available() and self.key[:7] == (python, model, path, config.get('cosySource'), config.get('torchRuntimePath'), config.get('cpuThreads', 2), config.get('gpuIndex', 0)))
            if compatible:
                # Cold allocation threshold still applies when upgrading a CPU worker.
                policy = {**config, 'minFreeMiB': config.get('warmReserveMiB', 1024)} if self.key[-1] == 'cuda' else config
                try:
                    device, reason = probe(policy)
                except Exception:
                    self.close()
                    raise
                if device == self.key[-1]:
                    if self.timer:
                        self.timer.cancel()
                        self.timer = None
                    return device, reason
            self.close()
            return probe(config)

    def _idle(self, config, probe):
        with self.guard:
            if not self.process:
                return
            expired = time.monotonic() - self.last_used >= max(0, min(300, float(config.get('warmIdleSeconds', 60))))
            try:
                pressured = self.key[-1] == 'cuda' and probe({**config, 'device': 'auto', 'minFreeMiB': config.get('warmReserveMiB', 1024)})[0] != 'cuda'
            except Exception:
                pressured = True
            if expired or pressured:
                self.close()
            else:
                self.timer = threading.Timer(2, self._idle, (config, probe))
                self.timer.daemon = True
                self.timer.start()

    def run(self, command, *, env, timeout, on_tick=None, probe, **unused):
        job = json.loads(Path(command[-1]).read_text(encoding='utf-8'))
        config = job['config']
        self.validate(config)
        # Device/runtime/model transitions require a fresh process, not CUDA env mutation.
        key = (command[0], job['model'], config['models'][job['model']], config.get('cosySource'), config.get('torchRuntimePath'), config.get('cpuThreads', 2), config.get('gpuIndex', 0), job['device'])
        with self.guard:
            if self.timer:
                self.timer.cancel()
                self.timer = None
            if self.key != key or (self.process and self.process.poll() is not None):
                self.close()
            try:
                if not self.process:
                    # Retain logs only for this worker lifetime; no reference content in health.
                    import tempfile
                    self.log = tempfile.TemporaryFile()
                    options = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {'start_new_session': True}
                    self.process = subprocess.Popen(command[:-1] + ['--serve'], stdin=subprocess.PIPE, stdout=self.log, stderr=self.log, env={**(os.environ if env is None else env), "AMADEUS_VOICE_OWNER_PID": str(os.getpid())}, **options)
                    self.key = key
                self.log.seek(0)
                self.log.truncate()
                self.process.stdin.write((json.dumps(command[-1])+'\n').encode())
                self.process.stdin.flush()
                deadline = time.monotonic() + timeout
                result = Path(job['result'])
                while not result.is_file():
                    if on_tick:
                        on_tick()
                    if self.process.poll() is not None:
                        raise RuntimeError('VOICE_WORKER_FAILED: resident worker exited without a result')
                    if time.monotonic() >= deadline:
                        raise subprocess.TimeoutExpired(command, timeout)
                    time.sleep(.05)
                receipt = json.loads(result.read_text(encoding='utf-8'))
                if 'error' in receipt:
                    self.close()
                    return 1
                if on_tick:
                    on_tick()
                self.loaded = True
                self.last_used = time.monotonic()
                self.timer = threading.Timer(2, self._idle, (config.copy(), probe))
                self.timer.daemon = True
                self.timer.start()
                return 0
            except BaseException:
                try:
                    if self.log:
                        self.log.flush()
                        self.log.seek(0, 2)
                        self.log.seek(max(0, self.log.tell() - 65536))
                        Path(command[-1]).with_suffix('.worker.log').write_bytes(self.log.read())
                finally:
                    self.close()
                raise
