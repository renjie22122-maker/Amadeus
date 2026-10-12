# Installation, upgrades and execution backends

[English](MIGRATION.md) | [简体中文](MIGRATION.zh-CN.md) · [Documentation](README.md)

Reviewed: 2026-10-12.

## Amadeus rename and startup

Install Node.js 24+ including npm. First-Start-Amadeus.cmd installs locked dependencies using pnpm 11.19.0, checks TypeScript, builds backend JavaScript/runtime assets and the UI and starts the service. Start-Amadeus.cmd also prepares missing/changed dependencies and rebuilds changed source.

First Start refuses dependency replacement while an existing service is running. Quick Start opens a running service, warns if local build inputs changed, and does not interrupt tasks or hot-update it. Finish tasks, stop the service and launch again to apply an update. Logs remain under .data/logs.

Old AgentDemo launcher names forward to the new scripts. Legacy default assistant names become Amadeus; custom names survive. .data, AGENTDEMO_* environment variables, browser storage/cookie keys, package-signature filename and sandbox identity namespace retain compatibility names. They are not obsolete branding to rename manually. Local checkout paths need not change.

Back up private data before moving an installation. Copying the repository alone does not migrate it. DPAPI secrets are tied to the Windows account; moving to another user/machine may require entering keys again. No old Agent4Learning Python package is imported at runtime.

## AppContainer

TypeScript communicates with native/windows/bridge.py over JSON stdin/stdout. The standalone Python adapter manages AppContainer profiles, ACL grants, suspended process launch and a kill-on-close Job Object. A configured absolute Python interpreter is required. Its standard library is materialized into private native-python storage; host conda site-packages are not implicitly exposed.

File-isolation mode allows networking; strict offline requires a denial preflight. Preflight failure rejects commands without host fallback. Directories with protected metadata currently refuse native startup. Stop, timeout and EOF terminate owned work; abrupt adapter death can leave ACL/profile artifacts. Automatic crash cleanup of all such artifacts is not implemented.

## Docker and host

Docker needs the engine and a preinstalled image (pull=never), uses a non-root user, offline networking and scoped mounts. Validate it on the deployment host. Host mode intentionally runs with host-account authority and requires explicit selection; it is not an OS sandbox.

## Writable workers

Isolated workers copy authorized folders without hard links; copies are bounded to 10,000 regular files/64 MiB. Allowlisted hidden configuration files (such as .editorconfig and .gitignore) are included; other hidden entries, dependency/build directories and key/certificate files are excluded. Links/private paths remain rejected. Copy reports expose file/byte totals and a bounded excluded-entry sample; excluded directory descendants are not counted. Limit failures identify the triggering path and do not create a usable partial copy. Missing copied dependencies do not prove the host installation is broken. Child commands require OS isolation; host command execution and external MCP are unavailable.

Review changes returns diffs/conflicts and a version. Merge needs explicit approval and unchanged parent/version hashes; binary conflicts need manual handling. Per-file journaling exposes partial results, not an atomic multi-file transaction. Merged copies cannot continue writing.

## Upgrade checks

Run pnpm check, pnpm test and pnpm build. Public sanitized tests are included. Native desktop/browser integrations need explicit host opt-in. Historical migration measurements are archived in [history](history/README.md); they are not current configuration requirements.

## Applying the 2026-10-12 boundary update

No additional package or installer migration is required. Both launchers already fingerprint server/native sources and rebuild changed modules; their code is unchanged for this update. A running service must be stopped and relaunched to load the new backend. Existing backend selections and private records are preserved; missing sandbox prerequisites never trigger automatic host fallback.

## Responsive conversation reads

Restart to load the server changes and reload the browser. The existing Start/First-Start launchers fingerprint src/shared/server and rebuild changed code; no new dependency or user configuration is required. Store startup creates a conversation lookup index without rewriting or removing records. First launch on a large database can spend additional time building that index.

## Vector tolerance and chart presentation

No dependency, configuration, startup command or database schema migration is required. Existing Start/First-Start launchers fingerprint changed server/shared/src files and rebuild them. Restart the service and reload the browser to activate the update; existing chart-format messages can render immediately. Damaged vector payloads are skipped during reads, not deleted; an already authorized normal index job repairs malformed vectors. Index repair still obeys the selected embedding destination and data authorization.

### Local media import

No new dependencies, model downloads or settings are required. Existing Start/First-Start source fingerprints include these changes and rebuild as needed. Restart the running service and refresh the browser to activate the new tool and UI. Existing attachments remain compatible.
