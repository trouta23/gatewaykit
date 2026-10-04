import { log, request, sleep, withGateway } from './harness.ts';

/** Rate limiting: the rubric's "50 requests hit a rate-limited route simultaneously", plus sliding windows. */
export default async function rateLimit(): Promise<void> {
  await withGateway(
    ['api'],
    (m) => `routes:
  - path: "/limited"
    methods: ["GET"]
    upstream: { url: "${m.api!.url}" }
    rate_limit: { requests: 10, window: "10s", strategy: "fixed_window", per: "ip" }
  - path: "/sliding"
    methods: ["GET"]
    upstream: { url: "${m.api!.url}" }
    rate_limit: { requests: 3, window: "1s", strategy: "sliding_window", per: "global" }
`,
    async ({ base, mocks }) => {
      const results = await Promise.all(Array.from({ length: 50 }, () => request(base, '/limited')));
      const count = (status: number) => results.filter((r) => r.status === status).length;
      log('50 concurrent vs limit 10', `200 x${count(200)}, 429 x${count(429)}; upstream saw ${mocks.api!.requests.length}`);
      const rejected = results.find((r) => r.status === 429)!;
      log('429 body', rejected.text);
      log('429 headers', `retry-after=${rejected.headers['retry-after']} x-ratelimit-remaining=${rejected.headers['x-ratelimit-remaining']}`);

      const sliding: number[] = [];
      for (let i = 0; i < 4; i++) sliding.push((await request(base, '/sliding')).status);
      log('sliding 3/1s, 4 back-to-back', sliding.join(' '));
      await sleep(1050);
      log('sliding, after the window passes', (await request(base, '/sliding')).status);
    },
  );
}
