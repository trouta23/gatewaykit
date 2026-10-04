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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void gateway.close().then(() => process.exit(0));
  });
}
