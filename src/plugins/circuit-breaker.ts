import type { GatewayResponse, Plugin } from '../pipeline.ts';
import { GatewayError } from '../pipeline.ts';

/** What one request says about upstream health. */
type Outcome = 'success' | 'failure' | 'inconclusive';

/**
 * Per-route circuit breaker.
 * - Closed: failures are counted over the trailing window; reaching the
 *   threshold opens the circuit.
 * - Open: requests fail fast with 503 until the cooldown ends.
 * - Half-open: exactly one probe goes through. Success closes the circuit,
 *   failure re-opens it with a fresh cooldown.
 *
 * It sits outside retry, so one logical request counts once however many
 * attempts it took. A request is classified when upstream headers arrive.
 */
export const circuitBreakerPlugin: Plugin = {
  feature: 'circuit_breaker',
  build(route, ctx) {
    const config = route.features.circuit_breaker;
    if (!config) return undefined;
    const { threshold, windowMs, cooldownMs } = config;

    /** Failure timestamps while closed. Never longer than `threshold`. */
    let failures: number[] = [];
    /** Set while open or half-open: when the cooldown ends. */
    let openUntil: number | undefined;
    let probeInFlight = false;

    const open = (now: number): void => {
      openUntil = now + cooldownMs;
      failures = [];
    };

    const record = (isProbe: boolean, outcome: Outcome): void => {
      const now = ctx.now();
      if (isProbe) {
        probeInFlight = false;
        if (outcome === 'success') openUntil = undefined;
        else if (outcome === 'failure') open(now);
        // Inconclusive (e.g. the client went away): stay half-open, so the
        // next request becomes the probe.
        return;
      }
      // A request admitted before the circuit opened must not move it: only
      // the probe decides when an open circuit closes.
      if (openUntil !== undefined || outcome !== 'failure') return;
      failures = failures.filter((at) => at > now - windowMs);
      failures.push(now);
      if (failures.length >= threshold) open(now);
    };

    return (next) => async (req) => {
      let isProbe = false;
      if (openUntil !== undefined) {
        const now = ctx.now();
        if (now < openUntil || probeInFlight) throw unavailable(openUntil - now);
        probeInFlight = true;
        isProbe = true;
      }

      let response: GatewayResponse;
      try {
        response = await next(req);
      } catch (error) {
        record(isProbe, classifyError(error));
        throw error;
      }
      record(isProbe, response.status >= 500 ? 'failure' : 'success');
      return response;
    };
  },
};

/**
 * Thrown 5xx errors are the forwarder's 502 (connection failure) and 504
 * (timeout). Anything else thrown, like 499 when the client goes away, says
 * nothing about the upstream.
 */
function classifyError(error: unknown): Outcome {
  return error instanceof GatewayError && error.status >= 500 ? 'failure' : 'inconclusive';
}

function unavailable(remainingMs: number): GatewayError {
  // At least 1: while the probe is in flight the cooldown has already ended,
  // but the client should still wait before retrying.
  const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));
  return new GatewayError(503, 'service_unavailable', {
    details: { retry_after: retryAfter },
    headers: { 'retry-after': String(retryAfter) },
  });
}
