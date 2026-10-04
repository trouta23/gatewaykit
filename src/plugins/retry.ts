import { setTimeout as sleep } from 'node:timers/promises';
import type { IncomingHttpHeaders } from 'node:http';
import type { RetryConfig } from '../config/types.ts';
import { GatewayError } from '../pipeline.ts';
import type { GatewayRequest, GatewayResponse, Plugin } from '../pipeline.ts';

// RFC 9110 §9.2.2: sending one of these twice has the same effect as sending it
// once. Anything else (POST, PATCH) goes upstream exactly once: a retried
// POST /api/orders after a 503 can create the order twice.
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** Largest request body buffered for replay. Bigger uploads are rejected instead of held in memory. */
export const MAX_REPLAY_BODY_BYTES = 10 * 1024 * 1024;

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
      const replayable: GatewayRequest = { ...req, body: await readReplayableBody(req) };

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

async function readReplayableBody(req: GatewayRequest): Promise<Buffer | undefined> {
  const { body } = req;
  if (body === undefined || Buffer.isBuffer(body)) return body;
  // Same framing rule as the forwarder: without either header the client sent no body.
  if (!declaresBody(req.headers)) return undefined;

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      // Leaving the loop by throwing destroys the stream, so the rest of the upload is dropped.
      if (size > MAX_REPLAY_BODY_BYTES) {
        throw new GatewayError(413, 'payload_too_large', { details: { max_bytes: MAX_REPLAY_BODY_BYTES } });
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (req.signal.aborted) throw new GatewayError(499, 'client_closed_request', { cause: error });
    throw error;
  }
  return Buffer.concat(chunks);
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
