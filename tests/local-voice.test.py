import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.request
from urllib.error import HTTPError
from unittest.mock import patch
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
        with patch.object(service.subprocess, "run", side_effect=AssertionError("must not launch")):
            self.assertEqual(self.request("/health", token=False)[0], 401)
            status, body, _ = self.request("/health")
            self.assertEqual(status, 200)
            self.assertFalse(json.loads(body)["modelLoaded"])
            self.assertNotIn("x" * 40, body.decode())

    def test_validation_before_worker(self):
        with patch.object(service.subprocess, "run", side_effect=AssertionError("must not launch")):
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
        with patch.object(service.subprocess, "run", side_effect=worker):
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
        with patch.object(service.subprocess, "run", side_effect=worker):
            status, body, mime = self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "hello", "response_format": "wav"})
            self.assertEqual((status, body, mime), (200, b"RIFFfixture", "audio/wav"))
        self.assertFalse(paths[0].exists())

    def test_gpu_policy_fails_closed_and_cpu_never_probes(self):
        with patch.object(policy.subprocess, "run", side_effect=AssertionError("no GPU probes")):
            self.assertEqual(policy.select_device({"device": "cpu"})[0], "cpu")
            self.assertEqual(policy.select_device({"device": "auto", "comfyUrls": []})[0], "cpu")
            with self.assertRaisesRegex(RuntimeError, "GPU_BUSY"):
                policy.select_device({"device": "cuda", "comfyUrls": []})

    def test_multipart_preserves_binary_and_ignores_filename(self):
        body = b'--edge\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper\r\n--edge\r\nContent-Disposition: form-data; name="file"; filename="../../bad"\r\nContent-Type: audio/wav\r\n\r\nRIFF\x00\xff\r\n--edge--\r\n'
        fields, audio = service.parse_upload("multipart/form-data; boundary=edge", body)
        self.assertEqual(fields["model"], "whisper")
        self.assertEqual(audio, b"RIFF\x00\xff")


if __name__ == "__main__":
    unittest.main()
