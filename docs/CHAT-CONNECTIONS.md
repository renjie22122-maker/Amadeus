# Chat connections

[English](CHAT-CONNECTIONS.md) | [简体中文](CHAT-CONNECTIONS.zh-CN.md)

Configure integrations from Chat connections in the sidebar. Connections start with Amadeus; no new startup script is required. Closing the browser does not stop the service. Deploying updated code requires a deliberate Amadeus restart. Bridges run separately; firewall rules are not modified automatically.

## Chat and work permissions

New connections default to ordinary chat. A selected conversation supplies only its model configuration: a clean conversation is created without project access, private history, memories or skills. Web, media and optionally the ordinary shared knowledge library are available; shell, arbitrary files, MCP, delegation and private-memory tools are denied. Shared-library citations can become visible to every group member.

Work mode explicitly binds an existing dedicated conversation and its permissions. Legacy connections retain work semantics. Create a new connection to change recipient, account, endpoint, conversation or mode. Model/scope changes pause the connection until reviewed and saved. One account/chat cannot have overlapping routes.

## Groups and selective participation

Choose group, its actual platform ID, a controller and allowed member IDs. Ordinary chat can allow all members. Members share the group context, with actual sender IDs attached; other groups, private chats and local private conversations remain separate. Display names never authorize actions, and quotations do not impersonate their attributed speaker.

Use `/amadeus question`. Genuine OneBot mention segments and official QQ group-mention events also trigger replies. Other adapters currently use the prefix; reply-to-bot detection is not universally implemented.

Optional recent context retains at most 40 observations, 600 characters each, for 24 hours, and supplies the latest 30 to a decision. Only allowed members enter this buffer. Passive media is not automatically downloaded. Explicit questions retain their full validated text.

Selective participation waits for five seconds of quiet and considers only new messages from the last two minutes. Decisions have a two-minute cooldown and a limit of three per hour, including silent decisions. No new message means no model call. Explicit work and incoming attachments take priority. These decisions cost model usage, may remain silent, and cannot execute commands, generate media, delegate or schedule tasks. Important requests should use a mention or prefix.

Own messages are ignored. Telegram bot senders are filtered; other bridges may not identify every bot, so cooldowns and budgets remain necessary. Controller-only commands are `/amadeus /status`, `/amadeus /stop` and approval responses. Work groups require explicit members, never whole-group authority.

### Automatically authorize groups invited by the controller

Enable automatic invitations on a OneBot 11 private controller route. A fresh authenticated `group_increase / invite` notice must identify this bot as the joining account and the configured controller as operator. A new isolated ordinary group route enables all-member chat, recent context and selective participation, inherits the shared-knowledge toggle, never work authority, and posts a disclosure.

Other inviters, admission approvals, missing operator IDs, old notices and text claims do not authorize groups. Existing routes, including paused ones, are never revived. This handles completed joins, not arbitrary pending invitation acceptance. Groups joined before enabling the feature must be configured manually. The application supports up to 20 configured routes.

## Platform setup

1. **Telegram:** create a bot with official BotFather and copy its token. Use actual `message.from.id` for controller and `message.chat.id` for destination (groups usually negative). Check bot privacy/group permissions for full-group context. Do not run a second poller for the token.
2. **QQ via NapCat:** independently install a trusted bridge and log in the bot. Enable forward OneBot 11 WebSocket on an unused loopback port with an access token. Enter that URL/token, bot QQ, controller QQ and, for groups, group number. A QQ password is not this token. Keep the bridge off the public internet.
3. **Official QQ:** configure App ID, AppSecret in the token field and signed webhook. Use platform user/group openids, not normal QQ account numbers. Group access follows official bot permissions and mention events.
4. **WeCom:** use official intelligent-bot WebSocket Bot ID/secret, event userid and group chatid. Legacy group webhooks and personal WeChat login are different protocols.
5. **Personal WeChat bridge:** independently provide a compatible trusted OneBot 12 service, loopback URL, token, bot user_id and contact user_id/group_id. Client/version compatibility is an upstream responsibility; Amadeus does not downgrade clients or bypass login.
6. **VK:** enable community messages and Long Poll, obtain a message-enabled community token, community ID and supported API version. Use actual from_id for users and peer_id for group destinations.
7. **WhatsApp:** use Meta Business Cloud API, not personal QR login. Supply access token, Phone Number ID, API version, App Secret and chosen webhook Verify Token. This adapter currently supports private chats only.

