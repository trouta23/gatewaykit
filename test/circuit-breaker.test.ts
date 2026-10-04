import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RouteConfig } from '../src/config/types.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { GatewayRequest, GatewayResponse, Handler } from '../src/pipeline.ts';
import { GatewayError } from '../src/pipeline.ts';
import { circuitBreakerPlugin } from '../src/plugins/circuit-breaker.ts';
import { startGateway, startMocks } from './helpers.ts';

const START = 1_700_000_000_000;

function breakerRoute(circuitBreaker: unknown): RouteConfig {
  return validateConfig({
    routes: [{ path: '/svc', methods: ['GET'], upstream: { url: 'http://127.0.0.1:1' }, circuit_breaker: circuitBreaker }],
  }).routes[0]!;
}

const reply = (status: number): GatewayResponse => ({ status, headers: {}, body: undefined });

/**
 * A breaker (threshold 3, window 10s, cooldown 5s) around a fake upstream.
 * Each call says how the upstream behaves for that request.
 */
function harness() {
  let now = START;
  const route = breakerRoute({ threshold: 3, window: '10s', cooldown: '5s' });
  let upstreamCalls = 0;
  let behave: () => Promise<GatewayResponse> = async () => reply(200);
  const next: Handler = () => {
    upstreamCalls += 1;
    return behave();
  };
  const handler = circuitBreakerPlugin.build(route, { now: () => now, onClose: () => {} })!(next);
  const req = { route } as GatewayRequest;
  const call = (upstream: () => Promise<GatewayResponse>): Promise<GatewayResponse> => {
    behave = upstream;
    return handler(req);
  };
  return {
    call,
    respond: (status: number) => call(async () => reply(status)),
    throwError: (error: Error) => call(async () => { throw error; }),
    advance: (ms: number) => { now += ms; },
    upstreamCalls: () => upstreamCalls,
  };
}

/** Matches the open-circuit rejection with the given retry_after. */
const openCircuit = (retryAfter: number) => (error: unknown): boolean => {
  assert.ok(error instanceof GatewayError);
  assert.equal(error.status, 503);
  assert.equal(error.code, 'service_unavailable');
  assert.deepEqual(error.details, { retry_after: retryAfter });
  assert.deepEqual(error.headers, { 'retry-after': String(retryAfter) });
  return true;
};

