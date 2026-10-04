import { log, request, sleep, withGateway } from './harness.ts';

/** Active health checks: skip unhealthy targets, fail open when all are down, recover. */
export default async function healthChecks(): Promise<void> {
  await withGateway(
    ['a', 'b'],
    (m) => `routes:
  - path: "/products"
    methods: ["GET"]
    strip_prefix: true
    upstream:
      targets: [{ url: "${m.a!.url}" }, { url: "${m.b!.url}" }]
      balance: round_robin
    health_check: { path: "/healthz", interval: "100ms", unhealthy_threshold: 2 }
`,
    async ({ base, mocks }) => {
      const sample = async () => {
        const seen: string[] = [];
        for (let i = 0; i < 6; i++) seen.push(String((await request(base, '/products/1')).headers['x-upstream']));
        return seen.join(' ');
      };
      log('both healthy', await sample());
      mocks.b!.setHealthy(false);
      await sleep(400);
      log('b failing /healthz (threshold 2)', await sample());
      mocks.a!.setHealthy(false);
      await sleep(400);
      log('both failing: fail open to all targets', await sample());
      mocks.a!.setHealthy(true);
      mocks.b!.setHealthy(true);
      await sleep(250);
      log('both recovered', await sample());
    },
  );
}
