import assert from 'node:assert/strict';
import type { IncomingHttpHeaders } from 'node:http';
import { describe, it } from 'node:test';
import type { RouteConfig } from '../src/config/types.ts';
import { validateConfig } from '../src/config/validate.ts';
import type { BuildContext, GatewayRequest, GatewayResponse, Handler } from '../src/pipeline.ts';
import { GatewayError } from '../src/pipeline.ts';
import { requestTransformPlugin } from '../src/plugins/request-transform.ts';
import { responseTransformPlugin } from '../src/plugins/response-transform.ts';
import { resolveTemplate } from '../src/plugins/template.ts';
import { DEAD_UPSTREAM, startGateway, startMocks } from './helpers.ts';

const RECEIVED_AT = Date.UTC(2026, 0, 2, 3, 4, 5, 678);
const NOW = RECEIVED_AT + 250;
const ctx: BuildContext = { now: () => NOW, onClose: () => {} };

function routeWith(features: Record<string, unknown>): RouteConfig {
  const config = validateConfig({
    routes: [{ path: '/edge', methods: ['GET'], upstream: { url: 'http://127.0.0.1:1' }, ...features }],
  });
  return config.routes[0]!;
}

function requestFor(route: RouteConfig, headers: IncomingHttpHeaders = {}): GatewayRequest {
  return {
    id: 'test', method: 'GET', path: '/edge/x', upstreamPath: '/edge/x', query: '?q=1', headers, body: undefined,
    clientIp: '10.0.0.1', receivedAt: new Date(RECEIVED_AT), deadline: Number.MAX_SAFE_INTEGER,
    signal: new AbortController().signal, route,
  };
}

describe('resolveTemplate', () => {
  const req = requestFor(routeWith({}));

  it('resolves $request_time and $response_time as ISO-8601 UTC', () => {
    assert.equal(resolveTemplate('$request_time', req, ctx.now), '2026-01-02T03:04:05.678Z');
    assert.equal(resolveTemplate('$response_time', req, ctx.now), '2026-01-02T03:04:05.928Z');
  });

  it('resolves $route_path to the configured route prefix', () => {
    assert.equal(resolveTemplate('$route_path', req, ctx.now), '/edge');
  });

  it('passes $literal: values and plain values through as text', () => {
    assert.equal(resolveTemplate('$literal:$request_time', req, ctx.now), '$request_time');
    assert.equal(resolveTemplate('gatewaykit', req, ctx.now), 'gatewaykit');
  });
});

describe('request transform plugin', () => {
  function forwardedHeaders(features: Record<string, unknown>, headers: IncomingHttpHeaders) {
    const route = routeWith(features);
    let seen: GatewayRequest | undefined;
    const capture: Handler = async (req) => {
      seen = req;
      return { status: 200, headers: {}, body: undefined };
    };
    const original = requestFor(route, headers);
    return requestTransformPlugin.build(route, ctx)!(capture)(original).then(() => ({ original, seen: seen! }));
  }

  it('is not built when the route has no request transform', () => {
    assert.equal(requestTransformPlugin.build(routeWith({}), ctx), undefined);
  });

  it('removes headers case-insensitively, then adds resolved values', async () => {
    const { seen } = await forwardedHeaders(
      { request_transform: { headers: { remove: ['X-Internal-Token'], add: { 'X-Request-Start': '$request_time' } } } },
      { 'x-internal-token': 'secret', 'x-keep': 'yes' },
    );
    assert.deepEqual(seen.headers, { 'x-keep': 'yes', 'x-request-start': '2026-01-02T03:04:05.678Z' });
  });

  it('runs removal before adds, so a name in both ends up with the added value', async () => {
    const { seen } = await forwardedHeaders(
      { request_transform: { headers: { remove: ['x-env'], add: { 'X-Env': 'gateway' } } } },
      { 'x-env': 'client' },
    );
    assert.deepEqual(seen.headers, { 'x-env': 'gateway' });
  });

  it('overwrites an existing header regardless of case, leaving a single value', async () => {
    const { seen } = await forwardedHeaders(
      { request_transform: { headers: { add: { 'X-Route': '$route_path' } } } },
      { 'x-route': 'spoofed' },
    );
    assert.deepEqual(seen.headers, { 'x-route': '/edge' });
  });

  it('derives a new request and leaves the original untouched', async () => {
    const { original, seen } = await forwardedHeaders(
      { request_transform: { headers: { remove: ['x-drop'] } } },
      { 'x-drop': '1' },
    );
    assert.notEqual(seen, original);
    assert.deepEqual(original.headers, { 'x-drop': '1' });
    assert.equal(seen.upstreamPath, original.upstreamPath);
    assert.equal(seen.query, original.query);
  });
});

