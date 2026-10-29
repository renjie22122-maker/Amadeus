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

The optional `youtube` account has the same shape. Empty conversation IDs authorize no conversations. The model cannot choose arbitrary cookie paths. Cookies are filtered by platform domain, written only to a temporary worker file and removed after use. Never commit this configuration or cookie file. No automatic extraction from browser profiles. Export only the current site in Netscape format using a reviewed browser extension; Chrome may require you to approve installation. `credentialsProvided` means a cookie jar was supplied, not that the platform validated the login. HTTP 412/403/429/567 and unavailable videos are explicit failures; credentials do not guarantee access.

## Desktop improvements and limits

The existing enabled computer MCP adapter gains window activation, configurable bounded accessibility inspection, focused-control metadata, observation IDs with a 60-second lifetime, element clicks, right/middle click, keyboard chords and horizontal scrolling. Observe, choose a returned window, activate when needed, inspect focus, perform one action, then reobserve. An element click requires the same session/window and unchanged runtime ID, bounds, role and name. Input invalidates references. Pointer targeting checks for covering windows; password controls reject typing.

Existing approval and host permission boundaries remain. This is not an isolated desktop. Capture still uses application-dependent PrintWindow, not Windows.Graphics.Capture: covered-window support varies and black/stale frames can occur. These additions do **not** establish parity with Codex Computer Use; app launch discovery, richer accessibility actions and WGC capture remain separate work. The opt-in `pnpm exec tsx scripts/test-desktop-live.ts` test creates its own disposable Windows editor and verifies activation, UI Automation clicks, typing, Ctrl+A replacement, button delivery and screenshot capture. This passed locally; it does not establish compatibility with every application.

## Language contract

Core system prompts and provider implementation are English. New tool contracts and diagnostics are English. UI translations, localized chat notices, bilingual search aliases, matching rules, test fixtures, documents and user-generated memories retain their original languages. UI language must not silently rewrite user data or force model replies into English. This audit is not a claim that every string in the repository is English.

## References and validation

Design references: [dsh-video-storyboard main fetch layer](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/src/fetch.js), [performance branch](https://github.com/SAOS-3624/dsh-video-storyboard/tree/feature/high-performance), [PyAV containers](https://pyav.org/docs/stable/api/container.html), [yt-dlp cookie guidance](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp). The reference plugin caches a low-resolution whole video for repeated scanning and uses direct streams for high-resolution zoom. Its timings and image token estimates are provider/sample-specific, not Amadeus guarantees.

Tests cover local video/subtitle/audio decoding, pagination/parsing, account/source isolation, DNS restrictions, Range seek/cache/unsupported responses and stale desktop observations. Real-site tests can be blocked by platform access controls; report metadata, subtitles, frames, audio and comments separately.

### Local verification (2026-10-29)

A public YouTube sample returned 6 subtitle cues, 20 comments, 4 actual frames (256 KiB transferred) and a 4-second audio window (256 KiB transferred). Repeating the frame window used its cache. A Bilibili sample returned automatic Chinese captions and 4 frames over a 12-second window (512 KiB transferred). Bilibili uses metadata/player APIs directly and at most two platform-provided backup CDN addresses; it does not need to load the HTML player. HTTP subtitle URLs supplied by the platform are upgraded to HTTPS. Access restrictions remain explicit; no bypass or whole-file fallback is attempted.

The CPU-only synthetic decoder test verifies requested/actual timestamps and audio duration through Range responses. The disposable Windows editor test passed activation, control selection, literal text, Ctrl+A, button callback and capture. Main-service deployment does not require restarting retrieval, voice or NapCat. Credentials used in validation are not committed or automatically enabled for other conversations.

Account grants also support `allowLocalConversations` (default false) and `privateChatTransports` (default empty). These apply to current and future local/project conversations or enabled private transport bindings. Groups require an explicit `conversationIds` entry; orphaned external chats never fall back to local authorization. Configure each account independently in the local file; the model cannot expand grants.
