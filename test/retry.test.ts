import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { validateConfig } from '../src/config/validate.ts';
import { GatewayError } from '../src/pipeline.ts';
import type { Body, GatewayRequest, GatewayResponse, Handler } from '../src/pipeline.ts';
import { MAX_REPLAY_BODY_BYTES, backoffMs, retryPlugin } from '../src/plugins/retry.ts';
import { startGateway, startMocks } from './helpers.ts';
import type { TestGateway } from './helpers.ts';

function routeWithRetry(retry: Record<string, unknown>) {
  return validateConfig({
    gateway: { port: 9999 },
    routes: [{ path: '/svc', methods: ['GET', 'PUT', 'POST'], upstream: { url: 'http://127.0.0.1:1' }, retry }],
  }).routes[0]!;
}

const DEFAULT_RETRY = { attempts: 3, backoff: 'fixed', initial_delay: '1ms', on: [502, 503, 504] };

function buildRetry(retry: Record<string, unknown> = DEFAULT_RETRY, now: () => number = Date.now) {
  const middleware = retryPlugin.build(routeWithRetry(retry), { now, onClose: () => {} });
  assert.ok(middleware);
  return middleware;
}

function request(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    id: 'req-1',
    method: 'GET',
    path: '/svc',
    upstreamPath: '/svc',
    query: '',
    headers: {},
    body: undefined,
    clientIp: '127.0.0.1',
    receivedAt: new Date(),
    deadline: Date.now() + 5_000,
    signal: new AbortController().signal,
    route: routeWithRetry(DEFAULT_RETRY),
    ...overrides,
  };
}

/** A fake upstream that plays back one scripted outcome per call and records what it saw. */
function scripted(...outcomes: Array<number | GatewayError>) {
  const seen: GatewayRequest[] = [];
  const bodies: Readable[] = [];
  const next: Handler = async (req) => {
    seen.push(req);
    const outcome = outcomes[Math.min(seen.length, outcomes.length) - 1]!;
    if (outcome instanceof GatewayError) throw outcome;
    const body = Readable.from([Buffer.from(`attempt ${seen.length}`)]);
    bodies.push(body);
    return { status: outcome, headers: {}, body } satisfies GatewayResponse;
  };
  return { next, seen, bodies };
}

