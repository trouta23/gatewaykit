import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import type { FeatureName, RouteConfig } from './config/types.ts';

// The gateway is a function from request to response. Every config feature is
// a Middleware that wraps the next Handler, so a feature can short-circuit
// (auth, rate limit), call `next` more than once (retry), or map the response
// (transforms) without knowing about sockets.

export type Body = Readable | Buffer | undefined;

/** Immutable view of one client request. Middleware derives new requests with spread, never mutation. */
export interface GatewayRequest {
  readonly id: string;
  readonly method: string;
  /** Normalized request path as received, without the query string. */
  readonly path: string;
  /** Path forwarded upstream, after `strip_prefix`. */
  readonly upstreamPath: string;
  /** Raw query string including the leading "?", or "". */
  readonly query: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Body;
  readonly clientIp: string;
  readonly receivedAt: Date;
  /** Epoch ms by which the whole request, retries included, must finish. */
  readonly deadline: number;
  /** Aborted when the client goes away. */
  readonly signal: AbortSignal;
  readonly route: RouteConfig;
}

/**
 * Resolves once upstream headers arrive. Whoever receives a response owns its
 * body stream: it must either consume it or destroy() it.
 */
export interface GatewayResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Body;
}

export type Handler = (req: GatewayRequest) => Promise<GatewayResponse>;
export type Middleware = (next: Handler) => Handler;

export interface BuildContext {
  /** Injectable clock (epoch ms) so time-based features are testable without sleeping. */
  now: () => number;
  /** Registers cleanup (timers, intervals) to run once when the gateway closes. */
  onClose: (cleanup: () => void) => void;
}

/** One config feature. `build` returns undefined when the route doesn't configure it. */
export interface Plugin {
  readonly feature: FeatureName;
  build(route: RouteConfig, ctx: BuildContext): Middleware | undefined;
}

/** An error the gateway itself answers with, rendered as `{ "error": code, ...details }`. */
export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly headers: OutgoingHttpHeaders;

  constructor(
    status: number,
    code: string,
    options: { message?: string; details?: Record<string, unknown>; headers?: OutgoingHttpHeaders; cause?: unknown } = {},
  ) {
    super(options.message ?? code, { cause: options.cause });
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.details = options.details ?? (options.message ? { message: options.message } : {});
    this.headers = options.headers ?? {};
  }
}

/** compose([a, b], terminal) => a(b(terminal)): the first middleware is outermost. */
export function compose(middleware: readonly Middleware[], terminal: Handler): Handler {
  return middleware.reduceRight<Handler>((next, wrap) => wrap(next), terminal);
}
