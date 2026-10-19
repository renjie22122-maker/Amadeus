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

    def test_revoked_reference_cleanup_only_unlinks_owned_upload(self):
        import uuid
        root = Path(self.tmp.name)
        voices = root / 'voices'; voices.mkdir()
        identity = str(uuid.uuid4())
        target = voices / (identity + '.wav'); target.write_bytes(b'owned')
        external = root / 'outside.wav'; external.write_bytes(b'keep')
        other = str(uuid.uuid4())
        config = root / 'config.json'
        data = {'voices': {identity: {'deleted':True,'source':'user-upload','audio':str(target)}, other:{'deleted':True,'source':'user-upload','audio':str(external)}, 'default': {'audio':str(external)}}}
        config.write_text(json.dumps(data))
        service.cleanup_deleted_voices(config)
        self.assertFalse(target.exists())
        self.assertEqual(external.read_bytes(),b'keep')
        service.cleanup_deleted_voices(config)  # idempotent

    def test_cleanup_rejects_a_linked_voice_directory(self):
        import os
        root = Path(self.tmp.name)
        outside = root / 'external'; outside.mkdir()
        try:
            os.symlink(outside, root / 'voices', target_is_directory=True)
        except OSError:
            self.skipTest('directory symlink permission unavailable')
        config = root / 'config.json'; config.write_text(json.dumps({'voices':{}}))
        with self.assertRaisesRegex(ValueError, 'VOICE_PATH'):
            service.cleanup_deleted_voices(config)

    def test_listener_port_is_configurable_and_validated(self):
        self.assertEqual(policy.listen_port({}), 8812)
        self.assertEqual(policy.listen_port({"listenPort": 9876}), 9876)
        for port in (0, -1, 65536, True, "8812"):
            with self.assertRaises(ValueError):
                policy.listen_port({"listenPort": port})

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

    def test_preset_voice_routes_to_prepared_sft_without_reference_audio(self):
        self.config["models"]["cosyvoice-sft"] = self.tmp.name
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            self.assertEqual(job["model"], "cosyvoice-sft")
            self.assertEqual(job["voice"], "preset:speaker-a")
            self.assertEqual(job["input"], "ordinary test")
            self.assertNotIn("voices", job["config"])
            Path(job["result"]).write_text(json.dumps({"mime": "audio/wav"}))
            Path(job["output"]).write_bytes(b"RIFFpreset")
        with patch.object(service, "run_worker", side_effect=worker):
            status, body, _ = self.request("/v1/audio/speech", {"model": "cosyvoice", "voice": "preset:speaker-a", "input": "ordinary test"})
            self.assertEqual((status, body), (200, b"RIFFpreset"))
        del self.config["models"]["cosyvoice-sft"]
        with patch.object(service, "run_worker", side_effect=AssertionError("no implicit download")):
            self.assertEqual(self.request("/v1/audio/speech", {"model": "cosyvoice", "voice": "preset:speaker-a", "input": "ordinary test"})[0], 503)

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
                chunks = Path(job["output"]).parent / "chunks"
                chunks.mkdir()
                (chunks / "1.wav").write_bytes(b"stale failed attempt")
                Path(job["result"]).write_text(json.dumps({"error": "CUDA out of memory", "code": "GPU_OOM"}))
            else:
                self.assertFalse(Path(job["output"]).exists())
                self.assertFalse((Path(job["output"]).parent / "chunks").exists())
                Path(job["output"]).write_bytes(b"RIFFcpu")
                Path(job["result"]).write_text(json.dumps({"mime": "audio/wav"}))
        with patch.object(service, "select_device", return_value=("cuda", "idle")), patch.object(service, "run_worker", side_effect=worker):
            status, body, _ = self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "hello"})
        self.assertEqual((status, body, devices), (200, b"RIFFcpu", ["cuda", "cpu"]))

    def test_stream_retry_never_emits_failed_attempt_chunks(self):
        import base64
        import io
        import wave
        def wav(value):
            output = io.BytesIO()
            with wave.open(output, "wb") as audio:
                audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                audio.writeframes(value.to_bytes(2, "little", signed=True) * 80)
            return output.getvalue()
        good, stale = wav(1000), wav(-1000)
        self.config["device"] = "auto"
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            chunks = Path(job["output"]).parent / "chunks"
            chunks.mkdir(exist_ok=True)
            if job["device"] == "cuda":
                (chunks / "1.wav").write_bytes(stale)
                Path(job["result"]).write_text(json.dumps({"error": "OOM", "code": "GPU_OOM"}))
            else:
                (chunks / "0.wav").write_bytes(good)
                Path(job["result"]).write_text(json.dumps({"mime": "audio/wav"}))
            return 0
        with patch.object(service, "select_device", return_value=("cuda", "idle")), patch.object(service, "run_worker", side_effect=worker):
            status, body, _ = self.request("/v1/audio/speech", {"model": "cosyvoice", "input": "normal fixture", "stream": True})
        frames = [json.loads(line) for line in body.splitlines()]
        audio = [frame for frame in frames if frame["type"] == "audio"]
        self.assertEqual(status, 200)
        self.assertEqual(len(audio), 1)
        self.assertEqual(base64.b64decode(audio[0]["audio"]), good)
        self.assertEqual(frames[-1], {"type": "done", "chunks": 1})

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

    def test_gpu_admission_uses_memory_not_application_state(self):
        with patch.object(policy.subprocess, "run") as probe, patch.object(urllib.request, "build_opener", side_effect=AssertionError("no application probes")):
            probe.return_value.stdout = "8191"
            self.assertEqual(policy.select_device({"device": "auto"})[0], "cpu")
            probe.return_value.stdout = "8192"
            device, reason = policy.select_device({"device": "auto", "comfyUrls": ["http://invalid"], "gpuIndex": 1})
            self.assertEqual(device, "cuda")
            self.assertIn("8192 MiB free", reason)
            self.assertEqual(probe.call_args.args[0][2], "1")
            probe.return_value.stdout = "4096"
            self.assertEqual(policy.select_device({"device": "auto", "minFreeMiB": 4096})[0], "cuda")
            with self.assertRaisesRegex(RuntimeError, "GPU_BUSY"):
                policy.select_device({"device": "cuda"})

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
            self.assertEqual(job["input"], "hello")
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


    def test_stream_delivers_audio_before_worker_finishes_and_has_terminal_receipt(self):
        received = threading.Event()
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            self.assertTrue(job["stream"])
            folder = Path(job["output"]).parent / "chunks"
            folder.mkdir()
            (folder / "0.wav").write_bytes(b"RIFFfixture")
            kwargs["on_tick"]()
            self.assertTrue(received.wait(2), "audio must reach client before inference completes")
            Path(job["result"]).write_text(json.dumps({"mime": "audio/wav"}))
            return 0
        request = urllib.request.Request(self.base + "/v1/audio/speech", data=json.dumps({"model": "cosyvoice", "input": "hello", "stream": True}).encode(), headers={"Authorization": "Bearer " + self.config["token"], "Content-Type": "application/json"})
        with patch.object(service, "run_worker", side_effect=worker):
            with urllib.request.urlopen(request, timeout=5) as response:
                first = json.loads(response.readline())
                self.assertEqual(first["type"], "audio")
                self.assertEqual(first["sequence"], 0)
                received.set()
                frames = [json.loads(line) for line in response.readlines()]
                self.assertEqual(frames[-1], {"type": "done", "chunks": 1})
        self.assertFalse(json.loads(self.request('/health')[1])["state"]["busy"])

    def test_stream_partial_gpu_failure_is_not_replayed_on_cpu(self):
        self.config["device"] = "auto"
        def worker(args, **kwargs):
            job = json.loads(Path(args[-1]).read_text())
            folder = Path(job["output"]).parent / "chunks"
            folder.mkdir(); (folder / "0.wav").write_bytes(b"RIFFfirst")
            kwargs["on_tick"]()
            Path(job["result"]).write_text(json.dumps({"error": "CUDA out of memory", "code": "GPU_OOM"}))
            return 1
        with patch.object(service, "select_device", return_value=("cuda", "idle")), patch.object(service, "run_worker", side_effect=worker) as launch:
            status, body, mime = self.request('/v1/audio/speech', {"model": "cosyvoice", "input": "hello", "stream": True})
            self.assertEqual(status, 200)
            self.assertEqual(mime, 'application/x-ndjson')
            self.assertEqual(json.loads(body.splitlines()[-1])["type"], "error")
            self.assertEqual(launch.call_count, 1)

    def test_stream_disconnect_terminates_only_owned_worker(self):
        process = MagicMock(); process.pid = 12345; process.poll.return_value = None
        with patch.object(service.os, "name", "nt"), patch.object(service.subprocess, "CREATE_NO_WINDOW", 0, create=True), patch.object(service.subprocess, "Popen", return_value=process), patch.object(service.subprocess, "run") as terminate:
            with self.assertRaises(BrokenPipeError):
                service.run_worker(["python", "worker.py"], stdout=None, stderr=None, env={}, timeout=1, on_tick=lambda: (_ for _ in ()).throw(BrokenPipeError()))
            self.assertEqual(terminate.call_args.args[0], ["taskkill", "/PID", "12345", "/T", "/F"])



    def test_gpu_probe_errors_and_invalid_memory_fail_closed(self):
        with patch.object(policy.subprocess, "run") as probe:
            for value in ("N/A", "", "16000\n16000", "-1"):
                probe.return_value.stdout = value
                self.assertEqual(policy.select_device({"device": "auto"})[0], "cpu")
            for error in (FileNotFoundError("nvidia-smi"), subprocess.TimeoutExpired("nvidia-smi", 3)):
                probe.side_effect = error
                self.assertEqual(policy.select_device({"device": "auto"})[0], "cpu")
                with self.assertRaisesRegex(RuntimeError, "GPU_BUSY"):
                    policy.select_device({"device": "cuda"})




