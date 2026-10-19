"""Choose the voice device from available GPU memory, independent of applications."""
import subprocess


def select_device(config):
    mode = config.get("device", "cpu")
    if mode == "cpu":
        return "cpu", "CPU mode: no GPU allocation"
    if mode not in ("auto", "cuda"):
        raise ValueError("device must be cpu, auto or cuda")
    try:
        gpu = int(config.get("gpuIndex", 0))
        required = int(config.get("minFreeMiB", 8192))
        if gpu < 0 or required <= 0:
            raise ValueError("gpuIndex must be nonnegative and minFreeMiB positive")
        result = subprocess.run(
            ["nvidia-smi", "-i", str(gpu), "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=3, check=True)
        free = int(result.stdout.strip())
        if free < 0:
            raise ValueError("Invalid free GPU memory reading")
        if free < required:
            raise ValueError(f"GPU {gpu}: {free} MiB free, {required} MiB required")
        return "cuda", f"GPU {gpu}: {free} MiB free, {required} MiB required (not an exclusive reservation)"
    except Exception as error:
        if mode == "auto":
            return "cpu", "GPU admission unavailable; using CPU: " + str(error)[:180]
        raise RuntimeError("GPU_BUSY: " + str(error)) from error
