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
 * A query on the target URL itself is kept too, first, exactly as the
 * forwarder joins it: a target that needs "?tenant=blue" to answer would
 * otherwise be probed without it and wrongly marked unhealthy.
 */
function probePath(target: URL, path: string): string {
  const queryStart = path.indexOf('?');
  const healthPath = queryStart === -1 ? path : path.slice(0, queryStart);
  const healthQuery = queryStart === -1 ? '' : path.slice(queryStart + 1);
  const base = target.pathname.replace(/\/+$/, '') + healthPath;
  const query = [target.search.slice(1), healthQuery].filter(Boolean).join('&');
  return query ? `${base}?${query}` : base;
}

/**
 * GET with a timeout; any 2xx is healthy. node:http, like the forwarder,
 * rather than fetch(): fetch refuses "bad ports" such as 6000 before
 * connecting, which would mark a working upstream unhealthy. Redirects
 * aren't followed, since a 3xx isn't a 2xx.
 */
function httpProbe(timeoutMs: number, stopped: AbortSignal): Probe {
  return (target, path) =>
    new Promise((resolve) => {
      // Settles exactly once, whichever event comes first. A probe that never
      // settled would leave its target marked in flight and stop all later probes.
      let settled = false;
      const settle = (healthy: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(healthy);
      };
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
        settle(status >= 200 && status < 300);
      });
      // A 101 upgrade emits neither 'response' nor 'error'. It isn't a health answer.
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        settle(false);
      });
      // Connection failures, the timeout and shutdown all surface as 'error'.
      req.on('error', () => settle(false));
      // Anything else that ends the request before an answer.
      req.on('close', () => settle(false));
      req.end();
    });
}
