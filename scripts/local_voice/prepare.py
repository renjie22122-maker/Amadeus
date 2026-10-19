"""Explicit model preparation only. Normal inference never downloads weights."""
import argparse
import json
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download

MODELS = {"sensevoice": "FunAudioLLM/SenseVoiceSmall", "whisper": "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "cosyvoice": "FunAudioLLM/Fun-CosyVoice3-0.5B-2512", "cosyvoice-sft": "FunAudioLLM/CosyVoice-300M-SFT"}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--models", nargs="+", choices=list(MODELS), default=["sensevoice", "whisper", "cosyvoice"])
    args = parser.parse_args()
    path = Path(args.config)
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    receipts = config.setdefault("modelRevisions", {})
    for name in args.models:
        repository = MODELS[name]
        revision = receipts.get(name) or HfApi().model_info(repository).sha
        destination = config.setdefault("models", {}).get(name) or str((path.parent / "models" / name).resolve())
        snapshot_download(repository, revision=revision, local_dir=destination)
        # Publish readiness only after the complete pinned snapshot is present.
        if name == "cosyvoice-sft":
            import torch
            speakers = torch.load(str(Path(destination) / "spk2info.pt"), map_location="cpu", weights_only=True)
            (Path(destination) / "preset-voices.json").write_text(json.dumps(list(speakers), ensure_ascii=False), encoding="utf-8")
        # Preserve concurrent user voice/settings edits made during a long download.
        config = json.loads(path.read_text(encoding="utf-8-sig"))
        receipts = config.setdefault("modelRevisions", {})
        config.setdefault("models", {})[name] = destination
        receipts[name] = revision
        temporary = path.with_suffix(".prepare.tmp")
        temporary.write_text(json.dumps(config, indent=2), encoding="utf-8")
        temporary.replace(path)
        print(name + " prepared at revision " + revision, flush=True)
