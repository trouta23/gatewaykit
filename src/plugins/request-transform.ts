import type { IncomingHttpHeaders } from 'node:http';
import type { Plugin } from '../pipeline.ts';
import { withoutHopByHop } from '../proxy/headers.ts';
import { resolveTemplate, transformHeaders, withoutGatewayOwnedHeaders } from './template.ts';

// The forwarder reads these to re-declare the upstream body's framing.
const FRAMING_HEADERS = ['content-length', 'transfer-encoding'];

/**
 * Applies the client's hop-by-hop stripping before the transform instead of
 * after it. Otherwise a client could send `Connection: x-trusted` and the
 * forwarder would delete the gateway's own `X-Trusted` addition, and a
 * transform that removed `Connection` would let nominated headers through.
 * Framing headers are kept for the forwarder.
 */
function withoutClientHopByHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwardable = withoutHopByHop(headers);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => Object.hasOwn(forwardable, name) || FRAMING_HEADERS.includes(name)),
  );
}

/** Rewrites the headers sent upstream. Runs once per logical request, outside retry. */
export const requestTransformPlugin: Plugin = {
  feature: 'request_transform',
  build(route, ctx) {
    const config = route.features.request_transform;
    if (!config) return undefined;
    // Body mapping is issue #10. This plugin claims the whole feature, so the
    // core no longer warns about it; say so here instead of silently ignoring it.
    if (config.body) process.emitWarning(`route ${route.path}: request_transform.body is not supported yet and is ignored`);
    if (!config.headers) return undefined;
    const headers = withoutGatewayOwnedHeaders(config.headers, `route ${route.path}: request_transform.headers`);

    return (next) => (req) => {
      const resolve = (value: string) => resolveTemplate(value, req, ctx.now);
      return next({ ...req, headers: transformHeaders(withoutClientHopByHop(req.headers), headers, resolve) });
    };
  },
};
