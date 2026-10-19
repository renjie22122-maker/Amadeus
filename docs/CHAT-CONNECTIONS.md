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
