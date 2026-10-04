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

describe('config hardening (Codex review on PR #13)', () => {
  const base = { path: '/a', methods: ['GET'], upstream: { url: 'http://x' } };
  const routeWith = (extra: Record<string, unknown>) => ({ routes: [{ ...base, ...extra }] });

  it('rejects header names and values Node could not send', () => {
    const problems = problemsOf(
      routeWith({
        request_transform: { headers: { add: { 'Bad Name': 'x', 'X-Ok': 'line\r\nbreak' }, remove: ['Also Bad'] } },
        auth: { type: 'api_key', header: 'X API Key', keys: ['k'] },
      }),
    );
    for (const field of ['add.Bad Name', 'add.X-Ok', 'remove[0]']) {
      assert.ok(problems.some((p) => p.includes(`request_transform.headers.${field}:`)), field);
    }
    assert.ok(problems.some((p) => p.startsWith('routes[0].auth.header:')));
  });

  it('rejects unsafe or conflicting mapping paths', () => {
    const mapping = { user: 'name', 'user.id': 'userId', '__proto__.polluted': 'x', 'meta.ok': 'constructor.prototype' };
    const problems = problemsOf(routeWith({ request_transform: { body: { mapping } } }));
    assert.ok(problems.some((p) => p.includes('mapping.user: conflicts with "user.id"')));
    assert.ok(problems.some((p) => p.includes('"__proto__.polluted" is not a safe dot path')));
    assert.ok(problems.some((p) => p.includes('"constructor.prototype" is not a safe dot path')));
  });

  it('checks template variables inside envelope lists and rejects cyclic aliases', () => {
    const listed = problemsOf(routeWith({ response_transform: { body: { envelope: { items: [{ data: '$boddy' }] } } } }));
    assert.deepEqual(listed, ['routes[0].response_transform.body.envelope.items[0].data: unknown variable "$boddy"']);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cycle = problemsOf(routeWith({ response_transform: { body: { envelope: cyclic } } }));
    assert.deepEqual(cycle, ['routes[0].response_transform.body.envelope.self: must not contain a cyclic YAML alias']);
  });

  it('allows empty literals and keeps special-named headers', () => {
    const config = validateConfig(
      routeWith({
        // JSON.parse, because an object literal's __proto__ key sets the prototype instead.
        request_transform: { headers: { add: JSON.parse('{"X-Empty": "", "__proto__": "kept"}') } },
        response_transform: { body: { envelope: { message: '' } } },
      }),
    );
    const add = config.routes[0]!.features.request_transform!.headers!.add;
    assert.equal(add['X-Empty'], '');
    assert.ok(Object.hasOwn(add, '__proto__'));
  });
});
