/** Credentials belong in host environment variables, never endpoint URLs. */
export function validMcpHeader(name: string): boolean {
  return (
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) &&
    ![
      'host',
      'content-length',
      'transfer-encoding',
      'connection',
      'accept',
      'content-type',
    ].includes(name.toLowerCase()) &&
    !name.toLowerCase().startsWith('mcp-')
  );
}

export function validMcpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
