import type { TargetConfig, UpstreamConfig } from '../config/types.ts';

/** Picks the target for one upstream attempt. Must be synchronous so selection can't interleave. */
export type TargetSelector = () => TargetConfig;

/** Plain round robin over the configured targets, in config order. */
export function createBalancer(upstream: UpstreamConfig): TargetSelector {
  const { targets } = upstream;
  let next = 0;
  return () => {
    const target = targets[next % targets.length]!;
    next = (next + 1) % targets.length;
    return target;
  };
}
