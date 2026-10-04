import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { Plugin } from '../pipeline.ts';
import { GatewayError } from '../pipeline.ts';

/**
 * API-key authentication. Runs first in the pipeline, so a rejected request
 * spends no rate-limit quota and never reaches the upstream.
 */
export const authPlugin: Plugin = {
  feature: 'auth',
  build(route) {
    const config = route.features.auth;
    if (!config) return undefined;
    // Hashed once at startup. Every digest is 32 bytes, so timingSafeEqual never
    // sees a length mismatch and comparison time can't leak a key's length.
    const keyDigests = config.keys.map(sha256);
    const { header } = config;

    return (next) => async (req) => {
      if (!isValidKey(req.headers[header], keyDigests)) {
        // One error for missing, wrong and duplicated keys, so a client can't
        // tell which check failed.
        throw new GatewayError(401, 'unauthorized');
      }
      // Credentials are for the gateway only; upstreams never see them.
      const headers: IncomingHttpHeaders = { ...req.headers };
      delete headers[header];
      return next({ ...req, headers });
    };
  },
};

function isValidKey(presented: string | string[] | undefined, keyDigests: readonly Buffer[]): boolean {
  // Node joins a repeated custom header into one "a, b" string, which fails the
  // comparison below like any other wrong key. An array is the other shape a
  // repeated header can take, so it's rejected outright.
  if (typeof presented !== 'string') return false;
  const digest = sha256(presented);
  let matched = false;
  // No early exit: every key is compared, so timing doesn't reveal which one matched.
  for (const keyDigest of keyDigests) {
    if (timingSafeEqual(digest, keyDigest)) matched = true;
  }
  return matched;
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
