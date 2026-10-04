import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { FeatureName, GatewayConfig, RouteConfig } from './config/types.ts';
import type { BuildContext, GatewayRequest, GatewayResponse, Handler, Middleware, Plugin } from './pipeline.ts';
import { compose, GatewayError } from './pipeline.ts';
import { plugins as defaultPlugins } from './plugins/index.ts';
import { createForwarder } from './proxy/forward.ts';
import { Router } from './router.ts';
import { createBalancer, UPSTREAM_FEATURES } from './upstream/balancer.ts';

export type Logger = (entry: Record<string, unknown>) => void;

export interface GatewayOptions {
  now?: () => number;
  log?: Logger;
  plugins?: readonly Plugin[];
}

export interface Gateway {
  readonly server: http.Server;
  /** Resolves with the bound port (useful with port 0 in tests). */
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

const REQUEST_ID = /^[\w.-]{1,128}$/;

const jsonLogger: Logger = (entry) => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);

export function createGateway(config: GatewayConfig, options: GatewayOptions = {}): Gateway {
  const now = options.now ?? Date.now;
  const log = options.log ?? jsonLogger;
  const cleanups: Array<() => void> = [];
  const ctx: BuildContext = { now, onClose: (cleanup) => cleanups.push(cleanup) };

  // Routes compile once at startup into a single composed Handler each.
  const plugins = options.plugins ?? defaultPlugins;
  const handlers = new Map<RouteConfig, Handler>(
    config.routes.map((route) => [route, buildRouteHandler(route, plugins, ctx, log)]),
  );
  const router = new Router(config.routes);
  let readyAt = performance.now();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      log({ level: 'error', msg: 'unhandled request failure', error: String(error) });
      res.destroy();
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const method = req.method ?? 'GET';
    const incomingId = String(req.headers['x-request-id'] ?? '');
    const id = REQUEST_ID.test(incomingId) ? incomingId : randomUUID();
    const clientIp = normalizeIp(req.socket.remoteAddress);
    let routePath: string | undefined;
    res.setHeader('x-request-id', id);
    res.on('close', () => {
      log({
        level: 'info', msg: 'request', id, method, path: req.url, route: routePath, status: res.statusCode,
        duration_ms: Math.round(performance.now() - started), client_ip: clientIp, completed: res.writableFinished,
      });
    });

    // Origin-form only ("/path?query"). Parsing against a fixed base also
    // resolves dot segments, so "/public/../internal" can't dodge route policies.
    if (!req.url?.startsWith('/')) return sendJson(res, 400, { error: 'bad_request', message: 'invalid request target' });
    const url = new URL(`http://gateway${req.url}`);

    if (url.pathname === '/health') {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
      return sendJson(res, 200, { status: 'healthy', uptime_seconds: Math.floor((performance.now() - readyAt) / 1000) });
    }

    const match = router.match(url.pathname);
    if (!match) return sendJson(res, 404, { error: 'not_found', message: `no route for ${url.pathname}` });
    const { route, upstreamPath } = match;
    routePath = route.path;
    if (!route.methods.includes(method)) {
      return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: route.methods.join(', ') });
    }

    const clientGone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) clientGone.abort();
    });

    const receivedAt = new Date(now());
    const gatewayReq: GatewayRequest = {
      id, method, clientIp, receivedAt, route, upstreamPath,
      path: url.pathname,
      query: url.search,
      headers: req.headers,
      body: req,
      deadline: receivedAt.getTime() + route.timeoutMs,
      signal: clientGone.signal,
    };

    let response: GatewayResponse;
    try {
      response = await handlers.get(route)!(gatewayReq);
    } catch (error) {
      return sendError(res, error, id, log);
    }
    await sendResponse(res, response);
  }

  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.off('error', reject);
          readyAt = performance.now();
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      });
    },
    close() {
      for (const cleanup of cleanups.splice(0)) cleanup();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}

function buildRouteHandler(route: RouteConfig, plugins: readonly Plugin[], ctx: BuildContext, log: Logger): Handler {
  const supported = new Set<FeatureName>([...plugins.map((p) => p.feature), ...UPSTREAM_FEATURES]);
  const middleware: Middleware[] = [];

  for (const feature of Object.keys(route.features) as FeatureName[]) {
    if (supported.has(feature)) continue;
    log({ level: 'warn', msg: `route ${route.path}: "${feature}" is configured but not supported by this build` });
    // Never forward a request that the config says must be authenticated.
    if (feature === 'auth') middleware.push(failClosed);
  }
  for (const plugin of plugins) {
    const wrap = plugin.build(route, ctx);
    if (wrap) middleware.push(wrap);
  }
  return compose(middleware, createForwarder(createBalancer(route, ctx), ctx.now));
}

const failClosed: Middleware = () => async () => {
  throw new GatewayError(503, 'service_unavailable', { message: 'authentication is required but not available' });
};

async function sendResponse(res: ServerResponse, response: GatewayResponse): Promise<void> {
  const { body } = response;
  if (res.destroyed) {
    if (body && !Buffer.isBuffer(body)) body.destroy();
    return;
  }
  res.writeHead(response.status, response.headers);
  if (body === undefined || Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }
  try {
    await pipeline(body, res);
  } catch {
    // Headers are already sent, so the only honest signal left is dropping the
    // connection; pipeline() has destroyed both streams.
  }
}

function sendError(res: ServerResponse, error: unknown, id: string, log: Logger): void {
  const gatewayError = error instanceof GatewayError ? error : undefined;
  if (!gatewayError || gatewayError.status >= 500) {
    const cause = gatewayError?.cause ?? error;
    log({ level: gatewayError ? 'warn' : 'error', msg: 'request failed', id, error: String(cause) });
  }
  if (res.destroyed || gatewayError?.status === 499) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (!gatewayError) return sendJson(res, 500, { error: 'internal_error' });
  sendJson(res, gatewayError.status, { error: gatewayError.code, ...gatewayError.details }, gatewayError.headers);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { ...headers, 'content-type': 'application/json', 'content-length': payload.length });
  res.end(payload);
}

function normalizeIp(address: string | undefined): string {
  if (!address) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
