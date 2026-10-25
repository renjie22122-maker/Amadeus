import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'AgentDemo test fixture', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Echo fixture', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }] }),
);
server.registerTool('environment_fixture', { inputSchema: {} }, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        mapped: process.env.MCP_MAPPED_TEST,
        unrelated: process.env.AMADEUS_MCP_UNRELATED_TEST,
      }),
    },
  ],
}));
server.registerResource('guide', 'fixture://guide', { mimeType: 'text/plain' }, async (uri) => ({
  contents: [{ uri: uri.href, text: 'Untrusted fixture guide', mimeType: 'text/plain' }],
}));
server.registerResource(
  'named',
  new ResourceTemplate('fixture://named/{name}', { list: undefined }),
  {},
  async (uri, variables) => ({ contents: [{ uri: uri.href, text: String(variables.name) }] }),
);
server.registerPrompt('review', { argsSchema: { topic: z.string() } }, async ({ topic }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `Review ${topic}` } }],
}));
await server.connect(new StdioServerTransport());
