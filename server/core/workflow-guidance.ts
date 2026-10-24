import type { ModelMessage, ToolSpec } from '../../shared/types.js';
import type { ToolContext } from '../tools/registry.js';
import { rootRun } from '../services/task-board.js';
import { TEAM_PROTOCOL } from './prompts.js';

// Load procedure from actual workflow state/discovery, never user-text keywords.
export function workflowGuidance(ctx: ToolContext, tools: ToolSpec[]): ModelMessage | undefined {
  const available = new Set(tools.map((t) => t.name));
  if (
    ctx.conversation.teamStrategy === 'off' ||
    (!available.has('configure_team') && !available.has('inspect_team'))
  )
    return;
  const selected = ctx.store.maybe<{ names: string[] }>('tool-selection', ctx.run.id)?.names || [];
  const active = ctx.store.maybe('team-space', rootRun(ctx.store, ctx.run));
  const explicit = ['host', 'creative'].includes(ctx.conversation.teamMode || 'auto');
  const discovered = selected.some(
    (name) =>
      available.has(name) &&
      (name === 'configure_team' || name === 'inspect_team' || name.includes('_team_')),
  );
  if (!active && !explicit && !discovered) return;
  return { role: 'system', contextKind: 'workflow-guidance', content: TEAM_PROTOCOL };
}

export function refreshWorkflowGuidance(ctx: ToolContext, tools: ToolSpec[]) {
  const message = workflowGuidance(ctx, tools);
  if (
    !message ||
    ctx.run.checkpoints.findLast((m) => m.contextKind === 'workflow-guidance')?.content ===
      message.content
  )
    return;
  ctx.run.checkpoints.push(message);
  ctx.store.event(ctx.run.conversationId, ctx.run.id, 'context.guidance_loaded', {
    workflow: 'team',
    characters: message.content.length,
  });
}
