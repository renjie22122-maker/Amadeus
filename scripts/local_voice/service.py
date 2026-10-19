from policy import listen_port
"""Loopback, authenticated OpenAI-compatible local speech bridge. No model imports here."""
import argparse
import base64
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import shutil
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import signal
import uuid
import stat
from policy import select_device
from resident import ResidentWorker

MAX_BODY = 25 * 1024 * 1024


def run_worker(command, *, stdout, stderr, env, timeout, check=False, on_tick=None, resident=None):
    """Bound the whole worker tree, including Windows venv redirectors."""
    if resident is not None:
        return resident.run(command, stdout=stdout, stderr=stderr, env=env, timeout=timeout, on_tick=on_tick, probe=select_device)
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    process = subprocess.Popen(command, stdout=stdout, stderr=stderr, env=env, **options)
    try:
        if on_tick is None:
            return process.wait(timeout=timeout)
        deadline = time.monotonic() + timeout
        while process.poll() is None:
            on_tick()
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(command, timeout)
            time.sleep(.1)
        on_tick()
        return process.returncode
    except BaseException:
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
    if "stream" in fields and (not speech or not isinstance(fields["stream"], bool)):
        raise ValueError("stream must be a boolean for speech")
    return {k: fields[k] for k in ("model", "language", "input", "voice", "stream") if k in fields}


def cleanup_deleted_voices(config_path):
    if not config_path:
        return 0
    removed = 0
    path = Path(config_path)
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    owned = path.parent / "voices"
    if not owned.exists():
        return 0
    # Windows short names and mapped temp roots can resolve to another spelling.
    # Inspect this directory entry for links/reparse points instead of comparing strings.
    info = owned.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
        raise ValueError("VOICE_PATH: unexpected linked voice directory")
    for identity, voice in data.get("voices", {}).items():
        if not voice.get("deleted") or voice.get("source") != "user-upload":
            continue
        try:
            if str(uuid.UUID(identity)) != identity:
                continue
        except (ValueError, AttributeError):
            continue
        target = owned / (identity + ".wav")
        if Path(voice.get("audio", "")).absolute() != target.absolute():
            continue
        # Unlink a single owned directory entry; never follow a voice file symlink.
        if target.exists() or target.is_symlink():
            target.unlink()
            removed += 1
    return removed


