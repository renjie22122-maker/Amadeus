import { secureDirectory } from './services/private-file.js';
import { lockService } from './services/service-lock.js';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './http/app.js';
const root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  import.meta.url.endsWith('.ts') ? '..' : '../..',
);
secureDirectory(process.env.AGENTDEMO_DATA_DIR || join(root, '.data'));
const release = lockService(process.env.AGENTDEMO_DATA_DIR || join(root, '.data'));
process.on('exit', release);
const { app } = await createApp({
  directory: process.env.AGENTDEMO_DATA_DIR || join(root, '.data'),
  dist: join(root, 'dist'),
});
const port = Number(process.env.PORT || 8810);
const address = await app.listen({ host: '127.0.0.1', port });
console.log('Amadeus is ready at ' + address);
process.send?.({ type: 'amadeus:ready', url: address });
let closing: Promise<void> | undefined;
function shutdown() {
  closing ||= app.close().then(() => {
    process.exit(0);
  });
  return closing;
}
// Only the owning parent process has this IPC channel; no HTTP shutdown endpoint.
if (process.send) {
  process.on('message', (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'amadeus:shutdown'
    )
      void shutdown();
  });
  process.on('disconnect', () => void shutdown());
  if (!process.connected) void shutdown();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
