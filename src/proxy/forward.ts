import http from 'node:http';
import https from 'node:https';
import type { Body, GatewayRequest, GatewayResponse, Handler } from '../pipeline.ts';
import { GatewayError } from '../pipeline.ts';
import type { TargetSelector } from '../upstream/balancer.ts';
import { withoutHopByHop } from './headers.ts';

// Keep-alive pools avoid a TCP (and TLS) handshake per proxied request.
const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
};

/**
 * The innermost Handler: sends one attempt to the selected upstream target.
 * Resolves on upstream headers; the deadline stays armed until both the upload
 * and the response body finish, so neither a stalled body nor a stalled upload
 * can outlive the route timeout.
 */
export function createForwarder(selectTarget: TargetSelector, now: () => number = Date.now): Handler {
  return async (req) => {
    const remainingMs = req.deadline - now();
    if (remainingMs <= 0) throw timeoutError(req);
    return send(selectTarget().url, req, remainingMs);
  };
}

function send(target: URL, req: GatewayRequest, timeoutMs: number): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onClientAbort = () => controller.abort();
    req.signal.addEventListener('abort', onClientAbort, { once: true });
    // Once the gateway has answered, Node's server stops tracking the request: a
    // client that drops mid-upload neither aborts req.signal nor errors the body
    // stream. Its socket closing is the only signal left.
    const clientSocket = req.body instanceof http.IncomingMessage ? req.body.socket : undefined;
    clientSocket?.once('close', onClientAbort);

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onClientAbort);
      // Keep-alive sockets carry many requests; don't pile listeners onto them.
      clientSocket?.removeListener('close', onClientAbort);
    };

    const headers = upstreamHeaders(req, target);
    const body = frameBody(req, headers);
    const transport = target.protocol === 'https:' ? https : http;
    const upstreamReq = transport.request({
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port,
      method: req.method,
      // Raw path bytes are forwarded as-is; only the configured base path is prepended.
      path: joinPath(target, req.upstreamPath) + joinQuery(target, req.query),
      headers,
      agent: agents[target.protocol as keyof typeof agents],
      signal: controller.signal,
    });

    // An upstream may answer before it has read the whole upload, so the response
    // ending alone must not disarm the deadline or the client-abort hooks: the
    // upload pipe would then outlive both the route timeout and a client disconnect.
    let uploadDone = false;
    let responseDone = false;
    const settle = () => {
      if (uploadDone && responseDone) release();
    };
    const onUploadDone = () => {
      uploadDone = true;
      settle();
    };
    upstreamReq.once('finish', onUploadDone);
    // Destroyed before finishing (upstream reset, abort): nothing is left to upload.
    upstreamReq.once('close', onUploadDone);

    // Settles a request that closes with neither a response nor an error. An
    // upstream answering 101 Switching Protocols does exactly that (upgrades aren't
    // proxied), and the client would otherwise hang past its deadline.
    let answered = false;
    upstreamReq.once('close', () => {
      if (answered) return;
      release();
      reject(timedOut ? timeoutError(req) : new GatewayError(502, 'bad_gateway', { message: 'upstream closed without a response' }));
    });

    upstreamReq.on('response', (res) => {
      answered = true;
      res.once('close', () => {
        responseDone = true;
        settle();
      });
      resolve({ status: res.statusCode ?? 502, headers: withoutHopByHop(res.headers), body: res });
    });

    upstreamReq.on('error', (error) => {
      release();
      // After 'response' this is a no-op; mid-body failures surface on the body stream instead.
      if (timedOut) reject(timeoutError(req));
      else if (req.signal.aborted) reject(new GatewayError(499, 'client_closed_request', { cause: error }));
      else reject(new GatewayError(502, 'bad_gateway', { message: 'upstream unavailable', cause: error }));
    });

    writeBody(body, upstreamReq);
  });
}

/**
 * Decides the upstream body and always re-declares its framing from the incoming
 * request, which Node's parser has already validated. Hop-by-hop stripping can drop
 * the framing header (Transfer-Encoding always; Content-Length if the client lists it
 * in `Connection`), and Node only re-frames by default for methods that usually carry
 * a body. Unframed bytes would be parsed upstream as a second, smuggled request.
 */
function frameBody(req: GatewayRequest, headers: http.OutgoingHttpHeaders): Body {
  const { body } = req;
  if (body === undefined || Buffer.isBuffer(body)) {
    delete headers['transfer-encoding'];
    if (body === undefined) delete headers['content-length'];
    else headers['content-length'] = body.length;
    return body;
  }
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    headers['content-length'] = contentLength;
    delete headers['transfer-encoding'];
    return body;
  }
  if (req.headers['transfer-encoding'] !== undefined) {
    headers['transfer-encoding'] = 'chunked';
    return body;
  }
  // Neither header: by HTTP/1.1 framing rules the client sent no body.
  return undefined;
}

function writeBody(body: Body, upstreamReq: http.ClientRequest): void {
  if (body === undefined) {
    upstreamReq.end();
  } else if (Buffer.isBuffer(body)) {
    upstreamReq.end(body);
  } else {
    // pipe(), not pipeline(): an upstream failure must not destroy the client
    // socket, or the gateway could no longer answer with a 502.
    body.on('error', (error) => upstreamReq.destroy(error));
    body.pipe(upstreamReq);
  }
}

function upstreamHeaders(req: GatewayRequest, target: URL): http.OutgoingHttpHeaders {
  const headers = withoutHopByHop(req.headers);
  headers.host = target.host;
  // Derived from the socket, not appended to client-supplied values: this gateway is
  // the edge, so any incoming X-Forwarded-* header is untrusted. X-Forwarded-Host is
  // deleted even when there is no Host to replace it with, so a forged one can't survive.
  headers['x-forwarded-for'] = req.clientIp;
  headers['x-forwarded-proto'] = 'http';
  delete headers['x-forwarded-host'];
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  headers['x-request-id'] = req.id;
  return headers;
}

function joinPath(target: URL, path: string): string {
  const base = target.pathname.replace(/\/+$/, '');
  return base + path;
}

function joinQuery(target: URL, query: string): string {
  if (!target.search) return query;
  return query ? `${target.search}&${query.slice(1)}` : target.search;
}

function timeoutError(req: GatewayRequest): GatewayError {
  return new GatewayError(504, 'gateway_timeout', {
    message: `upstream did not respond within ${req.route.timeoutMs}ms`,
  });
}