def create_server(config, host="127.0.0.1", port=8812, config_path=None):
    if len(config.get("token", "")) < 32:
        raise ValueError("A service token of at least 32 characters is required")
    lock = threading.Lock()
    resident = ResidentWorker()
    state = {"busy": False, "device": None, "reason": None}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Do not log audio, text, tokens or request paths.

        def setup(self):
            super().setup()
            self.connection.settimeout(20)

        def stream_event(self, data):
            if not getattr(self, "stream_started", False):
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.stream_started = True
                self.close_connection = True
            self.wfile.write(json.dumps(data).encode() + b"\n")
            self.wfile.flush()

        def reply(self, status, data, mime="application/json"):
            if getattr(self, "stream_started", False):
                return self.stream_event({"type": "error", "error": data.get("error", "VOICE_STREAM_FAILED")})
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
            return self.reply(200, {"application": "Amadeus Local Voice", "modelLoaded": resident.available() if not state["busy"] else None, "state": state, "models": {k: Path(v).is_dir() for k, v in config.get("models", {}).items()}, "devicePolicy": config.get("device", "cpu"), "voiceConfigured": bool(config.get("voices")), "streaming": True, "readyMeaning": "Paths only; inference and dependencies require smoke testing"})

        def do_POST(self):
            if not self.authorized():
                return self.reply(401, {"error": "unauthorized"})
            if self.path == "/v1/voices/cleanup":
                if not lock.acquire(blocking=False):
                    return self.reply(202, {"cleanupPending": True})
                try:
                    if cleanup_deleted_voices(config_path):
                        resident.close()
                    return self.reply(200, {"cleanupPending": False})
                except Exception:
                    return self.reply(503, {"cleanupPending": True})
                finally:
                    lock.release()
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
                    if cleanup_deleted_voices(config_path):
                        resident.close()
                    body = self.rfile.read(length)
                    if len(body) != length:
                        raise ValueError("Incomplete upload")
                    speech = self.path.endswith("/speech")
                    fields, audio = (json.loads(body), None) if speech else parse_upload(self.headers.get("Content-Type", ""), body)
                    if not isinstance(fields, dict):
                        raise ValueError("Expected a JSON object")
                    job = validate_job(fields, speech)
                    if config_path and speech:
                        # Snapshot current prepared resources; never download during inference.
                        latest = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))
                        config["voices"] = latest.get("voices", {})
                        config["models"] = latest.get("models", {})
                    if speech and job.get("voice", "").startswith("preset:"):
                        job["model"] = "cosyvoice-sft"
                    model_path = config.get("models", {}).get(job["model"])
                    if not model_path or not Path(model_path).is_dir():
                        return self.reply(503, {"error": "MODEL_NOT_READY: run local voice setup and prepare models"})
                    # A warm model already occupies VRAM: test remaining execution reserve,
                    # not the full cold-load allowance. Release before a fresh admission.
                    device, reason = resident.admit(config, job["model"], model_path, speech, select_device)
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
                        streaming = speech and bool(job.get("stream"))
                        emitted = 0
                        last_audio = time.monotonic()
                        last_heartbeat = 0
                        def pump():
                            nonlocal emitted, last_audio, last_heartbeat
                            chunk = directory / "chunks" / (str(emitted) + ".wav")
                            while chunk.is_file():
                                if chunk.stat().st_size > 4 * 1024 * 1024:
                                    raise ValueError("VOICE_STREAM_CHUNK: oversized audio chunk")
                                payload = chunk.read_bytes()
                                self.stream_event({"type": "audio", "sequence": emitted, "audio": base64.b64encode(payload).decode()})
                                chunk.unlink()
                                emitted += 1
                                last_audio = time.monotonic()
                                chunk = directory / "chunks" / (str(emitted) + ".wav")
                            now = time.monotonic()
                            if now - last_audio > 150:
                                raise subprocess.TimeoutExpired("voice stream stalled", 150)
                            if now - last_heartbeat > 2:
                                self.stream_event({"type": "waiting"})
                                last_heartbeat = now
                        deadline = time.monotonic() + (600 if streaming else 150)
                        for attempt in range(2):
                            request.write_text(json.dumps(job), encoding="utf-8")
                            with (directory / "worker.log").open("ab") as logs:
                                returncode = run_worker([python, "-X", "utf8", str(Path(__file__).with_name("worker.py")), str(request)], stdout=logs, stderr=logs, env=env, timeout=max(.1, deadline - time.monotonic()), check=False, resident=resident if speech else None, **({"on_tick": pump} if streaming else {}))
                            result_path = Path(job["result"])
                            if not result_path.is_file():
                                return self.reply(503, {"error": "VOICE_WORKER_FAILED: model worker exited without a result (exit " + str(returncode) + "); check native dependencies"})
                            result = json.loads(result_path.read_text(encoding="utf-8"))
                            if "error" not in result:
                                state["lastTiming"] = result.get("timings")
                                break
                            if attempt == 0 and emitted == 0 and config.get("device") == "auto" and device == "cuda" and result.get("code") in ("GPU_OOM", "GPU_UNAVAILABLE"):
                                device = job["device"] = "cpu"
                                state.update(device="cpu", reason="GPU worker unavailable; retrying once on CPU")
                                result_path.unlink()
                                Path(job["output"]).unlink(missing_ok=True)
                                # Failed-attempt chunks must never enter the CPU attempt's stream.
                                if (directory / "chunks").exists():
                                    shutil.rmtree(directory / "chunks")
                                continue
                            return self.reply(503, {"error": result["error"]})
                        if streaming:
                            pump()
                            if not emitted:
                                return self.reply(503, {"error": "VOICE_STREAM_EMPTY: no audio chunks"})
                            self.stream_event({"type": "done", "chunks": emitted})
                            return
                        payload = Path(job["output"]).read_bytes() if speech else {**result, "device": device}
                    return self.reply(200, payload, "audio/wav" if speech else "application/json")
                finally:
                    try:
                        if cleanup_deleted_voices(config_path):
                            resident.close()
                    except Exception:
                        pass  # Revoked IDs remain unusable; cleanup can retry later.
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

    class VoiceServer(ThreadingHTTPServer):
        def server_close(self):
            resident.close()
            super().server_close()
    return VoiceServer((host, port), Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    create_server(config, port=listen_port(config), config_path=args.config).serve_forever()