describe('retry plugin', () => {
  it('is not built for a route without a retry block', () => {
    const route = validateConfig({
      gateway: { port: 9999 },
      routes: [{ path: '/svc', methods: ['GET'], upstream: { url: 'http://127.0.0.1:1' } }],
    }).routes[0]!;
    assert.equal(retryPlugin.build(route, { now: Date.now, onClose: () => {} }), undefined);
  });

  it('retries a configured status until an attempt succeeds', async () => {
    const upstream = scripted(503, 502, 200);
    const res = await buildRetry()(upstream.next)(request());
    assert.equal(res.status, 200);
    assert.equal(upstream.seen.length, 3);
  });

  it('stops after `attempts` total tries and returns the last response as-is', async () => {
    const upstream = scripted(503);
    const res = await buildRetry()(upstream.next)(request());
    assert.equal(res.status, 503);
    assert.equal(upstream.seen.length, 3);
    assert.equal(res.body, upstream.bodies[2]);
    assert.equal(upstream.bodies[2]!.destroyed, false);
  });

  it('destroys the body of every discarded attempt', async () => {
    const upstream = scripted(503, 503, 200);
    await buildRetry()(upstream.next)(request());
    assert.deepEqual(
      upstream.bodies.map((b) => b.destroyed),
      [true, true, false],
    );
  });

  it('never retries a POST', async () => {
    const upstream = scripted(503, 200);
    const res = await buildRetry()(upstream.next)(request({ method: 'POST' }));
    assert.equal(res.status, 503);
    assert.equal(upstream.seen.length, 1);
  });

  it('retries a thrown 502 or 504 from the forwarder, and rethrows the last one', async () => {
    const upstream = scripted(new GatewayError(502, 'bad_gateway'), new GatewayError(504, 'gateway_timeout'));
    await assert.rejects(buildRetry()(upstream.next)(request()), { status: 504 });
    assert.equal(upstream.seen.length, 3);
  });

  it('returns a status not in `on` without retrying', async () => {
    const upstream = scripted(500, 200);
    const res = await buildRetry()(upstream.next)(request());
    assert.equal(res.status, 500);
    assert.equal(upstream.seen.length, 1);
  });

  it('rethrows a client-gone 499 or a non-gateway error without retrying', async () => {
    // As in the forwarder: the client's signal is aborted when a 499 is thrown.
    const client = new AbortController();
    const gone = scripted(new GatewayError(499, 'client_closed_request'), 200);
    const goneNext: Handler = (req) => {
      client.abort();
      return gone.next(req);
    };
    const req = request({ signal: client.signal });
    await assert.rejects(buildRetry({ ...DEFAULT_RETRY, on: [499, 503] })(goneNext)(req), { status: 499 });
    assert.equal(gone.seen.length, 1);

    let calls = 0;
    const bug: Handler = async () => {
      calls += 1;
      throw new TypeError('boom');
    };
    await assert.rejects(buildRetry()(bug)(request()), TypeError);
    assert.equal(calls, 1);
  });

  it('replays the same buffered body on every attempt', async () => {
    const upstream = scripted(503, 503, 200);
    const stream = Readable.from([Buffer.from('{"name":'), Buffer.from('"ada"}')]);
    await buildRetry()(upstream.next)(request({ method: 'PUT', headers: { 'content-length': '14' }, body: stream }));
    assert.equal(upstream.seen.length, 3);
    for (const seen of upstream.seen) assert.deepEqual(seen.body, Buffer.from('{"name":"ada"}'));
  });

  it('forwards no body when the request declares none', async () => {
    const upstream = scripted(200);
    await buildRetry()(upstream.next)(request({ body: Readable.from([]) as Body }));
    assert.equal(upstream.seen[0]!.body, undefined);
  });

  it('rejects a body too large to buffer with 413 before calling upstream', async () => {
    const upstream = scripted(200);
    // Still uploading: the gateway must answer without waiting for (or destroying) the rest.
    const big = new Readable({ read() {} });
    big.push(Buffer.alloc(MAX_REPLAY_BODY_BYTES));
    big.push(Buffer.alloc(1));
    const req = request({ method: 'PUT', headers: { 'transfer-encoding': 'chunked' }, body: big });
    await assert.rejects(buildRetry()(upstream.next)(req), { status: 413, code: 'payload_too_large' });
    assert.equal(upstream.seen.length, 0);
    assert.equal(big.destroyed, false);
  });

  it('answers 408 when the body stalls past the deadline, pausing the stream instead of destroying it', { timeout: 2_000 }, async () => {
    const upstream = scripted(200);
    const stalled = new Readable({ read() {} });
    stalled.push('partial');
    const req = request({ method: 'PUT', headers: { 'content-length': '100' }, body: stalled, deadline: Date.now() + 20 });
    await assert.rejects(buildRetry()(upstream.next)(req), { status: 408, code: 'request_timeout' });
    assert.equal(upstream.seen.length, 0);
    assert.equal(stalled.destroyed, false);
    assert.equal(stalled.isPaused(), true);
    assert.equal(stalled.listenerCount('data'), 0);
  });

  it('does not start a retry whose backoff would end past the deadline', async () => {
    const upstream = scripted(503, 200);
    const handler = buildRetry({ ...DEFAULT_RETRY, initial_delay: '20ms' }, () => 1_000)(upstream.next);
    const res = await handler(request({ deadline: 1_000 + 20 }));
    assert.equal(res.status, 503);
    assert.equal(upstream.seen.length, 1);
    assert.equal(upstream.bodies[0]!.destroyed, false);
  });

  it('answers 499 when the client leaves during the backoff wait', async () => {
    const client = new AbortController();
    const upstream = scripted(503, 200);
    // setImmediate runs after the plugin's microtasks, so the abort lands mid-wait.
    const leaveAfterFirstAttempt: Handler = async (req) => {
      setImmediate(() => client.abort());
      return upstream.next(req);
    };
    const handler = buildRetry({ ...DEFAULT_RETRY, initial_delay: '1s' })(leaveAfterFirstAttempt);
    await assert.rejects(handler(request({ signal: client.signal })), { status: 499 });
    assert.equal(upstream.seen.length, 1);
  });

  it('computes fixed and exponential backoff', () => {
    const fixed = routeWithRetry({ ...DEFAULT_RETRY, initial_delay: '100ms' }).features.retry!;
    const exponential = routeWithRetry({ ...DEFAULT_RETRY, backoff: 'exponential', initial_delay: '100ms' }).features.retry!;
    assert.deepEqual([1, 2, 3].map((n) => backoffMs(fixed, n)), [100, 100, 100]);
    assert.deepEqual([1, 2, 3].map((n) => backoffMs(exponential, n)), [100, 200, 400]);
  });
});

