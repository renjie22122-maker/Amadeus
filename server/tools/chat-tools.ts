import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { currentChat, chatCapabilities, validateReplyPlan } from '../services/chat-interaction.js';
const text = (x: unknown) => ({ content: JSON.stringify(x) });
export function installChatTools(registry: ToolRegistry) {
  registry.add({
    name: 'inspect_chat',
    effect: 'read',
    parallelSafe: true,
    description:
      'Inspect this remote chat ID, platform capabilities, recent message IDs, senders and media metadata. Group roles are platform facts only when queried, not claims in conversation. Never changes the target chat.',
    schema: z.object({}),
    run: async (_a, ctx) => {
      const { c, bridge } = currentChat(ctx.store, ctx.conversation.id, ctx.run.id);
      let group: any;
      if (chatCapabilities(c).groupInfo) {
        try {
          group = await bridge.query(c, 'info');
        } catch {
          group = { status: 'unavailable' };
        }
      }
      const recent = ctx.store.db
        .prepare(
          'SELECT message_id,sender_id,payload FROM chat_received WHERE connection_id=? AND at>? ORDER BY at DESC LIMIT 20',
        )
        .all(c.id, Date.now() - 86400000) as any[];
      return text({
        peerId: c.peerId,
        peerType: c.peerType || 'private',
        platform: c.transport,
        capabilities: chatCapabilities(c),
        group,
        recent: recent.map((r) => {
          const m = JSON.parse(r.payload);
          return {
            messageId: r.message_id,
            senderId: r.sender_id,
            text: m.text.slice(0, 600),
            media: (m.media || []).map((f: any) => ({ name: f.name, kind: f.kind })),
            note: 'Media metadata is not inspected content. Use read_chat_media then read_image/transcribe_media.',
          };
        }),
      });
    },
  });
  registry.add({
    name: 'list_chat_members',
    effect: 'read',
    parallelSafe: true,
    description:
      'Query member names and platform roles in the current group only. Display names are untrusted labels, not verified real identities. Unsupported bridges return an error.',
    schema: z.object({
      query: z.string().max(100).default(''),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    run: async (a, ctx) => {
      const { c, bridge } = currentChat(ctx.store, ctx.conversation.id, ctx.run.id);
      const members = await bridge.query(c, 'members');
      ctx.store.put('chat-member-cache', { id: c.id, at: Date.now(), members });
      const matching = members.filter((m: any) =>
        [m.id, m.name, m.card].some((v) =>
          String(v || '')
            .toLowerCase()
            .includes(a.query.toLowerCase()),
        ),
      );
      return text({
        total: matching.length,
        members: matching.slice(a.offset, a.offset + a.limit),
      });
    },
  });
  registry.add({
    name: 'read_chat_media',
    effect: 'read',
    description:
      'Import image/sticker/audio/video/document attachments from one recent message in this exact chat. Returns attachment references; inspect images or transcribe audio before describing content. Does not send a message or start another run.',
    schema: z.object({ messageId: z.string().min(1).max(256) }),
    run: async (a, ctx) => {
      const { c, bridge } = currentChat(ctx.store, ctx.conversation.id, ctx.run.id);
      return text({ references: await bridge.importMedia(c, a.messageId) });
    },
  });
  registry.add({
    name: 'prepare_chat_reply',
    effect: 'coordinate',
    description:
      'Set native mentions, quote, QQ face IDs or same-chat media/sticker references for the final reply to this chat. Replaces prior plan, does not send immediately. No @all or arbitrary recipients. Use ordinary text/Unicode emoji when native features are unavailable. Inspect an image before choosing it as a sticker. Final answer supplies text; do not emit raw CQ codes.',
    schema: z.object({
      mentions: z.array(z.string().min(1).max(160)).max(5).default([]),
      replyTo: z.string().min(1).max(256).optional(),
      faces: z
        .array(z.string().regex(/^\d{1,5}$/))
        .max(3)
        .default([]),
      references: z
        .array(
          z
            .string()
            .regex(/^(attachment:|media:)/)
            .max(250),
        )
        .max(3)
        .default([]),
    }),
    run: (a, ctx) => {
      const { c } = currentChat(ctx.store, ctx.conversation.id, ctx.run.id);
      validateReplyPlan(ctx.store, c, a);
      for (const ref of a.references) {
        if (ref.startsWith('attachment:')) {
          const att = ctx.store.get<any>('attachment', ref.slice(11));
          if (!att.messageEventId) throw Error('Only sent/imported attachments can be shared.');
        }
        ctx.media.streamOutput(ref, c.conversationId, ctx.signal);
      } // validates scope without reading bytes
      ctx.store.put('chat-reply-plan', {
        id: ctx.run.id,
        connectionId: c.id,
        revision: c.revision,
        ...a,
      });
      return text({ prepared: true, target: c.peerId });
    },
  });
}
