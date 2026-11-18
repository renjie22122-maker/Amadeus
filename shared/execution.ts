import type { Conversation, Settings } from './types.js';
export function executionSettings(
  settings: Settings,
  conversation: Pick<Conversation, 'execution'>,
): Settings {
  const choice = conversation.execution;
  return choice
    ? {
        ...settings,
        commandBackend: choice.backend,
        nativeNetwork:
          choice.backend === 'docker' || choice.backend === 'mxc'
            ? 'deny'
            : choice.backend === 'approval-host'
              ? 'host'
              : choice.network,
      }
    : settings;
}