describe('response transform plugin', () => {
  const upstream: Handler = async () => ({
    status: 503,
    headers: { server: 'mock-upstream', 'content-type': 'application/json' },
    body: Buffer.from('{}'),
  });

  it('is not built when the route has no response transform', () => {
    assert.equal(responseTransformPlugin.build(routeWith({}), ctx), undefined);
  });

  it('maps the upstream response headers and keeps status and body', async () => {
    const route = routeWith({
      response_transform: { headers: { remove: ['Server'], add: { 'X-Served-By': 'gatewaykit', 'X-Responded-At': '$response_time' } } },
    });
    const res: GatewayResponse = await responseTransformPlugin.build(route, ctx)!(upstream)(requestFor(route));
    assert.equal(res.status, 503, 'upstream error statuses are still upstream responses');
    assert.deepEqual(res.body, Buffer.from('{}'));
    assert.deepEqual(res.headers, {
      'content-type': 'application/json',
      'x-served-by': 'gatewaykit',
      'x-responded-at': '2026-01-02T03:04:05.928Z',
    });
  });

  it('does not touch gateway-generated errors, which are thrown past it', async () => {
    const route = routeWith({ response_transform: { headers: { add: { 'X-Served-By': 'gatewaykit' } } } });
    const thrown = new GatewayError(502, 'bad_gateway', { headers: { 'x-from': 'forwarder' } });
    const failing: Handler = async () => {
      throw thrown;
    };
    await assert.rejects(responseTransformPlugin.build(route, ctx)!(failing)(requestFor(route)), (error) => {
      assert.equal(error, thrown);
      assert.deepEqual(thrown.headers, { 'x-from': 'forwarder' });
      return true;
    });
  });
});

describe('body transforms (not supported yet)', () => {
  it('warn once per route at build time and are otherwise ignored', (t) => {
    const warn = t.mock.method(process, 'emitWarning', () => {});
    const route = routeWith({
      request_transform: { body: { mapping: { id: '$body' } } },
      response_transform: { headers: { add: { 'X-A': 'b' } }, body: { envelope: { data: '$body' } } },
    });
    assert.equal(requestTransformPlugin.build(route, ctx), undefined, 'nothing else to do');
    assert.ok(responseTransformPlugin.build(route, ctx), 'headers still apply');
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments[0]),
      [
        'route /edge: request_transform.body is not supported yet and is ignored',
        'route /edge: response_transform.body is not supported yet and is ignored',
      ],
    );
  });
});

describe('framing headers', () => {
  it('cannot be added or removed by a request transform: ignored with a startup warning', async (t) => {
    const warn = t.mock.method(process, 'emitWarning', () => {});
    const route = routeWith({
      request_transform: {
        headers: { remove: ['Transfer-Encoding', 'x-drop'], add: { 'Content-Length': '1', 'X-Ok': 'fine' } },
      },
    });
    let seen: IncomingHttpHeaders | undefined;
    const capture: Handler = async (req) => {
      seen = req.headers;
      return { status: 200, headers: {}, body: undefined };
    };
    await requestTransformPlugin.build(route, ctx)!(capture)(
      requestFor(route, { 'transfer-encoding': 'chunked', 'x-drop': '1' }),
    );
    assert.deepEqual(seen, { 'transfer-encoding': 'chunked', 'x-ok': 'fine' }, 'only the other entries were applied');
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments[0]),
      [
        'route /edge: request_transform.headers: "Transfer-Encoding" is controlled by the gateway (message framing); ignored',
        'route /edge: request_transform.headers: "Content-Length" is controlled by the gateway (message framing); ignored',
      ],
    );
  });

  it('cannot be changed by a response transform either', async (t) => {
    const warn = t.mock.method(process, 'emitWarning', () => {});
    const route = routeWith({ response_transform: { headers: { add: { 'content-length': '0' } } } });
    const upstream: Handler = async () => ({ status: 200, headers: { 'content-length': '2' }, body: Buffer.from('{}') });
    const res = await responseTransformPlugin.build(route, ctx)!(upstream)(requestFor(route));
    assert.deepEqual(res.headers, { 'content-length': '2' });
    assert.equal(warn.mock.callCount(), 1);
  });
});

describe('header transforms through the gateway', () => {
  it('rewrites upstream request headers and client response headers, but not gateway errors', async () => {
    const mocks = await startMocks('echo');
    const transforms = {
      request_transform: {
        headers: { add: { 'X-Gateway-Route': '$route_path', 'X-Request-Start': '$request_time' }, remove: ['X-Internal-Token'] },
      },
      response_transform: { headers: { add: { 'X-Served-By': 'gatewaykit' }, remove: ['Server'] } },
    };
    const gateway = await startGateway({
      routes: [
        { path: '/edge', methods: ['GET'], upstream: { url: mocks.echo.url }, ...transforms },
        { path: '/edge-down', methods: ['GET'], upstream: { url: DEAD_UPSTREAM }, ...transforms },
      ],
    });
    try {
      const res = await fetch(`${gateway.url}/edge/items`, { headers: { 'X-Internal-Token': 'secret', 'X-Keep': 'yes' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-served-by'), 'gatewaykit');
      assert.equal(res.headers.get('server'), null, 'the mock sends server: mock-upstream');
      assert.equal(res.headers.get('x-upstream'), 'echo', 'other upstream headers pass through');

      const echo = await res.json();
      assert.equal(echo.headers['x-gateway-route'], '/edge');
      assert.match(echo.headers['x-request-start'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal(echo.headers['x-internal-token'], undefined);
      assert.equal(echo.headers['x-keep'], 'yes');

      const down = await fetch(`${gateway.url}/edge-down`);
      assert.equal(down.status, 502);
      assert.equal(down.headers.get('x-served-by'), null, 'gateway-generated errors bypass the response transform');
      await down.body?.cancel();
    } finally {
      await gateway.close();
      await mocks.closeAll();
    }
  });
});
