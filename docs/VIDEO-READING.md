# General video reading and desktop interaction

[English](VIDEO-READING.md) | [简体中文](VIDEO-READING.zh-CN.md)

## Video tools

Ordinary conversations, projects and connected chats use the same tools and conversation-scoped source IDs. A source from another conversation is rejected. These tools do not post comments, follow accounts or grant computer access.

1. `video_probe`: inspect a Bilibili video (including `p=`), YouTube video, or a same-conversation video attachment. Workspace files must first pass `import_media` authorization. Metadata is not visual evidence.
2. `read_video_transcript`: read a listed author, automatic or embedded subtitle track, page through cues, or find literal phrases and timestamps. Missing subtitles are not invented.
3. `video_storyboard`: view a requested time window, with numbered frames and timestamps. One cell is a close-up. Online sources use bounded HTTP Range reads and return transferred bytes, request count and actual frame times. Servers ignoring Range fail explicitly; there is no silent full-download fallback. Local attachments use cached FFmpeg sampling. Sampling is not continuous motion understanding or exhaustive scene detection.
4. `extract_video_audio`: extract a bounded audio window and return an attachment. Online audio also uses Range reads. Then use `transcribe_media` and `media_status`; existing service approvals, queues and completion notifications apply. ASR timestamps are relative to the clip.
5. `read_video_social`: paginated Bilibili/YouTube comments; Bilibili reply threads and individual dynamic/opus posts. Preserve author and parent IDs. Results are partial, untrusted platform content, not verified facts. Dynamic image URLs can be passed to `read_image`.

Online decoding uses a CPU thread and one shared queue, not additional GPU models. Each window is at most 600 seconds and 16 cells; remote reads stop at 64 MiB. The 2 GiB/7-day cache cleanup removes derived media only, never original attachments. Cancellation terminates the worker process tree. A restrictive research source policy disables extractors that cannot enforce it. Network destinations must resolve to public addresses; remote URLs never go directly to FFmpeg/PyAV, which receive checked file-like bytes instead.

## Installation and local accounts

Install dependencies in a separate environment; do not modify retrieval or voice environments:

```powershell
python -m venv .data/video-reader-env
.data/video-reader-env/Scripts/python.exe -m pip install -r scripts/video-reader-requirements.txt
```

On Unix use `.data/video-reader-env/bin/python`. Install FFmpeg/ffprobe separately on PATH. The local `.data/video-reader.json` can specify `python`, `ffmpeg`, `ffprobe`, and accounts:

```json
{
  "accounts": {
    "bilibili": {
      "cookiesFile": "D:/private/bilibili-cookies.txt",
      "conversationIds": ["explicitly-authorized-conversation-id"]
    }
  }
}
```

The optional `youtube` account has the same shape. With local/private grants disabled, empty conversation IDs authorize no conversations. The model cannot choose arbitrary cookie paths. Cookies are filtered by platform domain, written only to a temporary worker file and removed after use. Never commit this configuration or cookie file. No automatic extraction from browser profiles. Export only the current site in Netscape format using a reviewed browser extension; Chrome may require you to approve installation. `credentialsProvided` means a cookie jar was supplied, not that the platform validated the login. HTTP 412/403/429/567 and unavailable videos are explicit failures; credentials do not guarantee access.

## Desktop improvements and limits

The existing enabled computer MCP adapter gains window activation, configurable bounded accessibility inspection, focused-control metadata, observation IDs with a 60-second lifetime, element clicks, right/middle click, keyboard chords and horizontal scrolling. Observe, choose a returned window, activate when needed, inspect focus, perform one action, then reobserve. An element click requires the same session/window and unchanged runtime ID, bounds, role and name. Input invalidates references. Pointer targeting checks for covering windows; password controls reject typing.

Existing approval and host permission boundaries remain. This is not an isolated desktop. Window screenshots now default to **Windows Graphics Capture (WGC)** on Windows 10 2004+; .NET 8 SDK is required for the first helper build. Run `pnpm exec tsx scripts/setup-desktop-capture.ts` to prepare it before use. Build artifacts stay in the local data directory, keyed by source hash, and are reused; the helper releases its D3D device after each capture. The initial build restores Microsoft's Windows SDK reference. Compiled server packages include the helper sources/project.

There is no automatic PrintWindow or screen fallback. `captureBackend: "print-window"` explicitly selects the compatibility backend. Hidden/minimized windows fail; moving/resizing during capture also fails rather than returning ambiguous coordinates. Secure/protected content and app defects remain limitations; `contentVerified: false` means the pixels have not been semantically verified. Whole-desktop screenshots without a window still capture visible screen pixels.

