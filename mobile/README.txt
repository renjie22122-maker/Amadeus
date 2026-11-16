Amadeus personal agent and Android preview

This is a locally hosted persistent agent. The computer must stay awake and Amadeus must remain running. Closing the desktop window keeps the backend running; Quit stops it. The Android companion shares the primary conversation and configured model, not a separate cloud model.

Desktop setup
1. Build the normal project (pnpm build). Use the desktop app, or run mobile/Start-Preview.ps1 for a separate preview on http://127.0.0.1:8820 with independent data. The preview copies existing local model settings once; it does not copy conversations.
2. Open Personal agent, choose a primary conversation and give the agent a name. The conversation's existing permission policy still applies.
3. Add a goal with completion criteria, cadence, launch limit and deadline. You can pause, resume or explicitly wake it. A model report can mark it complete; that is not independent verification. Interrupted/uncertain effects require review, never automatic replay. Existing task scheduling handles restart recovery.
4. View > Floating personal agent toggles the desktop companion window. It shows live goal state and reopens the primary UI.

Private remote access with Tailscale
Install Tailscale on the computer and phone, and sign into the same private network. Start the separate device gateway in Personal agent. It listens ONLY on loopback and remembers its port after restart.
Forward the displayed gateway address using:
  tailscale serve --bg --https=8443 http://127.0.0.1:8821
Replace 8821 with the actual displayed port. Enable HTTPS in the Tailscale admin page if prompted. The phone endpoint is https://YOUR-COMPUTER.YOUR-TAILNET.ts.net:8443 . This is reachable away from home while Tailscale is connected; it is NOT an unauthenticated public website. Never forward the local management UI port (8810/8820). No Funnel configuration is needed.
The client also supports other trusted HTTPS reverse proxies. No insecure certificates, cleartext connections, redirects carrying credentials, or browser-cookie authentication are accepted. Keep the terminating proxy on the same computer. Device credentials are scoped and revocable.

Phone setup
Build Android with JDK 17, Android SDK 36 and Gradle 8.13:
  gradle -p mobile/android :app:assembleDebug :app:lintDebug
The GitHub Android companion workflow publishes a downloadable preview APK artifact. Debug builds use a development signature and are intended for testing; preserve a production signing key before distributing release updates.
Install the APK on your own phone. In Device connection and permissions, enter the HTTPS origin and the one-use, five-minute code generated on the computer. Start the visible connection session. Notifications can report new replies; closing the app screen does not stop that explicitly started session. Stop in the app or notification. Android may suspend/kill services; this is not an unrestricted background-execution promise.

Capabilities and boundaries
- Chat, task status, goal creation/pause/resume/wake, stop current computer run, and optional approval responses all share the primary identity.
- Computer operation uses the existing agent tools and configured computer/browser adapters. This is not an independent remote desktop video-streaming product. Configure computer-use MCP for screen-level PC actions.
- Alarm, timer and calendar requests open the system application after phone confirmation. A handoff is not proof an alarm/event was saved.
- Amadeus maintains its own todo list and virtual photo collections. Samsung Reminder's private database is not accessed.
- Granted photo access enables metadata listing, bounded image previews for model analysis, and virtual collections. Original photos are not moved or deleted. Limited photo selection is respected.
- SMS, call history and contacts are read only if Android and the installer grant the respective permission. Restricted permissions may remain unavailable on Samsung/Play-distributed installs. There is no bypass, automatic SMS sending or deletion.
- A user-selected document folder supports listing and locally confirmed renaming. Use it for existing call recordings or exported files. No arbitrary filesystem access is exposed.
- Microphone recording starts only from a visible user action, with a persistent recording notification and stop control. It is not system call recording. Recordings are app-owned; upload a selected recording/file (up to 6 MB) for agent analysis. Transcription requires an appropriate configured audio/model tool.
- Email sorting uses a separately authorized email MCP/provider on the computer, or user-selected exported email files. The app does not read another email app's private data or contain mailbox credentials.
- Screen read/tap/swipe/back/home requires explicitly enabled Android accessibility AND a running user-started session. The locked screen is not controlled. Text nodes marked as passwords are omitted. All actions remain subject to agent approval.
- Pairing tokens are hashed on the computer and encrypted with Android Keystore on the phone. Revoking a device stops new requests; already executing operations cannot always be recalled.
- Phone actions are delivered at most once. A lost response is reported as uncertain; do not resend an action merely because it is waiting. Mobile outgoing chat requests persist their request ID for retry.

Extension points
server/services/personal-agent.ts: identity, goals, pairing and idempotent remote messages.
server/http/personal-agent.ts: separate scoped gateway, no arbitrary admin proxy.
server/services/device-commands.ts: durable one-claim action queue.
server/tools/device-tools.ts: model-visible discovery/action/result interface.
mobile/android/.../PhoneActions.java: advertise only currently permitted native capabilities and dispatch implementations. Add new adapters here without changing the generic queue protocol.

