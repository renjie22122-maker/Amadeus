"""One request per process. Exit releases model allocations, including CUDA contexts."""
import json
import os
from pathlib import Path
import sys
import subprocess
import ctypes

_DLL_HANDLES = []


def deny_network(event, args):
    # This is an offline-inference guard, not a sandbox for arbitrary code.
    if event in ("socket.connect", "socket.getaddrinfo"):
        raise RuntimeError("VOICE_OFFLINE: prepare missing resources before inference")


def run(job):
    config = job["config"]
    device = job["device"]
    os.environ["CUDA_VISIBLE_DEVICES"] = str(config.get("gpuIndex", 0)) if device == "cuda" else ""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["OMP_NUM_THREADS"] = str(config.get("cpuThreads", 2))
    sys.addaudithook(deny_network)
    model = job["model"]
    # CTranslate2 and PyTorch ship different OpenMP runtimes on Windows.
    # Never import PyTorch into the Whisper process.
    if model != "whisper":
        runtime = config.get("torchRuntimePath") if device == "cuda" else None
        if runtime:
            sys.path.insert(0, str(Path(runtime).resolve()))
        import torch
        torch.set_num_threads(int(config.get("cpuThreads", 2)))
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("GPU_UNAVAILABLE: CUDA-enabled speech environment is not ready")
    model_path = config.get("models", {}).get(model)
    if not model_path or not Path(model_path).is_dir():
        raise ValueError("MODEL_NOT_READY: prepare the selected model locally first")
    if model in ("sensevoice", "whisper"):
        import soundfile
        normalized = str(Path(job["result"]).with_suffix(".normalized.wav"))
        subprocess.run([config.get("ffmpeg", "ffmpeg"), "-nostdin", "-v", "error", "-y", "-i", job["audio"], "-vn", "-ac", "1", "-ar", "16000", "-t", "601", normalized], check=True, timeout=30, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if soundfile.info(normalized).duration > 600:
            raise ValueError("Recording exceeds ten minutes; split it without losing timestamps")
        job["audio"] = normalized
    if model == "sensevoice":
        from funasr import AutoModel
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
        engine = AutoModel(model=model_path, device="cuda:0" if device == "cuda" else "cpu", disable_update=True, trust_remote_code=False)
        result = engine.generate(input=job["audio"], cache={}, language=job.get("language") or "auto", use_itn=True, batch_size_s=60)
        return {"text": " ".join(rich_transcription_postprocess(x["text"]) for x in result)}
    if model == "whisper":
        from faster_whisper import WhisperModel
        import ctranslate2
        if device == "cuda":
            if not ctranslate2.get_cuda_device_count():
                raise RuntimeError("GPU_UNAVAILABLE: CTranslate2 CUDA runtime is not ready")
            # CT2 4.4 uses CUDA 12/cuDNN 8, matching optional Torch 2.3.1 wheels.
            # Load only runtime DLLs, never torch/OpenMP into this process.
            if os.name == "nt":
                library = Path(config["cudaLibraryDirectory"]) if config.get("cudaLibraryDirectory") else Path(config.get("asrPython", sys.executable)).parent.parent / "Lib/site-packages/torch/lib"
                if library.is_dir():
                    _DLL_HANDLES.append(os.add_dll_directory(str(library)))
                try:
                    _DLL_HANDLES.extend(ctypes.WinDLL(name) for name in ("cublas64_12.dll", "cudnn64_8.dll"))
                except OSError as error:
                    raise RuntimeError("GPU_UNAVAILABLE: Whisper requires CUDA 12/cuDNN 8 libraries") from error
        engine = WhisperModel(model_path, device=device, compute_type="int8_float16" if device == "cuda" else "int8", cpu_threads=int(config.get("cpuThreads", 2)), local_files_only=True)
        segments, info = engine.transcribe(job["audio"], language=job.get("language"), vad_filter=True)
        rows = [{"start": s.start, "end": s.end, "text": s.text} for s in segments]
        return {"text": "".join(s["text"] for s in rows), "segments": rows, "language": info.language}
    if model != "cosyvoice":
        raise ValueError("Unsupported model")
    source = Path(config["cosySource"]).resolve()
    sys.path.insert(0, str(source))
    sys.path.insert(0, str(source / "third_party/Matcha-TTS"))
    import torch
    import soundfile
    from cosyvoice.cli.cosyvoice import AutoModel
    torch.set_num_threads(int(config.get("cpuThreads", 2)))
    voice = config.get("voices", {}).get(job.get("voice", "default"))
    if not voice or not Path(voice.get("audio", "")).is_file() or not voice.get("text"):
        raise ValueError("VOICE_NOT_READY: configure a local reference recording and its transcript")
    engine = AutoModel(model_dir=model_path)
    prompt = "You are a helpful assistant.<|endofprompt|>" + voice["text"]
    chunks = engine.inference_zero_shot(job["input"], prompt, voice["audio"], stream=False)
    # Write incrementally; do not accumulate an entire long narration in RAM.
    with soundfile.SoundFile(job["output"], mode="w", samplerate=engine.sample_rate, channels=1, subtype="PCM_16") as output:
        written = 0
        for chunk in chunks:
            samples = chunk["tts_speech"].detach().cpu().numpy().reshape(-1)
            written += len(samples)
            if written > engine.sample_rate * 600:
                raise ValueError("Audio exceeds ten-minute request limit; split into sections")
            output.write(samples)
    if not written:
        raise ValueError("Model returned no audio")
    return {"mime": "audio/wav"}


if __name__ == "__main__":
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    try:
        result = run(job)
        Path(job["result"]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    except Exception as error:
        message = str(error)
        code = "GPU_UNAVAILABLE" if message.startswith("GPU_UNAVAILABLE:") else "GPU_OOM" if "CUDA out of memory" in message else None
        Path(job["result"]).write_text(json.dumps({"error": type(error).__name__ + ": " + message[:500], "code": code}), encoding="utf-8")
        raise