class ResidentTests(unittest.TestCase):
    def test_warm_policy_validation(self):
        from resident import ResidentWorker
        for config in ({'warmIdleSeconds':float('nan')}, {'warmIdleSeconds':301}, {'warmIdleSeconds':True}, {'warmReserveMiB':0}):
            with self.assertRaises(ValueError): ResidentWorker.validate(config)
        ResidentWorker.validate({})

    def test_reuse_switch_expiry_and_timeout(self):
        from resident import ResidentWorker
        import time
        with tempfile.TemporaryDirectory() as folder:
            d = Path(folder)
            script = d / "fake.py"
            script.write_text("import sys,json,os,time\nfrom pathlib import Path\nfor line in sys.stdin:\n j=json.loads(Path(json.loads(line)).read_text())\n time.sleep(j.get('delay',0))\n p=Path(j['result']); t=p.with_suffix('.tmp'); t.write_text(json.dumps({'pid':os.getpid()})); t.replace(p)\n")
            pool = ResidentWorker()
            config = {'models': {'cosyvoice': folder}, 'warmIdleSeconds': 60}
            request = d / 'job.json'
            def run(device='cpu', delay=0, timeout=5):
                result = d / 'result.json'; result.unlink(missing_ok=True)
                request.write_text(json.dumps({'config': config, 'model':'cosyvoice', 'device':device, 'result':str(result), 'delay':delay}))
                pool.run([sys.executable, str(script), str(request)], env=None, timeout=timeout, probe=lambda c: ('cuda','ok'))
                return json.loads(result.read_text())['pid']
            try:
                first = run()
                self.assertEqual(first, run())
                self.assertTrue(pool.available())
                second = run('cuda')
                self.assertNotEqual(first, second)
                pool._idle(config, lambda c: ('cpu','low memory'))
                self.assertFalse(pool.available())
                run()
                pool._idle({**config, 'warmIdleSeconds':0}, lambda c: ('cuda','ok'))
                self.assertFalse(pool.available())
                with self.assertRaises(subprocess.TimeoutExpired):
                    run(delay=5,timeout=.1)
                self.assertFalse(pool.available())
            finally:
                pool.close()

    def test_disconnect_discards_worker_without_replay(self):
        from resident import ResidentWorker
        pool = ResidentWorker()
        with tempfile.TemporaryDirectory() as folder:
            d=Path(folder); request=d/'job.json'
            request.write_text(json.dumps({'config':{'models':{'cosyvoice':folder}},'model':'cosyvoice','device':'cpu','result':str(d/'result.json')}))
            script=d/'fake.py';script.write_text('import time;time.sleep(20)')
            def disconnected(): raise BrokenPipeError('closed')
            with self.assertRaises(BrokenPipeError):
                pool.run([sys.executable,str(script),str(request)], env=None, timeout=5, probe=lambda c:('cpu',''),on_tick=disconnected)
            self.assertFalse(pool.available())

if __name__ == "__main__":
    unittest.main()
