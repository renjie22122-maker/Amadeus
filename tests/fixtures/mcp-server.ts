import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
await server.connect(new StdioServerTransport());
