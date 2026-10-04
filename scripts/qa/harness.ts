import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstream } from '../../mock/upstream.ts';
import type { MockUpstream } from '../../mock/upstream.ts';

// Manual QA harness. Unlike the test suite, which boots the gateway in-process,
// this spawns the real `node src/main.ts <config>` process against real mock
// upstreams, so it exercises exactly what an operator would run.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface QaResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

/** The mock upstream's echo of the request it received. */
export interface Echo {
  upstream: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface Scenario {
  base: string;
  mocks: Record<string, MockUpstream>;
  gateway: ChildProcess;
  output: () => string;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const echo = (res: QaResponse): Echo => JSON.parse(res.text) as Echo;

export function log(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(46)} ${String(value)}`);
}

/**
 * Sends a request with node:http so the path, framing headers and body go out
 * exactly as written (fetch would normalize "..", re-encode queries, and own framing).
 */
export function request(
  base: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<QaResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname, port, path, method: options.method ?? 'GET', headers: options.headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Writes a config file, starts mocks and the gateway process, runs the scenario, and cleans up. */
export async function withGateway(
  mockNames: readonly string[],
  routesYaml: (mocks: Record<string, MockUpstream>) => string,
  run: (scenario: Scenario) => Promise<void>,
): Promise<void> {
  const entries = await Promise.all(
    mockNames.map(async (name): Promise<[string, MockUpstream]> => [name, await startMockUpstream(name)]),
  );
  const mocks: Record<string, MockUpstream> = Object.fromEntries(entries);
  const port = await freePort();
  const configPath = join(mkdtempSync(join(tmpdir(), 'gatewaykit-qa-')), 'gateway.yaml');
  writeFileSync(configPath, `gateway:\n  port: ${port}\n${routesYaml(mocks)}`);

  const gateway = spawn(process.execPath, ['src/main.ts', configPath], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  gateway.stdout?.on('data', (data: Buffer) => (output += data));
  gateway.stderr?.on('data', (data: Buffer) => (output += data));
  for (let i = 0; i < 100 && !output.includes('listening'); i++) await sleep(50);
  try {
    if (!output.includes('listening')) throw new Error(`gateway did not start:\n${output}`);
    await run({ base: `http://127.0.0.1:${port}`, mocks, gateway, output: () => output });
  } finally {
    if (gateway.exitCode === null) gateway.kill('SIGKILL');
    await Promise.all(Object.values(mocks).map((mock) => mock.close()));
  }
}

export { repoRoot };
