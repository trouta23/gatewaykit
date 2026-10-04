import type { HeaderTransformConfig } from '../config/types.ts';
import type { GatewayRequest } from '../pipeline.ts';

// Shared by the request and response transforms: `$variable` resolution and
// the header add/remove step. Unknown `$variables` are rejected by the config
// validator, so anything unrecognized here is a plain value.

const LITERAL = '$literal:';

/** Resolves one configured value. Times are ISO-8601 UTC. */
export function resolveTemplate(value: string, req: GatewayRequest, now: () => number): string {
  switch (value) {
    case '$request_time':
      return req.receivedAt.toISOString();
    case '$response_time':
      return new Date(now()).toISOString();
    case '$route_path':
      return req.route.path;
  }
  // `$literal:` lets a config send a value that would otherwise read as a variable.
  return value.startsWith(LITERAL) ? value.slice(LITERAL.length) : value;
}

/**
 * Returns a copy of `headers` with `remove` applied first, then `add`. Names
 * match case-insensitively (RFC 9110), and added names are lowercased to match
 * the keys Node gives parsed headers, so later lookups like
 * `headers['x-foo']` still find them.
 */
export function transformHeaders<V>(
  headers: NodeJS.Dict<V>,
  config: HeaderTransformConfig,
  resolve: (value: string) => string,
): NodeJS.Dict<V | string> {
  // Added names are dropped too, so an add overwrites whatever casing was there before.
  const dropped = new Set([...config.remove, ...Object.keys(config.add)].map((name) => name.toLowerCase()));
  const result: NodeJS.Dict<V | string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!dropped.has(name.toLowerCase())) result[name] = value;
  }
  for (const [name, value] of Object.entries(config.add)) {
    result[name.toLowerCase()] = resolve(value);
  }
  return result;
}
