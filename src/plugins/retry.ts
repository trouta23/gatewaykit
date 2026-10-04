import { setTimeout as sleep } from 'node:timers/promises';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import type { RetryConfig } from '../config/types.ts';
import { GatewayError } from '../pipeline.ts';
import type { GatewayRequest, GatewayResponse, Plugin } from '../pipeline.ts';

// RFC 9110 §9.2.2: sending one of these twice has the same effect as sending it
// once. Anything else (POST, PATCH) goes upstream exactly once: a retried
// POST /api/orders after a 503 can create the order twice.
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** Largest request body buffered for replay. Bigger uploads are rejected instead of held in memory. */
export const MAX_REPLAY_BODY_BYTES = 10 * 1024 * 1024;

// Sent when the gateway answers before reading the whole upload: Node then closes
// the socket after the error instead of draining an upload that may never end.
const CLOSE = { connection: 'close' } as const;

type Outcome = { response: GatewayResponse } | { error: unknown };

/** Re-invokes `next` on configured statuses with fixed or exponential backoff, within the request deadline. */
export const retryPlugin: Plugin = {
  feature: 'retry',
  build(route, ctx) {
    const config = route.features.retry;
    if (!config) return undefined;
    const retryOn: ReadonlySet<number> = new Set(config.on);

    return (next) => async (req) => {
      if (!IDEMPOTENT_METHODS.has(req.method)) return next(req);

      // A stream can be read only once, so every attempt gets the same immutable Buffer.
      const body = await readReplayableBody(req, req.deadline - ctx.now());
      // An upload can finish right at the deadline, before the timer fires. That time
      // still went to the client, so it's the same 408 rather than the forwarder's 504,
      // which the circuit breaker would count as an upstream failure.
      if (Buffer.isBuffer(body) && !Buffer.isBuffer(req.body) && ctx.now() >= req.deadline) throw requestTimeout(req);
      const replayable: GatewayRequest = { ...req, body };

      for (let attempt = 1; ; attempt += 1) {
        let outcome: Outcome;
        try {
          const response = await next(replayable);
          if (!retryOn.has(response.status)) return response;
          outcome = { response };
        } catch (error) {
          // Only failures the operator listed are retried: an internal bug is not
          // something another attempt can fix.
          if (!(error instanceof GatewayError && retryOn.has(error.status))) throw error;
          outcome = { error };
        }

        const delayMs = backoffMs(config, attempt);
        // Nobody is waiting once the client is gone (the forwarder's 499), and the
        // deadline covers all attempts, so a retry that cannot finish in time is not started.
        const outOfTime = ctx.now() + delayMs >= req.deadline;
        if (attempt >= config.attempts || req.signal.aborted || outOfTime) return settle(outcome);

        discard(outcome);
        await waitUnlessClientLeaves(delayMs, req.signal);
      }
    };
  },
};

/** Delay before retry number `retry` (1-based). No jitter yet, so tests stay deterministic. */
export function backoffMs(config: RetryConfig, retry: number): number {
  return config.backoff === 'exponential' ? config.initialDelayMs * 2 ** (retry - 1) : config.initialDelayMs;
}

/**
 * Reads a declared request body into one Buffer, bounded by the request deadline:
 * the forwarder's timer is not armed yet, so a stalled upload would otherwise hold
 * the connection forever. On failure the stream is paused, not destroyed:
 * destroying it would reset the socket before the error response reaches the client.
 */
function readReplayableBody(req: GatewayRequest, timeoutMs: number): Promise<Buffer | undefined> {
  const { body } = req;
  if (body === undefined || Buffer.isBuffer(body)) return Promise.resolve(body);
  // Same framing rule as the forwarder: without either header the client sent no body.
  if (!declaresBody(req.headers)) return Promise.resolve(undefined);
  if (req.signal.aborted) return Promise.reject(new GatewayError(499, 'client_closed_request'));
  const stream: Readable = body;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_REPLAY_BODY_BYTES) {
        fail(new GatewayError(413, 'payload_too_large', { details: { max_bytes: MAX_REPLAY_BODY_BYTES }, headers: CLOSE }));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: unknown): void => {
      fail(req.signal.aborted ? new GatewayError(499, 'client_closed_request', { cause: error }) : error);
    };
    const onAbort = (): void => fail(new GatewayError(499, 'client_closed_request'));
    const timer = setTimeout(() => fail(requestTimeout(req)), Math.max(0, timeoutMs));

    function cleanup(): void {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      req.signal.removeEventListener('abort', onAbort);
    }
    function fail(error: unknown): void {
      cleanup();
      stream.pause();
      reject(error);
    }

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    req.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 408, not 504: the client failed to send its body in time (RFC 9110 §15.5.9) and
 * the upstream was never called. A 5xx would count as an upstream failure in the
 * circuit breaker, letting slow clients open it for everyone.
 */
function requestTimeout(req: GatewayRequest): GatewayError {
  const message = `request body not received within ${req.route.timeoutMs}ms`;
  return new GatewayError(408, 'request_timeout', { message, headers: CLOSE });
}

function declaresBody(headers: IncomingHttpHeaders): boolean {
  return Number(headers['content-length'] ?? 0) > 0 || headers['transfer-encoding'] !== undefined;
}

/** The last failure goes back as it came: the response if there was one, otherwise the error. */
function settle(outcome: Outcome): GatewayResponse {
  if ('response' in outcome) return outcome.response;
  throw outcome.error;
}

/** We own a discarded response's body stream; destroying it frees the upstream connection. */
function discard(outcome: Outcome): void {
  if (!('response' in outcome)) return;
  const { body } = outcome.response;
  if (body !== undefined && !Buffer.isBuffer(body)) body.destroy();
}

// Per request, so not registered with onClose: the caller only waits when the delay
// ends before the request deadline, so a graceful shutdown is held no longer than
// an in-flight upstream call would hold it.
async function waitUnlessClientLeaves(delayMs: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(delayMs, undefined, { signal });
  } catch (error) {
    throw new GatewayError(499, 'client_closed_request', { cause: error });
  }
}
