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

ASR retains one-shot workers. TTS lazily loads one worker and reuses it for consecutive requests. Default `warmIdleSeconds` is 60 (bounded to 0–300); a two-second idle check releases it on expiry or memory pressure. `warmReserveMiB` defaults to 1024 for an already loaded model; cold admission still uses `minFreeMiB`. Model/device/runtime transitions, failures, timeouts and streaming disconnects discard the worker. Startup itself loads no models.

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

The message action starts playback with one click. Pause/resume, Stop, speed and provider selection share a compact control. The sentence budget is soft up to a bounded extension, and at most one next segment is generated while the current segment plays. For older or remote services this is bounded prefetch, not native streaming. The updated local CosyVoice listener additionally supports native model streaming: one worker emits WAV chunks as inference progresses, the authenticated proxy forwards them without media cards, and Web Audio schedules them on one playback clock. A successful speech worker may remain warm until the idle deadline; failed or disconnected workers are discarded. The client schedules at most about 30 seconds ahead (plus one bounded chunk). Streams have a 150-second no-audio timeout and 10-minute total limit; disconnects terminate only the owned worker. GPU failure may fall back before any audio is emitted, never after partial playback. Native streaming requires the updated listener; explicit capability rejection before synthesis falls back to the older path, but interrupted streams are never automatically replayed. Stopping cancels client polling and prevents further submissions; an already submitted provider job may continue. Read-aloud receipts remain stored and accessible through the media API but are omitted from the chat gallery, including historical receipts identified by their original operation key. User-requested speech generation still appears normally.

Upgrade validation: the full Node run passed (591 tests: 582 passed, 9 skipped); the subsequently added proxy test also passed. Python voice tests passed (16), as did type/build/document checks. Browser reference import and real FFmpeg normalization passed. A Japanese preview did not finish within the browser test deadline; Japanese perceptual quality is not certified by this test.

Actual short streaming smoke tests (2026-10-19, upstream example reference voice, not a quality benchmark): CPU Chinese first chunk 53.77s / completion 84.84s; English 64.09s / 90.64s. GPU (CUDA) Chinese 25.66s / 26.97s; English 20.25s / 21.75s. All returned two chunks and a completion receipt. Cold loading is included; this does not match online-service instant response. Browser checks separately covered WAV decoding, pause/resume/stop, hidden legacy read-aloud cards and preserved user-generated speech.

GPU selection now depends only on available memory, independent of ComfyUI or any other application. Applying the update requires restarting Agent and the local voice listener; no new dependencies, model downloads or first-start steps. Native streaming is ephemeral read-aloud, without saved chat-media artifacts; ordinary speech generation retains file delivery.

Read-aloud service selection uses the declared `wav-ndjson-v1` capability, not a built-in connection ID or fixed port. In Media settings, enable it only for a service that implements the NDJSON WAV chunk contract; changing endpoint/model requires reconfirmation. Native listener `voice-service/config.json` optionally sets `listenPort` (default 8812); startup, health checks, registration and preview read the same value. Restart the listener after a port change, then re-add local connections to refresh their endpoint. Existing default installations need no manual migration. No dependencies or first-start steps changed.

## Unified pretrained and reference voice discovery

