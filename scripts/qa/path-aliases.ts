import { echo, log, request, withGateway } from './harness.ts';

/** Path aliases: a protected route next to a public catch-all on the same upstream. */
export default async function pathAliases(): Promise<void> {
  await withGateway(
    ['files'],
    (m) => `routes:
  - path: "/"
    methods: ["GET"]
    upstream: { url: "${m.files!.url}" }
  - path: "/DECISIONS.md"
    methods: ["GET"]
    upstream: { url: "${m.files!.url}" }
    auth: { type: "api_key", header: "X-API-Key", keys: ["sk_live_qa"] }
`,
    async ({ base, mocks }) => {
      const probe = async (path: string, headers: Record<string, string> = {}) => {
        const before = mocks.files!.requests.length;
        const res = await request(base, path, { headers });
        const reached = mocks.files!.requests.length > before;
        return `${res.status}${reached ? ` (upstream saw ${echo(res).url})` : ' (upstream never contacted)'}`;
      };
      log('/DECISIONS.md without a key', await probe('/DECISIONS.md'));
      log('/DECISIONS.md with a key', await probe('/DECISIONS.md', { 'x-api-key': 'sk_live_qa' }));
      for (const alias of ['/%44ECISIONS.md', '//DECISIONS.md', '/public/..%2fDECISIONS.md', '/x/..;/DECISIONS.md', '/%2544ECISIONS.md']) {
        log(`alias ${alias}`, await probe(alias));
      }
      log('public path still public', await probe('/index.html'));
    },
  );
}
