// Explicit opt-in smoke check; never writes application settings or enables a server.
import { resolve } from 'node:path';
import { mcpExamples } from '../shared/mcp-examples.js';
import type { Settings } from '../shared/types.js';
import { McpHub } from '../server/services/mcp.js';
const name = process.argv[2];
const example = mcpExamples.find((e) => e.name.toLowerCase() === name?.toLowerCase());
const probes: Record<string, { tool: string; args: Record<string, unknown> }> = {
  Fetch: { tool: 'fetch', args: { url: 'https://example.com', max_length: 1000 } },
  Git: { tool: 'git_status', args: { repo_path: resolve('.') } },
  Filesystem: { tool: 'list_allowed_directories', args: {} },
  Playwright: { tool: 'browser_tabs', args: { action: 'list' } },
  'Chrome DevTools': { tool: 'list_pages', args: {} },
};
if (!example || !probes[example.name])
  throw new Error(
    'Choose Fetch, Git, Filesystem, Playwright or "Chrome DevTools"; optional --pnpm uses pnpm dlx instead of npx.',
  );
const server: Settings['mcp'][number] = {
  ...structuredClone(example.config),
  id: 'smoke',
  name: example.name,
  enabled: true,
  startupTimeoutSeconds: 120,
};
server.args = server.args.map((a) => (a.startsWith('/ABSOLUTE/') ? resolve('.') : a));
if (process.argv.includes('--pnpm') && server.command === 'npx') {
  server.command = 'pnpm';
  server.args = ['dlx', ...server.args.filter((a) => a !== '-y')];
}
const hub = new McpHub();
try {
  const tools = await hub.list(server, 'smoke');
  const { tool, args } = probes[example.name];
  const result = await hub.call(server, tool, args, new AbortController().signal, 'smoke');
  if (result.isError)
    throw new Error('External MCP returned a tool error: ' + JSON.stringify(result));
  console.log(
    JSON.stringify({
      server: example.name,
      tools: tools.map((t) => t.name),
      executed: tool,
      successful: true,
      resultCharacters: JSON.stringify(result).length,
    }),
  );
} finally {
  await hub.close();
}
