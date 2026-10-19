# Local speech and reply read-aloud

[English](LOCAL-VOICE.md) | [简体中文](LOCAL-VOICE.zh-CN.md)

## Architecture and privacy

An optional authenticated service listens on literal loopback `127.0.0.1:8812`. It exposes OpenAI-compatible transcription and speech endpoints, reusing Amadeus media jobs, playback, downloads and workspace export. Audio/text inference stays local; model preparation downloads public code/weights. There is no cloud fallback. Secrets are not returned in public settings.

SenseVoice handles short multilingual recordings; faster-whisper adds segment timestamps; CosyVoice 3 uses a locally configured reference WAV and its exact transcript. These are separate engines, not a realtime conversational voice model. Current output is complete WAV audio, not streaming synthesis. No speaker diarization or automatic dubbing alignment is claimed.

## Prepare and start

Use Python 3.10/3.11, Git and FFmpeg on PATH. Windows: `Setup-Local-Voice.cmd` (Python must be on PATH). Portable alternative, including when PowerShell AllSigned blocks unsigned scripts:

```text
python scripts/local_voice/manage.py setup
python scripts/local_voice/manage.py start
```

Setup uses three environments: `.data/voice-asr-python` (SenseVoice), `.data/voice-whisper-python` (Whisper without PyTorch), and `.data/voice-tts-python` (CosyVoice). Keeping CTranslate2 and PyTorch apart avoids Windows OpenMP conflicts. Compatible native versions are pinned, including SentencePiece 0.2.0 and CTranslate2 4.4.0. Rerun setup to migrate an older two-environment installation. It does not install into RAG, ComfyUI or evaluation environments. `--asr-only` prepares transcription only; `--skip-download` installs dependencies without weights. Download interruption can be resumed by rerunning setup. The resolved model revisions and CosyVoice source revision are recorded. Upstream native packages may require a compiler/platform-specific preparation; installation failure is not readiness.

Models and configuration live under `.data/voice-service` (or `AGENTDEMO_DATA_DIR`). Offline users may place complete model snapshots at the `models` paths in `config.json`. Inference uses local paths and offline Hugging Face settings; it does not fetch missing models. A Python audit hook blocks network connections during inference, including optional upstream text-normalizer downloads; this is not a sandbox for arbitrary native code.

Setup uses the upstream example recording as a default when present and no voice is configured. Settings → Media and voice → **Local voices** now accepts a non-empty reference recording up to 30 seconds (at least 3 seconds recommended) (up to 25 MiB), a name and the exact transcript. Save, preview in Chinese/English/Japanese, then choose it for read-aloud. Uploaded files are normalized locally to 24 kHz mono WAV under random IDs; supplied filenames are never filesystem paths. Saving a voice applies to the next request without restarting. Choosing a voice updates only the local speech connection; other unsaved settings remain in the form. Preview runs local inference and may take one or two minutes on CPU. This conditions synthesis on a reference voice, rather than training a new model.

Advanced users can also configure a recording in `config.json`:

```json
{
  "voices": {
    "default": { "audio": "D:/Voices/reference.wav", "text": "Exact transcript of that recording." }
  }
}
```

Use a recording you are authorized to use. No arbitrary client-supplied filesystem path is accepted by the speech endpoint. Start the service, then Settings → Media and voice → **Add local voice connections** (save other edits first). This adds SenseVoice, Whisper and CosyVoice without duplicating them or replacing an existing microphone selection. Choose the desired transcription service separately. Adding connections does not prove dependencies, weights or voice quality have passed a real inference test.

`Start-Amadeus` starts the configured lightweight service; first-start supports `-LocalVoice -Python <executable>`. Ordinary startup never installs packages or loads speech models. Closing Codex does not own or terminate the detached speech service. No automatic restart of an existing service occurs.

## Resource policy

New installations default to `device: "auto"` (existing choices are preserved); CPU threads default to two. `device: "cpu"` avoids GPU allocation. Each request runs in a separate model process; success, failure or timeout ends that process. This favors predictable release over warm-model latency. The HTTP listener remains small while idle.

