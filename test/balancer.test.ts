import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { RouteConfig } from '../src/config/types.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { BuildContext } from '../src/pipeline.ts';
import { createBalancer } from '../src/upstream/balancer.ts';
import { startGateway, startMocks } from './helpers.ts';
import type { TestGateway } from './helpers.ts';

const ctx: BuildContext = { now: () => 0, onClose: () => {} };

/** A route over hosts a, b, c... with the given weights. */
function routeWith(balance: string, weights: number[]): RouteConfig {
  const targets = weights.map((weight, i) => ({ url: `http://${String.fromCharCode(97 + i)}.test`, weight }));
  return validateConfig({ routes: [{ path: '/svc', methods: ['GET'], upstream: { targets, balance } }] }).routes[0]!;
}

/** Makes `count` picks and returns the chosen hostnames. */
function picks(route: RouteConfig, count: number): string[] {
  const select = createBalancer(route, ctx);
  return Array.from({ length: count }, () => select().url.hostname.replace('.test', ''));
}

function tally(names: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

describe('round robin', () => {
  it('cycles through targets in config order and ignores weights', () => {
    assert.deepEqual(picks(routeWith('round_robin', [5, 1, 1]), 7), ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  });

  it('is the default when balance is not set', () => {
    const route = validateConfig({
      routes: [{ path: '/svc', methods: ['GET'], upstream: { targets: [{ url: 'http://a.test' }, { url: 'http://b.test' }] } }],
    }).routes[0]!;
    assert.deepEqual(picks(route, 4), ['a', 'b', 'a', 'b']);
  });
});

describe('smooth weighted round robin', () => {
  it('interleaves weights 3:1 as a, a, b, a rather than a burst', () => {
    assert.deepEqual(picks(routeWith('weighted_round_robin', [3, 1]), 8), ['a', 'a', 'b', 'a', 'a', 'a', 'b', 'a']);
  });

  it("matches nginx's reference sequence for weights 5:1:1", () => {
    assert.deepEqual(picks(routeWith('weighted_round_robin', [5, 1, 1]), 7), ['a', 'a', 'b', 'a', 'c', 'a', 'a']);
  });

  it('honors arbitrary weights exactly over every full cycle', () => {
    for (const weights of [[2, 3, 5], [1, 1, 1, 7], [4, 4], [10, 1]]) {
      const total = weights.reduce((sum, w) => sum + w, 0);
      const sequence = picks(routeWith('weighted_round_robin', weights), total * 2);
      const expected = Object.fromEntries(weights.map((w, i) => [String.fromCharCode(97 + i), w]));
      assert.deepEqual(tally(sequence.slice(0, total)), expected, `first cycle of ${weights.join(':')}`);
      assert.deepEqual(sequence.slice(total), sequence.slice(0, total), `cycle repeats for ${weights.join(':')}`);
    }
  });
});

describe('createBalancer', () => {
  it('always returns the only target of a single-url route', () => {
    for (const balance of ['round_robin', 'weighted_round_robin']) {
      const route = validateConfig({ routes: [{ path: '/svc', methods: ['GET'], upstream: { url: 'http://only.test', balance } }] })
        .routes[0]!;
      assert.deepEqual(picks(route, 3), ['only', 'only', 'only']);
    }
  });

  it('gives each route its own cursor', () => {
    const first = createBalancer(routeWith('round_robin', [1, 1]), ctx);
    const second = createBalancer(routeWith('round_robin', [1, 1]), ctx);
    assert.equal(first().url.hostname, 'a.test');
    assert.equal(first().url.hostname, 'b.test');
    assert.equal(second().url.hostname, 'a.test', 'picks on one route do not advance another');
  });
});

describe('load balancing through the gateway', () => {
  let mocks: Awaited<ReturnType<typeof startMocks<'heavy' | 'light' | 'left' | 'right'>>>;
  let gateway: TestGateway;

  before(async () => {
    mocks = await startMocks('heavy', 'light', 'left', 'right');
    gateway = await startGateway({
      routes: [
        {
          path: '/weighted',
          methods: ['GET'],
          upstream: {
            balance: 'weighted_round_robin',
            targets: [{ url: mocks.heavy.url, weight: 3 }, { url: mocks.light.url, weight: 1 }],
          },
        },
        {
          path: '/even',
          methods: ['GET'],
          upstream: { targets: [{ url: mocks.left.url, weight: 3 }, { url: mocks.right.url, weight: 1 }] },
        },
      ],
    });
  });

  after(async () => {
    await gateway.close();
    await mocks.closeAll();
  });

  it('splits 8 concurrent requests 6/2 across targets weighted 3:1', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${gateway.url}/weighted/items`)));
    await Promise.all(responses.map((res) => res.arrayBuffer()));
    assert.ok(responses.every((res) => res.status === 200));
    assert.equal(mocks.heavy.requests.length, 6);
    assert.equal(mocks.light.requests.length, 2);
  });

  it('splits evenly under round robin even when weights are set', async () => {
    for (let i = 0; i < 8; i++) await (await fetch(`${gateway.url}/even`)).arrayBuffer();
    assert.equal(mocks.left.requests.length, 4);
    assert.equal(mocks.right.requests.length, 4);
  });
});
