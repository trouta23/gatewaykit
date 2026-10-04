import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { echo, log, repoRoot, request, withGateway } from './harness.ts';

/** Core: /health, routing, 404/405, strip_prefix, 502/504, raw paths and queries, request smuggling, bad config. */
export default async function core(): Promise<void> {
  await withGateway(
    ['shop', 'catalog'],
    (m) => `  global_timeout: "2s"
routes:
  - path: "/shop"
    methods: ["GET", "POST"]
    upstream: { url: "${m.shop!.url}" }
  - path: "/catalog"
    methods: ["GET"]
    strip_prefix: true
    upstream: { url: "${m.catalog!.url}", timeout: "300ms" }
  - path: "/dead"
    methods: ["GET"]
    upstream: { url: "http://127.0.0.1:1" }
`,
    async ({ base }) => {
      log('GET /health', (await request(base, '/health')).text);
      const proxied = echo(await request(base, '/shop/items/7?sort=desc'));
      log('GET /shop/items/7?sort=desc', `upstream=${proxied.upstream} ${proxied.method} ${proxied.url}`);
      log('GET /catalog/123 (strip_prefix)', echo(await request(base, '/catalog/123?q=1')).url);
      const notAllowed = await request(base, '/catalog', { method: 'POST', body: 'x' });
      log('POST /catalog (GET only)', `${notAllowed.status} allow=${notAllowed.headers.allow}`);
      log('GET /nowhere', (await request(base, '/nowhere')).status);
      log('GET /dead (nothing listening)', (await request(base, '/dead')).text);
      const started = Date.now();
      const slow = await request(base, '/catalog/slow?ms=2000');
      log('GET slow upstream (300ms route timeout)', `${slow.status} after ${Date.now() - started}ms`);
      const hop = echo(await request(base, '/catalog/../shop/x'));
      log('raw "/catalog/../shop/x"', `upstream=${hop.upstream} ${hop.url}`);
      log("raw query \"?name='o''neil'&flag\"", echo(await request(base, "/shop/q?name='o''neil'&flag")).url);

      const smuggled = 'GET /shop/SMUGGLED HTTP/1.1\r\nHost: x\r\n\r\n';
      for (const [name, headers] of [
        ['smuggling: chunked GET', { 'transfer-encoding': 'chunked' }],
        ['smuggling: Connection: content-length', { 'content-length': String(smuggled.length), connection: 'content-length' }],
      ] as const) {
        const res = echo(await request(base, '/shop/visible', { headers, body: smuggled }));
        log(name, `upstream saw ${res.url}; payload stayed in the body: ${res.body === smuggled}`);
      }
    },
  );

  const configPath = join(mkdtempSync(join(tmpdir(), 'gatewaykit-qa-')), 'bad.yaml');
  writeFileSync(configPath, 'gateway:\n  port: 80800\nroutes:\n  - path: /a\n    methods: [FETCH]\n    upstream: { url: "ftp://x" }\n    auht: {}\n');
  const result = spawnSync(process.execPath, ['src/main.ts', configPath], { cwd: repoRoot, encoding: 'utf8' });
  log('malformed config', `exit ${result.status}`);
  for (const line of result.stderr.trim().split('\n').slice(1)) log('', line.trim());
}
