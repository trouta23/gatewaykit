import type { RouteConfig } from './config/types.ts';

export interface RouteMatch {
  route: RouteConfig;
  /** Path to forward upstream, after `strip_prefix`. Always starts with "/". */
  upstreamPath: string;
}

/** Longest-prefix router that only matches on path-segment boundaries. */
export class Router {
  readonly #routes: RouteConfig[];

  constructor(routes: readonly RouteConfig[]) {
    // Longest prefix first, so /api/users/admin wins over /api/users.
    this.#routes = [...routes].sort((a, b) => b.path.length - a.path.length);
  }

  match(pathname: string): RouteMatch | undefined {
    const route = this.#routes.find((r) => matchesPrefix(r.path, pathname));
    if (!route) return undefined;
    return { route, upstreamPath: route.stripPrefix ? stripPrefix(route.path, pathname) : pathname };
  }
}

/** "/api/users" matches "/api/users" and "/api/users/1", but not "/api/usersX". */
function matchesPrefix(prefix: string, pathname: string): boolean {
  if (prefix === '/') return true;
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function stripPrefix(prefix: string, pathname: string): string {
  if (prefix === '/') return pathname;
  return pathname.slice(prefix.length) || '/';
}
