"""Offline checks for the download collector; no network, model or Docker calls."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

COLLECTOR = Path(__file__).with_name("collect-downloads.py")

class IntegrityTests(unittest.TestCase):
    def invoke(self, root):
        return subprocess.run([sys.executable, str(COLLECTOR), "--output", str(root), "--verify"], capture_output=True, text=True)
    def test_missing_manifest_is_not_success(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertNotEqual(self.invoke(d).returncode, 0)
    def test_intact_and_modified_asset(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            data=root/"fixture"
            data.write_bytes(b"original")
            (root/"collection.json").write_text(json.dumps({"items":{"x":{"status":"downloaded","files":[{"path":"fixture","sha256":hashlib.sha256(b"original").hexdigest()}]}}}))
            self.assertEqual(self.invoke(d).returncode,0)
            data.write_bytes(b"modified")
            self.assertNotEqual(self.invoke(d).returncode,0)
    def test_pending_download_is_not_success(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/"collection.json").write_text(json.dumps({"items":{"x":{"status":"pending_large_asset"}}}))
            self.assertNotEqual(self.invoke(d).returncode,0)
    def test_path_outside_bundle_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/"collection.json").write_text(json.dumps({"items":{"x":{"status":"downloaded","files":[{"path":"../outside","sha256":"unused"}]}}}))
            self.assertNotEqual(self.invoke(d).returncode,0)

if __name__ == "__main__":
    unittest.main()
