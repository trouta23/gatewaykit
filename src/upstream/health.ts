import http from 'node:http';
import https from 'node:https';
import type { HealthCheckConfig, TargetConfig } from '../config/types.ts';
import type { BuildContext } from '../pipeline.ts';

/**
 * GETs `path` (raw, query included) on the target's host and resolves true
 * when it's healthy. A rejection counts as unhealthy.
 */
export type Probe = (target: URL, path: string) => Promise<boolean>;

export interface HealthChecker {
  readonly isHealthy: (target: TargetConfig) => boolean;
  /** Probes every target once. The interval timer calls this; tests call it to step through states. */
  readonly checkNow: () => Promise<void>;
}

/** A probe never waits longer than this, even when the interval is longer. */
const MAX_PROBE_TIMEOUT_MS = 5_000;

interface TargetHealth {
  readonly target: URL;
  readonly path: string;
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
    targets.map((target) => [
      target,
      { target: target.url, path: probePath(target.url, config.path), consecutiveFailures: 0, probing: false },
    ]),
  );

  async function check(state: TargetHealth): Promise<void> {
    // One probe per target at a time, so a slow answer can't land after a newer one.
    if (state.probing) return;
    state.probing = true;
    let healthy = false;
    try {
      healthy = await runProbe(state.target, state.path);
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
 * "target + path": the target's base path plus the configured health path,
 * kept raw like forwarded paths, so a query such as "?ready=1" isn't encoded.
 */
function probePath(target: URL, path: string): string {
  return target.pathname.replace(/\/+$/, '') + path;
}

/**
 * GET with a timeout; any 2xx is healthy. node:http, like the forwarder,
 * rather than fetch(): fetch refuses "bad ports" such as 6000 before
 * connecting, which would mark a working upstream unhealthy. Redirects
 * aren't followed, since a 3xx isn't a 2xx.
 */
function httpProbe(timeoutMs: number, stopped: AbortSignal): Probe {
  return (target, path) =>
    new Promise((resolve, reject) => {
      const transport = target.protocol === 'https:' ? https : http;
      const req = transport.request({
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port,
        method: 'GET',
        path,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stopped]),
      });
      req.on('response', (res) => {
        // Only the status matters. Destroying the body means a stalled one can't hold the socket.
        res.destroy();
        const status = res.statusCode ?? 0;
        resolve(status >= 200 && status < 300);
      });
      req.on('error', reject);
      req.end();
    });
}
