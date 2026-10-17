import type { Conversation, Profile } from '../../shared/types.js';
import { assert } from '../core/errors.js';

export function delegationModels(conversation: Conversation, profiles: Profile[]) {
  const policy = conversation.subagentModels;
  const allowed = new Set([
    conversation.profileId,
    ...(policy?.allowedProfileIds || []),
    ...(policy?.defaultProfileId ? [policy.defaultProfileId] : []),
  ]);
  return profiles
    .filter((p) => allowed.has(p.id))
    .map(({ id, name, model, transport }) => ({ id, name, model, transport }));
}
export function selectDelegationModel(
  conversation: Conversation,
  profiles: Profile[],
  requested?: string,
) {
  const id = requested ?? conversation.subagentModels?.defaultProfileId ?? conversation.profileId;
  assert(
    delegationModels(conversation, profiles).some((p) => p.id === id),
    'DELEGATION_MODEL',
    'Model connection is missing or not allowed for subagents in this conversation. Configure the model selection first; no fallback request was sent.',
  );
  return {
    profileId: id,
    reasoning: id === conversation.profileId ? conversation.reasoning : ('auto' as const),
  };
}
