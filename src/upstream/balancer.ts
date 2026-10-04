import type { FeatureName, RouteConfig, TargetConfig } from '../config/types.ts';
import type { BuildContext } from '../pipeline.ts';

/** Picks the target for one upstream attempt. Must be synchronous so selection can't interleave. */
export type TargetSelector = () => TargetConfig;

/**
 * Route features consumed by the upstream layer rather than by middleware
 * (for example health checks, which feed target selection).
 */
export const UPSTREAM_FEATURES: readonly FeatureName[] = [];

/** Builds the route's selector. It's called once per route, so each route keeps its own cursor. */
export function createBalancer(route: RouteConfig, _ctx: BuildContext): TargetSelector {
  const { targets, balance } = route.upstream;
  return balance === 'weighted_round_robin' ? smoothWeightedRoundRobin(targets) : roundRobin(targets);
}

/** Cycles through the targets in config order. Weights are ignored. */
function roundRobin(targets: readonly TargetConfig[]): TargetSelector {
  let cursor = 0;
  return () => {
    const target = targets[cursor]!;
    cursor = (cursor + 1) % targets.length;
    return target;
  };
}

/**
 * Smooth weighted round robin, as in nginx. Naive repetition of weights 3:1
 * sends a, a, a, b: a burst of consecutive requests to one target. This
 * algorithm sends a, a, b, a: the same proportions over every cycle of
 * sum(weights) picks, but spread out, so no target gets a run of traffic.
 *
 * Each pick adds every target's weight to its running score, picks the
 * highest score (ties go to config order), then subtracts the total weight
 * from the winner, so a target that just won has to build its score back up.
 */
function smoothWeightedRoundRobin(targets: readonly TargetConfig[]): TargetSelector {
  const total = targets.reduce((sum, target) => sum + target.weight, 0);
  const scores = targets.map((target) => ({ target, score: 0 }));
  return () => {
    let best = scores[0]!;
    for (const entry of scores) {
      entry.score += entry.target.weight;
      // Strictly greater, so an earlier target wins a tie.
      if (entry.score > best.score) best = entry;
    }
    best.score -= total;
    return best.target;
  };
}
