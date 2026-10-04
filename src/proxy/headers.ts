import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

// RFC 9110 §7.6.1: connection-specific headers describe a single hop and must
// not be forwarded by a proxy, in either direction.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Copies headers, dropping hop-by-hop headers and any named in `Connection`. */
export function withoutHopByHop(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const listed = String(headers.connection ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name) && !listed.includes(name)) result[name] = value;
  }
  return result;
}
