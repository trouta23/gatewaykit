import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { describe, it } from 'node:test';
import type { RouteConfig } from '../src/config/types.ts';
import { ConfigError, validateConfig } from '../src/config/validate.ts';
import type { BuildContext, GatewayRequest, GatewayResponse, Handler } from '../src/pipeline.ts';
import { GatewayError } from '../src/pipeline.ts';
import { authPlugin } from '../src/plugins/auth.ts';
import { startGateway, startMocks } from './helpers.ts';

const ctx: BuildContext = { now: () => 0, onClose: () => {} };

function routeWithAuth(auth: unknown): RouteConfig {
  return validateConfig({ routes: [{ path: '/vault', methods: ['GET'], upstream: { url: 'http://127.0.0.1:1' }, auth }] })
    .routes[0]!;
}

function request(route: RouteConfig, headers: IncomingHttpHeaders): GatewayRequest {
  return {
    id: 'test', method: 'GET', path: '/vault', upstreamPath: '/vault', query: '', headers, body: undefined,
    clientIp: '127.0.0.1', receivedAt: new Date(0), deadline: 1_000, signal: new AbortController().signal, route,
  };
}

/** Builds the auth handler around a fake upstream that records what it receives. */
function buildAuth(auth: unknown) {
  const route = routeWithAuth(auth);
  const forwarded: GatewayRequest[] = [];
  const next: Handler = async (req): Promise<GatewayResponse> => {
    forwarded.push(req);
    return { status: 200, headers: {}, body: undefined };
  };
  const handler = authPlugin.build(route, ctx)!(next);
  return { route, forwarded, call: (headers: IncomingHttpHeaders) => handler(request(route, headers)) };
}

const isUnauthorized = (error: unknown): boolean =>
  error instanceof GatewayError && error.status === 401 && error.code === 'unauthorized' &&
  Object.keys(error.details).length === 0;

describe('auth plugin', () => {
  const config = { type: 'api_key', header: 'X-Vault-Key', keys: ['key-one', 'key-two'] };

  it('is not built for routes without auth', () => {
    const route = validateConfig({ routes: [{ path: '/open', methods: ['GET'], upstream: { url: 'http://x:1' } }] }).routes[0]!;
    assert.equal(authPlugin.build(route, ctx), undefined);
  });

  it('accepts every configured key and strips the key header before forwarding', async () => {
    const { call, forwarded } = buildAuth(config);
    for (const key of config.keys) {
      const res = await call({ 'x-vault-key': key, accept: 'application/json' });
      assert.equal(res.status, 200);
    }
    assert.equal(forwarded.length, 2);
    for (const req of forwarded) {
      assert.equal(req.headers['x-vault-key'], undefined);
      assert.equal(req.headers.accept, 'application/json', 'other headers pass through');
    }
  });

  it('matches the configured header name case-insensitively', async () => {
    // Node lowercases incoming header names; the validator lowercases the configured one.
    const { route, call } = buildAuth({ ...config, header: 'X-VAULT-KEY' });
    assert.equal(route.features.auth?.header, 'x-vault-key');
    assert.equal((await call({ 'x-vault-key': 'key-one' })).status, 200);
  });

  it('rejects missing, wrong and duplicated keys with the same 401', async () => {
    const { call, forwarded } = buildAuth(config);
    const cases: Array<[string, IncomingHttpHeaders]> = [
      ['missing', {}],
      ['wrong', { 'x-vault-key': 'key-three' }],
      ['prefix of a valid key', { 'x-vault-key': 'key-' }],
      ['valid key with a suffix', { 'x-vault-key': 'key-one2' }],
      ['wrong case', { 'x-vault-key': 'KEY-ONE' }],
      ['key in a different header', { 'x-api-key': 'key-one' }],
      ['duplicated, joined by Node', { 'x-vault-key': 'key-one, key-one' }],
      ['duplicated, as an array', { 'x-vault-key': ['key-one', 'key-one'] }],
    ];
    for (const [name, headers] of cases) {
      await assert.rejects(call(headers), isUnauthorized, name);
    }
    assert.equal(forwarded.length, 0, 'a rejected request never reaches next()');
  });

  it('does not mutate the incoming request headers', async () => {
    const { call } = buildAuth(config);
    const headers = { 'x-vault-key': 'key-one' };
    await call(headers);
    assert.deepEqual(headers, { 'x-vault-key': 'key-one' });
  });

  it('rejects an unsupported type or empty keys at startup', () => {
    for (const auth of [{ ...config, type: 'jwt' }, { ...config, keys: [] }]) {
      assert.throws(() => routeWithAuth(auth), ConfigError);
    }
  });
});

describe('auth through the gateway', () => {
  it('rejects without reaching the upstream, and forwards accepted requests without the key', async () => {
    const mocks = await startMocks('vault');
    const gateway = await startGateway({
      gateway: { port: 9999, global_timeout: '2s' },
      routes: [
        {
          path: '/vault',
          methods: ['GET', 'POST'],
          upstream: { url: mocks.vault.url },
          auth: { type: 'api_key', header: 'X-Vault-Key', keys: ['s3cret-a', 's3cret-b'] },
        },
      ],
    });
    try {
      const rejected: Array<Record<string, string>> = [{}, { 'x-vault-key': 'nope' }, { 'X-VAULT-KEY': 's3cret' }];
      for (const headers of rejected) {
        const res = await fetch(`${gateway.url}/vault/items`, { headers });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: 'unauthorized' });
      }
      // A header sent twice on the wire, not joined by the client.
      const duplicate = await rawGet(`${gateway.url}/vault/items`, { 'x-vault-key': ['s3cret-a', 's3cret-a'] });
      assert.equal(duplicate.status, 401);
      assert.deepEqual(JSON.parse(duplicate.body), { error: 'unauthorized' });
      assert.equal(mocks.vault.requests.length, 0, 'rejected requests never reach the upstream');

      const res = await fetch(`${gateway.url}/vault/items`, { headers: { 'X-Vault-KEY': 's3cret-b' } });
      assert.equal(res.status, 200);
      const echo = await res.json();
      assert.equal(echo.url, '/vault/items');
      assert.equal(echo.headers['x-vault-key'], undefined, 'the upstream never sees the credential');
      assert.equal(mocks.vault.requests.length, 1);
      assert.ok(!JSON.stringify(gateway.logs).includes('s3cret'), 'keys never appear in logs');
    } finally {
      await gateway.close();
      await mocks.closeAll();
    }
  });
});

/** fetch() would join repeated headers into one line; http.request sends each array item as its own line. */
function rawGet(url: string, headers: http.OutgoingHttpHeaders): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}
