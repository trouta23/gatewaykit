import type { HeaderTransformConfig } from '../config/types.ts';
import type { GatewayRequest } from '../pipeline.ts';

// Shared by the request and response transforms: `$variable` resolution, the
// header add/remove step, and its build-time guard for gateway-owned headers. Unknown `$variables`
// are rejected by the config validator, so anything unrecognized here is a plain value.

const LITERAL = '$literal:';

// Headers the gateway manages itself. Changing framing headers could make the
// declared length disagree with the bytes sent: a request smuggled upstream, or a
// desynced keep-alive connection to the client. The others describe one hop: the
// forwarder strips them, and some (Trailer on a Content-Length response) make
// Node refuse to send the response at all.
const GATEWAY_OWNED_HEADERS = new Set([
  'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade',
]);

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
  const kept = Object.entries(headers).filter(([name]) => !dropped.has(name.toLowerCase()));
  const added = Object.entries(config.add).map(([name, value]) => [name.toLowerCase(), resolve(value)] as const);
  // fromEntries defines own properties: plain assignment of a "__proto__" name
  // would invoke the prototype setter instead of storing a header.
  return Object.fromEntries([...kept, ...added]);
}

/**
 * Runs once at build time. Header names and values are already validated with
 * the config; this drops add/remove entries for gateway-owned headers, with a
 * startup warning for each, so a transform can never misframe a message.
 */
export function withoutGatewayOwnedHeaders(config: HeaderTransformConfig, where: string): HeaderTransformConfig {
  const ignored = (name: string): boolean => {
    if (!GATEWAY_OWNED_HEADERS.has(name.toLowerCase())) return false;
    process.emitWarning(`${where}: "${name}" is managed by the gateway (framing or connection handling); ignored`);
    return true;
  };
  return {
    remove: config.remove.filter((name) => !ignored(name)),
    add: Object.fromEntries(Object.entries(config.add).filter(([name]) => !ignored(name))),
  };
}
