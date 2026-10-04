import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { RouteConfig } from '../src/config/types.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { GatewayRequest, GatewayResponse, Handler } from '../src/pipeline.ts';
import { GatewayError } from '../src/pipeline.ts';
import { createRateLimiter, rateLimitPlugin } from '../src/plugins/rate-limit.ts';
import { startGateway, startMocks } from './helpers.ts';

function routeWith(rateLimit: Record<string, unknown>, path = '/limited'): RouteConfig {
  const config = validateConfig({
    routes: [{ path, methods: ['GET'], upstream: { url: 'http://127.0.0.1:1' }, rate_limit: rateLimit }],
  });
  return config.routes[0]!;
}

function requestFrom(clientIp: string, route: RouteConfig): GatewayRequest {
  return {
    id: 'test', method: 'GET', path: route.path, upstreamPath: route.path, query: '', headers: {}, body: undefined,
    clientIp, receivedAt: new Date(0), deadline: Number.MAX_SAFE_INTEGER, signal: new AbortController().signal, route,
  };
}

/** A real ticking clock that starts at 0, which is a window boundary for every window size. */
function clockFromZero(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

const upstreamOk: Handler = async () => ({ status: 200, headers: { 'x-upstream': 'fake' }, body: undefined });

/** Builds the plugin for one route with an injected clock; returns a function that sends a request at a given time. */
function limitedHandler(rateLimit: Record<string, unknown>, cleanups: Array<() => void>, path?: string) {
  const route = routeWith(rateLimit, path);
  let clock = 0;
  const handler = rateLimitPlugin.build(route, { now: () => clock, onClose: (fn) => cleanups.push(fn) })!(upstreamOk);
  return (at: number, clientIp = '10.0.0.1'): Promise<GatewayResponse> => {
    clock = at;
    return handler(requestFrom(clientIp, route));
  };
}

async function rejection(promise: Promise<unknown>): Promise<GatewayError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GatewayError);
    return error;
  }
  assert.fail('expected the request to be rate limited');
}

