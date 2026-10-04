import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ConfigError, validateConfig } from '../src/config/validate.ts';
import { rawRequest, startGateway, startMocks } from './helpers.ts';
import type { TestGateway } from './helpers.ts';

// Regression for a P1 found by an adversarial review: a protected route and a
// public catch-all on the same upstream. Aliases of the protected path that the
// router didn't canonicalize matched the catch-all, skipped auth, and an upstream
// that normalizes paths served the protected resource without credentials.
describe('path aliases cannot skip a route policy', () => {
  let mocks: Awaited<ReturnType<typeof startMocks<'files'>>>;
  let gateway: TestGateway;

  before(async () => {
    mocks = await startMocks('files');
    gateway = await startGateway({
      routes: [
        { path: '/', methods: ['GET'], upstream: { url: mocks.files.url } },
        {
          path: '/secret',
          methods: ['GET'],
          upstream: { url: mocks.files.url },
          auth: { type: 'api_key', header: 'X-API-Key', keys: ['k'] },
        },
      ],
    });
  });

  after(async () => {
    await gateway.close();
    await mocks.closeAll();
  });

  const reachesUpstream = async (path: string) => {
    const before = mocks.files.requests.length;
    const res = await rawRequest(gateway.url, path);
    return { status: res.status, reached: mocks.files.requests.length > before };
  };

  for (const alias of ['/%73ecret', '/%73%65%63%72%65%74', '//secret', '/x/%2e%2e/secret', '/%2E%2E/secret/']) {
    it(`treats "${alias}" as /secret, so auth still applies`, async () => {
      assert.deepEqual(await reachesUpstream(alias), { status: 401, reached: false });
    });
  }

  // Each can make an upstream see a different path than the router matched: an
  // encoded separator, a path parameter (Java servers read "..;" as ".."),
  // an encoded query or fragment delimiter, double encoding, a non-standard
  // escape, or bytes that aren't valid UTF-8 (overlong encodings of "/").
  const ambiguousPaths = [
    '/x/..%2fsecret', '/x/..%2Fsecret', '/x/..%5csecret', '/secret%00',
    '/secret;x', '/x/..;/secret', '/x/%3Bsecret', '/x%3Fy', '/x%23y',
    '/%2573ecret', '/%u0073ecret', '/bad%zz', '/bad%', '/%c0%afsecret',
  ];
  for (const ambiguous of ambiguousPaths) {
    it(`rejects the ambiguous encoding in "${ambiguous}" with 400`, async () => {
      assert.deepEqual(await reachesUpstream(ambiguous), { status: 400, reached: false });
    });
  }

  it('forwards the canonical path, so the upstream sees what the router matched', async () => {
    const res = await rawRequest(gateway.url, '//public/%7Euser/doc?q=%2F');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).url, '/public/~user/doc?q=%2F', 'path canonicalized; query untouched');
  });

  it('forwards valid UTF-8 escapes as escapes', async () => {
    const res = await rawRequest(gateway.url, '/caf%c3%a9');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).url, '/caf%C3%A9');
  });

  it('leaves reserved escapes such as %20 encoded', async () => {
    const res = await rawRequest(gateway.url, '/a%20b');
    assert.equal(JSON.parse(res.body).url, '/a%20b');
  });

  it('canonicalizes before the reserved /health check too', async () => {
    const res = await rawRequest(gateway.url, '/%68ealth');
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).status, 'healthy');
  });
});

describe('route paths in config must be canonical', () => {
  for (const path of ['/a%2fb', '/a//b', '/%73ecret', '/café', '/./secret', '/a;b']) {
    it(`rejects "${path}" at startup`, () => {
      assert.throws(
        () => validateConfig({ routes: [{ path, methods: ['GET'], upstream: { url: 'http://x' } }] }),
        (error: unknown) => error instanceof ConfigError && error.problems.some((p) => p.startsWith('routes[0].path:')),
      );
    });
  }
  it('accepts a canonical path that keeps a reserved escape', () => {
    const [route] = validateConfig({ routes: [{ path: '/a%20b', methods: ['GET'], upstream: { url: 'http://x' } }] }).routes;
    assert.equal(route!.path, '/a%20b');
  });
});