describe('retry through the gateway', () => {
  let mocks: Awaited<ReturnType<typeof startMocks<'flakyGet' | 'flakyPut' | 'flakyPost'>>>;
  let gateway: TestGateway;

  before(async () => {
    mocks = await startMocks('flakyGet', 'flakyPut', 'flakyPost');
    const retry = { attempts: 3, backoff: 'exponential', initial_delay: '5ms', on: [503] };
    gateway = await startGateway({
      gateway: { port: 9999, global_timeout: '2s' },
      routes: [
        { path: '/inventory', methods: ['GET'], upstream: { url: mocks.flakyGet.url }, retry },
        { path: '/profile', methods: ['PUT'], upstream: { url: mocks.flakyPut.url }, retry },
        { path: '/upload', methods: ['PUT'], upstream: { url: mocks.flakyPut.url, timeout: '100ms' }, retry },
        {
          path: '/guarded',
          methods: ['GET', 'PUT'],
          upstream: { url: mocks.flakyPut.url, timeout: '100ms' },
          retry,
          circuit_breaker: { threshold: 2, window: '10s', cooldown: '10s' },
        },
        { path: '/checkout', methods: ['POST'], upstream: { url: mocks.flakyPost.url }, retry },
      ],
    });
  });

  after(async () => {
    await gateway.close();
    await mocks.closeAll();
  });

  /** A PUT that declares 100 bytes, sends a few, then stalls until the gateway answers. */
  function stalledUpload(path: string): Promise<http.IncomingMessage> {
    const { hostname, port } = new URL(gateway.url);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname, port, path, method: 'PUT', headers: { 'content-length': '100' } });
      req.on('response', (res) => {
        res.resume();
        resolve(res);
      });
      req.on('error', reject);
      req.write('only part of the body');
    });
  }

  it('a GET that fails twice succeeds on the third attempt', async () => {
    const res = await fetch(`${gateway.url}/inventory/flaky?fail=2`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).upstream, 'flakyGet');
    assert.equal(mocks.flakyGet.requests.length, 3);
  });

  it('a PUT body reaches the upstream intact on every attempt', async () => {
    const res = await fetch(`${gateway.url}/profile/flaky?fail=2`, { method: 'PUT', body: '{"name":"ada"}' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).body, '{"name":"ada"}');
    assert.deepEqual(
      mocks.flakyPut.requests.map((r) => r.body),
      ['{"name":"ada"}', '{"name":"ada"}', '{"name":"ada"}'],
    );
  });

  // Regression: buffering for replay happens before the forwarder arms its deadline
  // timer, so a stalled upload used to hold the request open indefinitely.
  it('a PUT whose body stalls gets a 408 at the route timeout and the connection is closed', { timeout: 2_000 }, async () => {
    const started = Date.now();
    const res = await stalledUpload('/upload/x');
    assert.equal(res.statusCode, 408);
    assert.equal(res.headers.connection, 'close');
    assert.ok(Date.now() - started < 1_000);
    assert.equal(mocks.flakyPut.requests.filter((r) => r.url.startsWith('/upload')).length, 0);
  });

  // Regression: the stall used to answer 504, which the circuit breaker counts as an
  // upstream failure, so slow clients could open the breaker for everyone.
  it('stalled uploads do not open the circuit breaker', { timeout: 2_000 }, async () => {
    assert.equal((await stalledUpload('/guarded/x')).statusCode, 408);
    assert.equal((await stalledUpload('/guarded/x')).statusCode, 408);
    const res = await fetch(`${gateway.url}/guarded/healthy`);
    assert.equal(res.status, 200);
    await res.body?.cancel();
  });

  it('a POST reaches the upstream exactly once', async () => {
    const res = await fetch(`${gateway.url}/checkout/flaky?fail=2`, { method: 'POST', body: '{"sku":1}' });
    assert.equal(res.status, 503);
    await res.body?.cancel();
    assert.equal(mocks.flakyPost.requests.length, 1);
  });
});
