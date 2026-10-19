# Amadeus documentation

[English](README.md) | [简体中文](README.zh-CN.md)

This is the maintained English/Chinese documentation set, reviewed on 2026-10-05 against code baseline d663030. Every current topic has a language pair. Superseded records are archived separately.

[Install and quick start](../README.md) · [Changelog](../CHANGELOG.md) · [Historical originals](history/README.md)

## Current guides

- [Chat connections](CHAT-CONNECTIONS.md)
- [Local speech and reply read-aloud](LOCAL-VOICE.md)

- [Benchmark plan](BENCHMARKS.md)
- [Benchmark downloads](BENCHMARK-DOWNLOADS.md)

- [Local retrieval and GPU](LOCAL-RAG.md)
- [Architecture](ARCHITECTURE.md)
- [Feature guide](FEATURES.md)
- [Conversations, progress and recovery](INTERACTION.md)
- [Automatic approval](AUTO-REVIEW.md)
- [Security model](SECURITY.md)
- [Memory, knowledge and retrieval](MEMORY.md)
- [Installation, upgrades and execution backends](MIGRATION.md)
- [Testing and evidence](VERIFICATION.md)
- [Planning and empirical routing](PLANNING-AND-ROUTING.md)
- [Prefix cache and token efficiency](DEEPSEEK-CACHE.md)
- [Folder import and automatic maintenance](knowledge-import-resilience.md)
- [Tool ecosystem](TOOL-ECOSYSTEM.md)
- [Rich conversation content](CHAT-FORMATTING.md)

## Evaluation and historical results

- [Coding pilot](../evals/coding/README.md)
- [Context/control probes](../evals/context-control/README.md)
- [Planning comparison](../evals/planning/README.md)
- [Historical approval results](APPROVAL-EVALUATION.md)
- [Historical planning results](PLANNING-EVALUATION-20261001.md)

## Maintenance convention

Update both language guides when behavior changes. Date results and identify code/grader versions and boundaries. Archive superseded facts instead of replacing old counts with new ones. Commands should name public entry points; skipped tests are not passes. Documentation maintenance does not rerun every historical API/OS experiment.
