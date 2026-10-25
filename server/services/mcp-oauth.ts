import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Settings } from '../../shared/types.js';
import { assert } from '../core/errors.js';
import { writePrivate } from './private-file.js';
import { windowsSecrets, type SecretCodec } from './credential-storage.js';

type Server = Settings['mcp'][number];
type Saved = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  redirect: string;
  loginId?: string;
};
type Flow = {
  server: Server;
  fingerprint: string;
  state: string;
  revision: number;
  verifier?: string;
  authorizationUrl?: string;
  expires: number;
  provider: OAuthClientProvider;
  saved: Saved;
};
/** UI owns interactive login. Tool calls may refresh credentials, but never initiate consent. */
export class McpOAuth {
  private flows = new Map<string, Flow>();
  private cache = new Map<string, Saved>();
  private revisions = new Map<string, number>();
  constructor(
    private directory: string,
    private codec: SecretCodec | undefined = process.platform === 'win32'
      ? windowsSecrets
      : undefined,
  ) {}
  private key(server: Server) {
    return createHash('sha256')
      .update(JSON.stringify([server.id, server.url, server.oauth]))
      .digest('hex');
  }
  private path(server: Server) {
    return join(this.directory, this.key(server) + '.json');
  }
  private load(server: Server): Saved | undefined {
    const key = this.key(server);
    if (this.cache.has(key)) return this.cache.get(key);
    if (!existsSync(this.path(server))) return;
    const envelope = JSON.parse(readFileSync(this.path(server), 'utf8'));
    assert(
      !envelope.encrypted || this.codec,
      'MCP_OAUTH_STORAGE',
      'OAuth credentials require their original operating-system account.',
    );
    const saved = JSON.parse(
      envelope.encrypted ? this.codec!.open(envelope.value) : envelope.value,
    ) as Saved;
    this.cache.set(key, saved);
    return saved;
  }
  private save(server: Server, saved: Saved) {
    const value = JSON.stringify(saved);
    const path = this.path(server),
      temporary = path + '.tmp';
    writePrivate(
      temporary,
      JSON.stringify({
        encrypted: !!this.codec,
        value: this.codec ? this.codec.seal(value) : value,
      }),
    );
    renameSync(temporary, path);
    this.cache.set(this.key(server), saved);
  }
  readonly fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert(
      !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))),
      'MCP_OAUTH_URL',
      'OAuth requires HTTPS or loopback HTTP.',
    );
    return fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(20000), ...(init?.signal ? [init.signal] : [])]),
    });
  };
  private provider(server: Server, saved: Saved, flow?: Flow): OAuthClientProvider {
    const revision = this.revisions.get(this.key(server)) || 0;
    const persist = () => {
      assert(
        (this.revisions.get(this.key(server)) || 0) === revision,
        'MCP_OAUTH_REVOKED',
        'Login changed during authentication.',
      );
      if (!flow) this.save(server, saved);
    };
    return {
      redirectUrl: saved.redirect,
      clientMetadata: {
        client_name: 'Amadeus',
        redirect_uris: [saved.redirect],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: server.oauth?.clientSecretEnv ? 'client_secret_post' : 'none',
        scope: server.oauth?.scopes?.join(' '),
      },
      state: () => {
        assert(flow, 'MCP_OAUTH_LOGIN', 'Sign in through MCP settings.');
        return flow.state;
      },
      clientInformation: () => {
        if (server.oauth?.clientId) {
          const secret = server.oauth.clientSecretEnv
            ? process.env[server.oauth.clientSecretEnv]
            : undefined;
          assert(
            !server.oauth.clientSecretEnv || secret,
            'MCP_OAUTH_ENV',
            'OAuth client secret environment variable is missing.',
          );
          return {
            client_id: server.oauth.clientId,
            client_secret: secret,
            issuer: server.oauth.issuer,
          };
        }
        return saved.client;
      },
      saveClientInformation: (client) => {
        saved.client = client;
        persist();
      },
      tokens: () => {
        assert(
          (this.revisions.get(this.key(server)) || 0) === revision,
          'MCP_OAUTH_REVOKED',
          'Sign-in changed; reconnect the MCP server.',
        );
        return saved.tokens;
      },
      saveTokens: (tokens) => {
        saved.tokens = tokens;
        persist();
      },
      saveCodeVerifier: (verifier) => {
        assert(flow, 'MCP_OAUTH_LOGIN', 'Sign in through MCP settings.');
        flow.verifier = verifier;
      },
      codeVerifier: () => {
        assert(flow?.verifier, 'MCP_OAUTH_STATE', 'Login session expired.');
        return flow.verifier;
      },
      redirectToAuthorization: (url) => {
        assert(flow, 'MCP_OAUTH_LOGIN', 'Sign in through MCP settings.');
        assert(
          url.protocol === 'https:' ||
            (url.protocol === 'http:' &&
              ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)),
          'MCP_OAUTH_URL',
          'Unsafe authorization URL.',
        );
        flow.authorizationUrl = url.toString();
      },
      discoveryState: () => saved.discovery,
      saveDiscoveryState: (discovery) => {
        const issuer = discovery.authorizationServerMetadata?.issuer;
        assert(
          !issuer || issuer === discovery.authorizationServerUrl,
          'MCP_OAUTH_ISSUER',
          'OAuth metadata issuer mismatch.',
        );
        assert(
          !server.oauth?.issuer || server.oauth.issuer === discovery.authorizationServerUrl,
          'MCP_OAUTH_ISSUER',
          'OAuth issuer differs from registered client.',
        );
        saved.discovery = discovery;
        persist();
      },
      invalidateCredentials: (scope) => {
        if (scope === 'all' || scope === 'tokens') delete saved.tokens;
        if (scope === 'all' || scope === 'client') delete saved.client;
        if (scope === 'all' || scope === 'discovery') delete saved.discovery;
        if (flow && (scope === 'all' || scope === 'verifier')) delete flow.verifier;
        persist();
      },
    };
  }
  forConnection(server: Server) {
    if (!server.oauth?.enabled) return undefined;
    const saved = this.load(server);
    assert(saved?.tokens, 'MCP_OAUTH_LOGIN', 'Sign in through MCP settings before connecting.');
    return this.provider(server, saved);
  }
  recoveryIdentity(server: Server) {
    const saved = this.load(server);
    assert(
      saved?.tokens && saved.loginId,
      'MCP_OAUTH_IDENTITY',
      'Sign in before creating recoverable tasks.',
    );
    return saved.loginId;
  }
  status(server: Server) {
    return {
      configured: !!server.oauth?.enabled,
      signedIn: !!this.load(server)?.tokens,
      pending: [...this.flows.values()].some(
        (f) => f.server.id === server.id && f.expires > Date.now(),
      ),
    };
  }
  async start(server: Server, redirect: string) {
    assert(
      server.enabled && server.transport === 'http' && server.oauth?.enabled,
      'MCP_OAUTH_CONFIG',
      'Save and enable an HTTP OAuth server first.',
    );
    for (const [key, f] of this.flows)
      if (f.server.id === server.id || f.expires < Date.now()) this.flows.delete(key);
    assert(this.flows.size < 16, 'MCP_OAUTH_BUSY', 'Too many pending logins.');
    const saved: Saved = { ...structuredClone(this.load(server) || {}), redirect };
    delete saved.tokens;
    // DCR redirect registrations are bound to the local app address.
    if (this.load(server)?.redirect !== redirect) delete saved.client;
    const revision = (this.revisions.get(this.key(server)) || 0) + 1;
    this.revisions.set(this.key(server), revision);
    const flow = {
      server: structuredClone(server),
      fingerprint: JSON.stringify(server),
      revision,
      state: randomBytes(32).toString('hex'),
      expires: Date.now() + 10 * 60000,
      saved,
    } as Flow;
    flow.provider = this.provider(server, saved, flow);
    this.flows.set(flow.state, flow);
    try {
      await auth(flow.provider, {
        serverUrl: server.url!,
        scope: server.oauth.scopes?.join(' '),
        fetchFn: this.fetch,
      });
      assert(
        flow.authorizationUrl,
        'MCP_OAUTH_REDIRECT',
        'Provider did not offer an authorization URL.',
      );
      return { authorizationUrl: flow.authorizationUrl, expiresAt: flow.expires };
    } catch {
      this.flows.delete(flow.state);
      throw new Error(
        'OAuth login could not start. Check provider registration, scopes and endpoint.',
      );
    }
  }
  async finish(params: URLSearchParams, current: (id: string) => Server | undefined) {
    const state = params.get('state') || '',
      flow = this.flows.get(state);
    assert(flow && flow.expires > Date.now(), 'MCP_OAUTH_STATE', 'Invalid or expired login state.');
    this.flows.delete(state); // Single use even when the provider denies access.
    assert(
      JSON.stringify(current(flow.server.id)) === flow.fingerprint,
      'MCP_CHANGED',
      'MCP settings changed during login.',
    );
    assert(
      !params.has('error') && params.get('code'),
      'MCP_OAUTH_DENIED',
      'Authorization was denied or returned no code.',
    );
    const metadata = flow.saved.discovery?.authorizationServerMetadata;
    const issuer = params.get('iss');
    assert(
      (!issuer || issuer === metadata?.issuer) &&
        (!(metadata as any)?.authorization_response_iss_parameter_supported || !!issuer),
      'MCP_OAUTH_ISSUER',
      'Authorization issuer does not match discovery.',
    );
    try {
      await auth(flow.provider, {
        serverUrl: flow.server.url!,
        authorizationCode: params.get('code')!,
        fetchFn: this.fetch,
      });
      assert(
        JSON.stringify(current(flow.server.id)) === flow.fingerprint &&
          flow.saved.tokens &&
          flow.expires > Date.now() &&
          this.revisions.get(this.key(flow.server)) === flow.revision,
        'MCP_CHANGED',
        'MCP settings changed during login.',
      );
      flow.saved.loginId = randomBytes(32).toString('hex');
      this.save(flow.server, flow.saved);
    } catch {
      throw new Error('OAuth token exchange failed. Start a new login.');
    }
    return flow.server.id;
  }
  logout(server: Server) {
    const saved = this.load(server);
    if (saved) delete saved.tokens;
    this.revisions.set(this.key(server), (this.revisions.get(this.key(server)) || 0) + 1);
    for (const [key, flow] of this.flows) if (flow.server.id === server.id) this.flows.delete(key);
    this.cache.delete(this.key(server));
    if (existsSync(this.path(server))) unlinkSync(this.path(server));
  }
}
