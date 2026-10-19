import type { Settings } from '../../shared/types.js';
export function extractionProfile(settings: Settings, explicit?: string) {
  if (explicit !== undefined) {
    const p = settings.profiles.find((p) => p.id === explicit);
    if (!p) throw Error('Unknown extraction connection: ' + explicit);
    if (p.transport !== 'openai-chat')
      throw Error('Extraction requires an OpenAI-compatible chat connection.');
    return p;
  }
  const compatible = settings.profiles.filter((p) => p.transport === 'openai-chat');
  return (
    compatible.find((p) => p.id === settings.defaultProfileId) ||
    (compatible.length === 1 ? compatible[0] : undefined)
  );
}
