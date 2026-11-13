# Bot startup and independent status notices

[English](BOT-STARTUP.md) | [简体中文](BOT-STARTUP.zh-CN.md)

The optional scripts in [scripts/bot](../scripts/bot) separate the chat bridge and a small notice worker from the Amadeus server. The Windows launcher uses on-demand, current-user interactive scheduled tasks; it does not install a boot/login trigger, store a Windows password, stop services, or touch benchmarks. Closing the terminal or Codex does not own newly launched task processes. Signing out, shutting down or sleeping still stops/suspends availability. Reused processes retain their original lifetime; installing these tasks cannot re-parent an already running service.

## Configure locally

1. Copy `scripts/bot/config.example.json` to `.data/bot/config.json` (ignored by Git) or another private directory. Replace **all** `YOUR` placeholders and use absolute paths. Node 24 is required. Keep this file private: it permits launching the configured programs.
2. Set the installed bridge executable, its argument string, working directory and environment. The example is NapCat on Windows, but launch paths are configuration rather than model/provider assumptions. For NapCat, retain the five `NAPCAT_*` values required by its launcher and provide the bot account as its final argument. The executable/argument process match prevents duplicate launches while login is pending. A listening port is only a readiness hint, not proof of the expected account's identity or login.
3. Configure `offline.database` with the actual Amadeus database, `accountId`, loopback `bridgeUrl` matching the saved connection endpoint, and health URL. Supply either `tokenEnv` (available in the scheduled task's environment) or `tokenFile` plus `tokenPath`, an array of JSON property names/array indices. No credential belongs in Git or a shortcut command line. The example token path selects the first WebSocket server; adjust it to your enabled server.
4. Choose private, writable status/ledger/lock/log files and an unused `taskPrefix`. Optional `notice` and `reauthorizeNotice` customize the short plain-text notices.
5. Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/bot/Install-Bot.ps1 -Config C:\absolute\private\config.json`. It creates **Amadeus + Bot** and **Bot only** desktop shortcuts. `-NoShortcuts` registers tasks only. Installation refuses to replace running tasks and does not start them. Existing manually installed watchdogs must be stopped before starting the new notice task, otherwise independent implementations could both reply.
6. Double-click the appropriate shortcut. Bot-only opens the bridge login page. Login expiration may require scanning a QR code; the launcher cannot bypass platform verification. The combined shortcut starts Amadeus only if its health probe fails. It does not stop or restart healthy services, nor automatically restart intentionally stopped services.

The notice worker can also run without the Windows launcher: `node scripts/bot/offline-notice.mjs /absolute/private/config.json`. Other systems should use their own service manager. The notice adapter currently supports **OneBot 11 only**; it is not a Telegram/WhatsApp/WeChat implementation.

## Notice behavior and authorization

- Read-only database access follows the current enabled connection, account, endpoint, peer and allowed sender. Private messages must come from the bound sender. In groups only an actual bot mention or the configured command prefix triggers a notice; ordinary chatter and the bot's own messages are ignored.
- Three failed health probes (default five-second intervals, two-second timeout) enable outage notices. The worker probes again before sending. A healthy server with a slow/busy model is not considered offline. This does not detect every stalled model or route-specific transport failure.
- A disabled **private** route explicitly marked `reauthorize` can notify only its previously bound sender to review settings locally, even when the server is healthy. Group reauthorization and manual pauses remain silent. No notice grants permissions or accepts work.
- Default rate limits: one notice per peer per two minutes and one globally per ten seconds. Old events, duplicates, cross-peer requests and unauthorized senders are discarded. Bounded deduplication/cooldown state is persisted before sending; uncertain delivery is not retried. A failed ledger write prevents sending. Invalid configuration/database/ledger fails closed. No model call or paid inference is involved.
- If QQ/the bridge is offline there is no channel through which to send a notice. Status files distinguish bridge disconnection, agent availability and send failures; logs contain no message body or token.

Amadeus now distinguishes **manually disabled**, **reauthorization required**, **connected** and **disconnected**. A permission/model/scope change does not silently inherit a prior remote authorization. Review, enable and save the connection again. Ordinary chat still uses local approval; a casual “yes” is not an approval command. Remote work approvals require an explicitly enabled, bound-controller connection, a complete reviewable operation and the issued single-use command. Sensitive/oversized/recovery operations stay local.

## Verification and maintenance

`pnpm test` includes deterministic outage/recovery, authorization revocation, concurrent events, cooldown, restart ledger, uncertain send and reauthorization tests. Windows CI additionally exercises the startup path with mocked process creation and a space-containing path, without opening QQ or contacting a group. The regular chat tests cover preserved reauthorization reasons and explicit pause. No real outage is induced during these tests.

Disable/remove only the configured task-prefix tasks in Task Scheduler to uninstall this optional integration. This is not an instruction to terminate unrelated Node/QQ processes. Keep local configuration and credential sources out of commits and backup bundles. Running services are not automatically upgraded by pulling code; arrange a safe restart of the relevant helper/server separately.

### Platform session health (optional)

Set `bridgeHealth.enabled` and `bridgeHealth.autoReconnect` in the private launcher configuration to enable bounded recovery. The independent notice watcher probes login identity, platform status and a fresh friend list once a minute; results appear as `bridgeHealth` in its local status file. A socket connection alone is not proof that QQ receives messages.

A previously nonempty friend list becoming empty for three consecutive checks is suspicious only after a three-minute startup grace and two minutes without incoming messages. Unknown/failed probes, quiet chats, an empty list on first installation, account mismatch and logged-out sessions never trigger a restart. This heuristic cannot prove a broken platform session: legitimate removal of all friends can also match it. Recovery is opt-in, at least ten minutes apart and at most twice per hour; its baseline and attempts survive watcher restarts. A login challenge still requires the user to scan; no passwords or verification codes are collected.

Recovery matches the configured bridge executable AND process argument, rejects ambiguous roots, and revalidates process creation time before stopping only its descendant tree. Other QQ sessions, Amadeus, RAG and benchmark processes are not restart targets. It does not send diagnostic messages or replay missed messages. Unsupported adapters can leave this optional OneBot-specific monitor disabled.

The combined bot launcher invokes the idempotent Amadeus launcher even when the main HTTP service is already ready. This also checks configured local voice and RAG services, reusing healthy instances without restarting the main app. Voice startup is lightweight; models remain unloaded until a transcription or speech request arrives.

## Hidden launch and client updates

Windows quick launch now delegates to `scripts/Launch-Hidden.vbs`: main, desktop, all, or bridge. Shortcuts target wscript directly (no console); legacy CMD launchers exit immediately after delegation and may briefly flash while Windows opens cmd. Errors appear in a message box and are recorded in `.data/logs/launcher-*.log`. Direct PowerShell scripts remain available for diagnostics.

A running scheduler wrapper no longer implies its child bridge is alive: an explicit launch checks/reuses services through the shared launch mutex and waits for the bridge port before opening its page. A listening port is not proof of account login. For QQ hot-update compatibility, use a separately extracted, signature-verified client directory instead of modifying the personal QQ installation. Optional `bridge.versionCheck` contains `path`, `field` and `expected` for a local JSON version manifest; mismatches stop a new launch with an actionable error. Never kill every QQ process or silently downgrade a personal installation.

Usage diagnostics: model calls retain split provider counters and never replace a receipt with an empty trailing usage object. Incomplete run totals show counted reasons (HTTP status, connection failure, interrupted stream, or omitted usage). Missing usage is not zero cost; no generation is replayed to recover accounting. Historical receipts remain unchanged.

When the local management page is reachable but OneBot is not listening, the quick launcher opens management immediately, including in combined startup mode. Check login and OneBot configuration there; management readiness is not evidence of QQ login. It does not start a duplicate QQ process.

The independent notice watcher checks the configured loopback NapCat WebUI login state even when OneBot is unavailable. With bridgeWebUiConfig configured, confirmed QR/login-required states open the login page once per outage after 15 seconds; successful login rearms the reminder. Ordinary network errors and unknown states do not open tabs. bridgeHealth.openLoginOnDisconnect=false disables automatic opening. Credentials remain local; 2FA or unsupported management APIs require manual inspection. The chat page distinguishes fresh account-matched login-required/confirming evidence from a disconnected socket. Platform session revocation still requires user confirmation; the watcher does not bypass QQ login.

Supervisor locks on Windows are validated against process creation time, not just PID existence. Legacy PID-only locks use the lock file timestamp; a process created later is a recycled PID and does not block startup. New locks record creation time and an ownership token; cleanup only removes the same owner's lock. If process identity cannot be inspected, an apparently live owner is retained conservatively. Probing does not kill the process or delete the lock. This handles stale locks after reboot without stopping unrelated services.

The independent bot notice watcher uses the same process-identity validation and migrates its legacy plain-PID lock on the next start. RAG already checks process creation time. This change does not restart live RAG or voice services.
