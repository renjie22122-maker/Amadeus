"""Loopback, authenticated OpenAI-compatible local speech bridge. No model imports here."""
import argparse
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import signal
from policy import select_device

MAX_BODY = 25 * 1024 * 1024


def run_worker(command, *, stdout, stderr, env, timeout, check=False):
    """Bound the whole worker tree, including Windows venv redirectors."""
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    process = subprocess.Popen(command, stdout=stdout, stderr=stderr, env=env, **options)
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10)
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
        raise


def parse_upload(content_type, body):
    if not content_type.startswith("multipart/form-data;"):
        raise ValueError("Expected multipart audio upload")
    message = BytesParser(policy=default).parsebytes(("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
    fields, audio = {}, None
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        data = part.get_payload(decode=True) or b""
        if name == "file":
            if audio is not None:
                raise ValueError("Only one audio file is accepted")
            audio = data
        elif name in ("model", "language", "response_format"):
            if len(data) > 256:
                raise ValueError("Field is too long")
            fields[name] = data.decode("utf-8")
    if not audio:
        raise ValueError("Audio is empty")
    return fields, audio


def validate_job(fields, speech):
    model = fields.get("model", "")
    if model not in (("cosyvoice",) if speech else ("sensevoice", "whisper")):
        raise ValueError("Unsupported model for this endpoint")
    if speech:
        if not isinstance(fields.get("input"), str) or not 1 <= len(fields["input"].strip()) <= 4000:
            raise ValueError("Speech text must contain 1-4000 characters; split longer documents")
        if not isinstance(fields.get("voice", "default"), str):
            raise ValueError("voice must be a configured voice name")
        if fields.get("response_format", "wav") != "wav":
            raise ValueError("Local speech supports response_format=wav")
    elif fields.get("response_format", "json") not in ("json", "verbose_json"):
        raise ValueError("Transcription supports json or verbose_json")
    return {k: fields[k] for k in ("model", "language", "input", "voice") if k in fields}


def create_server(config, host="127.0.0.1", port=8812, config_path=None):
    if len(config.get("token", "")) < 32:
        raise ValueError("A service token of at least 32 characters is required")
    lock = threading.Lock()
    state = {"busy": False, "device": None, "reason": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Do not log audio, text, tokens or request paths.

        def setup(self):
            super().setup()
            self.connection.settimeout(20)

        def reply(self, status, data, mime="application/json"):
            payload = json.dumps(data, ensure_ascii=False).encode() if mime == "application/json" else data
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def authorized(self):
            return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + config["token"])

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"error": "not_found"})
            if not self.authorized():
                return self.reply(401, {"error": "unauthorized"})
            return self.reply(200, {"application": "Amadeus Local Voice", "modelLoaded": False if not state["busy"] else None, "state": state, "models": {k: Path(v).is_dir() for k, v in config.get("models", {}).items()}, "devicePolicy": config.get("device", "cpu"), "voiceConfigured": bool(config.get("voices")), "readyMeaning": "Paths only; inference and dependencies require smoke testing"})

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {"error": "unauthorized"})
            if self.path not in ("/v1/audio/transcriptions", "/v1/audio/speech"):
                return self.reply(404, {"error": "not_found"})
            if self.headers.get("Transfer-Encoding"):
                return self.reply(411, {"error": "Content-Length required"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_BODY:
                    return self.reply(413, {"error": "Audio upload must be at most 25 MiB"})
                if not lock.acquire(blocking=False):
                    return self.reply(429, {"error": "VOICE_BUSY: another local voice request is running; retry explicitly later"})
                state.update(busy=True, device=None, reason=None)
                try:
                    body = self.rfile.read(length)
                    if len(body) != length:
                        raise ValueError("Incomplete upload")
                    speech = self.path.endswith("/speech")
                    fields, audio = (json.loads(body), None) if speech else parse_upload(self.headers.get("Content-Type", ""), body)
                    if not isinstance(fields, dict):
                        raise ValueError("Expected a JSON object")
                    job = validate_job(fields, speech)
                    model_path = config.get("models", {}).get(job["model"])
                    if not model_path or not Path(model_path).is_dir():
                        return self.reply(503, {"error": "MODEL_NOT_READY: run local voice setup and prepare models"})
                    if config_path and speech:
                        # Refresh voice presets only; a request keeps its own snapshot.
                        latest = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
                        config["voices"] = latest.get("voices", {})
                    device, reason = select_device(config)
                    state.update(device=device, reason=reason)
                    with tempfile.TemporaryDirectory(prefix="amadeus-voice-") as folder:
                        directory = Path(folder)
                        if audio is not None:
                            (directory / "input.audio").write_bytes(audio)
                        job.update(config=config, device=device, audio=str(directory / "input.audio"), output=str(directory / "output.wav"), result=str(directory / "result.json"))
                        request = directory / "job.json"
                        request.write_text(json.dumps(job), encoding="utf-8")
                        python = config.get("ttsPython" if speech else "whisperPython" if job["model"] == "whisper" else "asrPython", sys.executable)
                        if job["model"] == "whisper" and not config.get("whisperPython"):
                            return self.reply(503, {"error": "VOICE_ENVIRONMENT: rerun setup to prepare the isolated Whisper environment"})
                        env = {**os.environ, "PYTHONUTF8": "1"}
                        # GPU admission can race another application. Retry only a typed
                        # GPU failure, once on CPU, after the failed process has exited.
                        deadline = time.monotonic() + 150
                        for attempt in range(2):
                            request.write_text(json.dumps(job), encoding="utf-8")
                            with (directory / "worker.log").open("ab") as logs:
                                returncode = run_worker([python, "-X", "utf8", str(Path(__file__).with_name("worker.py")), str(request)], stdout=logs, stderr=logs, env=env, timeout=max(.1, deadline - time.monotonic()), check=False)
                            result_path = Path(job["result"])
                            if not result_path.is_file():
                                return self.reply(503, {"error": "VOICE_WORKER_FAILED: model worker exited without a result (exit " + str(returncode) + "); check native dependencies"})
                            result = json.loads(result_path.read_text(encoding="utf-8"))
                            if "error" not in result:
                                break
                            if attempt == 0 and config.get("device") == "auto" and device == "cuda" and result.get("code") in ("GPU_OOM", "GPU_UNAVAILABLE"):
                                device = job["device"] = "cpu"
                                state.update(device="cpu", reason="GPU worker unavailable; retrying once on CPU")
                                result_path.unlink()
                                Path(job["output"]).unlink(missing_ok=True)
                                continue
                            return self.reply(503, {"error": result["error"]})
                        payload = Path(job["output"]).read_bytes() if speech else {**result, "device": device}
                    return self.reply(200, payload, "audio/wav" if speech else "application/json")
                finally:
                    state["busy"] = False
                    lock.release()
            except subprocess.TimeoutExpired:
                self.reply(504, {"error": "VOICE_TIMEOUT: worker stopped and model released; use a shorter recording/text"})
            except (ValueError, TypeError, KeyError) as error:
                self.reply(400, {"error": str(error)[:300]})
            except RuntimeError as error:
                self.reply(503, {"error": str(error)[:300]})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            except Exception:
                self.reply(503, {"error": "VOICE_SERVICE_FAILED: check local configuration and dependencies"})

    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    create_server(config, config_path=args.config).serve_forever()
