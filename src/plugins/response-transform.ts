import type { Plugin } from '../pipeline.ts';
import { resolveTemplate, transformHeaders, withoutGatewayOwnedHeaders } from './template.ts';

/**
 * Rewrites the headers of the upstream response. Errors the gateway generates
 * itself (429, 502, 504...) are thrown, so they propagate past this mapping
 * untouched: only real upstream responses are transformed.
 */
export const responseTransformPlugin: Plugin = {
  feature: 'response_transform',
  build(route, ctx) {
    const config = route.features.response_transform;
    if (!config) return undefined;
    // Body envelopes are issue #10. This plugin claims the whole feature, so the
    // core no longer warns about it; say so here instead of silently ignoring it.
    if (config.body) process.emitWarning(`route ${route.path}: response_transform.body is not supported yet and is ignored`);
    if (!config.headers) return undefined;
    const headers = withoutGatewayOwnedHeaders(config.headers, `route ${route.path}: response_transform.headers`);

    return (next) => async (req) => {
      const response = await next(req);
      return {
        ...response,
        headers: transformHeaders(response.headers, headers, (value) => resolveTemplate(value, req, ctx.now)),
      };
    };
  },
};
