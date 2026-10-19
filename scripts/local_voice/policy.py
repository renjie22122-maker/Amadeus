"""GPU admission is conservative; external applications do not share our lock."""
import json
import errno
import urllib.error
import subprocess
import urllib.request
from urllib.parse import urlparse


def select_device(config):
    mode = config.get("device", "cpu")
    if mode == "cpu":
        return "cpu", "CPU mode: no GPU allocation"
    if mode not in ("auto", "cuda"):
        raise ValueError("device must be cpu, auto or cuda")
    try:
        endpoints = config.get("comfyUrls", ["http://127.0.0.1:8188"])
        if not endpoints:
            raise ValueError("GPU mode requires a configured ComfyUI queue probe")
        for endpoint in endpoints:
            u = urlparse(endpoint)
            if u.scheme != "http" or u.hostname not in ("127.0.0.1", "localhost", "::1") or u.username or u.password or u.query or u.fragment:
                raise ValueError("ComfyUI probes must be local HTTP endpoints")
            # Disable proxies and redirects; never submit, interrupt or unload ComfyUI.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *args, **kwargs):
                    return None
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            try:
                # Windows may take several seconds to report a refused loopback connection.
                with opener.open(endpoint.rstrip("/") + "/queue", timeout=6) as response:
                    queue = json.loads(response.read(1024 * 1024))
            except urllib.error.URLError as error:
                reason = error.reason
                if isinstance(reason, ConnectionRefusedError) or (isinstance(reason, OSError) and
                        (reason.errno == errno.ECONNREFUSED or getattr(reason, "winerror", None) == 10061)):
                    # Explicitly closed configured endpoint is different from an unresponsive one.
                    # Still require the GPU memory check; never bypass it.
                    continue
                raise
            if not isinstance(queue.get("queue_running"), list) or not isinstance(queue.get("queue_pending"), list):
                raise ValueError("Unrecognized ComfyUI queue response")
            if queue["queue_running"] or queue["queue_pending"]:
                raise ValueError("ComfyUI has active or queued work")
        gpu = str(int(config.get("gpuIndex", 0)))
        free = subprocess.run(["nvidia-smi", "-i", gpu, "--query-gpu=memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3, check=True)
        if int(free.stdout.strip()) < int(config.get("minFreeMiB", 8192)):
            raise ValueError("Insufficient free GPU memory")
        return "cuda", "ComfyUI idle or closed and free-memory check passed (not an exclusive GPU reservation)"
    except Exception as error:
        if mode == "auto":
            return "cpu", "GPU admission unavailable; using CPU: " + str(error)[:180]
        raise RuntimeError("GPU_BUSY: " + str(error)) from error
