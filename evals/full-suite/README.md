# Complete local-track evaluation

[English](README.md) | [简体中文](README.zh-CN.md)

This opt-in batch runner expands the pilot to every row of its supported protocols. It is not a claim to run every track in every downloaded source repository.

| Track                | Questions per agent | Protocol                                                                                                                       |
| -------------------- | ------------------: | ------------------------------------------------------------------------------------------------------------------------------ |
| BFCL                 |               3,491 | All eleven Python/live single-turn categories; first structured response, upstream AST grading; no described function executes |
| LongMemEval-S        |                 500 | Full supplied history, first-response QA; original downloaded snapshot                                                         |
| LongMemEval-Oracle   |                 500 | Gold-history upper-bound comparison, reported separately; not a memory retrieval score                                         |
| GAIA 2023 validation |                 165 | Three native arms, or a separately reported shared-tool control; official scorer                                               |

Both arms use the same configured DeepSeek connection. The baseline is smolagents 1.26.0 with native prompt/loop and a shared provider broker, not its default SDK transport. Each arm has a separate store. The default full-batch protocol uses 32,768 output tokens and at most 16 model calls for GAIA. First-response tracks do not measure Runtime recovery. No original answer text is modified to satisfy a scorer.

Native GAIA uses production Amadeus tools and native smolagents search/page/Python tools with configured file/image integrations. Entire smolagents solvers run inside offline Docker. The auxiliary shared protocol adds image crops, styled sheets, remote PDF, Python/FFmpeg and bounded format repair. Browser interaction and transcription are unavailable in these profiles. Source filtering cannot prove zero contamination. See [protocol details](../../docs/BENCHMARKS.md#native-versus-controlled-evaluation).

LongMemEval-M needs a separate context/ingestion decision; `profile-context.py` estimates all histories without loading the whole file. Its estimate is not exact provider tokenization. Do not truncate histories and call it full-context. BFCL multi-turn, memory, web-search, Java/JavaScript and format-sensitivity have different protocols and are not covered here. SWE-bench can be deferred independently. Source-only web/desktop/terminal suites need their actual environments.

## Run

Use an isolated Python environment with smolagents 1.26.0 and unidiff. Data preparation and the GAIA grader need pandas, pyarrow, PyYAML and NumPy in the selected data Python. Keep downloaded data and outputs outside the repository.

```powershell
<data-python> evals/full-suite/prepare.py <download-root> <new-output>
<eval-python> evals/bfcl/check-adapter.py <bfcl-source> <eval-python>
```

Copy the pinned official GAIA scorer and receipt to `<new-output>/gaia/official-scorer.py` and `scorer-receipt.json`. Freeze server/shared/evals sources, record their hashes and dependency versions, and resolve Node dependencies in that snapshot. Do not copy production databases or plaintext credentials. The host broker reads the authorized settings; containers do not receive keys.

```powershell
<eval-python> <frozen-runtime>/evals/full-suite/run.py <new-output> <frozen-runtime> <eval-python> <settings-path> --download <download-root> --prepare-python <data-python> --concurrency 4 --analysis-image <immutable-image-sha256>
```

`progress.json` records active attempts and counts; each attempt saves job, start receipt, request/result and process outcome. `runner.lock` prevents two coordinators from owning the same output. Creating a file named `STOP` stops new attempts after current work settles. Resume only after checking the old process has stopped; started attempts are never silently replayed, including unknown outcomes. Use a new output directory for any protocol/code/model change.

After solving, BFCL/GAIA scoring and LongMemEval rubric scoring run automatically. The latter substitutes the configured DeepSeek judge for the official GPT-4o judge: disclose this and do not call it a blind independent human review. Empty/error submissions fail delivery before LLM grading. Invalid judge responses stay ungraded. `REPORT.md` and `report.json` distinguish expected, attempted, graded and passed counts; measured token sums are lower bounds when usage is missing. Cached input is a subset of input, not extra tokens. Unknown prices mean unknown cost.

These optional scripts do not change normal startup or install benchmark environments on first launch.

Choose `--protocol native-evidence-v1` (default) or `--protocol shared-evidence-v2`. Use `--tracks gaia` for the auxiliary experiment. A new directory is required; preparation never overwrites an existing queue. Set `AMADEUS_EVAL_PYTHON` and `AMADEUS_TEST_NATIVE_IMAGE` to run the synthetic three-arm container smoke test in `tests/shared-broker.test.ts` before paid native evaluation.
