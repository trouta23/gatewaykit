import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { RouteConfig } from '../src/config/types.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { BuildContext } from '../src/pipeline.ts';
import { createBalancer } from '../src/upstream/balancer.ts';
import { startHealthChecks } from '../src/upstream/health.ts';
import type { HealthChecker } from '../src/upstream/health.ts';
import { startGateway, startMocks } from './helpers.ts';

/** A route over hosts a, b, c... with the given weights and a health check. */
function routeWith(balance: string, weights: number[], unhealthyThreshold = 2): RouteConfig {
  const targets = weights.map((weight, i) => ({ url: `http://${String.fromCharCode(97 + i)}.test/base`, weight }));
  return validateConfig({
    routes: [
      {
        path: '/svc',
        methods: ['GET'],
        upstream: { targets, balance },
        health_check: { path: '/healthz', interval: '10s', unhealthy_threshold: unhealthyThreshold },
      },
    ],
  }).routes[0]!;
}

/** Health checks driven by hand: `down` holds the hosts whose probes fail. */
function harness(route: RouteConfig) {
  const cleanups: Array<() => void> = [];
  const ctx: BuildContext = { now: () => 0, onClose: (cleanup) => cleanups.push(cleanup) };
  const down = new Set<string>();
  const probed: string[] = [];
  const checker = startHealthChecks(route.upstream.targets, route.features.health_check!, ctx, async (target, path) => {
    probed.push(`${target.origin}${path}`);
    return !down.has(target.hostname.replace('.test', ''));
  });
  const healthy = (name: string): boolean => checker.isHealthy(route.upstream.targets.find((t) => t.url.hostname === `${name}.test`)!);
  const select = createBalancer(route, ctx, checker);
  const picks = (count: number): string[] => Array.from({ length: count }, () => select().url.hostname.replace('.test', ''));
  return { ctx, checker, down, probed, healthy, picks, close: () => cleanups.forEach((cleanup) => cleanup()) };
}

async function rounds(checker: HealthChecker, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await checker.checkNow();
}

describe('health checker', () => {
  it('probes GET target + path, keeping the target base path', async () => {
    const h = harness(routeWith('round_robin', [1, 1]));
    await h.checker.checkNow();
    assert.deepEqual(h.probed, ['http://a.test/base/healthz', 'http://b.test/base/healthz']);
    h.close();
  });

  it('marks a target unhealthy only after unhealthy_threshold consecutive failures', async () => {
    const h = harness(routeWith('round_robin', [1, 1], 3));
    assert.equal(h.healthy('a'), true, 'targets start healthy');
    h.down.add('a');
    await rounds(h.checker, 2);
    assert.equal(h.healthy('a'), true, 'two failures are below the threshold of three');
    await rounds(h.checker, 1);
    assert.equal(h.healthy('a'), false);
    assert.equal(h.healthy('b'), true);
    h.close();
  });

  it('only counts consecutive failures', async () => {
    const h = harness(routeWith('round_robin', [1, 1], 3));
    h.down.add('a');
    await rounds(h.checker, 2);
    h.down.delete('a');
    await rounds(h.checker, 1);
    h.down.add('a');
    await rounds(h.checker, 2);
    assert.equal(h.healthy('a'), true, 'the success in between reset the count');
    h.close();
  });

  it('recovers after a single successful probe', async () => {
    const h = harness(routeWith('round_robin', [1, 1], 2));
    h.down.add('a');
    await rounds(h.checker, 2);
    assert.equal(h.healthy('a'), false);
    h.down.delete('a');
    await rounds(h.checker, 1);
    assert.equal(h.healthy('a'), true);
    h.close();
  });

  it('treats a probe that throws as a failure', async () => {
    const route = routeWith('round_robin', [1], 1);
    const cleanups: Array<() => void> = [];
    const ctx: BuildContext = { now: () => 0, onClose: (cleanup) => cleanups.push(cleanup) };
    const checker = startHealthChecks(route.upstream.targets, route.features.health_check!, ctx, () =>
      Promise.reject(new Error('connection refused')),
    );
    await checker.checkNow();
    assert.equal(checker.isHealthy(route.upstream.targets[0]!), false);
    cleanups.forEach((cleanup) => cleanup());
  });

  it('probes on every interval tick and stops once the gateway closes', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    // Lets the previous round's probes settle; until then the in-flight guard skips a target.
    const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const h = harness(routeWith('round_robin', [1, 1]));
    t.mock.timers.tick(10_000);
    assert.equal(h.probed.length, 2, 'one probe per target per tick');
    await settle();
    t.mock.timers.tick(10_000);
    assert.equal(h.probed.length, 4);
    h.close();
    t.mock.timers.tick(30_000);
    assert.equal(h.probed.length, 4, 'no probes after close');
  });
});

/** A bare upstream that records each raw request target and answers with `status`, or never answers. */
async function listen(port: number, status: number | 'hang' = 200) {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    if (status !== 'hang') res.writeHead(status).end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  return { seen, port: (server.address() as AddressInfo).port, close };
}

/** fetch() refuses these ports before connecting (the WHATWG "bad ports" list). Binds the first free one. */
async function listenOnPortFetchRefuses(): Promise<Awaited<ReturnType<typeof listen>>> {
  for (const port of [6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080]) {
    try {
      return await listen(port);
    } catch {
      // In use: try the next one.
    }
  }
  throw new Error('no fetch-refused port is free');
}

