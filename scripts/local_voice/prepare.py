"""Explicit model preparation only. Normal inference never downloads weights."""
import argparse
import json
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

MODELS = {"sensevoice": "FunAudioLLM/SenseVoiceSmall", "whisper": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "cosyvoice": "FunAudioLLM/Fun-CosyVoice3-0.5B-2512"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--models", nargs="+", choices=list(MODELS), default=list(MODELS))
    args = parser.parse_args()
    path = Path(args.config)
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    receipts = config.setdefault("modelRevisions", {})
    for name in args.models:
        repository = MODELS[name]
        revision = receipts.get(name) or HfApi().model_info(repository).sha
        snapshot_download(repository, revision=revision, local_dir=config["models"][name])
        receipts[name] = revision
        path.write_text(json.dumps(config, indent=2), encoding="utf-8")
        print(name + " prepared at revision " + revision, flush=True)
