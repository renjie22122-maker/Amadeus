from policy import listen_port
"""Portable local-voice installation/start. Never touches the app or benchmark environment."""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DATA = Path(os.environ.get("AGENTDEMO_DATA_DIR", str(ROOT / ".data"))).resolve()
HOME = DATA / "voice-service"
CONFIG = HOME / "config.json"


def python_in(folder):
    return str(folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))


def health(config):
    request = urllib.request.Request("http://127.0.0.1:" + str(listen_port(config)) + "/health", headers={"Authorization": "Bearer " + config["token"]})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=2) as response:
        return json.loads(response.read(65536))


def save(config):
    temporary = CONFIG.with_suffix(".tmp")
    temporary.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(CONFIG)


def setup(args):
    HOME.mkdir(parents=True, exist_ok=True)
    asr = python_in(DATA / "voice-asr-python")
    tts = python_in(DATA / "voice-tts-python")
    whisper = python_in(DATA / "voice-whisper-python")
    source = HOME / "CosyVoice"
    config = json.loads(CONFIG.read_text(encoding="utf-8-sig")) if CONFIG.exists() else {
        "token": secrets.token_urlsafe(32), "device": "auto", "cpuThreads": 2,
        "gpuIndex": 0, "minFreeMiB": 8192,
        "asrPython": asr, "ttsPython": tts, "cosySource": str(source),
        "models": {name: str(HOME / "models" / name) for name in ("sensevoice", "whisper", "cosyvoice")}, "voices": {},
    }
    try:
        running = health(config)
    except Exception:
        running = None
    if running:
        raise RuntimeError("Stop the local voice service before changing its dependencies. Other services need not stop.")
    config.setdefault("whisperPython", whisper)
    save(config)
    for folder in (DATA / "voice-asr-python", DATA / "voice-whisper-python") + (() if args.asr_only else (DATA / "voice-tts-python",)):
        if not Path(python_in(folder)).exists():
            subprocess.run([args.python, "-m", "venv", str(folder)], check=True)
    pip = [asr, "-m", "pip", "install", "--timeout", "120", "--retries", "8"]
    subprocess.run(pip + ["-r", str(ROOT / "scripts/requirements-voice-asr.txt")], check=True)
    subprocess.run([whisper, "-m", "pip", "install", "--timeout", "120", "--retries", "8", "-r", str(ROOT / "scripts/requirements-voice-whisper.txt")], check=True)
    if not args.asr_only:
        if not (source / ".git").exists():
            subprocess.run(["git", "clone", "--recursive", "https://github.com/FunAudioLLM/CosyVoice.git", str(source)], check=True)
        subprocess.run(["git", "-C", str(source), "submodule", "update", "--init", "--recursive"], check=True)
        subprocess.run([tts, "-m", "pip", "install", "--timeout", "120", "--retries", "8", "-r", str(source / "requirements.txt")], check=True)
        if not config.get("voices") and (source / "asset/zero_shot_prompt.wav").is_file():
            config["voices"] = {"default": {"audio": str(source / "asset/zero_shot_prompt.wav"), "text": "希望你以后能够做的比我还好呦。", "source": "CosyVoice upstream example voice"}}
            save(config)
        revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        (HOME / "cosyvoice-revision.txt").write_text(revision, encoding="utf-8")
    if args.cuda:
        for interpreter in (asr,) + (() if args.asr_only else (tts,)):
            subprocess.run([interpreter, "-m", "pip", "install", "--timeout", "120", "--retries", "8", "--index-url", "https://download.pytorch.org/whl/cu121", "torch==2.3.1+cu121", "torchaudio==2.3.1+cu121"], check=True)
    if not args.skip_download:
        models = ["sensevoice", "whisper"] + ([] if args.asr_only else ["cosyvoice"])
        subprocess.run([asr, str(Path(__file__).with_name("prepare.py")), "--config", str(CONFIG), "--models", *models], check=True)
    print("Preparation finished. Configure voices.default.audio and voices.default.text in " + str(CONFIG), flush=True)
    print("Run start, then Settings > Media > Add local voice connections. Inference must be smoke-tested separately.", flush=True)


def start():
    config = json.loads(CONFIG.read_text(encoding="utf-8-sig"))
    try:
        if health(config).get("application") == "Amadeus Local Voice":
            print("Local voice already running; idle service holds no models.")
            return
    except Exception:
        pass
    probe = socket.socket()
    try:
        if probe.connect_ex(("127.0.0.1", listen_port(config))) == 0:
            raise RuntimeError(f"Port {listen_port(config)} already occupied or voice token changed. Inspect the existing service; no process was stopped.")
    finally:
        probe.close()
    options = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS} if os.name == "nt" else {"start_new_session": True}
    with (HOME / "stdout.log").open("ab") as stdout, (HOME / "stderr.log").open("ab") as stderr:
        child = subprocess.Popen([config["asrPython"], "-X", "utf8", "-u", str(Path(__file__).with_name("service.py")), "--config", str(CONFIG)], cwd=ROOT, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, **options)
    (HOME / "process.json").write_text(json.dumps({"id": child.pid, "startedAt": time.time()}), encoding="utf-8")
    for _ in range(20):
        time.sleep(.25)
        try:
            if health(config).get("application") == "Amadeus Local Voice":
                print("Local voice listening; model inference not yet verified.")
                return
        except Exception:
            pass
        if child.poll() is not None:
            break
    raise RuntimeError("Local voice did not become ready; inspect voice-service/stderr.log")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["setup", "start"])
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--asr-only", action="store_true")
    parser.add_argument("--cuda", action="store_true", help="Install the matching NVIDIA CUDA 12.1 PyTorch wheels in voice environments only")
    args = parser.parse_args()
    setup(args) if args.action == "setup" else start()
