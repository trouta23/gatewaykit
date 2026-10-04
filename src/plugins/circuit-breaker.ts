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
    /**
     * Bumped on every transition (open, half-open, closed). A request is
     * admitted in one generation and may settle in a later one: with a
     * cooldown shorter than the route timeout, a slow request admitted before
     * the trip can fail after a successful probe has closed the circuit. Its
     * result describes an upstream state that no longer exists, so it is
     * ignored rather than counted against the new closed period.
     */
    let generation = 0;

    const open = (now: number): void => {
      generation += 1;
      openUntil = now + cooldownMs;
      failures = [];
    };
    const halfOpen = (): void => {
      generation += 1;
      probeInFlight = true;
    };
    const close = (): void => {
      generation += 1;
      openUntil = undefined;
    };

    const record = (admittedIn: number, isProbe: boolean, outcome: Outcome): void => {
      if (admittedIn !== generation) return;
      const now = ctx.now();
      if (isProbe) {
        probeInFlight = false;
        if (outcome === 'success') close();
        else if (outcome === 'failure') open(now);
        // Inconclusive (e.g. the client went away): stay half-open, so the
        // next request becomes the probe.
        return;
      }
      if (outcome !== 'failure') return;
      failures = failures.filter((at) => at > now - windowMs);
      failures.push(now);
      if (failures.length >= threshold) open(now);
    };

    return (next) => async (req) => {
      let isProbe = false;
      if (openUntil !== undefined) {
        const now = ctx.now();
        if (now < openUntil || probeInFlight) throw unavailable(openUntil - now);
        halfOpen();
        isProbe = true;
      }
      const admittedIn = generation;

      let response: GatewayResponse;
      try {
        response = await next(req);
      } catch (error) {
        record(admittedIn, isProbe, classifyError(error));
        throw error;
      }
      record(admittedIn, isProbe, response.status >= 500 ? 'failure' : 'success');
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
