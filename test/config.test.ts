import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDuration } from '../src/config/duration.ts';
import { loadConfig } from '../src/config/load.ts';
import { ConfigError, validateConfig } from '../src/config/validate.ts';

function problemsOf(raw: unknown): string[] {
  try {
    validateConfig(raw);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail('expected ConfigError');
}

describe('config', () => {
  it('loads the provided example config', () => {
    const config = loadConfig('config/gateway.yaml');
    assert.equal(config.port, 8080);
    assert.equal(config.routes.length, 5);

    const orders = config.routes.find((r) => r.path === '/api/orders')!;
    assert.equal(orders.timeoutMs, 5_000);
    assert.deepEqual(orders.features.rate_limit, { requests: 10, windowMs: 10_000, strategy: 'fixed_window', per: 'ip' });

    const users = config.routes.find((r) => r.path === '/api/users')!;
    assert.equal(users.timeoutMs, 30_000, 'falls back to global_timeout');

    const internal = config.routes.find((r) => r.path === '/api/internal')!;
    assert.equal(internal.features.rate_limit?.requests, 100, 'inherits global_rate_limit');
    assert.equal(internal.features.auth?.header, 'x-api-key');

    const products = config.routes.find((r) => r.path === '/api/products')!;
    assert.deepEqual(products.upstream.targets.map((t) => t.weight), [3, 1]);
  });

  it('normalizes a single url into one target and applies defaults', () => {
    const config = validateConfig({ routes: [{ path: '/a/', methods: ['get'], upstream: { url: 'http://x:1' } }] });
    const [route] = config.routes;
    assert.equal(config.port, 8080);
    assert.equal(route!.path, '/a');
    assert.deepEqual(route!.methods, ['GET']);
    assert.equal(route!.stripPrefix, false);
    assert.equal(route!.timeoutMs, 30_000);
    assert.equal(route!.upstream.targets[0]!.url.href, 'http://x:1/');
  });

  it('reports every problem with its path instead of stopping at the first', () => {
    const problems = problemsOf({
      gateway: { port: 99999, global_timeout: 'soon' },
      routes: [
        { path: 'no-slash', methods: [], upstream: { url: 'ftp://x' } },
        { path: '/ok', methods: ['GET'], upstream: { url: 'http://x', targets: [] } },
        { path: '/rl', methods: ['GET'], upstream: { url: 'http://x' }, rate_limit: { requests: 0, window: '1s', strategy: 'leaky' } },
      ],
    });
    for (const expected of [
      'gateway.port',
      'gateway.global_timeout',
      'routes[0].path',
      'routes[0].methods',
      'routes[0].upstream.url',
      'routes[1].upstream',
      'routes[2].rate_limit.requests',
      'routes[2].rate_limit.strategy',
    ]) {
      assert.ok(problems.some((p) => p.startsWith(`${expected}:`)), `missing problem for ${expected}: ${problems.join(' | ')}`);
    }
  });

  it('rejects unknown keys so a typo cannot silently disable a feature', () => {
    const problems = problemsOf({ routes: [{ path: '/a', methods: ['GET'], upstream: { url: 'http://x' }, auht: {} }] });
    assert.deepEqual(problems, ['routes[0].auht: unknown key']);
  });

  it('rejects duplicate routes, unknown methods and unknown template variables', () => {
    const route = { path: '/a', methods: ['GET'], upstream: { url: 'http://x' } };
    assert.ok(problemsOf({ routes: [route, { ...route, path: '/a/' }] }).some((p) => p.includes('duplicate route')));
    assert.ok(problemsOf({ routes: [{ ...route, methods: ['FETCH'] }] }).some((p) => p.includes('unsupported HTTP method')));
    const transform = { headers: { add: { 'X-When': '$tomorrow' } } };
    assert.ok(problemsOf({ routes: [{ ...route, request_transform: transform }] }).some((p) => p.includes('unknown variable')));
  });

  it('fails cleanly on unreadable or invalid YAML', () => {
    assert.throws(() => loadConfig('does/not/exist.yaml'), ConfigError);
  });
});

describe('parseDuration', () => {
  it('parses supported units', () => {
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('1.5m'), 90_000);
    assert.equal(parseDuration('1h'), 3_600_000);
  });

  it('rejects unitless, zero, negative and timer-overflowing values', () => {
    for (const bad of ['30', '0s', '-1s', 's', '1d', '1000h']) assert.equal(parseDuration(bad), undefined, bad);
  });
});
