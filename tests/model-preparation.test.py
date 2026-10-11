import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).resolve().parents[1] / "scripts/prepare_retrieval_models.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

class ManagedModels(unittest.TestCase):
    def test_copy_reuse_and_detach(self):
        with tempfile.TemporaryDirectory() as tmp:
            prepare.ROOT = Path(tmp) / "data"
            source = Path(tmp) / "source"
            source.mkdir()
            (source / "config.json").write_text("{}")
            (source / "model.safetensors").write_bytes(b"fixture")
            target = Path(prepare.prepare("fixture/model", str(source)))
            stamp = (target / "model.safetensors").stat().st_mtime_ns
            self.assertEqual(prepare.prepare("fixture/model", str(source)), str(target))
            self.assertEqual(stamp, (target / "model.safetensors").stat().st_mtime_ns)
            (source / "model.safetensors").unlink()
            self.assertEqual((target / "model.safetensors").read_bytes(), b"fixture")
    def test_invalid_source_does_not_update_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            prepare.ROOT = Path(tmp)
            prepare.CONFIG = Path(tmp) / "config.json"
            value = {"embeddingModel": "fixture/model", "embeddingPath": str(Path(tmp) / "missing")}
            prepare.CONFIG.write_text(json.dumps(value))
            with self.assertRaises(FileNotFoundError):
                prepare.main()
            self.assertEqual(json.loads(prepare.CONFIG.read_text()), value)

if __name__ == "__main__":
    unittest.main()
