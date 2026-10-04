import http from 'node:http';
import { log, request, withGateway } from './harness.ts';

/** Retry: backoff, idempotent-only replay, the shared deadline, and stalled uploads. */
export default async function retry(): Promise<void> {
  await withGateway(
    ['orders'],
    (m) => `routes:
  - path: "/orders"
    methods: ["GET", "POST", "PUT"]
    upstream: { url: "${m.orders!.url}", timeout: "2s" }
    retry: { attempts: 3, backoff: "exponential", initial_delay: "100ms", on: [502, 503, 504] }
  - path: "/tight"
    methods: ["GET", "PUT"]
    upstream: { url: "${m.orders!.url}", timeout: "250ms" }
    retry: { attempts: 3, backoff: "fixed", initial_delay: "200ms", on: [503] }
    circuit_breaker: { threshold: 2, window: "10s", cooldown: "5s" }
`,
    async ({ base, mocks }) => {
      const sent = () => mocks.orders!.requests.length;
      let before = sent();
      let started = Date.now();
      const flaky = await request(base, '/orders/flaky?fail=2');
      log('GET flaky (fails twice), attempts 3', `${flaky.status} after ${Date.now() - started}ms; upstream saw ${sent() - before}`);

      before = sent();
      const post = await request(base, '/orders/status/503', { method: 'POST', body: '{"sku":1}' });
      log('POST to an always-503 upstream', `${post.status}; upstream saw ${sent() - before} (POST is never retried)`);

      before = sent();
      const body = '{"qty":2}';
      const put = await request(base, '/orders/status/503', { method: 'PUT', headers: { 'content-length': String(body.length) }, body });
      const bodies = mocks.orders!.requests.slice(before).map((r) => r.body);
      log('PUT to an always-503 upstream', `${put.status}; upstream saw ${bodies.length}, same body each time: ${bodies.every((b) => b === body)}`);

      before = sent();
      started = Date.now();
      const tight = await request(base, '/tight/status/503');
      log('250ms deadline, 200ms backoff', `${tight.status} after ${Date.now() - started}ms; upstream saw ${sent() - before}`);

      for (const n of [1, 2]) log(`stalled upload #${n} (retry + breaker route)`, await stalledPut(base));
      log('healthy GET afterwards (breaker stays closed)', (await request(base, '/tight/ok')).status);
    },
  );
}

/** Sends 7 of a promised 100 body bytes, then stalls. */
function stalledPut(base: string): Promise<string> {
  const { hostname, port } = new URL(base);
  const started = Date.now();
  return new Promise((resolve) => {
    const req = http.request({ hostname, port, path: '/tight/upload', method: 'PUT', headers: { 'content-length': '100' }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(`${res.statusCode} after ${Date.now() - started}ms, connection: ${res.headers.connection}`));
    });
    req.on('error', (error: NodeJS.ErrnoException) => resolve(String(error.code)));
    req.write('partial');
  });
}