/** Runs one round of real HTTP probes against `url + path` and reports whether the target is healthy. */
async function probeOnce(url: string, path: string, interval = '10s'): Promise<boolean> {
  const route = validateConfig({
    routes: [
      { path: '/svc', methods: ['GET'], upstream: { url }, health_check: { path, interval, unhealthy_threshold: 1 } },
    ],
  }).routes[0]!;
  const cleanups: Array<() => void> = [];
  const ctx: BuildContext = { now: () => 0, onClose: (cleanup) => cleanups.push(cleanup) };
  const checker = startHealthChecks(route.upstream.targets, route.features.health_check!, ctx);
  try {
    await checker.checkNow();
    return checker.isHealthy(route.upstream.targets[0]!);
  } finally {
    cleanups.forEach((cleanup) => cleanup());
  }
}

describe('HTTP probe', () => {
  it('reaches targets on ports that fetch() refuses', async () => {
    const upstream = await listenOnPortFetchRefuses();
    try {
      assert.equal(await probeOnce(`http://127.0.0.1:${upstream.port}`, '/healthz'), true);
      assert.deepEqual(upstream.seen, ['/healthz']);
    } finally {
      await upstream.close();
    }
  });

  it('sends base path + health path raw, query string included', async () => {
    const upstream = await listen(0);
    try {
      assert.equal(await probeOnce(`http://127.0.0.1:${upstream.port}/base/`, '/healthz?ready=1'), true);
      assert.deepEqual(upstream.seen, ['/base/healthz?ready=1']);
    } finally {
      await upstream.close();
    }
  });

  it('treats non-2xx answers and timeouts as failures', async () => {
    const failing = await Promise.all([listen(0, 503), listen(0, 302), listen(0, 'hang')]);
    try {
      for (const upstream of failing) {
        assert.equal(await probeOnce(`http://127.0.0.1:${upstream.port}`, '/healthz', '50ms'), false);
      }
    } finally {
      await Promise.all(failing.map((upstream) => upstream.close()));
    }
  });
});

describe('health-aware balancing', () => {
  it('round robin skips unhealthy targets', async () => {
    const h = harness(routeWith('round_robin', [1, 1, 1], 1));
    h.down.add('b');
    await h.checker.checkNow();
    assert.deepEqual(h.picks(4), ['a', 'c', 'a', 'c']);
    h.close();
  });

  it('weighted round robin skips unhealthy targets and keeps the rest in proportion', async () => {
    const h = harness(routeWith('weighted_round_robin', [5, 2, 1], 1));
    h.down.add('a');
    await h.checker.checkNow();
    assert.deepEqual(h.picks(6), ['b', 'c', 'b', 'b', 'c', 'b']);
    h.close();
  });

  it('a recovered target rejoins the rotation', async () => {
    const h = harness(routeWith('round_robin', [1, 1], 1));
    h.down.add('b');
    await h.checker.checkNow();
    assert.deepEqual(h.picks(2), ['a', 'a']);
    h.down.delete('b');
    await h.checker.checkNow();
    assert.deepEqual(h.picks(2), ['b', 'a']);
    h.close();
  });

  it('fails open across all targets when every target is unhealthy', async () => {
    const h = harness(routeWith('round_robin', [1, 1], 1));
    h.down.add('a').add('b');
    await h.checker.checkNow();
    assert.equal(h.healthy('a'), false);
    assert.equal(h.healthy('b'), false);
    assert.deepEqual(h.picks(4), ['a', 'b', 'a', 'b']);
    h.close();
  });
});

describe('health checks through the gateway', () => {
  it('stops sending traffic to a failing target and resumes once it recovers', async () => {
    const mocks = await startMocks('steady', 'shaky');
    const gateway = await startGateway({
      routes: [
        {
          path: '/svc',
          methods: ['GET'],
          upstream: { targets: [{ url: mocks.steady.url }, { url: mocks.shaky.url }] },
          health_check: { path: '/healthz', interval: '50ms', unhealthy_threshold: 2 },
        },
      ],
    });
    const upstreamOf = async (): Promise<string | null> => {
      const res = await fetch(`${gateway.url}/svc`);
      await res.arrayBuffer();
      return res.headers.get('x-upstream');
    };
    /** Polls until `condition` holds, so the test waits only as long as it has to. */
    const until = async (condition: () => Promise<boolean>, what: string): Promise<void> => {
      const deadline = Date.now() + 3_000;
      while (!(await condition())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
        await sleep(20);
      }
    };

    try {
      assert.ok(!gateway.logs.some((l) => l.level === 'warn'), 'health_check is a supported feature');

      mocks.shaky.setHealthy(false);
      // Under round robin, two answers in a row from "steady" mean "shaky" was skipped.
      await until(async () => (await upstreamOf()) === 'steady' && (await upstreamOf()) === 'steady', 'shaky is skipped');
      const shakyBefore = mocks.shaky.requests.length;
      for (let i = 0; i < 6; i++) assert.equal(await upstreamOf(), 'steady');
      assert.equal(mocks.shaky.requests.length, shakyBefore, 'no traffic reaches the unhealthy target');

      mocks.shaky.setHealthy(true);
      await until(async () => (await upstreamOf()) === 'shaky', 'shaky receives traffic again');
    } finally {
      await gateway.close();
      await mocks.closeAll();
    }
  });
});
