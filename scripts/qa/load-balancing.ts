import { log, request, withGateway } from './harness.ts';

/** Load balancing: smooth weighted round robin spreads 3:1 as a a b a, plain round robin ignores weights. */
export default async function loadBalancing(): Promise<void> {
  await withGateway(
    ['a', 'b'],
    (m) => `routes:
  - path: "/weighted"
    methods: ["GET"]
    upstream:
      targets: [{ url: "${m.a!.url}", weight: 3 }, { url: "${m.b!.url}", weight: 1 }]
      balance: weighted_round_robin
  - path: "/rr"
    methods: ["GET"]
    upstream:
      targets: [{ url: "${m.a!.url}", weight: 5 }, { url: "${m.b!.url}", weight: 1 }]
      balance: round_robin
`,
    async ({ base }) => {
      const pick = async (path: string, n: number) => {
        const seen: string[] = [];
        for (let i = 0; i < n; i++) seen.push(String((await request(base, path)).headers['x-upstream']));
        return seen.join(' ');
      };
      log('weighted 3:1, 8 requests', await pick('/weighted', 8));
      log('round_robin with weights 5:1', await pick('/rr', 4));
    },
  );
}
