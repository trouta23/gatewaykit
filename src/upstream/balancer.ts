import type { FeatureName, RouteConfig, TargetConfig } from '../config/types.ts';
import type { BuildContext } from '../pipeline.ts';
import { startHealthChecks } from './health.ts';
import type { HealthChecker } from './health.ts';

/** Picks the target for one upstream attempt. Must be synchronous so selection can't interleave. */
export type TargetSelector = () => TargetConfig;

/**
 * Route features consumed by the upstream layer rather than by middleware
 * (for example health checks, which feed target selection).
 */
export const UPSTREAM_FEATURES: readonly FeatureName[] = ['health_check'];

/** Picks among the targets `usable` accepts. The caller guarantees it accepts at least one. */
type Picker = (usable: (target: TargetConfig) => boolean) => TargetConfig;

const anyTarget = (): boolean => true;

/**
 * Builds the route's selector. It's called once per route, so each route keeps
 * its own cursor. `health` is injectable for tests; by default it's started
 * from the route's `health_check` block, if it has one.
 */
export function createBalancer(route: RouteConfig, ctx: BuildContext, health?: HealthChecker): TargetSelector {
  const { targets, balance } = route.upstream;
  const pick = balance === 'weighted_round_robin' ? smoothWeightedRoundRobin(targets) : roundRobin(targets);
  const config = route.features.health_check;
  const checker = health ?? (config ? startHealthChecks(targets, config, ctx) : undefined);
  if (!checker) return () => pick(anyTarget);

  const { isHealthy } = checker;
  return () => {
    // Panic mode, as in Envoy: when every target looks down, the health
    // checker is as likely to be wrong as the upstreams are (a bad path, a
    // network blip). Trying all targets beats black-holing the whole route.
    const usable = targets.some(isHealthy) ? isHealthy : anyTarget;
    return pick(usable);
  };
}

/** Cycles through the usable targets in config order. Weights are ignored. */
function roundRobin(targets: readonly TargetConfig[]): Picker {
  let cursor = 0;
  return (usable) => {
    // At most one lap, skipping targets that aren't usable.
    for (let step = 0; step < targets.length; step++) {
      const target = targets[cursor]!;
      cursor = (cursor + 1) % targets.length;
      if (usable(target)) return target;
    }
    throw new Error('no usable upstream target');
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
function smoothWeightedRoundRobin(targets: readonly TargetConfig[]): Picker {
  const scores = targets.map((target) => ({ target, score: 0 }));
  return (usable) => {
    let best: (typeof scores)[number] | undefined;
    let total = 0;
    for (const entry of scores) {
      // As in nginx, an unusable target sits the pick out, so it can't bank
      // score while it's down and then win a burst of picks on recovery.
      if (!usable(entry.target)) continue;
      entry.score += entry.target.weight;
      total += entry.target.weight;
      // Strictly greater, so an earlier target wins a tie.
      if (!best || entry.score > best.score) best = entry;
    }
    if (!best) throw new Error('no usable upstream target');
    best.score -= total;
    return best.target;
  };
}
