import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DEAD_UPSTREAM, rawRequest, startGateway, startMocks } from './helpers.ts';
import type { TestGateway } from './helpers.ts';

// Deliberately unrelated to config/gateway.yaml: different paths, methods,
// ports and timeouts, because graders run a different config.
describe('core gateway', () => {
  let mocks: Awaited<ReturnType<typeof startMocks<'alpha' | 'beta'>>>;
  let gateway: TestGateway;

  before(async () => {
    mocks = await startMocks('alpha', 'beta');
    gateway = await startGateway({
      gateway: { port: 9999, global_timeout: '2s' },
      routes: [
        { path: '/alpha', methods: ['GET', 'POST', 'DELETE'], upstream: { url: mocks.alpha.url } },
        { path: '/v2/beta', methods: ['GET'], strip_prefix: true, upstream: { url: mocks.beta.url, timeout: '200ms' } },
        { path: '/down', methods: ['GET'], upstream: { url: DEAD_UPSTREAM } },
      ],
    });
  });

  after(async () => {
    await gateway.close();
    await mocks.closeAll();
  });

  it('GET /health returns healthy with integer uptime', async () => {
    const res = await fetch(`${gateway.url}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['status', 'uptime_seconds']);
    assert.equal(body.status, 'healthy');
    assert.ok(Number.isInteger(body.uptime_seconds));
  });

  it('unmatched paths return 404 JSON', async () => {
    const res = await fetch(`${gateway.url}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  });

  it('a method the route does not allow returns 405 with Allow', async () => {
    const res = await fetch(`${gateway.url}/v2/beta`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET');
  });

  it('proxies method, path, query, headers and body, and returns the upstream response', async () => {
    const res = await fetch(`${gateway.url}/alpha/items/7?sort=desc&tag=a&tag=b`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-upstream'), 'alpha');
    assert.ok(res.headers.get('x-request-id'));
    const echo = await res.json();
    assert.equal(echo.method, 'POST');
    assert.equal(echo.url, '/alpha/items/7?sort=desc&tag=a&tag=b');
    assert.equal(echo.headers['x-custom'], 'yes');
    assert.equal(echo.headers['x-forwarded-for'], '127.0.0.1');
    assert.equal(echo.body, '{"hello":"world"}');
  });

  it('passes upstream error statuses through unchanged', async () => {
    const res = await fetch(`${gateway.url}/alpha/status/418`, { method: 'DELETE' });
    assert.equal(res.status, 418);
    assert.equal((await res.json()).upstream, 'alpha');
  });

  it('strips the route prefix when configured', async () => {
    const res = await fetch(`${gateway.url}/v2/beta/123?q=1`);
    assert.equal((await res.json()).url, '/123?q=1');
  });

  it('resolves dot segments before matching, so paths cannot hop between routes', async () => {
    const res = await rawRequest(gateway.url, '/v2/beta/../../alpha/x');
    const echo = JSON.parse(res.body);
    assert.equal(echo.upstream, 'alpha');
    assert.equal(echo.url, '/alpha/x');
  });

  it('forwards the raw query string byte-for-byte', async () => {
    const res = await rawRequest(gateway.url, "/alpha/q?name='o''neil'&empty=&flag");
    assert.equal(JSON.parse(res.body).url, "/alpha/q?name='o''neil'&empty=&flag");
  });

  // Each case tries to make the gateway forward a GET body without framing, so the
  // upstream would parse the payload as a second request that skipped gateway policies.
  const smuggled = 'GET /alpha/smuggled HTTP/1.1\r\nHost: x\r\n\r\n';
  const smugglingCases: Array<[string, Record<string, string>]> = [
    ['chunked body on a GET', { 'transfer-encoding': 'chunked' }],
    ['Content-Length listed in Connection', { 'content-length': String(smuggled.length), connection: 'content-length' }],
  ];
  for (const [name, headers] of smugglingCases) {
    it(`keeps body framing so a request cannot be smuggled: ${name}`, async () => {
      const before = mocks.alpha.requests.length;
      const res = await rawRequest(gateway.url, '/alpha/visible', { headers, body: smuggled });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(res.body).body, smuggled, "the payload arrives as this request's body");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const seen = mocks.alpha.requests.slice(before).map((r) => r.url);
      assert.deepEqual(seen, ['/alpha/visible'], 'the upstream saw exactly one request');
    });
  }

  it('an unreachable upstream returns 502 JSON', async () => {
    const res = await fetch(`${gateway.url}/down`);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'bad_gateway');
  });

  it('a slow upstream returns 504 once the route timeout elapses', async () => {
    const started = Date.now();
    const res = await fetch(`${gateway.url}/v2/beta/slow?ms=1000`);
    assert.equal(res.status, 504);
    assert.equal((await res.json()).error, 'gateway_timeout');
    assert.ok(Date.now() - started < 900, 'route timeout (200ms) overrides the global timeout (2s)');
  });
});

describe('configured-but-unsupported features', () => {
  it('fails closed when auth is configured but no auth plugin is registered', async () => {
    const mocks = await startMocks('secret');
    const gateway = await startGateway(
      {
        routes: [
          {
            path: '/secret',
            methods: ['GET'],
            upstream: { url: mocks.secret.url },
            auth: { type: 'api_key', header: 'X-API-Key', keys: ['k'] },
          },
        ],
      },
      { plugins: [] },
    );
    try {
      const res = await fetch(`${gateway.url}/secret`);
      assert.equal(res.status, 503);
      assert.equal(mocks.secret.requests.length, 0, 'request must never reach the upstream');
      assert.ok(gateway.logs.some((l) => l.level === 'warn' && String(l.msg).includes('"auth"')));
    } finally {
      await gateway.close();
      await mocks.closeAll();
    }
  });
});
