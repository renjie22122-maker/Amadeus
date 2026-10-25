import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../core/runtime.js';
import { assert } from '../core/errors.js';
export function mcpRoutes(app: FastifyInstance, runtime: Runtime) {
  app.get<{ Params: { conversationId: string; jobId: string } }>(
    '/api/mcp/jobs/:conversationId/:jobId',
    async (req) => runtime.mcp.jobs!.get(req.params.conversationId, req.params.jobId),
  );
  app.post<{ Params: { conversationId: string; jobId: string } }>(
    '/api/mcp/jobs/:conversationId/:jobId/cancel',
    async (req) => runtime.mcp.jobs!.cancel(req.params.conversationId, req.params.jobId),
  );
  const server = (id: string) => {
    const value = runtime.config.get().mcp.find((s) => s.id === id);
    assert(value, 'MCP_SERVER', 'MCP server not found.');
    assert(runtime.mcp.oauth, 'MCP_OAUTH', 'OAuth service unavailable.');
    return value;
  };
  app.get<{ Params: { id: string } }>('/api/mcp/:id/oauth', async (req) => ({
    ...runtime.mcp.oauth!.status(server(req.params.id)),
    callbackUrl: `http://${req.headers.host}/mcp/oauth/callback`,
  }));
  app.post<{ Params: { id: string } }>('/api/mcp/:id/oauth/login', async (req) => {
    const configured = server(req.params.id);
    return runtime.mcp.oauth!.start(configured, `http://${req.headers.host}/mcp/oauth/callback`);
  });
  app.post<{ Params: { id: string } }>('/api/mcp/:id/oauth/logout', async (req) => {
    runtime.mcp.oauth!.logout(server(req.params.id));
    await runtime.mcp.closeServer(req.params.id);
    return { signedIn: false };
  });
  // OAuth state authenticates this callback; no app cookie or CSRF token travels to the provider.
  app.get('/mcp/oauth/callback', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'none'");
    try {
      const id = await runtime.mcp.oauth!.finish(
        new URL(req.url, 'http://localhost').searchParams,
        (id) => runtime.config.get().mcp.find((s) => s.id === id),
      );
      await runtime.mcp.closeServer(id);
      return reply.type('text/plain').send('MCP sign-in completed. Return to Amadeus.');
    } catch {
      return reply
        .code(400)
        .type('text/plain')
        .send('MCP sign-in failed or expired. Return to Amadeus and start a new login.');
    }
  });
}
