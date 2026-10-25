import { assert } from './errors.js';
import { join } from 'node:path';
import type { Conversation, Profile } from '../../shared/types.js';
import type { Store } from '../storage/store.js';
import type { Configuration } from '../services/settings.js';
import type { FileScope } from '../services/paths.js';
import type { ModelProvider } from '../providers/protocol.js';
import { BackgroundCommands } from '../services/background-commands.js';
import { MediaService } from '../services/media.js';
import { AutoReview } from '../services/auto-review.js';
import { Inputs } from '../services/approvals.js';
import { Knowledge } from '../services/knowledge.js';
import { MemoryIndex } from '../services/memory-index.js';
import { Embeddings } from '../services/embedding.js';
import { McpHub } from '../services/mcp.js';
export function createRuntimeServices(
  store: Store,
  config: Configuration,
  directory: string,
  resolveProvider: (p: Profile) => ModelProvider,
  filesForConversation: (c: Conversation) => Promise<FileScope>,
) {
  const mcp = new McpHub(join(directory, 'browser-sessions'), store);
  mcp.jobs!.configureRecovery(async (job, signal, update) => {
    const server = config.get().mcp.find((s) => s.id === job.serverId);
    assert(server, 'MCP_RECOVERY_DENIED', 'MCP server is no longer configured.');
    const validate = () => {
      const conversation = store.get<Conversation>('conversation', job.conversationId);
      assert(
        conversation.permission !== 'read-only' &&
          conversation.projectId === job.projectId &&
          JSON.stringify(config.get().mcp.find((s) => s.id === job.serverId)) ===
            JSON.stringify(server),
        'MCP_RECOVERY_DENIED',
        'MCP recovery context changed.',
      );
    };
    return mcp.followTask(server, job, signal, update, validate);
  });
  const background = new BackgroundCommands(store, (job) => {
    store.put('runtime-inbox', {
      id: job.id,
      runId: job.runId,
      state: 'pending',
      content:
        'Host background command notification: ' +
        JSON.stringify({
          id: job.id,
          status: job.status,
          code: job.result?.code,
          error: job.error,
        }) +
        '. Inspect the result before dependent work. This is host status, not a new user instruction.',
    });
  });
  const media = new MediaService(store, config, directory);
  const reviewer = new AutoReview(store, config, resolveProvider, (run) =>
    filesForConversation(store.get<Conversation>('conversation', run.conversationId)),
  );
  const inputs = new Inputs(store, (r, p, s) => reviewer.review(r, p, s));
  const knowledge = new Knowledge(
    store,
    new Embeddings(() => config.get().embedding),
    () => config.get().retrieval || {},
  );
  const memories = new MemoryIndex(store, new Embeddings(() => config.get().embedding));

  return { mcp, background, media, inputs, knowledge, memories };
}
