# Chat connections

[English](CHAT-CONNECTIONS.md) | [简体中文](CHAT-CONNECTIONS.zh-CN.md)

Open **Chat connections** below Settings in the sidebar. Connections start with the Amadeus service and are disabled until explicitly enabled. No separate startup script, package download, or firewall change is required. The service must remain running; closing the browser is fine, shutting down the computer is not.

## Setup

Create a dedicated conversation with the desired model, tools, folders and permissions first. Add a connection, select that conversation, enter the platform credentials and the trusted private sender ID (not their display name), then enable it. One connection binds one conversation and one private recipient. Group access is not implemented. Existing history and authorized resources in that conversation are available to the remote user. Changing the model or scope pauses the connection until reviewed and saved again. To change the account, recipient, endpoint or conversation, create a new connection; queued results cannot be redirected to another recipient.

| Platform               | Transport and required configuration                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram               | Official Bot API long polling. Bot token and private numeric user/chat ID. Stop other consumers of the same bot's updates.                                                                                                |
| WhatsApp               | Official Business Cloud API, not personal WhatsApp login. Access token, Phone Number ID, Graph API version, App Secret and your webhook verification token.                                                               |
| VK                     | Official community long polling. Community token, community ID, supported API version and private numeric user ID. Enable messages and long-poll message events in the community.                                         |
| QQ official            | App ID, AppSecret in the service-token field, private contact **openid** and signed webhook. Platform app permissions and approval requirements apply.                                                                    |
| WeCom                  | Official enterprise WeChat intelligent-bot WebSocket. Bot ID, secret and private userid. This is distinct from personal WeChat.                                                                                           |
| QQ bridge              | A separately installed trusted OneBot 11 bridge, such as NapCat, with loopback WebSocket, access token, bot QQ ID and private QQ ID.                                                                                      |
| Personal WeChat bridge | A separately installed compatible OneBot 12 bridge, bot ID and private user ID. Client versions and bridge maintenance constrain compatibility; Amadeus does not install/downgrade WeChat or bypass account verification. |

WhatsApp and official QQ need an HTTPS reverse proxy to the dedicated loopback webhook port (default 8788), with the callback path displayed after saving. **Do not expose the Amadeus management port.** WhatsApp validates the verification token and raw-body HMAC; QQ validates Ed25519 signatures and timestamps. Tokens are write-only in the UI; blank keeps the existing secret. Secrets are stored separately with private-file permissions and Windows DPAPI where available.

## Messages, approvals and media

Ordinary messages queue in arrival order. They never submit local composer drafts. `/status` reports state; `/stop` stops the current conversation task and cancels pending remote messages. Use a dedicated chat to avoid stopping unrelated local work.

Remote approvals are opt-in. Eligible pending operations show their exact review payload plus a one-time `/approve CODE` or `/deny CODE`; questions use `/answer CODE response`. Only the bound account can answer, within 15 minutes, for an unchanged request. Sensitive, oversized and recovery-inspection requests remain local. Remote approval does not change permanent permissions. A plain “yes” is ordinary task text, not approval.

Pictures, audio/voice, videos and files use the same attachment and media services as local chat. Incoming audio can be transcribed by the configured service; WeCom's platform-provided speech transcript is labelled as such. Images/video still require the appropriate model/tools. Receiving a file does not imply successful transcription or understanding. Generated media and registered file deliveries from the remote task are returned to its private chat; arbitrary workspace files and unrelated local results are not automatically sent.

Native image/audio/video messages are used where supported. VK currently returns outputs as document attachments; WeCom audio uses a file attachment rather than mislabelling WAV as a voice codec. Unsupported provider formats fail visibly. This is asynchronous media messaging, not a live voice/video call. Separate album messages are separate tasks.

The initial bounded transfer route accepts 10 attachments/message and 50 MiB/file; Telegram Bot API downloads are capped at 20 MiB and document parsing at 25 MiB. Provider-specific codec, size, time-window and account limits also apply. Downloads are public HTTPS only, with DNS pinning and no redirects or private-network/file URLs. Larger files remain accessible locally; this route does not promise arbitrary-size remote video transfer.

QQ's passive private reply window/quota can leave results waiting for another message. Other platform errors appear in delivery state. Ambiguous sends after network failure or restart are **not automatically retried**: inspect the remote chat, then retry or dismiss in Chat connections. This avoids duplicate operations/messages. Media import failure does not start a text-only task pretending to have read the attachment.

## Validation and sources

Local tests cover seven protocol normalizers, signature tampering/replay, recipient boundaries, ordered queues, explicit attachment isolation, single-use approvals, registered outputs, mocked media receipts, restart ambiguity, encrypted files and private-address rejection. **No real-account end-to-end success is claimed without credentials and platform testing.** The bridge routes are compatibility adapters, not bundled or officially endorsed clients. No paid model requests are made by these tests.

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Meta webhook signature example](https://github.com/fbsamples/whatsapp-api-examples)
- [VK official API schema](https://github.com/VKCOM/vk-api-schema)
- [QQ official SDK and protocol](https://github.com/tencent-connect/qqbot-nodejs)
- [QQ messaging documentation](https://github.com/tencent-connect/bot-docs)
- [WeCom official bot SDK](https://github.com/WecomTeam/aibot-node-sdk)
- [NapCat](https://github.com/NapNeko/NapCatQQ)
- [OneBot 12](https://12.onebot.dev/)
- [ComWeChatBotClient compatibility reference](https://github.com/JustUndertaker/ComWeChatBotClient)
