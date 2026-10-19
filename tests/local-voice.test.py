import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
from urllib.error import HTTPError
from unittest.mock import patch, MagicMock
import subprocess

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/local_voice"))
import service
import policy


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = {"token": "x" * 40, "models": {"cosyvoice": self.tmp.name}, "device": "cpu"}
        self.server = service.create_server(self.config, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = "http://127.0.0.1:" + str(self.server.server_address[1])

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def request(self, path, body=None, token=True):
        headers = {"Authorization": "Bearer " + self.config["token"]} if token else {}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.read(), response.headers.get("Content-Type")
        except HTTPError as error:
            return error.code, error.read(), error.headers.get("Content-Type")

    def test_auth_and_health_do_not_load_models(self):
        with patch.object(service, "run_worker", side_effect=AssertionError("must not launch")):
            self.assertEqual(self.request("/health", token=False)[0], 401)
            status, body, _ = self.request("/health")
            self.assertEqual(status, 200)
            self.assertFalse(json.loads(body)["modelLoaded"])
            self.assertNotIn("x" * 40, body.decode())

    def test_validation_before_worker(self):
        with patch.object(service, "run_worker", side_effect=AssertionError("must not launch")):
            self.assertEqual(self.request("/v1/audio/speech", {"model": "../arbitrary", "input": "hello"})[0], 400)
            self.assertEqual(self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "hello", "response_format": "mp3"})[0], 400)
            self.assertEqual(self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "x" * 4001})[0], 400)

    def test_busy_timeout_and_release(self):
        entered, release = threading.Event(), threading.Event()
        def worker(*args, **kwargs):
            entered.set()
            release.wait(3)
            raise subprocess.TimeoutExpired("worker", 150)
        body = {"model": "cosyvoice", "input": "hello", "response_format": "wav"}
        results = []
        with patch.object(service, "run_worker", side_effect=worker):
            thread = threading.Thread(target=lambda: results.append(self.request("/v1/audio/speech", body)))
            thread.start()
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.request("/v1/audio/speech", body)[0], 429)
            release.set()
            thread.join(4)
            self.assertEqual(results[0][0], 504)
            self.assertFalse(json.loads(self.request("/health")[1])["state"]["busy"])

    def test_wav_result_and_temp_cleanup(self):
        paths = []
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            paths.append(Path(args[-1]))
            Path(job["result"]).write_text(json.dumps({"mime": "audio/wav"}))
            Path(job["output"]).write_bytes(b"RIFFfixture")
        with patch.object(service, "run_worker", side_effect=worker):
            status, body, mime = self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "hello", "response_format": "wav"})
            self.assertEqual((status, body, mime), (200, b"RIFFfixture", "audio/wav"))
        self.assertFalse(paths[0].exists())

    def test_gpu_policy_fails_closed_and_cpu_never_probes(self):
        with patch.object(policy.subprocess, "run", side_effect=AssertionError("no GPU probes")):
            self.assertEqual(policy.select_device({"device": "cpu"})[0], "cpu")
            self.assertEqual(policy.select_device({"device": "auto", "comfyUrls": []})[0], "cpu")
            with self.assertRaisesRegex(RuntimeError, "GPU_BUSY"):
                policy.select_device({"device": "cuda", "comfyUrls": []})

    def test_auto_gpu_failure_retries_once_on_cpu_and_clears_partial_output(self):
        self.config["device"] = "auto"
        devices = []
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            devices.append(job["device"])
            if job["device"] == "cuda":
                Path(job["output"]).write_bytes(b"partial")
                Path(job["result"]).write_text(json.dumps({"error": "CUDA out of memory", "code": "GPU_OOM"}))
            else:
                self.assertFalse(Path(job["output"]).exists())
                Path(job["output"]).write_bytes(b"RIFFcpu")
                Path(job["result"]).write_text(json.dumps({"mime": "audio/wav"}))
        with patch.object(service, "select_device", return_value=("cuda", "idle")), patch.object(service, "run_worker", side_effect=worker):
            status, body, _ = self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "hello"})
        self.assertEqual((status, body, devices), (200, b"RIFFcpu", ["cuda", "cpu"]))

    def test_unrelated_failure_is_not_replayed(self):
        self.config["device"] = "auto"
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            Path(job["result"]).write_text(json.dumps({"error": "missing model file", "code": None}))
        with patch.object(service, "select_device", return_value=("cuda", "idle")), patch.object(service, "run_worker", side_effect=worker) as launch:
            self.assertEqual(self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "hello"})[0], 503)
            self.assertEqual(launch.call_count, 1)

    def test_offline_worker_guard_blocks_unexpected_library_network(self):
        folder = str(Path(__file__).resolve().parents[1] / "scripts/local_voice")
        code = "import sys,socket; sys.path.insert(0," + repr(folder) + "); from worker import deny_network; sys.addaudithook(deny_network); socket.getaddrinfo('example.com',443)"
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("VOICE_OFFLINE", result.stderr)

    def test_gpu_admission_busy_and_low_memory_fall_back(self):
        def response(running):
            handle = MagicMock()
            handle.__enter__.return_value.read.return_value = json.dumps({"queue_running": running, "queue_pending": []}).encode()
            return handle
        opener = MagicMock()
        with patch.object(policy.urllib.request, "build_opener", return_value=opener), patch.object(policy.subprocess, "run") as probe:
            opener.open.return_value = response([1])
            self.assertEqual(policy.select_device({"device": "auto"})[0], "cpu")
            probe.assert_not_called()
            opener.open.return_value = response([])
            probe.return_value.stdout = "1024"
            self.assertEqual(policy.select_device({"device": "auto"})[0], "cpu")
            probe.return_value.stdout = "16000"
            self.assertEqual(policy.select_device({"device": "auto"})[0], "cuda")

    def test_windows_timeout_targets_only_owned_worker_tree(self):
        process = MagicMock()
        process.pid = 12345
        process.wait.side_effect = [subprocess.TimeoutExpired("worker", 1), 1]
        with patch.object(service.os, "name", "nt"), patch.object(service.subprocess, "CREATE_NO_WINDOW", 0, create=True), patch.object(service.subprocess, "Popen", return_value=process), patch.object(service.subprocess, "run") as terminate:
            with self.assertRaises(subprocess.TimeoutExpired):
                service.run_worker(["python", "worker.py"], stdout=None, stderr=None, env={}, timeout=1)
            self.assertEqual(terminate.call_args.args[0], ["taskkill", "/PID", "12345", "/T", "/F"])

    def test_saved_voices_reload_without_restarting_listener(self):
        path = Path(self.tmp.name) / "config.json"
        path.write_text(json.dumps({**self.config, "voices": {"new": {"audio": "local.wav", "text": "exact words"}}}))
        extra = service.create_server(self.config, port=0, config_path=path)
        thread = threading.Thread(target=extra.serve_forever, daemon=True); thread.start()
        previous = self.base; self.base = "http://127.0.0.1:" + str(extra.server_address[1])
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            self.assertEqual(job["config"]["voices"]["new"]["text"], "exact words")
            Path(job["output"]).write_bytes(b"RIFFfixture")
            Path(job["result"]).write_text(json.dumps({"mime": "audio/wav"}))
        try:
            with patch.object(service, "run_worker", side_effect=worker):
                self.assertEqual(self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "hello", "voice": "new"})[0], 200)
        finally:
            self.base = previous; extra.shutdown(); extra.server_close()

    def test_multipart_preserves_binary_and_ignores_filename(self):
        body = b'--edge\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper\r\n--edge\r\nContent-Disposition: form-data; name="file"; filename="../../bad"\r\nContent-Type: audio/wav\r\n\r\nRIFF\x00\xff\r\n--edge--\r\n'
        fields, audio = service.parse_upload("multipart/form-data; boundary=edge", body)
        self.assertEqual(fields["model"], "whisper")
        self.assertEqual(audio, b"RIFF\x00\xff")


if __name__ == "__main__":
    unittest.main()