describe('rate limit plugin', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('is not built when the route has no rate limit', () => {
    const route = validateConfig({ routes: [{ path: '/a', methods: ['GET'], upstream: { url: 'http://x:1' } }] }).routes[0]!;
    assert.equal(rateLimitPlugin.build(route, { now: () => 0, onClose: () => {} }), undefined);
  });

  it('registers the idle-bucket sweeper for cleanup on close', () => {
    limitedHandler({ requests: 1, window: '1s' }, cleanups);
    assert.equal(cleanups.length, 1);
  });

  describe('fixed_window', () => {
    it('admits `requests` per window, counting down X-RateLimit-Remaining, then answers 429', async () => {
      const send = limitedHandler({ requests: 3, window: '10s', strategy: 'fixed_window' }, cleanups);
      for (const remaining of ['2', '1', '0']) {
        const res = await send(1_000);
        assert.equal(res.status, 200);
        assert.equal(res.headers['x-upstream'], 'fake', 'upstream headers are preserved');
        assert.equal(res.headers['x-ratelimit-limit'], '3');
        assert.equal(res.headers['x-ratelimit-remaining'], remaining);
      }
      const error = await rejection(send(1_000));
      assert.equal(error.status, 429);
      assert.equal(error.code, 'rate_limited');
      assert.deepEqual(error.details, { retry_after: 9 });
      assert.deepEqual(error.headers, { 'retry-after': '9', 'x-ratelimit-limit': '3', 'x-ratelimit-remaining': '0' });
    });

    it('aligns windows to the clock and resets exactly at the boundary', async () => {
      const send = limitedHandler({ requests: 2, window: '10s', strategy: 'fixed_window' }, cleanups);
      await send(9_000);
      await send(9_500);
      assert.equal((await rejection(send(9_999))).details.retry_after, 1, '1ms left rounds up to 1s');
      assert.equal((await send(10_000)).headers['x-ratelimit-remaining'], '1', 'a new window starts at 10s');
    });

    it('rounds retry_after up to the earliest admission', async () => {
      const send = limitedHandler({ requests: 1, window: '10s', strategy: 'fixed_window' }, cleanups);
      await send(0);
      assert.equal((await rejection(send(1))).details.retry_after, 10, '9999ms -> 10s');
      assert.equal((await rejection(send(8_500))).details.retry_after, 2, '1500ms -> 2s');
      assert.equal((await rejection(send(9_000))).details.retry_after, 1, '1000ms -> 1s');
    });
  });

  describe('sliding_window', () => {
    it('expires each admission exactly one window after it was recorded', async () => {
      const send = limitedHandler({ requests: 2, window: '1s', strategy: 'sliding_window' }, cleanups);
      await send(0);
      await send(400);
      assert.equal((await rejection(send(999))).details.retry_after, 1);
      assert.equal((await send(1_000)).status, 200, 'the t=0 entry expires at t=1000');
      await rejection(send(1_399));
      assert.equal((await send(1_400)).status, 200, 'the t=400 entry expires at t=1400');
    });

    it('does not allow the boundary burst a fixed window would', async () => {
      const fixed = limitedHandler({ requests: 3, window: '1s', strategy: 'fixed_window' }, cleanups, '/fixed');
      const sliding = limitedHandler({ requests: 3, window: '1s', strategy: 'sliding_window' }, cleanups, '/sliding');
      for (const send of [fixed, sliding]) {
        for (let i = 0; i < 3; i++) await send(900);
      }
      assert.equal((await fixed(1_000)).status, 200, 'fixed window resets at the boundary');
      assert.equal((await rejection(sliding(1_000))).details.retry_after, 1, 'sliding waits until t=1900');
    });

    it('does not record rejected requests', async () => {
      const send = limitedHandler({ requests: 1, window: '1s', strategy: 'sliding_window' }, cleanups);
      await send(0);
      for (let t = 100; t < 1_000; t += 100) await rejection(send(t));
      assert.equal((await send(1_000)).status, 200, 'retries during the window did not extend it');
    });
  });

  describe('bucket keys', () => {
    for (const strategy of ['fixed_window', 'sliding_window']) {
      it(`${strategy}: per ip gives each client its own bucket`, async () => {
        const send = limitedHandler({ requests: 1, window: '1m', strategy, per: 'ip' }, cleanups);
        await send(0, '10.0.0.1');
        await send(0, '10.0.0.2');
        await rejection(send(0, '10.0.0.1'));
      });

      it(`${strategy}: per global shares one bucket across clients`, async () => {
        const send = limitedHandler({ requests: 2, window: '1m', strategy, per: 'global' }, cleanups);
        await send(0, '10.0.0.1');
        await send(0, '10.0.0.2');
        await rejection(send(0, '10.0.0.3'));
      });
    }

    it('keeps separate buckets for each route', async () => {
      const first = limitedHandler({ requests: 1, window: '1m', per: 'global' }, cleanups, '/first');
      const second = limitedHandler({ requests: 1, window: '1m', per: 'global' }, cleanups, '/second');
      await first(0);
      await rejection(first(0));
      assert.equal((await second(0)).status, 200);
    });
  });
});

describe('rate limiter sweep', () => {
  for (const strategy of ['fixed_window', 'sliding_window'] as const) {
    it(`${strategy}: drops buckets once they are idle for a window, and keeps active ones`, () => {
      const limiter = createRateLimiter({ requests: 5, windowMs: 1_000, strategy, per: 'ip' });
      limiter.take('a', 0);
      limiter.take('b', 999);
      limiter.sweep(999);
      assert.equal(limiter.size, 2);
      limiter.sweep(1_000);
      assert.equal(limiter.size, strategy === 'fixed_window' ? 0 : 1, 'b is still inside its sliding window');
      limiter.sweep(1_999);
      assert.equal(limiter.size, 0);
    });
  }

  it('sweeping does not change decisions for active clients', () => {
    const limiter = createRateLimiter({ requests: 2, windowMs: 1_000, strategy: 'sliding_window', per: 'ip' });
    limiter.take('a', 500);
    limiter.take('a', 600);
    limiter.sweep(1_000);
    assert.equal(limiter.take('a', 1_000).allowed, false);
  });
});