`device: "auto"` reads available memory on the NVIDIA GPU before each request, without probing any application or queue. Low memory or an unavailable reading falls back to CPU. A typed CUDA-unavailable or out-of-memory error allows one CPU attempt after the GPU worker exits, only before any streamed audio has been delivered. Other failures are not replayed. `device: "cuda"` rejects unavailable admission without CPU fallback. `gpuIndex` selects a GPU; `minFreeMiB` defaults to 8192, a conservative admission threshold rather than a measured model minimum. Status includes free and required MiB. Memory can change after admission; this is not an exclusive GPU reservation. CPU mode avoids GPU allocation entirely. Legacy `comfyUrls` settings are ignored and no longer generated.

Install matching NVIDIA wheels with `python scripts/local_voice/manage.py setup --cuda` (or `Setup-Local-Voice.ps1 -Cuda`), with the voice service stopped. The CUDA 12.1 Torch 2.3.1 wheels also supply the CUDA/cuDNN libraries used by CTranslate2 4.4 on Windows. Ordinary startup never downloads these large packages. CPU and GPU generally differ mainly in latency, but differing numerical precision, quantization and synthesis sampling can change outputs; quality equivalence is not assumed.

One local request runs at a time; competing requests receive `VOICE_BUSY` and are not automatically replayed. Uploads are bounded to 25 MiB, recordings to ten minutes, synthesis text to 4000 characters, and each model worker to 150 seconds (within the existing media HTTP timeout). Timeout cleanup terminates the owned worker process tree, including Windows virtual-environment redirectors. Cold CPU inference may exceed this: split recordings/narration. Overlong audio is rejected, never silently truncated. FFmpeg normalizes browser/WebM/MP3 audio. Missing dependencies/models, timeout and GPU admission errors remain distinct local diagnostics.

## Read a reply aloud

The speaker button follows copy, branch and feedback on each assistant message. Select a speech connection and press Start. Only that reply's prose is sent; code fences, image URLs and unsent drafts are excluded. Long replies are generated and played sequentially in small segments. The local connection supplies `read_aloud_units: 20`: non-ASCII characters cost one unit and ASCII characters a quarter, with sentence boundaries preferred. This conservative mixed-language budget reduces CPU timeout risk; it is not a pronunciation-duration guarantee. Other services retain their normal segment size, and the UI hint is not sent to speech providers; only one message plays at a time. Stop or switching conversations halts playback and prevents later submissions. Already submitted provider work may finish and remain in media history; stopping playback is not a promise of provider cancellation/refund. Remote services may charge, as noted beside Start. Audio controls provide a manual Play option when browser autoplay is blocked. No automatic reading of new replies.

## Verification boundary

Unit/HTTP tests cover token checks, idle no-load behavior, busy rejection, timeout release, temporary-file cleanup, binary upload parsing, CPU admission and WAV format. TypeScript tests cover connection preservation, loopback-only HTTP and prose segmentation. These tests use a fixture worker, not generated speech, and do not establish ASR accuracy, pronunciation quality or hardware latency. Run an actual Chinese/English recording and synthesis smoke test after installing models and a reference voice. No model download or inference is required by CI.

## Upstream resources

- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [CosyVoice, installation and inference examples](https://github.com/FunAudioLLM/CosyVoice)

The integration is maintained by Amadeus; model code/weights retain their upstream licenses.

## Local smoke results (2026-10-19)

Six authenticated HTTP requests passed on Windows, with automatic CUDA-unavailable → CPU fallback:

| Request                      | Wall time       | Result                                   |
| ---------------------------- | --------------- | ---------------------------------------- |
| SenseVoice Chinese / English | 13.62 / 13.56 s | Expected short test sentence transcribed |
| Whisper Chinese / English    | 19.58 / 15.83 s | Expected text plus segment timestamps    |
| CosyVoice Chinese / English  | 59.34 / 86.03 s | 24 kHz mono WAV, 2.64 / 5.24 s audio     |

Direct synthesis → ASR round trips also recovered the Chinese and English test sentences. These are short smoke fixtures, not an accuracy benchmark or a human listening-quality certification. GPU admission and OOM recovery have deterministic tests; **all six actual GPU HTTP smoke requests also passed using independently copied existing runtimes**, without installing into the source environments. No benchmark runtime or ComfyUI environment was modified. Slow CPU synthesis is expected with per-request cold loading and two CPU threads.

GPU HTTP wall times were SenseVoice Chinese/English **11.17 / 11.44 s**, Whisper **6.88 / 4.41 s**, and CosyVoice **32.83 / 25.28 s** (2.84 / 4.52 s output). These short tests include cold startup and are not general speedup claims. Existing PyTorch **2.6.0+cu118, CPython 3.11** packages were copied for SenseVoice/CosyVoice; Whisper used independently copied CUDA 12/cuDNN 8 DLLs. ComfyUI's newer PyTorch 2.11.0+cu128 was inspected but not modified or adopted. The redundant CUDA download was stopped.

Optional advanced `torchRuntimePath` points to an independently copied compatible package directory, used only for GPU Torch workers; CPU uses its original environment. `cudaLibraryDirectory` points to matching Windows CUDA 12/cuDNN 8 DLLs for CTranslate2. Neither setting adds packages to global PATH or changes source environments. Match Python ABI, package dependencies and CUDA/cuDNN versions, then run actual inference tests. An existing newer runtime is not automatically interchangeable. No username or local source path is shipped in defaults.

## Reference input limits and language

The preset endpoint exposes the local CosyVoice adapter limits to the UI. The installed upstream `cosyvoice/cli/frontend.py::_extract_speech_token` explicitly rejects audio longer than **30 seconds**, including zero-shot and cross-lingual paths. The **3-second recommendation** is quality guidance, not a rejection threshold; **25 MiB** is upload protection, not a model limit. Longer recordings require an excerpt and its matching transcript; the importer never silently truncates them. Output narration length is independent. Different future adapters must declare their own limits.

Reference language is optional metadata, including Japanese; it does not force the output language or translate the transcript. Preview supports Chinese, English and Japanese. Original upload playback is available before saving. Silent recordings are rejected; quiet or clipped recordings receive persisted warnings. These signal checks do not establish speaker identity, transcript correctness or perceptual quality. Use authorized reference material and listen to cross-language output before adopting a voice. No new dependencies or launcher changes are needed.

## Read-aloud presentation

The message action starts playback with one click. Pause/resume, Stop, speed and provider selection share a compact control. The sentence budget is soft up to a bounded extension, and at most one next segment is generated while the current segment plays. For older or remote services this is bounded prefetch, not native streaming. The updated local CosyVoice listener additionally supports native model streaming: one worker emits WAV chunks as inference progresses, the authenticated proxy forwards them without media cards, and Web Audio schedules them on one playback clock. The model remains loaded for that request and exits afterward. The client schedules at most about 30 seconds ahead (plus one bounded chunk). Streams have a 150-second no-audio timeout and 10-minute total limit; disconnects terminate only the owned worker. GPU failure may fall back before any audio is emitted, never after partial playback. Native streaming requires the updated listener; explicit capability rejection before synthesis falls back to the older path, but interrupted streams are never automatically replayed. Stopping cancels client polling and prevents further submissions; an already submitted provider job may continue. Read-aloud receipts remain stored and accessible through the media API but are omitted from the chat gallery, including historical receipts identified by their original operation key. User-requested speech generation still appears normally.

Upgrade validation: the full Node run passed (591 tests: 582 passed, 9 skipped); the subsequently added proxy test also passed. Python voice tests passed (16), as did type/build/document checks. Browser reference import and real FFmpeg normalization passed. A Japanese preview did not finish within the browser test deadline; Japanese perceptual quality is not certified by this test.

Actual short streaming smoke tests (2026-10-19, upstream example reference voice, not a quality benchmark): CPU Chinese first chunk 53.77s / completion 84.84s; English 64.09s / 90.64s. GPU (CUDA) Chinese 25.66s / 26.97s; English 20.25s / 21.75s. All returned two chunks and a completion receipt. Cold loading is included; this does not match online-service instant response. Browser checks separately covered WAV decoding, pause/resume/stop, hidden legacy read-aloud cards and preserved user-generated speech.

GPU selection now depends only on available memory, independent of ComfyUI or any other application. Applying the update requires restarting Agent and the local voice listener; no new dependencies, model downloads or first-start steps. Native streaming is ephemeral read-aloud, without saved chat-media artifacts; ordinary speech generation retains file delivery.
