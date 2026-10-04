// Canonical request paths. The router, the route policies and the upstream must
// all agree on which path a request is for. If the gateway routes one spelling
// while the upstream decodes or normalizes another, an alias of a protected path
// can match a public route and skip its policies (auth). So the gateway routes
// and forwards one canonical form, and rejects encodings an upstream might read
// differently.

/**
 * Encodings with more than one plausible reading, rejected outright:
 * - %2F %5C %00: an encoded separator or NUL, decoded by some upstreams only;
 * - ";" and %3B: path parameters (Java servers read "/..;/" as "/../");
 * - %3F %23: an encoded query or fragment delimiter;
 * - %25xx: double encoding, which a double-decoding upstream turns into a new escape;
 * - "%" not followed by two hex digits, including "%u0073" escapes.
 */
const AMBIGUOUS = /%(?:2f|5c|00|3b|3f|23|25[0-9a-f]{2})|;|%(?![0-9a-f]{2})/i;

/** RFC 3986 §2.3: decoding these never changes a URI's meaning. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * Canonicalizes a WHATWG-parsed pathname (dot segments already resolved,
 * "%2e" included), or returns undefined when the path must be rejected.
 * Decodes escaped unreserved characters, normalizes other escapes to uppercase
 * hex (RFC 3986 §6.2.2), and collapses repeated slashes. The result is what the
 * router matches AND what is forwarded, so the upstream sees exactly the path
 * whose policies ran.
 */
export function canonicalPath(pathname: string): string | undefined {
  if (AMBIGUOUS.test(pathname)) return undefined;
  try {
    // Throws on bytes that aren't valid UTF-8, overlong encodings included.
    decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const decoded = pathname.replace(/%([0-9a-f]{2})/gi, (escape: string, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : escape.toUpperCase();
  });
  return decoded.replace(/\/{2,}/g, '/');
}