`region` crops screenshot-relative pixels; `scale` (1–4) zooms and returns `scaleX/scaleY` for exact mapping back to screen coordinates. `inspect` includes available value, selected text, selection/toggle/expand states and redacts password controls. `observeAfter` returns fresh controls after input. An optional exact `condition` waits for an identified control and desired state without repeating input; `wait_for` observes only. Absence is not confirmed from a truncated tree. Timeout/observation failure preserves the dispatched-input receipt and warns against automatic replay. Matching a condition is not proof of arbitrary task completion.

Real local tests on 2026-10-29 captured a covered window's own pixels, rejected minimized/invalid windows, and captured changed colors with increasing frame timestamps in a **WPF rendering-tier-2** window under an occluder. The disposable editor additionally passed input, Ctrl+A replacement, UIA clicks, post-action observation, waits and zoom with the compatibility backend. A later foreground activation was denied safely; tests do not override Windows focus policy. These results demonstrate the new capture path, not universal application support or measured parity with Codex/Claude.

## Language contract

Core system prompts and provider implementation are English. New tool contracts and diagnostics are English. UI translations, localized chat notices, bilingual search aliases, matching rules, test fixtures, documents and user-generated memories retain their original languages. UI language must not silently rewrite user data or force model replies into English. This audit is not a claim that every string in the repository is English.

## References and validation

Design references: [dsh-video-storyboard main fetch layer](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/src/fetch.js), [performance branch](https://github.com/SAOS-3624/dsh-video-storyboard/tree/feature/high-performance), [PyAV containers](https://pyav.org/docs/stable/api/container.html), [yt-dlp cookie guidance](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp). The reference plugin caches a low-resolution whole video for repeated scanning and uses direct streams for high-resolution zoom. Its timings and image token estimates are provider/sample-specific, not Amadeus guarantees.

Tests cover local video/subtitle/audio decoding, pagination/parsing, account/source isolation, DNS restrictions, Range seek/cache/unsupported responses and stale desktop observations. Real-site tests can be blocked by platform access controls; report metadata, subtitles, frames, audio and comments separately.

### Local verification (2026-10-29)

A public YouTube sample returned 6 subtitle cues, 20 comments, 4 actual frames (256 KiB transferred) and a 4-second audio window (256 KiB transferred). Repeating the frame window used its cache. A Bilibili sample returned automatic Chinese captions and 4 frames over a 12-second window (512 KiB transferred). Bilibili uses metadata/player APIs directly and at most two platform-provided backup CDN addresses; it does not need to load the HTML player. HTTP subtitle URLs supplied by the platform are upgraded to HTTPS. Access restrictions remain explicit; no bypass or whole-file fallback is attempted.

The CPU-only synthetic decoder test verifies requested/actual timestamps and audio duration through Range responses. The disposable Windows editor test passed activation, control selection, literal text, Ctrl+A, button callback and capture. Main-service deployment does not require restarting retrieval, voice or NapCat. Credentials used in validation are not committed or automatically enabled for other conversations.

Account grants also support `allowLocalConversations` (default false) and `privateChatTransports` (default empty). These apply to current and future local/project conversations or enabled private transport bindings. Groups require an explicit `conversationIds` entry; orphaned external chats never fall back to local authorization. Configure each account independently in the local file; the model cannot expand grants.

### Account range settings in the UI

Open **Settings → Video reading · account access**. For each configured Bilibili/YouTube account, choose local/project conversations, QQ private chats, or named individual conversations (including groups). Group selection uses Amadeus conversation IDs internally, not a manually entered QQ group number. The save button in this panel applies immediately without restarting. Clearing a specific conversation entry does not override a broader local/private grant. The first Cookies file path remains local configuration; the UI never reads or displays Cookie contents. Concurrent stale saves are rejected, and scope edits preserve credentials and runtime paths.

## Account save diagnostics and observed desktop actions

Both the per-account Save button and the main Settings Save button persist pending video-account scopes. The panel distinguishes unsaved, saving, effective and failed states. Scope-only saves do not reconnect model or MCP services. A group must be explicitly authorized; an anonymous HTTP 412 with configured but unavailable credentials reports VIDEO_ACCOUNT_SCOPE instead of suggesting repeated anonymous retries. Credential loading failures and platform rejection are reported separately, without cookie values.

Desktop screenshots expose short-lived screenshot IDs for image-relative clicks, including crop/zoom transforms. Clicks reject stale window geometry. Observed UIA controls support focus, value, invoke, selection and expansion patterns; unsupported patterns fail explicitly. Mouse actions follow a continuous eased path (normally 120–650 ms, adjustable 80–1,500 ms). They stop if the user moves the pointer, focus changes or the target window moves; covered click targets are rejected. Native control operations do not move the pointer. Input receipts do not prove the application completed its work.

Windows live fixture checks cover native value editing, invocation, screenshot-bound clicks, moved-window rejection and continuous pointer steps. Bilibili tests using an authorized group scope retrieved three video frames and 20 comments; subtitle availability varies by video and platform response. These checks do not establish parity with proprietary desktop agents or cover every application.
