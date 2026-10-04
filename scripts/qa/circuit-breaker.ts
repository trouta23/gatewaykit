import { log, request, sleep, withGateway } from './harness.ts';

/** Circuit breaker: trip, fail fast with the spec'd 503 body, single probe after cooldown, recovery. */
export default async function circuitBreaker(): Promise<void> {
  await withGateway(
    ['svc'],
    (m) => `routes:
  - path: "/svc"
    methods: ["GET"]
    strip_prefix: true
    upstream: { url: "${m.svc!.url}" }
    circuit_breaker: { threshold: 3, window: "10s", cooldown: "1s" }
`,
    async ({ base, mocks }) => {
      // The mock's /flaky?fail=4 fails its first 4 requests, then succeeds.
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await request(base, '/svc/flaky?fail=4')).status);
      log('5 requests, upstream failing (threshold 3)', `${statuses.join(' ')} | upstream saw ${mocks.svc!.requests.length}`);
      const open = await request(base, '/svc/flaky?fail=4');
      log('while open', `${open.text} retry-after=${open.headers['retry-after']}`);
      await sleep(1100);
      log('after cooldown, probe while still failing', (await request(base, '/svc/flaky?fail=4')).status);
      log('right after the failed probe (re-opened)', (await request(base, '/svc/flaky?fail=4')).status);
      await sleep(1100);
      log('after 2nd cooldown, probe recovers', (await request(base, '/svc/flaky?fail=4')).status);
      log('closed again', (await request(base, '/svc/ok')).status);
      const clientErrors: number[] = [];
      for (let i = 0; i < 5; i++) clientErrors.push((await request(base, '/svc/status/404')).status);
      log('5 x upstream 404 (4xx is not a failure)', clientErrors.join(' '));
    },
  );
}