Official QQ and WhatsApp require HTTPS reverse proxy to the dedicated callback port (default 8788), using the displayed callback path. Never expose the management port. Blank credential edits preserve existing secrets; Windows storage uses DPAPI.

## Media, approvals and recovery

Explicit image/audio/video/document inputs use normal attachments and configured understanding/transcription capabilities. Only registered outputs from that route's runs are returned. Ordinary media generation still follows cost and approval policies. VK returns documents; WeCom audio may be sent as a file, not mislabeled voice encoding.

Remote approval is explicitly enabled only for work routes. Controller responses use single-use `/approve CODE`, `/deny CODE`, or `/answer CODE text`, expire within the platform-aware review window described below and invalidate on operation changes. Sensitive, oversized and recovery decisions remain local. Group members can see posted approval details; use private work for sensitive tasks.

Limits: ten attachments per message, 50 MiB per file, Telegram downloads 20 MiB, document parsing 25 MiB, plus platform limits. Downloads require validated public HTTPS, never bridge-provided local paths. Failed attachments are not treated as read.

Routes share account transports and maintain separate delivery queues. Ambiguous sends are not automatically repeated. Pausing cancels queued messages; deleting removes recent observations. Material already incorporated into normal conversation history follows normal history retention, not the observation buffer's 24-hour expiry. Remote tasks never send a local unsent draft.

## Validation and references

Automated tests cover protocols, permissions, isolated histories, invite identity/freshness, duplicate handling, context expiry/capacity, decision budgets, silent replies and shared delivery fairness. They make no paid model calls. Live QQ private messaging and group ingress have been observed; new group behavior needs post-deployment acceptance. Other platforms are not claimed live-tested.

