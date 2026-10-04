import { startMockUpstream } from '../mock/upstream.ts';
import type { MockUpstream } from '../mock/upstream.ts';
import { validateConfig } from '../src/config/validate.ts';
import { createGateway } from '../src/server.ts';
import type { GatewayOptions } from '../src/server.ts';

export interface TestGateway {
  url: string;
  logs: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Boots a gateway on an ephemeral port from a raw (YAML-shaped) config object. */
export async function startGateway(rawConfig: unknown, options: GatewayOptions = {}): Promise<TestGateway> {
  const logs: Array<Record<string, unknown>> = [];
  const gateway = createGateway(validateConfig(rawConfig), { log: (entry) => logs.push(entry), ...options });
  const port = await gateway.listen(0);
  return { url: `http://127.0.0.1:${port}`, logs, close: () => gateway.close() };
}

/** Starts named mock upstreams and returns them with a single close(). */
export async function startMocks<const N extends string>(...names: N[]) {
  const mocks = await Promise.all(names.map((name) => startMockUpstream(name)));
  const byName = Object.fromEntries(mocks.map((m) => [m.name, m])) as Record<N, MockUpstream>;
  return { ...byName, closeAll: () => Promise.all(mocks.map((m) => m.close())) };
}

/** A local URL with nothing listening, for "upstream is down" scenarios. */
export const DEAD_UPSTREAM = 'http://127.0.0.1:1';
