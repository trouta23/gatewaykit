import type { HeaderTransformConfig } from '../config/types.ts';
import type { GatewayRequest } from '../pipeline.ts';

// Shared by the request and response transforms: `$variable` resolution, the
// header add/remove step, and its build-time framing guard. Unknown `$variables`
// are rejected by the config validator, so anything unrecognized here is a plain value.

const LITERAL = '$literal:';

// The gateway owns message framing. A transform that changed these could make the
// declared length disagree with the bytes actually sent: a request smuggled
// upstream, or a desynced keep-alive connection to the client.
const FRAMING_HEADERS = new Set(['content-length', 'transfer-encoding']);

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

/**
 * Runs once at build time. Header names and values are already validated with
 * the config; this drops add/remove entries for framing headers, with a startup
 * warning for each, so a transform can never misframe a message.
 */
export function withoutFramingHeaders(config: HeaderTransformConfig, where: string): HeaderTransformConfig {
  const ignored = (name: string): boolean => {
    if (!FRAMING_HEADERS.has(name.toLowerCase())) return false;
    process.emitWarning(`${where}: "${name}" is controlled by the gateway (message framing); ignored`);
    return true;
  };
  return {
    remove: config.remove.filter((name) => !ignored(name)),
    add: Object.fromEntries(Object.entries(config.add).filter(([name]) => !ignored(name))),
  };
}