Reference cloning remains available. Optionally prepare the official [CosyVoice-300M-SFT](https://huggingface.co/FunAudioLLM/CosyVoice-300M-SFT) snapshot with the configured TTS Python:

```text
python scripts/local_voice/prepare.py --config .data/voice-service/config.json --models cosyvoice-sft
```

This separate, revision-pinned model is about 2.6 GB. It is not downloaded by default. Preparation publishes the model path and speaker manifest only after download; retries reuse the cache. Speaker names come from the actual checkpoint. The settings voice list includes both references and `preset:` speakers. Existing voices and defaults remain intact. Updated listeners load the selected model on demand and release it after the bounded idle period; no replacement of the cloning model is needed.

`media_services` exposes IDs, names, source and language metadata for matching local speech connections. It excludes reference recordings, transcripts, private paths and credentials. Use `generate_media` with `options.voice` to select a listed ID, honoring explicit user choices and stable character assignments. This applies to narration, dialogue and other tasks, without a roleplay-specific branch. Unknown providers are not assigned invented catalogs. Speech generation retains normal permission/cost handling and does not authorize autoplay of history.

## Playback buffering and developer validation

Native playback starts with a 1.5-second scheduling lead. An underrun rebuilds 0.5–3 seconds of buffer; already scheduled audio remains contiguous on one audio clock. Sustained generation slower than playback can still wait. Duplicate/missing sequences and premature termination fail instead of silently skipping audio.

Diagnostics are test-only, with no download control in daily settings. Tests explicitly supply bounded, memory-only `ReadAloudDiagnostics` to capture sent text, the server text hash, WAV chunks and arrival/decode/scheduling/end-callback times. Scheduled times are not physical speaker measurements. Normal playback does not retain diagnostic text or audio.

On 2026-10-19 a normal upstream sample voice on CUDA produced 9 chunks, 29.68 seconds of audio in 39.31 seconds, first chunk at 17.44 seconds. A 1.36-second chunk was followed after 1.47 seconds; a 2-second chunk was followed after 2.94 seconds. Replaying this timing with the new lead has no scheduling gap. Concatenated chunk PCM exactly matches the complete generated file. Two ASR systems covered all ordinary Chinese test sentences; no paragraph omission or Japanese was observed. One ASR hallucinated a tail beyond the actual audio duration, which is not evidence of TTS contamination. These results do not validate all voices or cross-language synthesis; character voices were not tested, and unreplicated historical omissions/language shifts are not declared fixed.

Set `AMADEUS_TEST_SPEECH_BROWSER=1` and run `node --import tsx --test tests/read-aloud-browser.test.ts` for an installed Edge AudioContext test using ordinary synthetic waveforms. CI does not download a browser. Regular tests cover text forwarding, chunk fidelity/order, cancellation, buffering, catalog privacy and diagnostic memory bounds.

Additional pretrained-model smoke results: Chinese female, English female and Japanese male produced WAV files on CUDA in approximately 23.9/34.8/21.3 seconds. Independent ASR matched the Chinese and English test sentences. **Japanese male did not pass content checks**: both SenseVoice and Whisper diverged substantially from the input. Non-streaming and language-marker controls also failed; these experimental parameters were not added to production. Successful download, WAV output and CI do not establish language quality. The remaining four pretrained voices have not received individual content checks. All choices and existing cloning remain available, without claiming every voice has been validated.

## 2026-10-19 warm-worker measurements and limits

An ordinary upstream reference and identical Chinese text took 24.23 s cold versus 8.95 s warm; first chunks arrived at 16.86 versus 3.56 s. Cold dependency import took 7.36 s and model loading 7.25 s. Independent CPU SenseVoice transcriptions covered both complete texts, quoted dialogue and final sentences without extra Japanese. A separate four-second idle test confirmed worker exit. These are limited smoke samples, not guarantees for every voice.

Worker receipts expose importsSeconds, modelLoadSeconds, modelReused and per-chunk generationSeconds, cpuCopySeconds, writeSeconds, readySeconds and audioSeconds. Generator timing includes upstream preprocessing/reference extraction and waiting, not only GPU kernels. CPU transfer may synchronize CUDA. Performance-counter instrumentation does not insert global CUDA synchronization. Health exposes timings only, never reference transcripts. Developer fixtures can correlate private input/WAV receipts with browser playback diagnostics; no diagnostic-download UI is required.

The initial Windows measurements used a coarse monotonic clock; zero-duration copy/write observations do not establish zero cost. Instrumentation now uses the high-resolution performance counter. Playback buffering remains necessary: reuse removes cold-load overhead, not sustained generation bottlenecks.

Cloning remains available. The CosyVoice3 reference prefix is applied only to that generation. No text deletion, Japanese filtering or speculative audio trimming masks content failures. The previously failed Japanese SFT content test remains unresolved; historical reference leakage/omission has not been stably reproduced with ordinary fixtures. CI is not speech-content certification. Startup scripts need no new dependency/download steps; the updated voice listener must eventually restart to adopt the worker protocol.

### Delete uploaded voices

Only uploaded UUID clones expose Delete, with confirmation. Built-in/default and pretrained voices are protected. A clone selected as a connection default must be replaced first. Revocation immediately removes catalog visibility, name and transcript; a content-free tombstone lets the listener unlink only its owned UUID recording after the active request or an idle cleanup request. Offline listeners report deferred cleanup and retry on the next speech request. External source recordings, generated audio and model weights are untouched. In-flight synthesis can finish; later jobs referencing the revoked ID fail explicitly rather than changing voice silently.

Long-text fixture: the user's mirror story with the ordinary upstream reference produced 22 chunks / 80.64 seconds in about 88.67 seconds including cold start and cleanup. Chunk PCM exactly matched the full WAV. Independent SenseVoice transcription covered the previously omitted paragraphs without detected Japanese, but contained individual word differences. Scheduling replay using measured arrival times had no underrun; this is not an acoustic end-to-end guarantee or resolution of the historical cloned-voice case.

Reference features use the upstream `add_zero_shot_spk` / `zero_shot_spk_id` API with at most one ephemeral entry. Audio-content SHA-256 plus the exact transcript invalidates it, not filenames or timestamps alone. No speaker features are saved to model checkpoints. Reference changes evict the previous entry; worker release and successful deleted-reference cleanup discard the process. Receipts add `referencePrepareSeconds` and `referenceReused`.

One same-text before/after comparison took 61.22 s with reference caching versus 88.67 s before it, with identical full-WAV SHA-256 (`21f20016fe38ce2f47e19d329e3e683ae339fd19db0e0a4182cf69fff2e6c7b3`). This is a single local observation, not a guaranteed speedup under other loads. Reference extraction no longer repeats for every normalized text segment.

### Synthesis coverage diagnostics

The worker preserves source spans, submits explicit sentence-sized segments, and
disables the model's second normalization pass. Kana and Hangul bypass the
Chinese/English normalizer, including reference transcripts. This avoids treating
Japanese kanji as proof that the text is Chinese. Source text is never silently
truncated to fit a segment.

Empty spoken segments and implausibly short dense-script audio produce an error.
These are conservative anomaly checks, not proof of transcription accuracy:
`generated-unverified` explicitly means no semantic coverage verification occurred.
There is no automatic regeneration loop or automatic change of voice. Streaming
can already have delivered earlier chunks when a later segment fails.

The local voice config's sibling `diagnostics/` keeps the latest 20 synthesis
traces (source/model text, segment offsets, duration and device; no credentials
or reference transcript). They contain private narration text; keep this folder
local and delete it when no longer needed. Temporary worker logs and audio are
not retained there. Diagnostics are for troubleshooting, not a public UI step.

All runtime modules and regression tests are in this repository; no developer
scratch directory is required. On a new computer run `Setup-Local-Voice.cmd`,
prepare models, and configure voices using the documented setup. Model weights,
voice recordings, `.data`, credentials and machine-specific config are not
included in Git. Reconfigure paths rather than copying old absolute paths.

Speech requests accept `language` (e.g. `ja`, `zh-CN`, `en`). Explicit language takes precedence; otherwise routing is inferred once for the entire request, so a kanji-only segment inherits Japanese from nearby kana. Unsupported language normalizers preserve the original text; no kana transliteration is applied. Preview supplies its selected language, and streaming forwards the configured language default. Reference language is independent of output language.

## Incremental browser transcription

Chat Connections → Browser voice offers the configured whole-sentence recognizer and explicitly registered `audio-snapshot-v1` services. Register/update local voice connections in Settings after upgrading to expose Whisper preview; existing selected voice/defaults are preserved. No extra model download is needed when faster-whisper and its packaged Silero VAD are prepared.

This is bounded incremental decoding of cumulative audio, not a native streaming Whisper model: one request in flight, at least 1.5 s between snapshots, adaptive pacing, no backlog of obsolete previews. Whole audio is retained (120 s / approximately 7 MiB recording cap) and decoded once more at finish. Preview text can be revised and never starts a model turn, creates a transcript artifact, or grants permissions. Only the final transcript is sent. The existing whole-sentence path, including SenseVoice, remains selectable.

Automatic endpointing combines Silero speech timestamps (at least 1.2 s trailing silence), a fresh result and a live browser audio-level guard. Manual finish remains available; disable auto finish for long pauses. Background throttling, slow inference and missing audio meters fall back to manual finish. Recording stops before playback. This is half-duplex, not barge-in/full-duplex calling.

ASR now reuses the single leased worker, with runtime/model/device isolation and the existing idle/VRAM-pressure release policy. ASR/TTS transitions replace the resident model rather than holding both. GPU admission retains typed CPU fallback. A CPU preview exceeding 4 s pauses further previews for that turn instead of queuing work. End-of-turn recognition can still be slow on CPU.

Measured on the local RTX 4090, 2026-10-21: English first 2 s cold snapshot 3.91 s (model load 2.50 s); warm full English/Chinese/Japanese short samples 0.67/0.67/0.72 s, repeats 0.67/0.63/0.67 s. CPU English cold 19.25 s, warm full 14.91 s. These are worker wall times including decoding/VAD, not browser microphone-to-text latency or an accuracy benchmark. Japanese used the public [JSUT sample referenced by kotoba-tech](https://github.com/kotoba-tech/tts_eval); older synthetic Japanese clips were unsuitable as recognition ground truth. Preview completion and repeat transcripts matched for these short samples; longer/noisy/mixed-language speech still needs broader evaluation. No general zero-error claim is made.

Verification: Python worker lifecycle/admission tests; HTTP capability/target/scope/provisional-only tests; opt-in `AMADEUS_TEST_CHAT_VOICE=1` browser test verifies provisional text does not dispatch and only final corrected text is sent. Browser test mocks audio/service responses; it does not certify real microphone quality. Service results include device, model reuse/load/inference timings and VAD timestamps, without publishing credentials. Preview responses are ephemeral, not an accumulating library of partial transcripts.
