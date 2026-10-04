import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log, repoRoot, request, withGateway } from './harness.ts';

/** API-key auth: rejected requests never reach the upstream, and keys are never forwarded. */
export default async function auth(): Promise<void> {
  await withGateway(
    ['secret'],
    (m) => `routes:
  - path: "/internal"
    methods: ["GET"]
    upstream: { url: "${m.secret!.url}" }
    auth: { type: "api_key", header: "X-API-Key", keys: ["sk_live_abc123", "sk_live_def456"] }
`,
    async ({ base, mocks }) => {
      const cases: Array<[string, Record<string, string>]> = [
        ['no key', {}],
        ['wrong key', { 'x-api-key': 'sk_live_nope' }],
        ['valid key', { 'x-api-key': 'sk_live_abc123' }],
        ['second valid key, header case varied', { 'X-Api-KEY': 'sk_live_def456' }],
      ];
      for (const [name, headers] of cases) {
        const before = mocks.secret!.requests.length;
        const res = await request(base, '/internal/data', { headers });
        const reached = mocks.secret!.requests.length > before;
        const forwarded = reached && 'x-api-key' in mocks.secret!.requests.at(-1)!.headers;
        log(name, `${res.status} | reached upstream: ${reached} | key forwarded: ${forwarded}`);
      }
      // Raw socket, because Node's client would merge the duplicate itself.
      const statusLine = await new Promise<string>((resolve) => {
        const socket = net.connect(Number(new URL(base).port), '127.0.0.1', () =>
          socket.write('GET /internal/x HTTP/1.1\r\nHost: x\r\nX-API-Key: sk_live_abc123\r\nX-API-Key: sk_live_abc123\r\nConnection: close\r\n\r\n'),
        );
        let data = '';
        socket.on('data', (chunk) => (data += chunk));
        socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
      });
      log('duplicated X-API-Key header', statusLine);
    },
  );

  const configPath = join(mkdtempSync(join(tmpdir(), 'gatewaykit-qa-')), 'bad.yaml');
  writeFileSync(configPath, 'routes:\n  - path: /x\n    methods: [GET]\n    upstream: { url: "http://127.0.0.1:1" }\n    auth: { type: api_key, header: X-Request-Id, keys: [k] }\n');
  const result = spawnSync(process.execPath, ['src/main.ts', configPath], { cwd: repoRoot, encoding: 'utf8' });
  log('auth.header = X-Request-Id', `exit ${result.status}: ${result.stderr.trim().split('\n').at(-1)?.trim()}`);
}
