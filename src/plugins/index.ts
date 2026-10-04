import type { Plugin } from '../pipeline.ts';
import { rateLimitPlugin } from './rate-limit.ts';

/**
 * Every config feature, in request-pipeline order: the first entry is the
 * outermost middleware. See docs/PLAN.md for why this order.
 *
 * To add a feature: validate its block in src/config/validate.ts, write a
 * Plugin in this directory, and register it in its slot below.
 */
export const plugins: readonly Plugin[] = [
  // auth (#3): reject before any work is done or quota is spent

  rateLimitPlugin, // rate_limit (#4)

  // response_transform (#8, #10): outside retry, so it maps the final response

  // request_transform (#8, #10): once per logical request

  // circuit_breaker (#7): outside retry, one count per logical request

  // retry (#6): innermost, re-invokes the forwarder
];
