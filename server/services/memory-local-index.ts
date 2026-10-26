import type { Settings } from '../../shared/types.js';
/** Only explicit built-in local execution or the configured loopback service. */
export function localMemoryEmbedding(settings: Settings['embedding']) {
  if (settings.backend === 'local') return true;
  try {
    const u = new URL(settings.baseUrl);
    return (
      !!settings.model &&
      ['http:', 'https:'].includes(u.protocol) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}
