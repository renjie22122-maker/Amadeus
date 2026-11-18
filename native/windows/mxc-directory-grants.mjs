import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { lstatSync } from 'node:fs';

// Keep each directory component in place while MXC consumes a path-based grant.
// The broker owns the handles. Windows releases them if the broker exits.
export async function withPinnedDirectories(koffi, paths, action) {
  const kernel = koffi.load('kernel32.dll');
  const open = kernel.func(
    'intptr_t __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, intptr_t)',
  );
  const close = kernel.func('int __stdcall CloseHandle(intptr_t)');
  const attributes = kernel.func('uint32_t __stdcall GetFileAttributesW(str16)');
  const handles = [];
  const seen = new Set();
  try {
    for (const input of paths) {
      if (!isAbsolute(input) || !/^[a-z]:[\\/]/i.test(input))
        throw Error('A local absolute directory is required');
      const path = resolve(input);
      const parts = [];
      for (let p = path; p !== parse(p).root; p = dirname(p)) parts.unshift(p);
      if (!parts.length) throw Error('Volume-root grants are unsupported');
      for (const part of parts) {
        const key = part;
        if (seen.has(key)) continue;
        // FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES, share read/write (no delete), OPEN_EXISTING,
        // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
        const h = open(part, 0x81, 3, null, 3, 0x02200000, 0);
        if (BigInt(h) === -1n) throw Error('Failed to pin an authorized directory');
        handles.push(h);
        const info = lstatSync(part);
        const flags = attributes(part);
        if (flags === 0xffffffff || flags & 0x400 || !info.isDirectory() || info.isSymbolicLink())
          throw Error('Unsupported directory component');
        seen.add(key);
      }
    }
    return await action();
  } finally {
    for (const handle of handles.reverse()) close(handle);
  }
}
