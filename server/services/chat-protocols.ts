import { richSegments, richSummary } from './chat-rich.js';
import {
  createHmac,
  timingSafeEqual,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import type {
  ChatConnection,
  ChatIncoming,
  ChatRemoteFile,
} from '../../shared/chat-connections.js';
export function equalSecret(a: string, b: string) {
  return (
    !!a &&
    !!b &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}
export function whatsappSignature(body: Buffer, signature: string, secret: string) {
  return (
    !!secret &&
    equalSecret(signature, 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'))
  );
}
function textSegments(parts: any): string {
  // Do not execute CQ codes, fetch attachments, or treat forwarded payloads as user text.
  if (!Array.isArray(parts) || parts.some((p) => p?.type !== 'text')) return '';
  return parts.map((p) => (typeof p.data?.text === 'string' ? p.data.text : '')).join('');
}
export function incoming(c: ChatConnection, event: any): ChatIncoming[] {
  const make = (
    id: unknown,
    sender: unknown,
    peer: unknown,
    text: unknown,
    time: unknown,
    media: ChatRemoteFile[] = [],
  ) => {
    const addressed =
      (c.transport === 'qq' && event.t === 'GROUP_AT_MESSAGE_CREATE') ||
      (Array.isArray(event.message) &&
        event.message.some(
          (x: any) =>
            (x.type === 'at' && String(x.data?.qq) === c.accountId) ||
            (x.type === 'mention' && String(x.data?.user_id) === c.accountId),
        ));
    if (
      id == null ||
      sender == null ||
      peer == null ||
      typeof text !== 'string' ||
      (!text.trim() && !media.length && !addressed) ||
      text.length > 16000 ||
      media.length > 10
    )
      return [];
    const timestamp = Number(time) * 1000;
    if (!Number.isFinite(timestamp)) return [];
    return [
      {
        id: String(id),
        senderId: String(sender),
        peerId: String(peer),
        text:
          text.trim() ||
          (media.length
            ? '[Media attached without a caption]'
            : '[Bot mentioned without additional text]'),
        textOrigin: text.trim()
          ? ('user' as const)
          : media.length
            ? ('media-placeholder' as const)
            : ('mention-only' as const),
        mentionedIds: Array.isArray(event.message)
          ? [
              ...new Set<string>(
                event.message
                  .filter((x: any) => x.type === 'at' || x.type === 'mention')
                  .map((x: any) => String(x.data?.qq ?? x.data?.user_id ?? ''))
                  .filter((x: string) => x && x !== c.accountId && x !== 'all'),
              ),
            ]
          : [],
        timestamp,
        peerType: c.peerType || 'private',
        addressed,
        media,
      },
    ];
  };
  if (c.transport === 'telegram') {
    const m = event.message;
    if (
      !m ||
      (c.peerType === 'group'
        ? !['group', 'supergroup'].includes(m.chat?.type)
        : m.chat?.type !== 'private') ||
      m.sender_chat ||
      m.from?.is_bot ||
      m.forward_origin ||
      m.forward_from ||
      m.forward_from_chat ||
      m.via_bot
    )
      return [];
    const media: ChatRemoteFile[] = [];
    if (m.sticker)
      media.push({
        id: m.sticker.file_id,
        name: m.sticker.is_video
          ? 'sticker.webm'
          : m.sticker.is_animated
            ? 'sticker.tgs'
            : 'sticker.webp',
        kind: m.sticker.is_video ? 'video' : m.sticker.is_animated ? 'file' : 'image',
      });
    const photo = m.photo?.at(-1);
    if (photo) media.push({ id: photo.file_id, name: 'photo.jpg', kind: 'image' });
    for (const [key, kind, name] of [
      ['voice', 'audio', 'voice.ogg'],
      ['audio', 'audio', 'audio.mp3'],
      ['video', 'video', 'video.mp4'],
      ['document', 'file', 'document'],
    ] as const)
      if (m[key]) media.push({ id: m[key].file_id, name: m[key].file_name || name, kind });
    return make(event.update_id, m.from?.id, m.chat.id, m.text || m.caption || '', m.date, media);
  }
  if (c.transport === 'vk') {
    const m = event.object?.message;
    if (
      event.type !== 'message_new' ||
      !m ||
      m.out ||
      (c.peerType === 'group' ? m.peer_id < 2000000000 : m.peer_id !== m.from_id) ||
      m.from_id <= 0 ||
      m.fwd_messages?.length
    )
      return [];
    const media: ChatRemoteFile[] = [];
    for (const a of m.attachments || []) {
      if (a.type === 'photo') {
        const photo = [...(a.photo?.sizes || [])].sort(
          (a, b) => b.width * b.height - a.width * a.height,
        )[0];
        if (photo?.url) media.push({ url: photo.url, name: 'photo.jpg', kind: 'image' });
      } else if (a.type === 'audio_message' && a.audio_message?.link_mp3)
        media.push({ url: a.audio_message.link_mp3, name: 'voice.mp3', kind: 'audio' });
      else if (a.type === 'doc' && a.doc?.url)
        media.push({ url: a.doc.url, name: a.doc.title || 'document', kind: 'file' });
      else media.push({ name: 'unsupported-' + String(a.type), kind: 'file' });
    }
    return make(
      event.event_id || `${m.peer_id}:${m.id}`,
      m.from_id,
      m.peer_id,
      m.text || '',
      m.date,
      media,
    );
  }
  if (c.transport === 'whatsapp') {
    if (event.object !== 'whatsapp_business_account') return [];
    return (event.entry || []).flatMap((e: any) =>
      (e.changes || []).flatMap((change: any) => {
        const v = change.value;
        if (change.field !== 'messages' || v?.metadata?.phone_number_id !== c.accountId) return [];
        return (v.messages || []).flatMap((m: any) => {
          if (m.context?.forwarded || m.context?.frequently_forwarded) return [];
          if (m.type === 'text') return make(m.id, m.from, m.from, m.text?.body, m.timestamp);
          const kind = (
            {
              image: 'image',
              sticker: 'image',
              audio: 'audio',
              video: 'video',
              document: 'file',
            } as const
          )[m.type as 'image'];
          const part = m[m.type];
          if (!kind || !part?.id) return [];
          const suffix =
            kind === 'image' ? '.jpg' : kind === 'audio' ? '.ogg' : kind === 'video' ? '.mp4' : '';
          return make(m.id, m.from, m.from, part.caption || '', m.timestamp, [
            { id: part.id, name: part.filename || m.type + suffix, kind },
          ]);
        });
      }),
    );
  }
  if (c.transport === 'qq') {
    const m = event.d;
    if (
      event.op !== 0 ||
      event.t !== (c.peerType === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE') ||
      !m
    )
      return [];
    const media: ChatRemoteFile[] = (m.attachments || []).map((a: any) => ({
      url: a.url?.startsWith('//') ? 'https:' + a.url : a.url,
      name: a.filename || 'attachment',
      kind: a.content_type?.startsWith('image/')
        ? 'image'
        : a.content_type?.startsWith('audio/')
          ? 'audio'
          : a.content_type?.startsWith('video/')
            ? 'video'
            : 'file',
    }));
    return make(
      m.id,
      m.author?.member_openid || m.author?.user_openid,
      c.peerType === 'group' ? m.group_openid : m.author?.user_openid,
      (m.content || '').replace(/^<@!?[^>]+>\s*/, ''),
      Date.parse(m.timestamp) / 1000,
      media,
    );
  }
  if (c.transport === 'wecom') {
    const m = event.body;
    if (
      event.cmd !== 'aibot_msg_callback' ||
      m?.chattype !== (c.peerType === 'group' ? 'group' : 'single') ||
      m.aibotid !== c.accountId
    )
      return [];
    if (m.msgtype === 'text')
      return make(
        m.msgid,
        m.from?.userid,
        c.peerType === 'group' ? m.chatid : m.from?.userid,
        m.text?.content,
        m.create_time || Date.now() / 1000,
      );
    if (m.msgtype === 'voice' && m.voice?.content)
      return make(
        m.msgid,
        m.from?.userid,
        c.peerType === 'group' ? m.chatid : m.from?.userid,
        '[Platform speech transcript] ' + m.voice.content,
        m.create_time || Date.now() / 1000,
      );
    const media: ChatRemoteFile[] = [];
    for (const part of m.msgtype === 'mixed' ? m.mixed?.msg_item || [] : [m]) {
      const a = part[part.msgtype];
      if (a?.url)
        media.push({
          url: a.url,
          aeskey: a.aeskey,
          name:
            part.msgtype +
            (part.msgtype === 'image' ? '.jpg' : part.msgtype === 'video' ? '.mp4' : ''),
          kind: part.msgtype === 'image' ? 'image' : part.msgtype === 'video' ? 'video' : 'file',
        });
    }
    return make(
      m.msgid,
      m.from?.userid,
      c.peerType === 'group' ? m.chatid : m.from?.userid,
      (m.mixed?.msg_item || [])
        .filter((a: any) => a.msgtype === 'text')
        .map((a: any) => a.text?.content || '')
        .join('\n'),
      m.create_time || Date.now() / 1000,
      media,
    );
  }
  if (c.transport === 'onebot11') {
    if (
      event.post_type === 'notice' &&
      event.notice_type === 'group_upload' &&
      c.peerType === 'group' &&
      String(event.self_id) === c.accountId &&
      event.file?.id &&
      event.user_id
    ) {
      return make(
        'upload:' + event.file.id + ':' + event.time,
        event.user_id,
        event.group_id,
        '[Group file upload]',
        event.time,
        [
          {
            id: String(event.file.id),
            url: event.file.url,
            name: String(event.file.name || 'file'),
            kind: 'file',
          },
        ],
      );
    }
    if (
      event.post_type !== 'message' ||
      event.message_type !== (c.peerType || 'private') ||
      String(event.self_id) !== c.accountId ||
      String(event.user_id) === c.accountId
    )
      return [];
    const parsed = onebotMedia(groupSegments(event.message, c.accountId), false);
    return make(
      event.message_id,
      event.user_id,
      c.peerType === 'group' ? event.group_id : event.user_id,
      parsed.text,
      event.time,
      parsed.media,
    ).map((m) => ({
      ...m,
      text:
        parsed.media.length &&
        !event.message?.some((p: any) => p.type === 'text' && p.data?.text?.trim()) &&
        richSummary(event.message)
          ? '[Media attached; content not inspected.] ' + m.text
          : m.text,
      rich: richSegments(event.message),
      ...(!event.message?.some((p: any) => p.type === 'text' && p.data?.text?.trim()) &&
      richSummary(event.message)
        ? { textOrigin: 'media-placeholder' as const }
        : {}),
    }));
  }
  if (
    event.type !== 'message' ||
    event.detail_type !== (c.peerType || 'private') ||
    event.self?.platform !== 'wechat' ||
    String(event.self?.user_id) !== c.accountId ||
    String(event.user_id) === c.accountId
  )
    return [];
  const parsed = onebotMedia(groupSegments(event.message, c.accountId), true);
  return make(
    event.id,
    event.user_id,
    c.peerType === 'group' ? event.group_id : event.user_id,
    parsed.text,
    event.time,
    parsed.media,
  );
}
export function messageParts(text: string, limit = 2800) {
  // Respect byte-limited transports and never split Unicode surrogate pairs.
  const parts: string[] = [];
  let part = '',
    bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit && part) {
      parts.push(part);
      part = '';
      bytes = 0;
    }
    part += char;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}
export function onebotAction(
  c: ChatConnection,
  text: string,
  echo: string,
  plan?: import('./chat-interaction.js').ChatReplyPlan,
) {
  const message: any[] = [];
  if (plan?.replyTo)
    message.push({
      type: 'reply',
      data: c.transport === 'onebot11' ? { id: plan.replyTo } : { message_id: plan.replyTo },
    });
  if (c.peerType === 'group')
    for (const who of plan?.mentions || [])
      if (who !== 'all')
        message.push({
          type: c.transport === 'onebot11' ? 'at' : 'mention',
          data: c.transport === 'onebot11' ? { qq: who } : { user_id: who },
        });
  message.push({ type: 'text', data: { text } });
  if (c.transport === 'onebot11')
    for (const face of plan?.faces || []) message.push({ type: 'face', data: { id: face } });
  return c.transport === 'onebot11'
    ? {
        action: c.peerType === 'group' ? 'send_group_msg' : 'send_private_msg',
        params: {
          [c.peerType === 'group' ? 'group_id' : 'user_id']: Number(c.peerId),
          message,
          auto_escape: true,
        },
        echo,
      }
    : {
        action: 'send_message',
        self: { platform: 'wechat', user_id: c.accountId },
        params: {
          detail_type: c.peerType || 'private',
          [c.peerType === 'group' ? 'group_id' : 'user_id']: c.peerId,
          message,
        },
        echo,
      };
}

// Protocol implementation from QQ's published Ed25519 seed/signature specification.
// See https://github.com/tencent-connect/qqbot-nodejs/tree/main/src/protocol/transport
function qqKey(secret: string) {
  if (!/^[\x21-\x7e]{1,4096}$/.test(secret)) throw Error('Invalid QQ secret');
  let seed = secret;
  while (seed.length < 32) seed += secret;
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(seed.slice(0, 32)),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}
export function qqSign(secret: string, message: string) {
  return sign(null, Buffer.from(message), qqKey(secret)).toString('hex');
}
export function qqVerify(
  secret: string,
  body: Buffer,
  timestamp: string,
  signature: string,
  now = Date.now(),
) {
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000 ||
    !/^[a-f0-9]{128}$/i.test(signature)
  )
    return false;
  try {
    return verify(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      createPublicKey(qqKey(secret)),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

// Preserve who is mentioned/replied to as data, without fetching referenced messages.
function groupSegments(parts: any, account: string) {
  if (!Array.isArray(parts)) return parts;
  return parts.flatMap((p: any) => {
    if (['at', 'mention'].includes(p?.type)) {
      const target = String(p.data?.qq ?? p.data?.user_id ?? '');
      return target === account
        ? []
        : [{ type: 'text', data: { text: ' [Mention ID: ' + target + '] ' } }];
    }
    if (p?.type === 'reply')
      return [
        {
          type: 'text',
          data: {
            text: ' [Reply message ID: ' + String(p.data?.id ?? p.data?.message_id ?? '') + '] ',
          },
        },
      ];
    if (['forward', 'json', 'xml'].includes(p?.type))
      return [{ type: 'text', data: { text: richSummary([p]) } }];
    if (p?.type === 'face')
      return [
        {
          type: 'text',
          data: {
            text: ' [Platform face ID: ' + String(p.data?.id ?? p.data?.message_id ?? '') + '] ',
          },
        },
      ];
    if (!['text', 'image', 'record', 'audio', 'voice', 'video', 'file'].includes(p?.type))
      return [];
    return [p];
  });
}
function onebotMedia(parts: any, v12: boolean): { text: string; media: ChatRemoteFile[] } {
  if (
    !Array.isArray(parts) ||
    parts.some(
      (p) => !['text', 'image', 'record', 'audio', 'voice', 'video', 'file'].includes(p?.type),
    )
  )
    return { text: '', media: [] };
  const media: ChatRemoteFile[] = parts
    .filter((p) => p.type !== 'text')
    .map((p) => ({
      id: v12 ? p.data?.file_id : p.data?.file,
      url: !v12 ? p.data?.url : undefined,
      name:
        p.data?.name ||
        p.type +
          (p.type === 'image'
            ? '.jpg'
            : ['audio', 'voice', 'record'].includes(p.type)
              ? '.ogg'
              : p.type === 'video'
                ? '.mp4'
                : ''),
      kind:
        p.type === 'image'
          ? 'image'
          : p.type === 'video'
            ? 'video'
            : ['audio', 'record', 'voice'].includes(p.type)
              ? 'audio'
              : 'file',
    }));
  return { text: textSegments(parts.filter((p) => p.type === 'text')), media };
}
