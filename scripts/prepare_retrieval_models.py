"""Prepare managed model assets. Offline sources are optional, never runtime dependencies."""
import hashlib
import json
import os
from pathlib import Path
import shutil

ROOT = Path(os.environ.get("AGENTDEMO_DATA_DIR") or Path(__file__).resolve().parents[1] / ".data")
CONFIG = ROOT / "retrieval-service/config.json"

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.digest()

def prepare(model, source=None):
    target = ROOT / "retrieval-service/models" / hashlib.sha256(model.encode()).hexdigest()[:24]
    target.mkdir(parents=True, exist_ok=True)
    if source:
        origin = Path(source).resolve(strict=True)
        if origin == target.resolve():
            return str(target.resolve())
        # Reject links instead of copying files outside the selected model folder.
        for entry in origin.rglob("*"):
            if entry.is_symlink() or getattr(entry, "is_junction", lambda: False)():
                raise ValueError("Model folder contains a link: " + str(entry))
            if not entry.is_file():
                continue
            destination = target / entry.relative_to(origin)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists() and destination.stat().st_size == entry.stat().st_size and digest(destination) == digest(entry):
                continue
            temporary = destination.with_name(destination.name + ".partial")
            shutil.copyfile(entry, temporary)
            if digest(temporary) != digest(entry):
                raise ValueError("Model copy verification failed")
            temporary.replace(destination)
    else:
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=model, local_dir=str(target),
                          allow_patterns=["*.json", "*.safetensors", "*.bin", "*.model", "*.txt"])
    if not (target / "config.json").exists():
        raise ValueError("Model config.json missing: " + str(target))
    return str(target.resolve())

def main():
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    for kind in ("embedding", "rerank"):
        print("Preparing " + kind + " model...", flush=True)
        config[kind + "Path"] = prepare(config[kind + "Model"], config.get(kind + "Path"))
    # Preserve permissions of the private config by updating its existing inode.
    with CONFIG.open("w", encoding="utf-8") as stream:
        json.dump(config, stream)
    print("Managed models ready; the offline source is no longer needed.", flush=True)

if __name__ == "__main__":
    main()
