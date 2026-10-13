# Public benchmark adapters
[English](README.md) | [简体中文](README.zh-CN.md)

These are opt-in evaluation scripts, not startup dependencies. They do not restart or reconfigure the running Amadeus service. Run from the repository root with a separate output directory and an isolated Python environment.

## Implemented protocols
- BFCL V4: frozen Python simple / multiple / parallel / irrelevance samples, one provider response per task. Amadeus uses the production Runtime context; smolagents 1.26.0 constructs its native ToolCallingAgent request. Both use the same Amadeus provider transport and identical normalized dataset schemas. Dataset tools never execute. Dotted function names map reversibly to underscores. Native smolagents final_answer represents a non-action response.
- LongMemEval-S: timestamped full-history QA using the same first-response adapters. Strip answer and evidence labels before inference. This is **not** a test of automatic memory formation, persisted retrieval, or forgetting. The source snapshot is the downloaded original release, not an assumed latest cleaned dataset.
- GAIA 2023 validation: a deterministic six-question no-attachment pilot. Native multi-step loops use the same DeepSeek connection and read-only public search/fetch services. This does not cover the 38 attachment questions, browser interaction, code execution, or all 165 validation questions.
- SWE-bench Verified: a one-task pilot, pylint-dev__pylint-7277, selected by a deterministic hash of instance IDs. Both agents use an offline persistent Docker container with the same shell adapter. Official eval.sh and upstream grading code evaluate the patch. Pristine/gold controls must fail/pass respectively before solver results are interpreted. This is not a full 500-task score.

The smolagents provider transport is a shared broker, not its default provider SDK. It retains native prompts and (for GAIA/SWE) its native agent loop. Provider tool_choice is auto in both arms. This is a controlled integration comparison, not an out-of-the-box product comparison.

## Setup
Use a Python venv and install smolagents==1.26.0 and unidiff==1.0.1. Data preparation additionally needs pandas, pyarrow and PyYAML. Keep benchmark repositories/data outside the application repository. Point commands at the downloaded BFCL/LongMemEval/SWE source revisions. No credentials go into Docker containers; the configured model connection is read only by the host broker.

Examples (replace paths):
~~~powershell
python evals/bfcl/dataset.py prepare <bfcl-source> <output>/cases.json
python evals/bfcl/check-adapter.py <bfcl-source> <venv-python>
node --import tsx evals/bfcl/run.ts <output> <venv-python> 20
python evals/bfcl/dataset.py grade <bfcl-source> <output>

python evals/public-qa/prepare-longmem.py <download-root> <output>
node --import tsx evals/bfcl/run.ts <output> <venv-python> 14
python evals/public-qa/prepare-judge.py <download-root> <output>
# Optional, billed DeepSeek judge; not the official GPT-4o judge:
node --import tsx evals/public-qa/judge.ts <output>

python evals/public-qa/prepare-gaia.py <download-root> <output>
node --import tsx evals/public-qa/run.ts <output> <venv-python> 16384 12 complete-catalog
# Put the pinned official GAIA scorer.py in <output>/official-scorer.py first:
python evals/public-qa/grade-gaia.py <output>

# Requires the pinned official task assets under <output>/grader/pylint-dev__pylint-7277
# and its already-downloaded Docker image:
node --import tsx evals/public-qa/run-swe.ts <output> <venv-python> 16384 complete-catalog <swe-source>
~~~

Prepare the output directory before the BFCL command. Each attempt has a started receipt and result/process records; existing solver attempts are not silently rerun. Use a fresh directory for new protocols or retries. Do not launch two runners against the same output directory. A started receipt with no result is incomplete/unknown, not a pass or a free retry. Keep old trials and their costs.

## Limits and integrity
The first trial used a 4,096-token output limit; incomplete outputs count as delivery failures. Later 16K trials are separate experiments, not replacements. Data/scorer hashes and image digests should accompany reports. The initial pilot was also an adapter bring-up; invalid trials are explicitly excluded from comparative claims.

No dollar cost is reported when provider prices are absent. Measured tokens from successful responses are lower bounds if failed responses omit usage. Cached input is a subset of input, not additional tokens. Search requests incur additional model usage.

Check delivery before judging: a missing answer or invalid final_answer must not be sent to an LLM judge as an ordinary answer. Preserve body correctness and protocol correctness as separate metrics. Official exact-match scoring and semantic review can disagree; retain both, never silently edit a reference answer.

The original SWE bring-up omitted a project record, so Amadeus's capability kernel correctly hid execute tools. Those trials are adapter-invalid. The corrected adapter registers an isolated project and checks that the container tool is present before starting inference. The benchmark shell never falls back to host execution.

