# Benchmark downloads and transfer

[English](BENCHMARK-DOWNLOADS.md) | [简体中文](BENCHMARK-DOWNLOADS.zh-CN.md) · [Plan](BENCHMARKS.md)

## Local layout

Use **D:\Amadeus-Benchmarks**, outside source control and the application's knowledge stores:

- incoming/swe-smoke-v1: transferred bundle.
- datasets: runtime data; gold and hidden tests are grader-only.
- images: Docker save archives.
- runs: logs, patches and reports; never automatically upload.
- cache: reproducible caches.
- manifests: versions, task IDs and SHA256.
- wsl: optional dedicated Linux distribution.

On 2026-10-12 D: had about 195 GiB free; C: about 32 GiB. Docker's default WSL directory is on C:. Saving tar archives on D: does **not** move installed images there. Before large imports, use Docker Desktop's Disk image location setting to migrate to **D:\DockerData**. Never move a running VHDX manually. [Official capacity guidance](https://www.swebench.com/SWE-bench/guides/docker_setup/).

## Full collection requested

Copy evals/benchmark/collect-downloads.py and download-catalog.json together to the online machine. Install Python 3.10+ and Git:

```powershell
python -m pip install huggingface_hub gdown
python collect-downloads.py --output E:\Amadeus-Benchmark-Pack --assets
python collect-downloads.py --output E:\Amadeus-Benchmark-Pack --verify
```

This downloads all candidate source repositories, complete Verified/Lite/LongMemEval data, five WebArena assets and OSWorld initialization cache. Git/HF revisions lock on first resolution; files receive sizes and hashes. Errors do not hide other results; retries retain completed sources. Transfer to **D:\Amadeus-Benchmarks\incoming\full-v1**.

This is a source/data collector, not an all-environment installer. The manifest explicitly keeps image/VM/dependency preparation pending. Follow the full per-track checklist below and the detailed Chinese command companion. Large full environments may exceed local capacity; retain the full package on external storage and import selected environments later.

## SWE environment preparation (ten-task smoke, all tasks for full pack)

Use a clean dedicated Ubuntu 24.04 WSL environment on a well-connected Windows x86_64 Docker machine, or equivalent Linux x86_64. Do not substitute ARM images or Windows Python wheels. The [Chinese companion](BENCHMARK-DOWNLOADS.zh-CN.md) contains the complete copy/paste Bash and PowerShell commands; the same commands apply regardless of UI language.

Required inventory:

1. [SWE-bench source](https://github.com/SWE-bench/SWE-bench), recorded commit and license.
2. Python 3.12 venv installed from that source; pip freeze, package list and Linux wheelhouse including transitive dependencies.
3. [Verified dataset](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified): resolve and record HF revision, download test split, preserve HF cache and JSONL.
4. Freeze ten repository-balanced task IDs with seed amadeus-smoke-v1 before seeing model results.
5. Run the official grader with gold predictions on those IDs, concurrency 1, instance caching. Keep complete reports and actual task images.
6. Export sweb images with docker save and image inspect metadata. Include Alpine 3.22 for diagnostics if absent.
7. SHA256 checksums; optional WSL export preserving apt packages, venv and caches.

No E5, reranker, LightRAG, CUDA or daily application dependencies are needed for this first coding bundle. Gold validation costs compute and downloads, not model tokens. **The public-bundle preparation procedure has not been executed locally in this change**; only Docker and the existing synthetic grader preflight have passed. Handle upstream changes using the locked source and retain errors.

## Preparation sequence

In the dedicated Ubuntu environment:

- Install python3-venv, python3-pip, git and build-essential via apt.
- Clone the official source, record git rev-parse HEAD, create venv and pip install ./source.
- pip freeze --exclude-editable into requirements.lock; pip wheel --wheel-dir wheels ./source collects dependency wheels. Record Python, Docker and package versions.
- Set HF_HOME inside the pack. Resolve dataset_info(...).sha, load_dataset with that revision, export JSONL and preserve the HF cache.
- Inspect the locked harness --help. Run swebench.harness.run_evaluation with the recorded dataset, --predictions_path gold, --instance_ids from tasks.txt, --max_workers 1, --cache_level instance, and a unique run_id. HF_HUB_OFFLINE=1 keeps dataset selection frozen while Docker may still download task dependencies.
- If that harness version changes gold handling, create official JSONL predictions from the gold patch field for **grader self-check only**. Never expose these to the solver.
- Require per-task reports; investigate gold failures as data/environment failures. A gold pass is not an Amadeus pass.
- Inspect/export the sweb images matching all selected tasks. An empty image list is an error. Preserve gold logs, image IDs/digests and all licenses.
- Hash image archives, wheelhouse, manifests and dataset; record actual sizes.

To transport a complete Linux system, terminate only the dedicated WSL distribution, then wsl --export it to AmadeusBench.tar and hash the archive. It may contain private files, so prepare a clean dedicated distribution without API keys. Either transfer that archive or also the separate pack for convenience; do not accidentally retain redundant copies on a constrained disk.

## Import on this machine

Place AmadeusBench.tar and its checksum in **D:\Amadeus-Benchmarks\incoming\swe-smoke-v1**. Verify before importing:

```powershell
wsl --import AmadeusBench D:\Amadeus-Benchmarks\wsl\AmadeusBench D:\Amadeus-Benchmarks\incoming\swe-smoke-v1\AmadeusBench.tar --version 2
```

Enable Docker Desktop WSL integration for AmadeusBench. Enter using the original Linux user rather than the default imported root user. Activate the original venv, verify SHA256SUMS, docker load the saved archives, and compare all recorded image IDs/digests. Rerun gold offline with a **new run_id** to avoid cached grades.

Without WSL export, transfer the complete pack plus the system version list and install wheels into a matching Linux environment. A wheelhouse alone lacks apt packages, git and system libraries. Neither approach removes the need for network access to a remote model API.

## Remaining full-pack environments

| Track          | Official source                                                                                                         | Required bundle                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Terminal-Bench | [Repository](https://github.com/laude-institute/terminal-bench), [Harbor](https://www.harborframework.com/)             | Pinned 2.0 tasks, Harbor version/dependencies, task images and oracle/verifier logs  |
| BFCL           | [Repository](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)                      | Pinned data, grader, dependencies/license; separate online tasks                     |
| τ²-bench       | [Repository](https://github.com/sierra-research/tau2-bench)                                                             | Pinned domains, simulator and dependencies; simulator API costs remain               |
| WebArena       | [Repository](https://github.com/web-arena-x/webarena)                                                                   | Site images, database/media snapshots, reset scripts and browser environment         |
| LongMemEval    | [Repository](https://github.com/xiaowu0162/LongMemEval), [data](https://huggingface.co/datasets/xiaowu0162/longmemeval) | Histories/questions/answers, grader commit and judge configuration; keep V2 separate |
| OSWorld        | [Repository](https://github.com/xlang-ai/OSWorld)                                                                       | Matching official VM image, task assets and reset snapshots; prepare last            |

These adapters remain planned, but all tracks are included in the requested download scope. For each batch: pin → validate oracle/controls → export images/system dependencies → checksum → offline revalidate. Preserve third-party licenses independently of Amadeus MIT.

For the full SWE environment pack, replace both occurrences of 10 in the Chinese task-selection script with len(ds), then prepare/export all task environments in batches.

The catalog contains exact official Google Drive IDs for shopping, admin, forum, GitLab, Wikipedia and OSWorld initialization assets. WebArena additionally requires kiwix-serve:3.3.0, matching Playwright Chromium, map frontend/backend and database volume snapshots. Docker save does not preserve volumes. Follow the pinned environment_docker setup; its current map backend guide alone estimates about 180 GB. Keep test sites private.

OSWorld initialization cache is not a VM. Prepare the selected provider's full official Ubuntu VM disk/configuration/snapshots; record provider and commit. Current upstream may be OSWorld-Verified, not the original benchmark. Docker availability does not establish KVM support. Account-dependent tasks remain explicitly pending.

Use independent Python environments per track, resolving the pinned pyproject/requirements/uv.lock. Keep complete wheelhouses, freezes, install logs, Python/Ubuntu versions, matching browser caches and system libraries. A dedicated WSL export captures system dependencies; Docker images and volumes need separate export. Do not combine conflicting requirements in one venv.

A complete pack needs source/revisions, all tasks, dependencies, environment assets, licenses, hashes and preparation logs per track. Mark gaps missing/needs-account/needs-build, never ready. Internal RAG/fault fixtures use repository tests and a future independently labelled holdout, not the user's private data.

## Coverage supplements

The same collector includes AgentBench v0.2 source and GAIA data. Prepare DB/KG/game assets from the pinned v0.2 docs separately. GAIA may require accepting access terms and local HF authentication; never include tokens in the transfer. Missing access remains a failed item, not a successful download. See [coverage](BENCHMARKS.md).
