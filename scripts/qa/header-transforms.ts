import { echo, log, request, withGateway } from './harness.ts';

/** Header transforms: dynamic values, removals, response headers, and forgery attempts. */
export default async function headerTransforms(): Promise<void> {
  await withGateway(
    ['legacy'],
    (m) => `routes:
  - path: "/legacy"
    methods: ["GET"]
    strip_prefix: true
    upstream: { url: "${m.legacy!.url}" }
    request_transform:
      headers:
        add: { X-Gateway: "gatewaykit", X-Request-Start: "$request_time", X-Route: "$route_path", X-Lit: "$literal:hello" }
        remove: ["X-Debug", "X-Internal"]
    response_transform:
      headers:
        add: { X-Served-By: "gatewaykit" }
        remove: ["Server", "X-Powered-By"]
`,
    async ({ base }) => {
      const res = await request(base, '/legacy/v1/data', {
        headers: { 'x-debug': '1', 'x-internal': 'secret', 'x-gateway': 'client-forged', connection: 'x-gateway' },
      });
      const up = echo(res).headers;
      log('upstream path (strip_prefix)', echo(res).url);
      log('X-Gateway (client forged it and nominated it)', up['x-gateway']);
      log('X-Request-Start / X-Route / X-Lit', `${up['x-request-start']} / ${up['x-route']} / ${up['x-lit']}`);
      log('X-Debug / X-Internal', `${up['x-debug'] ?? '(removed)'} / ${up['x-internal'] ?? '(removed)'}`);
      log('client: X-Served-By / Server', `${res.headers['x-served-by']} / ${res.headers.server ?? '(removed)'}`);
      const spoof = echo(await request(base, '/legacy/x', { headers: { connection: 'host', 'x-forwarded-host': 'attacker.example' } }));
      log('Connection: host + forged X-Forwarded-Host', `upstream saw ${spoof.headers['x-forwarded-host']}`);
      const notFound = await request(base, '/nope');
      log('gateway-generated 404 is not transformed', `${notFound.status} x-served-by=${notFound.headers['x-served-by'] ?? '(absent)'}`);
    },
  );
}
