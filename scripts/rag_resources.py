"""Conservative, application-independent admission for local RAG work."""
import threading, time, subprocess

class ResourcePolicy:
    def __init__(self, options=None, clock=time.monotonic):
        c = options or {}
        self.clock = clock
        self.min_free = max(512, int(c.get('minFreeVramMiB', 4096)))
        self.max_util = max(10, min(100, int(c.get('maxGpuUtilPercent', 80))))
        self.recover_seconds = max(5, float(c.get('recoverySeconds', 30)))
        self.idle_seconds = max(10, float(c.get('idleReleaseSeconds', 120)))
        self.lock = threading.RLock()
        self.sample = {'available':False, 'reason':'awaiting_probe'}
        self.healthy_since = None
        self.foreground = 0
        self.last_used = clock()
        self.sample_at = None

    def observe(self, sample):
        with self.lock:
            self.sample = dict(sample)
            self.sample_at = self.clock()
            busy = self._pressure()
            if busy: self.healthy_since = None
            elif self.healthy_since is None: self.healthy_since = self.clock()

    def _pressure(self):
        s = self.sample
        if s.get('cpuPercent', 0) >= 90 or s.get('ramPercent', 0) >= 90: return 'host_pressure'
        if not s.get('available'): return 'telemetry_unavailable'
        if s['freeMiB'] < self.min_free: return 'low_vram'
        if s['utilPercent'] >= self.max_util: return 'gpu_busy'
        return None

    def state(self):
        with self.lock:
            reason = self._pressure()
            if self.sample_at is None or self.clock()-self.sample_at > 15: reason = 'telemetry_stale'
            if not reason and (self.healthy_since is None or self.clock()-self.healthy_since < self.recover_seconds): reason = 'recovery_cooldown'
            return {**self.sample, 'reason':reason or 'ready', 'gpuAllowed':reason is None,
                    'admitGraph':(reason is None or (self.sample.get('reason') == 'cpu_only' and reason == 'telemetry_unavailable')) and self.foreground == 0,
                    'foregroundRequests':self.foreground}

    def used(self):
        with self.lock: self.last_used = self.clock()

    def should_release(self):
        with self.lock:
            return not self.state()['gpuAllowed'] or self.clock()-self.last_used >= self.idle_seconds


def probe_resources():
    """Use the actual PyTorch device UUID, including CUDA_VISIBLE_DEVICES remapping."""
    sample = {'available':False, 'reason':'telemetry_unavailable'}
    try:
        import psutil
        sample.update(cpuPercent=psutil.cpu_percent(), ramPercent=psutil.virtual_memory().percent)
    except ImportError: pass
    try:
        import torch
        if not torch.cuda.is_available(): return {**sample, 'reason':'cpu_only'}
        device = torch.cuda.get_device_properties(torch.cuda.current_device())
        uuid = getattr(device, 'uuid', None)
        if not uuid: return sample  # Do not accidentally measure a different physical GPU.
        device_id = str(uuid)
        if not device_id.startswith(('GPU-', 'MIG-')): device_id = 'GPU-'+device_id
        result = subprocess.run(['nvidia-smi', '--id='+device_id,
            '--query-gpu=memory.free,utilization.gpu', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=2,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode: return sample
        free, util = [float(x.strip()) for x in result.stdout.strip().split(',')]
        return {**sample, 'available':True, 'reason':'measured', 'freeMiB':free, 'utilPercent':util}
    except (ImportError, OSError, ValueError, RuntimeError, subprocess.TimeoutExpired): return sample