function deferred() {
  let resolve!: (response: GatewayResponse) => void;
  const promise = new Promise<GatewayResponse>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('circuit breaker plugin', () => {
  it('is not built for routes without circuit_breaker', () => {
    const route = validateConfig({ routes: [{ path: '/x', methods: ['GET'], upstream: { url: 'http://x:1' } }] }).routes[0]!;
    assert.equal(circuitBreakerPlugin.build(route, { now: () => 0, onClose: () => {} }), undefined);
  });

  it('opens once threshold failures land inside the window, then fails fast without calling upstream', async () => {
    const b = harness();
    assert.equal((await b.respond(500)).status, 500, 'failures pass through while closed');
    b.advance(1_000);
    await assert.rejects(b.throwError(new GatewayError(502, 'bad_gateway')), { status: 502 });
    b.advance(1_000);
    await assert.rejects(b.throwError(new GatewayError(504, 'gateway_timeout')), { status: 504 });
    assert.equal(b.upstreamCalls(), 3);

    await assert.rejects(b.respond(200), openCircuit(5));
    b.advance(2_500);
    await assert.rejects(b.respond(200), openCircuit(3), 'retry_after counts down, rounded up');
    assert.equal(b.upstreamCalls(), 3, 'an open circuit never reaches the upstream');
  });

  it('only counts failures inside the trailing window', async () => {
    const b = harness();
    await b.respond(500); // t = 0
    b.advance(6_000);
    await b.respond(503); // t = 6s
    b.advance(5_000);
    await b.respond(500); // t = 11s: the t = 0 failure has expired, so 2 in window
    assert.equal((await b.respond(200)).status, 200, 'still closed');
    b.advance(1_000);
    await b.respond(500); // t = 12s: 6s, 11s, 12s
    await assert.rejects(b.respond(200), openCircuit(5));
  });

  it('does not count 4xx responses, client aborts or other thrown errors', async () => {
    const b = harness();
    for (let i = 0; i < 5; i++) {
      await b.respond(404);
      await b.respond(429);
      const clientGone = new GatewayError(499, 'client_closed_request');
      await assert.rejects(b.throwError(clientGone), (error) => error === clientGone, 're-thrown unchanged');
      await assert.rejects(b.throwError(new Error('bug')), /bug/);
    }
    await b.respond(500);
    await b.respond(500);
    assert.equal((await b.respond(200)).status, 200, 'two real failures stay below the threshold of 3');
  });

  it('lets exactly one probe through after the cooldown; success closes the circuit and clears failures', async () => {
    const b = harness();
    for (let i = 0; i < 3; i++) await b.respond(500);
    b.advance(4_999);
    await assert.rejects(b.respond(200), openCircuit(1));
    b.advance(1);

    const probe = deferred();
    const probeResult = b.call(() => probe.promise);
    await assert.rejects(b.respond(200), openCircuit(1), 'concurrent requests are rejected while the probe is in flight');
    await assert.rejects(b.respond(200), openCircuit(1));
    probe.resolve(reply(204));
    assert.equal((await probeResult).status, 204);
    assert.equal(b.upstreamCalls(), 4, 'three failures plus the single probe');

    assert.equal((await b.respond(200)).status, 200, 'closed again');
    await b.respond(500);
    await b.respond(500);
    assert.equal((await b.respond(200)).status, 200, 'old failures were cleared, so two new ones do not trip it');
  });

  it('re-opens with a fresh cooldown when the probe fails', async () => {
    const b = harness();
    for (let i = 0; i < 3; i++) await b.respond(500);
    b.advance(5_000);
    await assert.rejects(b.throwError(new GatewayError(502, 'bad_gateway')), { status: 502 });
    await assert.rejects(b.respond(200), openCircuit(5), 'a full new cooldown');
    b.advance(4_999);
    await assert.rejects(b.respond(200), openCircuit(1));
    b.advance(1);
    assert.equal((await b.respond(200)).status, 200, 'the next probe succeeds and closes it');
  });

  it('treats a probe the client abandoned as inconclusive and probes again', async () => {
    const b = harness();
    for (let i = 0; i < 3; i++) await b.respond(500);
    b.advance(5_000);
    await assert.rejects(b.throwError(new GatewayError(499, 'client_closed_request')), { status: 499 });
    // Still half-open: the next request is the new probe, and its failure re-opens the circuit at once.
    await b.respond(500);
    await assert.rejects(b.respond(200), openCircuit(5));
  });

  it('ignores results of requests admitted before the circuit opened', async () => {
    const b = harness();
    const slow = [deferred(), deferred(), deferred(), deferred()];
    const pending = slow.map((d) => b.call(() => d.promise));
    for (let i = 0; i < 3; i++) await b.respond(500); // opens at t = 0, cooldown ends at 5s

    slow[0]!.resolve(reply(200));
    await assert.rejects(b.respond(200), openCircuit(5), 'a late success does not close an open circuit');
    b.advance(4_000);
    for (const d of slow.slice(1)) d.resolve(reply(500));
    await Promise.all(pending);
    await assert.rejects(b.respond(200), openCircuit(1), 'late failures do not extend the cooldown');
    b.advance(1_000);
    assert.equal((await b.respond(200)).status, 200, 'the probe runs on the original schedule');
  });

  it('ignores failures from before the trip that settle after a successful probe', async () => {
    // Cooldown (5s) shorter than the time these requests stay pending: they
    // were admitted while closed and fail only after the circuit has recovered.
    const b = harness();
    const slow = [deferred(), deferred(), deferred()];
    const pending = slow.map((d) => b.call(() => d.promise));
    for (let i = 0; i < 3; i++) await b.respond(500); // opens
    b.advance(5_000);
    assert.equal((await b.respond(200)).status, 200, 'the probe succeeds and closes the circuit');

    for (const d of slow) d.resolve(reply(500));
    await Promise.all(pending);
    assert.equal((await b.respond(200)).status, 200, 'stale failures do not count against the new closed period');
  });
});

describe('circuit breaker through the gateway', () => {
  it('trips on upstream 5xx, answers 503 with retry_after, and recovers after the cooldown', async () => {
    let now = START;
    const mocks = await startMocks('ledger');
    const gateway = await startGateway(
      {
        gateway: { port: 9999, global_timeout: '2s' },
        routes: [
          {
            path: '/ledger',
            methods: ['GET'],
            upstream: { url: mocks.ledger.url },
            circuit_breaker: { threshold: 2, window: '1m', cooldown: '30s' },
          },
          { path: '/ledger-mirror', methods: ['GET'], upstream: { url: mocks.ledger.url } },
        ],
      },
      { now: () => now },
    );
    try {
      for (let i = 0; i < 2; i++) assert.equal((await fetch(`${gateway.url}/ledger/status/500`)).status, 500);

      const res = await fetch(`${gateway.url}/ledger/entries`);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('retry-after'), '30');
      assert.equal(await res.text(), '{"error":"service_unavailable","retry_after":30}');
      assert.equal(mocks.ledger.requests.length, 2, 'the open circuit never reached the upstream');

      assert.equal((await fetch(`${gateway.url}/ledger-mirror/entries`)).status, 200, 'state is per route');

      now += 30_000;
      assert.equal((await fetch(`${gateway.url}/ledger/entries`)).status, 200, 'the probe succeeds');
      assert.equal((await fetch(`${gateway.url}/ledger/entries`)).status, 200, 'closed again');
    } finally {
      await gateway.close();
      await mocks.closeAll();
    }
  });
});
