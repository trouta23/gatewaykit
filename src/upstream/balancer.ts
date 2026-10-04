import type { FeatureName, RouteConfig, TargetConfig } from '../config/types.ts';
import type { BuildContext } from '../pipeline.ts';

/** Picks the target for one upstream attempt. Must be synchronous so selection can't interleave. */
export type TargetSelector = () => TargetConfig;

/**
 * Route features consumed by the upstream layer rather than by middleware
 * (for example health checks, which feed target selection).
 */
export const UPSTREAM_FEATURES: readonly FeatureName[] = [];

/** Plain round robin over the route's targets, in config order. */
export function createBalancer(route: RouteConfig, _ctx: BuildContext): TargetSelector {
  const { targets } = route.upstream;
  let next = 0;
  return () => {
    const target = targets[next % targets.length]!;
    next = (next + 1) % targets.length;
    return target;
  };
}