References
https://tailscale.com/docs/reference/tailscale-cli/serve
https://developer.android.com/reference/android/provider/AlarmClock
https://developer.android.com/reference/android/accessibilityservice/AccessibilityService
https://developer.android.com/training/data-storage/shared/media


Android 0.2.1 preview: chat-first interface
Ordinary and project conversations, history search, model selection, rename/pin, streaming replies, staged file/photo attachments, system speech input, text-to-speech, copy/share, and a separate tools/settings screen. Install over the locally signed previous preview to retain pairing.
The optional workspace device grant enables local workspace conversations and memory management; external-channel-only conversations remain excluded. Ordinary chats use shared user memory; projects use their own scope. The memory screen can enable/disable, create, edit and forget memories through the existing server memory APIs. Model changes use the normal conversation settings endpoint so memory policy remains consistent.
Speech input and read-aloud depend on installed Android services. Search, research and image-generation entries compose requests for configured agent tools/providers; they do not provide proprietary Gemini/ChatGPT services or real-time voice/video by themselves.


Android 0.2.2 preview
Chat updates reuse unchanged message views; partial replies update only their own text. State polling runs independently of interactive network operations, with slower idle polling. The history drawer opens immediately from its cached index and refreshes in the background.
Device switcher remembers separately encrypted paired computer credentials. Conversation histories belong to the selected host, not a merged global database. Each computer must be paired independently. Command receipts are namespaced by host; switching computers stops the old phone foreground session.
Phone-independent mode uses a user-configured HTTPS OpenAI-compatible chat/completions endpoint. It stores chats, project briefs, notebooks and reusable assistant text in application-private storage. Model keys are encrypted with Android Keystore. Changing the endpoint without supplying a key clears the previous key. No desktop credentials are copied automatically. Network/provider charges still apply. This is not an offline on-device model or a phone compiler. Phone projects currently organize conversations and project context.
Independent mode offers confirmed local alarm, timer, calendar, todo and recordings-list function calls when the model supports tool calls. A system application handoff is reported as unverified, and interrupted actions are not automatically replayed. The local model request is foreground-scoped; unattended independent goal scheduling is not implemented. Local saved preferences are manually edited and shared between independent chats, separate from desktop memory.
Remote reasoning choices come from the configured model's declared efforts. Unsupported choices are rejected. Web search preference is stored per conversation and blocks the built-in web_search tool when disabled; it is not an OS firewall or a disconnection of the model API. Independent mode does not currently have a search provider.
Native fenced code cards support copy, with isolated static HTML preview. Full document view renders LaTeX with bundled KaTeX offline; no privileged bridge or remote subresources are exposed to generated HTML. KaTeX assets retain their upstream license. Images/video generation still require configured providers; no proprietary Gemini or ChatGPT services are bundled.
Settings are grouped into device connections, persistent assistant, permissions, files/photos, audio recording, services, goals/approvals and phone tools. Android system permissions and overlay access must be granted by the user. Desktop can attach to an existing local Amadeus service using AMADEUS_BACKEND_URL; closing that desktop does not stop the independently owned service. AMADEUS_SHOW_DOT=1 opens the persistent dot window.


Android 0.2.3 preview: independent agent and interaction improvements
- Provider presets (DeepSeek, Gemini OpenAI compatibility, OpenAI and custom HTTPS); account model discovery via /models with manual fallback. Model listing is not proof of tool/chat support. Keys stay encrypted on the phone and are not forwarded across origins.
- Bounded multi-round native tool loop, scoped persistent memory (ordinary/project/character), and rolling conversation summaries. Original events remain on disk. This is not desktop-equivalent retrieval or a fully autonomous background runtime.
- Confirmed reminders (Android inexact delivery, restored on reboot), SMS drafts, maps, one-shot gravity/acceleration/gyroscope readings and permission-gated foreground location. Android permissions and system UI completion remain necessary.
- Direct HTTPS MCP 2025-11-25 Streamable HTTP: tool/resource/prompt discovery and calls, bounded JSON/SSE responses and encrypted bearer tokens. No OAuth, stdio, resumable tasks, sampling or 2026 protocol support in the phone client. Unknown tool outcomes are not replayed automatically. Use desktop connections for those unsupported transports/features.
- Tavern quick entry: create/edit/import/export JSON character cards, read PNG chara/ccv3 text chunks, persona and basic keyword/constant lore entries. Role memory is isolated and real-world tools are disabled by default. No recursive lore engine, group role chat or imported scripts. Inspired by https://docs.sillytavern.app/usage/core-concepts/characterdesign/ and https://docs.sillytavern.app/usage/core-concepts/worldinfo/ .
- Unified card styling on new configuration screens, improved settings touch spacing and a custom vector launcher icon.
- Remote chat switches cancel obsolete reads, reject late results, provide loading/slow/retry/connected feedback and block sending while switching. Duplicate in-flight conversation creation and message submission are guarded. Device-scoped index results cannot replace another device's list.
Validation: Android unit tests cover memory scopes, portable cards, lore matching, malformed imports, bounded MCP event responses, and cancellation of obsolete reads. Build/lint do not replace S25 device testing.
