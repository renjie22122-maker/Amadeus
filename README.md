# Amadeus

[English](README.md) | [简体中文](README.zh-CN.md)

A local-first AI workspace for conversation, coding, research and creative work. Connect model APIs, work with project files and use skills, knowledge, media and agent teams in one interface.

Named after Amadeus from _Steins;Gate_. Formerly AgentDemo. Built with TypeScript, Node.js, React, Fastify and SQLite.

## Quick start

Install **Node.js 24+ including npm**, then download and fully extract this repository.

**Windows:** double-click **First-Start-Amadeus.cmd**. It installs locked dependencies, checks/builds the app, starts the supervisor and opens http://127.0.0.1:8810. Later use **Start-Amadeus.cmd**. No global pnpm or Corepack installation is needed for these launchers. Native-module build failures may require Python and Visual Studio C++ Build Tools; installation needs internet access.

**Command line:** install pnpm **11.19.0**, then:

```sh
git clone https://github.com/renjie22122-maker/Amadeus.git
cd Amadeus
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

In Settings, add a model connection with endpoint, model and API key, then test it. Provider/model capability fields are not a guarantee of endpoint support.

## Everyday use

- Use **general chats** for conversation and session artifacts; choose a **project** to authorize local folders and commands. Projects can contain up to 12 non-overlapping folders.
- Select supported reasoning, collaboration, approval and execution-isolation settings near the composer. An approved host command still has host-user permissions.
- Add attachments or select skills; use the global attention menu for questions/approvals in other chats.
- Read expandable steps, round navigation, file diffs, context and usage. HTML demos and Mermaid diagrams default to preview with a scrollable code tab.
- Configure media providers separately. Images, video, audio and 3D outputs can be inspected/exported; compatible image/audio/video outputs can feed later generation. Dictation creates an editable draft.
- Enable scoped automatic memory or knowledge-folder maintenance deliberately. Ordinary-chat shared libraries, project libraries and private session documents remain separate.

The interface supports English/Chinese, custom assistant names, automatic sizing and 25–150% text presets. See the [complete bilingual documentation](docs/README.md).

## Updating

Stop the service after finishing active tasks, replace/pull code, then run Quick Start. It detects changed dependencies and source. First Start refuses to replace dependencies while a service is running; Quick Start opens the existing service without hot-updating it. Check .data/logs on startup failure.

Old AgentDemo launcher names remain compatible. Existing data and custom assistant names are preserved. Internal AGENTDEMO_* variables, cookie/storage keys and signature filenames intentionally retain compatibility names. The local checkout folder need not be renamed.

## Safety and local data

New configurations default to AppContainer on Windows and Docker elsewhere; prerequisites must be configured before commands can run. Existing configurations retain their backend. There is no automatic host fallback. Browser/MCP/desktop integrations have separate host authority. See [security](docs/SECURITY.md) and [execution setup](docs/MIGRATION.md).

.data contains private configuration, conversations and artifacts; .diagnostics contains local test output. Both are excluded from Git. Windows secrets use current-user DPAPI; other platforms use restricted files. Back up private state before migration. Model/embedding/media calls send their inputs to the selected providers; local embedding does not make the answer-generating LLM local.

## Development

```sh
pnpm dev
# In another terminal:
pnpm web
```

Backend: 8810. Vite: 8811, with API proxying. Validate with:

```sh
pnpm check
pnpm test
pnpm build
```

CI runs on Windows and Ubuntu. Public tests are sanitized; optional desktop/browser tests require host opt-in. Historical results are not general capability scores.

| Directory               | Contents                                         |
| ----------------------- | ------------------------------------------------ |
| src                     | React UI                                         |
| server/core             | Runtime, context, lifecycle and teams            |
| server/providers        | Model adapters                                   |
| server/tools            | Tool contracts and invocation                    |
| server/services         | Execution, approvals, retrieval and integrations |
| server/storage / shared | Persistence / shared types                       |
| tests / evals           | Regression / evaluation harnesses                |
| docs                    | Current guides and clearly separated history     |

## Help and changes

For failures, include OS, Node version, backend, reproduction and sanitized error output. Never post credentials or private conversations. Missing sandbox dependencies and unknown interrupted effects are not fixed by blindly rerunning commands.

- [Documentation directory](docs/README.md)
- [Changelog](CHANGELOG.md)
- [History and original reports](docs/history/README.md)
- [Testing and evidence boundaries](docs/VERIFICATION.md)

## Build and distribution status

The standard build emits backend JavaScript plus native/worker assets in build/ and browser assets in dist/. pnpm start and the Windows supervisor run the compiled backend; tsx is retained for development and tests. Keep build/, dist/, package metadata and installed dependencies together; the CI artifact is not a standalone installer.

This repository currently grants no open-source license (package metadata: UNLICENSED). The maintainer has deliberately deferred selecting a license. Version 0.1.0 is a development package identifier, not a promise that dated changelog entries are numbered releases.

## Local retrieval

[Optional local LightRAG, GPU embedding and reranking](docs/LOCAL-RAG.md)