References: [Telegram](https://core.telegram.org/bots/api), [Meta](https://developers.facebook.com/docs/whatsapp/cloud-api/), [VK](https://github.com/VKCOM/vk-api-schema), [QQ](https://github.com/tencent-connect/bot-docs), [WeCom](https://github.com/WecomTeam/aibot-node-sdk), [NapCat](https://github.com/NapNeko/NapCatQQ), [OneBot 11](https://github.com/botuniverse/onebot-11), [OneBot 12](https://12.onebot.dev/).

## Outbound formatting

QQ, WeChat and current adapters send model answers as plain text: Markdown styling is removed, tables become labeled records, and code, line breaks, URLs, footnotes and formula content are preserved. Code punctuation is not stripped. Conversion precedes byte-budget splitting. Local history retains the original. Approval commands and reviewed operation payloads bypass conversion so the reviewed operation cannot change. Images, speech and video continue through media delivery.

## Scoped chat inspection and structured replies

Remote runs gain `inspect_chat`, `list_chat_members`, `read_chat_media`, and `prepare_chat_reply`. Targets come from the active inbox route, never a model-supplied group ID. Group/member queries use OneBot 11/12; results include bounded names and platform roles only (unknown when absent), never grant authority based on a name or a claim. Member results are filtered/paged. Other adapters report unavailable capabilities explicitly.

Reply plans attach native mentions and quotes to the first final-response part: OneBot 11 at/reply/face and OneBot 12 mention/reply, subject to bridge support. Mentions require a recently observed/queried member; no mention-all. Quotes require a recent message in this exact chat. Plans replace earlier plans, send only at completion, and are rejected if the connection changed. Literal CQ codes remain text. Same-conversation sent/imported media or generated outputs can be selected as image/GIF stickers through the existing upload path; native QQ faces use numeric IDs. Other platforms retain text/Unicode emoji and supported media rather than claiming universal native sticker support.

Recent envelopes retain media metadata (40 messages per route, 24 hours). Passive context explicitly states that media is not imported. `read_chat_media` imports one observed message on demand without starting another run, disclosing host files or picking up unsent drafts. Image understanding still requires read_image and a visual-capable model; audio requires transcription, and documents use read_attachment after extraction. QQ group_upload notices are supported; this does not enumerate the complete historical group file library.

For NapCat, enable `enableLocalFile2Url` to return authenticated bridge media bytes, avoiding reliance on CDN reachability. Converted get_record MP3 Base64 takes priority over URLs; local paths from a bridge are never read. Other bridges may provide bytes or public HTTPS. Public HTTP URLs are upgraded to HTTPS only, with private addresses still rejected. Existing per-message/file/parser budgets remain. No new model, Python or launcher dependency is required; restart Amadeus to load the tools.

Validation includes native segment encoding, cross-group denial, upload notices, mixed media, idempotent passive imports and converted voice bytes. A read-only local QQ probe verified group/member metadata and retrieved a 122,966-byte GIF; no test messages were sent to the group. Other platform behavior is protocol-tested, not represented as universally live-tested. Protocol sources: [OneBot 11 segments](https://github.com/botuniverse/onebot-11/blob/master/message/segment.md), [OneBot 12 segments](https://12.onebot.dev/interface/message/segments/), [group queries](https://12.onebot.dev/interface/group/actions/).

### Legacy envelopes and direct visual results

OneBot 11 can recover a legacy message only when its ID was already observed in the current group. Group ID, message ID and sender must match before accepting recovered metadata; arbitrary history lookup is rejected. Deleted/expired platform messages may remain unavailable. Context distinguishes available media, no media, and missing legacy metadata, rather than treating a text-only prompt as proof of missing attachments.

`read_chat_media` now returns actual image pixels (up to three) when the current model declares vision, with explicit per-file states for unsupported vision or decoding failure. Additional images remain available through read_image. GIF previews show the first frame. Audio still requires transcription and documents require extraction. This does not force downloading all group images every turn.

Permission fix: discovery and pre-execution revalidation apply the same effective ordinary-remote-chat policy, so an old persisted tool list cannot spuriously produce CAPABILITY_CHANGED. Actual permission, workspace, remote-chat mode or shared-knowledge changes still stop execution. Regression coverage invokes ToolRegistry, not just the media helper.

See [Bot startup and independent status notices](BOT-STARTUP.md) for optional Windows launch tasks and OneBot 11 fallback notices.

### Friend-request review (OneBot 11)

Enable friend-request review on one dedicated private work/controller connection per bot account (off by default). Incoming requests forward the applicant ID, untrusted verification message and a random code to that controller. Reply `同意 CODE` to accept or `拒绝 CODE` to reject. Bare assent is accepted only for exactly one pending friend request and no pending task input. Requests expire after 24 hours. Manual acceptance in QQ also enrolls a friend when a matching observed request receives a native `friend_add` notice; missed offline events are not guaranteed to be recovered.

Each accepted friend receives a new isolated ordinary conversation. Controller history, private memory, projects, work permissions and remote approvals are never inherited. Shared knowledge follows the controller connection setting. Existing/paused routes are preserved. The 20-connection limit and 50-new-requests/day bound apply. Uncertain bridge results are not retried; inspect them in QQ. Task approvals remain separate, using the exact `/approve CODE` command; issuing a review offer no longer adds a contradictory local-only waiting notice.

Remote approval and denial commands are sent as separate short messages for whole-message copying. Group commands include the trigger prefix. These are plain messages, not native platform buttons; a compact summary precedes them, /details CODE provides the full operation, and codes remain single-use within the platform-aware review window.

### Group calls, passive media and targeted replies

A native mention without additional text is an explicit call and receives a brief acknowledgement. Passive media and file notifications stay available as context but do not independently trigger unsolicited participation or become fabricated inspection instructions. Later explicit media questions use the existing association/read path.

Each explicit run identifies its current sender separately from the controller and group owner. New explicit requests supersede unfinished proactive replies. The internal `[NO_REPLY]` marker is never delivered literally: proactive runs remain silent; explicit runs that unexpectedly return it receive a brief acknowledgement without claiming to understand attachments.

On OneBot 11/12, explicit group responses default to a native mention of the observed current sender. Valid model-selected recipients are retained; unsolicited whole-group replies do not acquire a default recipient. Unknown/expired recipients and unsupported platform mentions are not guessed. Protocol/scheduler tests verify these boundaries, not a visual model's recognition accuracy.

Remote review defaults to operation, destination, parameters, cost and risk; long media prose has a marked preview. `/details CODE` retrieves the full payload for the same bound controller without approving it. Commands and paths are never shortened; sensitive or oversized payloads still require local review.

### Revocable remembered approvals

Local approval cards offer “Allow and remember scope”; bound remote work controllers can send `/allow-similar CODE`. Media generation/transcription grants bind the configured service: prose, voices, parameters and conversation-authorized references may vary, but per-call estimated cost cannot increase. Changing service identity, endpoint or model configuration requires review; unknown prices are ineligible.

Other approvals with explicit execution backend and command require exact approval-parameter matches, including command, target, arguments and source digests where supplied. Name-only extension discovery, recovery inspection and force-manual requests are ineligible. Grants are conversation-local, valid for 24 hours/up to 100 calls, and never replace capability checks, attachment isolation or execution revalidation.

Revoke from the approved local card, or use `/grants` and `/revoke-grants` remotely (with the group prefix where applicable). Only the enabled remote-approval work controller may manage grants. Grants persist locally across restart; authority/workspace/connection revisions invalidate matching. Revocation affects subsequent requests, not an already running approved operation.

### Review expiry and message retraction

Remote codes use a platform-aware application lifetime: OneBot 11/12 use 90 seconds, reserving time for bridge latency and recall; Telegram uses 5 minutes; other adapters use 2 minutes without automatic deletion. These are application defaults, not universal provider limits. OneBot specifies deletion actions but no common time limit. Telegram documents its own [deleteMessage constraints](https://core.telegram.org/bots/api#deletemessage). Adapters can reject a deletion even inside these windows.

Lifetime includes send queue time. Approval fragments with less than 30 seconds remaining are cancelled, the old code expires, and the controller can send `/renew CODE` for an unchanged pending request. Renewal is explicit, never an infinite reminder loop. Accepted/denied/expired remote offers schedule best-effort cleanup using verified bot send receipts. Unknown outcomes are retained as unconfirmed, not silently retried or reported successful. Unsupported adapters retain messages. Local pending input, conversation history, completed effects and audit records are unaffected by retraction.

Users may explicitly ask the bot to retract its own reply. `inspect_chat.sentMessages` exposes delivery IDs and `retract_chat_message` accepts only a verified delivery in the current route. Ordinary members may retract replies to themselves; the configured controller or freshly queried platform administrators may retract other bot messages. Ambiguous requests require clarification. No arbitrary user-message deletion or cross-chat deletion is supported. Historical messages and media without retained platform receipts cannot be safely retracted.

No new daemon, port, dependency or startup task is required. Tables migrate on normal startup; the existing detached bot supervisor remains the launcher. Deployment needs an idle Amadeus restart, not a NapCat or benchmark restart. On reconnect the scheduler cleans expired offers; it cannot guarantee provider recall after an extended outage.

### Quick help

A bare native mention or `/help` returns a small deterministic help message without calling the model. The controller also sees status/stop and, on remotely reviewable work routes, grant-management commands. Help never mints approval codes. Mention plus text/media still dispatches normally. `sentMessages` contains only confirmed recent deliveries; pre-upgrade messages, untracked media and a reply still being generated may be absent. Do not ask users for internal delivery IDs.

### Received voice messages

Remote voice transcription keeps the existing approval and service boundaries. Once an approved transcription job is submitted for an attachment on the incoming message, a durable continuation waits for its text. If the original run finishes before reading the text, the host resumes in the same route with the original sender, without touching composer drafts or requiring Insert draft. Already consumed transcripts do not trigger duplicate answers. Changed connection authority, interrupted runs and `/stop` prevent continuation; failure or a 15-minute wait timeout gives a concise notice. This is chat-only orchestration, not automatic approval or a change to local microphone editing.

Native mentions of other members retain their IDs and message text; they are not bare bot mentions. On explicit requests, an invalid NO_REPLY result is reported as an invalid answer rather than falsely treating the message as empty.

### Group media authorization

In an ordinary group connection, the local owner can enable **Group media
authorization**, select enabled services, set a maximum configured cost per
request and a group-wide hourly quota, then save once. Admitted members can use
these services without individual approvals. This does not enable remote work,
shell, private files, settings changes or approvals by group members. Newly
invited groups do not inherit this authority automatically.

Default cost ceiling is USD 0, quota 12 requests/hour. Unknown estimates are not
preauthorized; configured estimates are not a provider billing cap. Failed
submissions count. Unsolicited participation cannot consume this authorization.
Model-supplied raw URLs/paths in options are rejected; use same-conversation
attachment references. Service changes invalidate the snapshot until the owner
reviews and saves again. Pause, disable or revoke blocks future submissions;
already submitted jobs are not automatically cancelled. Every use is audited
with the actual requesting member. Platform media delivery limits still apply.

### Quoted messages, forwarded records and shared cards

OneBot 11 retains forward resource IDs and bounded JSON/XML card text and HTTP(S) links. Cards alone do not initiate participation. `read_chat_message` reads messages received or quoted in the current route, validates recovered chat identity, and expands forwarded records with pagination (20 nodes by default). Forward authors are untrusted attribution, never members or authorization. Returned `mediaMessageId` references let `read_chat_media` import that page's attachments; image understanding still requires vision and audio requires transcription.

Card claims do not verify linked content. Expired/retracted records, app-only identifiers and unavailable URLs remain explicit limitations. Existing web tools handle requested link fetching; there is no automatic URL fetch, internal protocol execution or unbounded recursive forward traversal. Output/depth limits are reported. `inspect_knowledge_status` exposes only authorized knowledge counts and vector coverage, without private memory or configuration.

For NapCat shortcuts, optional local `bridgeWebUiConfig` points to its `config/webui.json`. The bridge launcher reads the current token and opens the built-in token-prefill login route only on loopback HTTP(S). Do not share the resulting URL; browser history may retain it. Credentials are not stored in the shortcut or committed configuration.

Forwarded OneBot images with a scoped CDN URL use the bounded public-HTTPS downloader before bridge cache lookup. A valid forwarded image need not exist in the bot's local `get_image` cache. Failed direct downloads can use bridge-provided bytes/URLs; local filesystem paths and private destinations remain forbidden. The real group forward validation returned two nodes and one JPEG with `pixels-attached`; this confirms bytes reached the vision tool, not recognition accuracy or the truth of pictured content. A mini-app card's b23.tv link was parsed without fetching the linked page. Validation used a temporary store and sent no group replies.

Remote replies support explicit `prepare_chat_reply.messages` (1–8 ordered text bubbles) or `mediaOnly: true`. Explicit messages replace the final text; media-only delivery sends generated/referenced media without a forced text, speaker emoji or automatic mention. Missing/failed media produces a concise error; pending generation can complete after the turn. Automatic and explicitly referenced outputs share delivery IDs to avoid duplicate uploads. Existing recipient, permission and uncertain-send rules remain. Casual replies may use appropriate inspected same-chat stickers, without requiring them; voice-only requests override reactions.

Remote group and private conversations adapt their tone to the message: casual banter can be brief and playful without routine disclaimers; factual questions and requested work still require appropriate verification. No fixed persona is imposed. This guidance is injected only when dispatching a remote chat turn, not into the shared system prompt or saved conversation settings. Local ordinary and project chats retain their existing behavior. Permissions, approvals, sender identity, privacy and unsolicited-participation rules are unchanged. Naturalness remains model-dependent; transport tests verify scope and boundaries, not conversational quality.

Remote conversation guidance considers communicative intent, context, stakes and expressed preferences together. Social reactions, interpretation and verification/work are flexible dimensions, not keyword-triggered modes or fixed personas. Mixed requests can combine them; uncertainty is stated where it matters, not appended to every subjective reaction. The model should avoid automatic image inventories, formal verdicts and unsolicited task offers in casual exchanges, while reading media before visual claims. A group member’s preferences do not become everyone’s preferences. No separate classifier, extra model call or global conversation-policy change is introduced.

Atmosphere adaptation uses only recent context already available in the same remote chat. It can adjust rhythm, length, formality and humor; group patterns are tentative and should not be dominated by one loud participant or spam. Current requests and topic changes override inferred habits. This is contextual adaptation, not model training or a persistent personality profile: it does not fetch unrelated histories, enable new memory, change participation triggers or propagate style across conversations.

Immediate mood is separate from recurring preferences: a few relevant playful exchanges can justify a natural reaction without establishing a lasting group persona. Same-chat emoji/sticker frequency, timing and meaning can guide optional reactions; unsupported or uninspected media must not be invented or blindly echoed. Participation triggers and cooldowns remain unchanged.

Pending consecutive text messages from the same connection and sender can be coalesced into one model turn (up to 8 messages, an 8-second span and 6,000 characters). Media, other senders and commands form boundaries. Already running turns are not interrupted; this merges queued follow-ups, not messages arriving after dispatch. Separate reply bubbles use prepare_chat_reply.messages rather than newline splitting. Delivery claims must use receipts, not inferred assistant-turn counts.

Remote text batching now waits for 2 seconds of quiet with a 5-second cap from the first queued message (plus the dispatcher tick, normally up to 1 second). Stop/status/approval commands bypass the window. Local composer messages are unaffected.

Controller-approved `schedule_followup` tasks can deliver back to the original remote group/private chat. Repeats require at least 15-minute intervals and a run-count or end-time bound; `meaningful` suppresses completed runs reported unchanged. Agree on purpose, timing and quiet hours in the task. Binding changes or disabled routes block launches, and permissions are rechecked. This does not automatically enable unbounded social check-ins or let ordinary group members schedule work. Existing group participation still uses its own opt-in/cooldown rules. The service and computer must remain running; this is not a wake-from-sleep or wake-up-call guarantee.

The authenticated Chat Connections page offers **Browser voice**: click to record and finish a sentence, or choose **Assistant speaks first**. It uses the configured transcription and streaming read-aloud services, saves turns in the current conversation, excludes composer drafts, and does not create a platform delivery. Hang up releases microphone/audio and requests cancellation of this panel's pending work only. Opening the conversation to handle approval leaves that run available. HTTPS or localhost and microphone permission are required. It is alternating, sentence-based transcription, not full-duplex or streaming ASR; a closed/background browser cannot promise ringing or automatic answering.

Native QQ/WeChat calls are not implemented by these adapters. [NapCat's public call API request](https://github.com/NapNeko/NapCatQQ/issues/1878) was closed as not planned, with the maintainer stating the implementation is not publicly exposed. A [community QQ AV bridge](https://github.com/ClaudiaGardner/maibot-qq-voice-call) describes Linux QQ/AVSDK, PulseAudio and a loader hook, not a drop-in Windows OneBot API. It has not been installed or validated here. No claim of native inbound/outbound calls or reliable morning phone alarms is made.

Whisper incremental audio snapshots and optional silence endpointing are now available in browser voice; only final text is submitted. See [Local voice](LOCAL-VOICE.md) for capability registration, pacing, measured limits and the distinction from native streaming ASR.

Remote reply planning chooses bubble boundaries by conversational meaning: a coherent reply may remain one message, while a distinct reaction and follow-up can use `prepare_chat_reply.messages` without an explicit split request. There is no newline splitter, character-count heuristic or multi-message quota. Explanations, lists, code and task results stay together when appropriate. Planned bubbles replace the final platform text; the preparation receipt reports the text source and planned count, not delivery success. Local final messages and local/project prompts remain unchanged. Tests verify explicit ordering, no repeated final delivery, intact paragraphs and unchanged local history; model style adherence still depends on the configured model and context.

An approval whose delivery is unconfirmed is never automatically resent. When that review expires or is answered locally, its unconfirmed summary becomes `uncertain-closed` and its unsent commands are cancelled, allowing later messages (including the expiry/renew notice) to proceed. This does not approve the operation or assert delivery/recall success. The latest per-connection `chat-delivery-failure` record stores a bounded timeout/disconnection/rejection category without provider payloads; older incidents without that record cannot be diagnosed retroactively.
