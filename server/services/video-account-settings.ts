import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { videoConfigSchema } from './video-reader.js';
import { assert } from '../core/errors.js';

const scope = z
  .object({
    allowLocalConversations: z.boolean(),
    privateChatTransports: z.array(z.string().min(1).max(40)).max(100),
    conversationIds: z.array(z.string().min(1).max(200)).max(10000),
  })
  .strict();
const update = z
  .object({ revision: z.string(), platform: z.enum(['bilibili', 'youtube']), scope })
  .strict();
// Scope-only API: credentials and executable paths never enter browser responses.
export function createVideoAccountSettings(directory: string) {
  const path = join(directory, 'video-reader.json');
  let queue: Promise<unknown> = Promise.resolve();
  async function load() {
    let raw = '{}';
    try {
      raw = await readFile(path, 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    return {
      config: videoConfigSchema.parse(JSON.parse(raw)),
      revision: createHash('sha256').update(raw).digest('hex'),
    };
  }
  function view(data: Awaited<ReturnType<typeof load>>) {
    return {
      revision: data.revision,
      accounts: Object.entries(data.config.accounts || {}).map(([platform, account]) => ({
        platform,
        configured: Boolean(account.cookiesFile),
        allowLocalConversations: account.allowLocalConversations,
        privateChatTransports: account.privateChatTransports,
        conversationIds: account.conversationIds,
      })),
    };
  }
  return {
    read: async () => view(await load()),
    save: (body: unknown) => {
      const task = queue.then(async () => {
        const input = update.parse(body),
          data = await load();
        assert(
          data.revision === input.revision,
          'CONFIG_CHANGED',
          'Video account settings changed; refresh before saving.',
          409,
        );
        const account = data.config.accounts?.[input.platform];
        assert(
          account,
          'VIDEO_ACCOUNT',
          'Configure a local account file before changing its scope.',
          400,
        );
        Object.assign(account, input.scope, {
          conversationIds: [...new Set(input.scope.conversationIds)],
          privateChatTransports: [...new Set(input.scope.privateChatTransports)],
        });
        const temporary = path + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temporary, JSON.stringify(data.config, null, 2) + '\n', { mode: 0o600 });
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
        return view(await load());
      });
      queue = task.catch(() => {});
      return task;
    },
  };
}
