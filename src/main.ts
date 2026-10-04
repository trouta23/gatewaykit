import { loadConfig } from './config/load.ts';
import { ConfigError } from './config/validate.ts';
import { createGateway } from './server.ts';

// Config path: first CLI argument, then GATEWAY_CONFIG, then ./gateway.yaml.
const configPath = process.argv[2] ?? process.env.GATEWAY_CONFIG ?? 'gateway.yaml';

let config;
try {
  config = loadConfig(configPath);
} catch (error) {
  // Fail before binding the port: a half-understood config is worse than no gateway.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

const gateway = createGateway(config);
try {
  const port = await gateway.listen(config.port);
  console.log(JSON.stringify({ level: 'info', msg: 'gatewaykit listening', port, routes: config.routes.length }));
} catch (error) {
  console.error(`Failed to listen on port ${config.port}: ${(error as Error).message}`);
  process.exit(1);
}

// Long enough for a typical route timeout to elapse, short enough for an orchestrator's kill grace period.
const SHUTDOWN_GRACE_MS = 10_000;

// close() stops accepting connections and resolves once in-flight requests have
// drained; the timer caps the wait for a stuck client. once(): a second signal
// falls back to Node's default and kills the process immediately.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down, draining in-flight requests', signal }));
    setTimeout(() => {
      console.error(JSON.stringify({ level: 'warn', msg: 'drain timed out, forcing exit', grace_ms: SHUTDOWN_GRACE_MS }));
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    // A keep-alive socket goes idle when its last response finishes; close it then,
    // or the client's idle connection holds the drain open until its own timeout.
    setInterval(() => gateway.server.closeIdleConnections(), 100).unref();
    void gateway.close().then(() => process.exit(0));
  });
}
