import type { Plugin } from '../pipeline.ts';
import { resolveTemplate, transformHeaders } from './template.ts';

/** Rewrites the headers sent upstream. Runs once per logical request, outside retry. */
export const requestTransformPlugin: Plugin = {
  feature: 'request_transform',
  build(route, ctx) {
    const config = route.features.request_transform;
    if (!config) return undefined;
    // Body mapping is issue #10. This plugin claims the whole feature, so the
    // core no longer warns about it; say so here instead of silently ignoring it.
    if (config.body) process.emitWarning(`route ${route.path}: request_transform.body is not supported yet and is ignored`);
    const headers = config.headers;
    if (!headers) return undefined;

    return (next) => (req) =>
      next({ ...req, headers: transformHeaders(req.headers, headers, (value) => resolveTemplate(value, req, ctx.now)) });
  },
};