describe('rate limiting through the gateway', () => {
  for (const strategy of ['fixed_window', 'sliding_window']) {
    it(`${strategy}: 50 simultaneous requests against a limit of 10 -> exactly 10 x 200 and 40 x 429`, async () => {
      const mocks = await startMocks('limited');
      // The clock starts at a window boundary, so a fixed window can't roll over mid-test.
      const gateway = await startGateway(
        {
          gateway: { global_timeout: '5s' },
          routes: [
            {
              path: '/burst',
              methods: ['GET'],
              upstream: { url: mocks.limited.url },
              rate_limit: { requests: 10, window: '1m', strategy, per: 'ip' },
            },
          ],
        },
        { now: clockFromZero() },
      );
      try {
        const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(`${gateway.url}/burst`)));
        const statuses = responses.map((res) => res.status);
        assert.equal(statuses.filter((s) => s === 200).length, 10);
        assert.equal(statuses.filter((s) => s === 429).length, 40);
        assert.equal(mocks.limited.requests.length, 10, 'rejected requests never reach the upstream');

        const admitted = responses.filter((res) => res.status === 200);
        const remaining = admitted.map((res) => Number(res.headers.get('x-ratelimit-remaining'))).sort((a, b) => a - b);
        assert.deepEqual(remaining, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert.ok(admitted.every((res) => res.headers.get('x-ratelimit-limit') === '10'));

        const rejected = responses.find((res) => res.status === 429)!;
        assert.equal(rejected.headers.get('content-type'), 'application/json');
        assert.equal(rejected.headers.get('x-ratelimit-limit'), '10');
        assert.equal(rejected.headers.get('x-ratelimit-remaining'), '0');
        const retryAfter = rejected.headers.get('retry-after');
        assert.match(retryAfter ?? '', /^\d+$/, 'Retry-After is an integer number of seconds');
        assert.ok(Number(retryAfter) >= 1 && Number(retryAfter) <= 60);
        assert.deepEqual(await rejected.json(), { error: 'rate_limited', retry_after: Number(retryAfter) });
        await Promise.all(responses.map((res) => res.bodyUsed || res.body?.cancel()));
      } finally {
        await gateway.close();
        await mocks.closeAll();
      }
    });
  }

  it('routes inherit global_rate_limit unless they set their own, and never share buckets', async () => {
    const mocks = await startMocks('shared');
    const gateway = await startGateway({
      gateway: { global_rate_limit: { requests: 1, window: '1h' } },
      routes: [
        { path: '/inherits-a', methods: ['GET'], upstream: { url: mocks.shared.url } },
        { path: '/inherits-b', methods: ['GET'], upstream: { url: mocks.shared.url } },
        { path: '/own', methods: ['GET'], upstream: { url: mocks.shared.url }, rate_limit: { requests: 3, window: '1h' } },
      ],
    }, { now: clockFromZero() });
    try {
      const statusOf = async (path: string) => {
        const res = await fetch(`${gateway.url}${path}`);
        await res.body?.cancel();
        return res.status;
      };
      assert.deepEqual([await statusOf('/inherits-a'), await statusOf('/inherits-a')], [200, 429]);
      assert.equal(await statusOf('/inherits-b'), 200, 'a sibling route has its own bucket');
      assert.deepEqual(
        [await statusOf('/own'), await statusOf('/own'), await statusOf('/own'), await statusOf('/own')],
        [200, 200, 200, 429],
        'a route-level rate_limit replaces the global one',
      );
    } finally {
      await gateway.close();
      await mocks.closeAll();
    }
  });
});
