import type { Settings } from './types.js';
type Example = {
  name: string;
  source: string;
  note: string;
  config: Omit<Settings['mcp'][number], 'id' | 'enabled' | 'name'>;
};
/** Data-only examples. All use the same client and approval path; never auto-enable. */
export const mcpExamples: Example[] = [
  {
    name: 'GitHub',
    source: 'https://github.com/github/github-mcp-server',
    note: 'GITHUB_MCP_TOKEN',
    config: {
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      bearerTokenEnv: 'GITHUB_MCP_TOKEN',
      command: '',
      args: [],
    },
  },
  {
    name: 'Playwright',
    source: 'https://github.com/microsoft/playwright-mcp',
    note: 'Node.js / Chrome',
    config: {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.83', '--isolated', '--headless'],
      capability: 'browser',
    },
  },
  {
    name: 'Filesystem',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    note: 'Replace /ABSOLUTE/ALLOWED/DIRECTORY',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2.0.1', '/ABSOLUTE/ALLOWED/DIRECTORY'],
    },
  },
  {
    name: 'Git',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    note: 'uvx / Git; replace /ABSOLUTE/REPOSITORY',
    config: {
      command: 'uvx',
      args: ['mcp-server-git==2026.10.19', '--repository', '/ABSOLUTE/REPOSITORY'],
    },
  },
  {
    name: 'Chrome DevTools',
    source: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    note: 'Node.js / Chrome',
    config: {
      command: 'npx',
      args: [
        '-y',
        'chrome-devtools-mcp@1.12.0',
        '--isolated',
        '--headless',
        '--no-usage-statistics',
      ],
      capability: 'browser',
    },
  },
  {
    name: 'Sentry',
    source: 'https://mcp.sentry.dev/',
    note: 'OAuth',
    config: {
      command: '',
      args: [],
      transport: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      oauth: { enabled: true },
    },
  },
  {
    name: 'Brave Search',
    source: 'https://github.com/brave/brave-search-mcp-server',
    note: 'BRAVE_API_KEY',
    config: {
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server@2.1.4', '--transport', 'stdio'],
      envFromHost: { BRAVE_API_KEY: 'BRAVE_API_KEY' },
    },
  },
  {
    name: 'Fetch',
    source: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    note: 'uvx / Python',
    config: { command: 'uvx', args: ['mcp-server-fetch==2026.10.24'] },
  },
];
