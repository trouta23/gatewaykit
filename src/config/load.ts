import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { GatewayConfig } from './types.ts';
import { ConfigError, validateConfig } from './validate.ts';

/** Reads, parses and validates a YAML config file. Throws ConfigError on any problem. */
export function loadConfig(filePath: string): GatewayConfig {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ConfigError([`${filePath}: cannot read file (${(error as Error).message})`]);
  }

  let parsed: unknown;
  try {
    // uniqueKeys rejects duplicate mapping keys instead of silently keeping the last one.
    parsed = parse(source, { uniqueKeys: true });
  } catch (error) {
    throw new ConfigError([`${filePath}: invalid YAML (${(error as Error).message.split('\n')[0]})`]);
  }
  return validateConfig(parsed);
}
