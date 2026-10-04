import type { HealthCheckConfig, TargetConfig } from '../config/types.ts';
import type { BuildContext } from '../pipeline.ts';

/** Probes one health URL and resolves true when it's healthy. A rejection counts as unhealthy. */
export type Probe = (url: URL) => Promise<boolean>;

export interface HealthChecker {
  readonly isHealthy: (target: TargetConfig) => boolean;
  /** Probes every target once. The interval timer calls this; tests call it to step through states. */
  readonly checkNow: () => Promise<void>;
}

/** A probe never waits longer than this, even when the interval is longer. */
const MAX_PROBE_TIMEOUT_MS = 5_000;

interface TargetHealth {
  readonly url: URL;
  consecutiveFailures: number;
  probing: boolean;
}

/**
 * Probes each target's `target + path` every interval. A target turns
 * unhealthy after `unhealthyThreshold` consecutive failed probes and healthy
 * again after one success. Targets start healthy, so traffic flows before the
 * first probe has run. `probe` is injectable so tests control the outcomes.
 */
export function startHealthChecks(
  targets: readonly TargetConfig[],
  config: HealthCheckConfig,
  ctx: BuildContext,
  probe?: Probe,
): HealthChecker {
  const stopped = new AbortController();
  const runProbe = probe ?? httpProbe(Math.min(config.intervalMs, MAX_PROBE_TIMEOUT_MS), stopped.signal);
  const health = new Map<TargetConfig, TargetHealth>(
    targets.map((target) => [target, { url: healthUrl(target.url, config.path), consecutiveFailures: 0, probing: false }]),
  );

  async function check(state: TargetHealth): Promise<void> {
    // One probe per target at a time, so a slow answer can't land after a newer one.
    if (state.probing) return;
    state.probing = true;
    let healthy = false;
    try {
      healthy = await runProbe(state.url);
    } catch {
      // A probe that throws is a failed probe.
    } finally {
      state.probing = false;
    }
    state.consecutiveFailures = healthy ? 0 : state.consecutiveFailures + 1;
  }

  async function checkNow(): Promise<void> {
    await Promise.all([...health.values()].map(check));
  }

  const timer = setInterval(() => void checkNow(), config.intervalMs);
  timer.unref();
  ctx.onClose(() => {
    clearInterval(timer);
    stopped.abort();
  });

  return {
    isHealthy: (target) => (health.get(target)?.consecutiveFailures ?? 0) < config.unhealthyThreshold,
    checkNow,
  };
}

/**
 * "target + path", keeping any base path on the target (as forwarding does).
 * Setting only the pathname means a probe can never reach a different host.
 */
function healthUrl(target: URL, path: string): URL {
  const url = new URL(target);
  url.pathname = url.pathname.replace(/\/+$/, '') + path;
  return url;
}

/** GET with a timeout; any 2xx is healthy. Redirects aren't followed, since a 3xx isn't a 2xx. */
function httpProbe(timeoutMs: number, stopped: AbortSignal): Probe {
  return async (url) => {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stopped]) });
    await res.body?.cancel();
    return res.ok;
  };
}
