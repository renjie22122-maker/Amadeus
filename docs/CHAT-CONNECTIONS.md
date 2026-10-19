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

Remote approval is explicitly enabled only for work routes. Controller responses use single-use `/approve CODE`, `/deny CODE`, or `/answer CODE text`, expire in 15 minutes and invalidate on operation changes. Sensitive, oversized and recovery decisions remain local. Group members can see posted approval details; use private work for sensitive tasks.

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

Remote approval and denial commands are sent as separate short messages for whole-message copying. Group commands include the trigger prefix. These are plain messages, not native platform buttons; full review details remain in the preceding message and codes stay single-use with a 15-minute expiry.
