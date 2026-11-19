import { readFileSync } from 'node:fs';
export function buildIdentity() {
  try {
    const m = JSON.parse(readFileSync(new URL('../build-info.json', import.meta.url), 'utf8'));
    if (typeof m.version === 'string')
      return {
        version: m.version,
        commit:
          typeof m.commit === 'string' && /^[0-9a-f]{40,64}$/.test(m.commit) ? m.commit : null,
        dirty: typeof m.dirty === 'boolean' ? m.dirty : null,
        builtAt: m.builtAt ?? null,
      };
  } catch {
    /* dev checkout or a legacy distribution */
  }
  for (const path of ['../../package.json', '../../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
      if (pkg.name === 'amadeus')
        return { version: String(pkg.version), commit: null, dirty: null, builtAt: null };
    } catch {
      /* next package location */
    }
  }
  return { version: 'unknown', commit: null, dirty: null, builtAt: null };
}
