/** Inspect structured credential fields separately from ordinary metadata names. */
export function chatApprovalContainsCredentials(value: unknown): boolean {
  if (typeof value === 'string')
    return /(?:api[_-]?key|access[_-]?token|authorization|password|secret|bearer\s|BEGIN .*PRIVATE KEY)/i.test(
      value,
    );
  if (Array.isArray(value)) return value.some(chatApprovalContainsCredentials);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    const field = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const credential =
      /(?:apikey|accesskey|accesstoken|refreshtoken|authorization|password|passwd|passphrase|secret|privatekey|cookie|credentials)/.test(
        field,
      );
    if (credential && item != null && item !== '' && typeof item !== 'boolean') return true;
    return chatApprovalContainsCredentials(item);
  });
}
