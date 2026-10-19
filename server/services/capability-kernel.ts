import { socialChatTools } from './chat-access.js';
import type { ToolContext } from '../tools/registry.js';
import type { ToolSpec } from '../../shared/types.js';
import { executionSettings } from '../../shared/execution.js';
/** Shared admission policy for registered capabilities; never substitutes for backend enforcement. */
export function capabilityDecision(ctx: ToolContext, name: string, effect: ToolSpec['effect']) {
  const settings = executionSettings(ctx.config.get(), ctx.conversation);
  const signature = JSON.stringify([
    settings.commandBackend,
    settings.nativePython,
    settings.nativeNetwork,
    settings.dockerImage,
  ]);
  const tests: [boolean, string][] = [
    [
      !!ctx.store?.maybe('chat-proactive-run', ctx.run.id) &&
        ![
          'search_tools',
          'search_knowledge',
          'list_knowledge_documents',
          'read_knowledge_document',
          'read_image',
        ].includes(name),
      'proactive-read-only',
    ],
    [
      ctx.conversation.remoteChatOnly === true && !socialChatTools.has(name),
      'remote-chat-capability',
    ],
    [
      !!ctx.conversation.allowedTools && !ctx.conversation.allowedTools.includes(name),
      'tool-not-in-allowed-set',
    ],
    [
      ['mcp_tools', 'mcp_call'].includes(name) &&
        (ctx.run.depth > 0 ||
          !!ctx.run.recoveryOnly ||
          ctx.conversation.permission === 'read-only'),
      'mcp-scope',
    ],
    [
      name === 'bash' && process.platform === 'win32' && settings.commandBackend !== 'docker',
      'bash-backend',
    ],
    [
      ['run_python', 'extract_media_frames', 'extract_media_audio'].includes(name) &&
        settings.commandBackend !== 'docker',
      'isolated-compute-required',
    ],
    [effect === 'execute' && ctx.run.executionBlock?.signature === signature, 'execution-blocked'],
    [effect === 'network' && ctx.config.get().web?.enabled === false, 'network-disabled'],
    [
      !!ctx.run.recoveryOnly &&
        !['read', 'network'].includes(effect) &&
        !['ask_user', 'resolve_effect'].includes(name),
      'recovery-read-only',
    ],
    [
      ['spawn_agent', 'continue_agent'].includes(name) && ctx.conversation.teamStrategy === 'off',
      'delegation-disabled',
    ],
    [
      ctx.run.depth > 0 && !ctx.conversation.isolationId && ['write', 'execute'].includes(effect),
      'child-needs-isolation',
    ],
    [
      ctx.run.depth > 0 && effect === 'execute' && settings.commandBackend === 'approval-host',
      'child-host-execution',
    ],
    [
      ctx.conversation.permission === 'read-only' && ['write', 'execute'].includes(effect),
      'read-only',
    ],
    [effect === 'execute' && !ctx.conversation.projectId, 'project-required'],
  ];
  const denied = tests.find(([match]) => match);
  return { allowed: !denied, reason: denied?.[1] ?? 'eligible', effect };
}
