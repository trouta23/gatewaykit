import { echo, log, request, sleep, withGateway } from './harness.ts';

/** Transport: header hygiene, X-Forwarded-For, graceful shutdown with an in-flight request. */
export default async function transport(): Promise<void> {
  await withGateway(
    ['up'],
    (m) => `routes:
  - path: "/up"
    methods: ["GET"]
    upstream: { url: "${m.up!.url}" }
`,
    async ({ base, gateway }) => {
      const seen = echo(
        await request(base, '/up/echo', {
          headers: { connection: 'keep-alive, x-secret-hop', 'x-secret-hop': 'drop-me', 'keep-alive': 'timeout=5', 'x-forwarded-for': '6.6.6.6', 'x-keep': 'yes' },
        }),
      ).headers;
      log('hop-by-hop + Connection-listed headers', `x-secret-hop=${seen['x-secret-hop'] ?? '(stripped)'} keep-alive=${seen['keep-alive'] ?? '(stripped)'} x-keep=${seen['x-keep']}`);
      log('spoofed X-Forwarded-For 6.6.6.6', `upstream saw ${seen['x-forwarded-for']}`);

      const started = Date.now();
      const inflight = request(base, '/up/slow?ms=800');
      await sleep(150);
      gateway.kill('SIGTERM');
      const done = await inflight;
      const exitCode = await new Promise<number | null>((resolve) =>
        gateway.exitCode !== null ? resolve(gateway.exitCode) : gateway.once('exit', (code) => resolve(code)),
      );
      log('SIGTERM during an 800ms request', `request ${done.status} after ${Date.now() - started}ms; exit code ${exitCode}`);
      log('new request after shutdown', await request(base, '/up/echo').then((r) => r.status, (error: NodeJS.ErrnoException) => error.code));
    },
  );
}
