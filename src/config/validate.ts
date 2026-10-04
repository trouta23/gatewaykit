import { parseDuration } from './duration.ts';
import type {
  AuthConfig,
  CircuitBreakerConfig,
  GatewayConfig,
  HeaderTransformConfig,
  HealthCheckConfig,
  RateLimitConfig,
  RequestTransformConfig,
  ResponseTransformConfig,
  RetryConfig,
  RouteConfig,
  RouteFeatures,
  TargetConfig,
  UpstreamConfig,
} from './types.ts';

/** Thrown with every problem found, so an operator can fix a config in one pass. */
export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid gateway config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const DEFAULT_PORT = 8080;
const DEFAULT_TIMEOUT_MS = 30_000;
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const TEMPLATE_VARIABLES = new Set(['$request_time', '$response_time', '$body', '$route_path']);

type Raw = Record<string, unknown>;

/**
 * Collects problems with their YAML path instead of failing on the first one.
 * Every reader returns undefined on a problem so validation can keep going.
 */
class Reader {
  readonly problems: string[] = [];

  fail(path: string, message: string): undefined {
    this.problems.push(`${path}: ${message}`);
    return undefined;
  }

  /** Unknown keys are errors: a typo like `auht:` must not silently disable auth. */
  object(value: unknown, path: string, allowedKeys: readonly string[]): Raw | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return this.fail(path, 'must be a mapping');
    }
    for (const key of Object.keys(value)) {
      if (!allowedKeys.includes(key)) this.fail(`${path}.${key}`, 'unknown key');
    }
    return value as Raw;
  }

  string(value: unknown, path: string): string | undefined {
    if (typeof value !== 'string' || value.trim() === '') return this.fail(path, 'must be a non-empty string');
    return value;
  }

  integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return this.fail(path, `must be an integer between ${min} and ${max}`);
    }
    return value;
  }

  duration(value: unknown, path: string): number | undefined {
    const ms = typeof value === 'string' ? parseDuration(value) : undefined;
    return ms ?? this.fail(path, 'must be a positive duration like "500ms", "30s", "5m"');
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T | undefined {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    return this.fail(path, `must be one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
  }

  boolean(value: unknown, path: string): boolean | undefined {
    if (typeof value !== 'boolean') return this.fail(path, 'must be true or false');
    return value;
  }

  stringList(value: unknown, path: string, { nonEmpty = false } = {}): string[] | undefined {
    if (!Array.isArray(value)) return this.fail(path, 'must be a list');
    if (nonEmpty && value.length === 0) return this.fail(path, 'must not be empty');
    const items = value.map((item, i) => this.string(item, `${path}[${i}]`));
    return items.every((item) => item !== undefined) ? (items as string[]) : undefined;
  }

  stringMap(value: unknown, path: string): Record<string, string> | undefined {
    const raw = this.object(value, path, Object.keys(value ?? {}));
    if (!raw) return undefined;
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(raw)) {
      const str = this.template(item, `${path}.${key}`);
      if (str !== undefined) result[key] = str;
    }
    return result;
  }

  /** Strings that may reference `$variables`; unknown variables are rejected at startup. */
  template(value: unknown, path: string): string | undefined {
    const str = this.string(value, path);
    if (str?.startsWith('$') && !str.startsWith('$literal:') && !TEMPLATE_VARIABLES.has(str)) {
      return this.fail(path, `unknown variable "${str}"`);
    }
    return str;
  }

  url(value: unknown, path: string): URL | undefined {
    const str = this.string(value, path);
    if (str === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(str);
    } catch {
      return this.fail(path, 'must be an absolute URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return this.fail(path, 'must use http or https');
    if (url.username || url.password || url.hash) return this.fail(path, 'must not contain credentials or a fragment');
    return url;
  }
}

/** Validates parsed YAML and normalizes it into a GatewayConfig, or throws ConfigError. */
export function validateConfig(input: unknown): GatewayConfig {
  const r = new Reader();
  const root = r.object(input ?? {}, 'config', ['gateway', 'routes']) ?? {};
  const gateway = r.object(root.gateway ?? {}, 'gateway', ['port', 'global_timeout', 'global_rate_limit']) ?? {};

  const port = gateway.port === undefined ? DEFAULT_PORT : r.integer(gateway.port, 'gateway.port', 1, 65_535);
  const globalTimeoutMs =
    gateway.global_timeout === undefined ? DEFAULT_TIMEOUT_MS : r.duration(gateway.global_timeout, 'gateway.global_timeout');
  const globalRateLimit =
    gateway.global_rate_limit === undefined ? undefined : readRateLimit(r, gateway.global_rate_limit, 'gateway.global_rate_limit');

  const routes: RouteConfig[] = [];
  if (root.routes !== undefined && !Array.isArray(root.routes)) {
    r.fail('routes', 'must be a list');
  } else {
    const seen = new Set<string>();
    (root.routes ?? []).forEach((raw: unknown, i: number) => {
      const route = readRoute(r, raw, `routes[${i}]`, globalTimeoutMs ?? DEFAULT_TIMEOUT_MS, globalRateLimit);
      if (!route) return;
      if (seen.has(route.path)) r.fail(`routes[${i}].path`, `duplicate route "${route.path}"`);
      seen.add(route.path);
      routes.push(route);
    });
  }

  if (r.problems.length > 0) throw new ConfigError(r.problems);
  return { port: port ?? DEFAULT_PORT, routes };
}

const ROUTE_KEYS = [
  'path', 'methods', 'strip_prefix', 'upstream',
  'rate_limit', 'retry', 'health_check', 'request_transform', 'response_transform', 'auth', 'circuit_breaker',
] as const;

function readRoute(
  r: Reader,
  value: unknown,
  path: string,
  globalTimeoutMs: number,
  globalRateLimit: RateLimitConfig | undefined,
): RouteConfig | undefined {
  const raw = r.object(value, path, ROUTE_KEYS);
  if (!raw) return undefined;
  const problemsBefore = r.problems.length;

  const routePath = readRoutePath(r, raw.path, `${path}.path`);
  const methods = r.stringList(raw.methods, `${path}.methods`, { nonEmpty: true })?.map((m) => m.toUpperCase());
  methods?.forEach((m, i) => {
    if (!HTTP_METHODS.has(m)) r.fail(`${path}.methods[${i}]`, `unsupported HTTP method "${m}"`);
  });
  const stripPrefix = raw.strip_prefix === undefined ? false : r.boolean(raw.strip_prefix, `${path}.strip_prefix`);
  const upstream = readUpstream(r, raw.upstream, `${path}.upstream`);

  const features: RouteFeatures = {};
  const rateLimit = raw.rate_limit === undefined ? globalRateLimit : readRateLimit(r, raw.rate_limit, `${path}.rate_limit`);
  if (rateLimit) features.rate_limit = rateLimit;
  if (raw.retry !== undefined) features.retry = readRetry(r, raw.retry, `${path}.retry`);
  if (raw.health_check !== undefined) features.health_check = readHealthCheck(r, raw.health_check, `${path}.health_check`);
  if (raw.request_transform !== undefined) {
    features.request_transform = readRequestTransform(r, raw.request_transform, `${path}.request_transform`);
  }
  if (raw.response_transform !== undefined) {
    features.response_transform = readResponseTransform(r, raw.response_transform, `${path}.response_transform`);
  }
  if (raw.auth !== undefined) features.auth = readAuth(r, raw.auth, `${path}.auth`);
  if (raw.circuit_breaker !== undefined) {
    features.circuit_breaker = readCircuitBreaker(r, raw.circuit_breaker, `${path}.circuit_breaker`);
  }

  if (r.problems.length > problemsBefore || !routePath || !methods || stripPrefix === undefined || !upstream) {
    return undefined;
  }
  return {
    path: routePath,
    methods: [...new Set(methods)],
    stripPrefix,
    upstream: upstream.config,
    timeoutMs: upstream.timeoutMs ?? globalTimeoutMs,
    features,
  };
}

function readRoutePath(r: Reader, value: unknown, path: string): string | undefined {
  const str = r.string(value, path);
  if (str === undefined) return undefined;
  if (!str.startsWith('/')) return r.fail(path, 'must start with "/"');
  if (/[?#\s]/.test(str)) return r.fail(path, 'must be a plain path without query, fragment or whitespace');
  return str.length > 1 ? str.replace(/\/+$/, '') || '/' : str;
}

function readUpstream(
  r: Reader,
  value: unknown,
  path: string,
): { config: UpstreamConfig; timeoutMs: number | undefined } | undefined {
  const raw = r.object(value, path, ['url', 'targets', 'balance', 'timeout']);
  if (!raw) return undefined;
  const timeoutMs = raw.timeout === undefined ? undefined : r.duration(raw.timeout, `${path}.timeout`);
  const balance =
    raw.balance === undefined
      ? 'round_robin'
      : r.oneOf(raw.balance, `${path}.balance`, ['round_robin', 'weighted_round_robin'] as const);

  if ((raw.url === undefined) === (raw.targets === undefined)) {
    return r.fail(path, 'must define exactly one of "url" or "targets"');
  }

  let targets: TargetConfig[] | undefined;
  if (raw.url !== undefined) {
    const url = r.url(raw.url, `${path}.url`);
    targets = url ? [{ url, weight: 1 }] : undefined;
  } else if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    r.fail(`${path}.targets`, 'must be a non-empty list');
  } else {
    const parsed = raw.targets.map((item: unknown, i: number) => {
      const target = r.object(item, `${path}.targets[${i}]`, ['url', 'weight']);
      if (!target) return undefined;
      const url = r.url(target.url, `${path}.targets[${i}].url`);
      const weight = target.weight === undefined ? 1 : r.integer(target.weight, `${path}.targets[${i}].weight`, 1, 1000);
      return url && weight ? { url, weight } : undefined;
    });
    if (parsed.every((t) => t !== undefined)) targets = parsed as TargetConfig[];
  }

  if (!targets || !balance) return undefined;
  return { config: { targets, balance }, timeoutMs };
}

function readRateLimit(r: Reader, value: unknown, path: string): RateLimitConfig | undefined {
  const raw = r.object(value, path, ['requests', 'window', 'strategy', 'per']);
  if (!raw) return undefined;
  const requests = r.integer(raw.requests, `${path}.requests`, 1);
  const windowMs = r.duration(raw.window, `${path}.window`);
  const strategy =
    raw.strategy === undefined
      ? 'fixed_window'
      : r.oneOf(raw.strategy, `${path}.strategy`, ['fixed_window', 'sliding_window'] as const);
  const per = raw.per === undefined ? 'ip' : r.oneOf(raw.per, `${path}.per`, ['ip', 'global'] as const);
  return requests && windowMs && strategy && per ? { requests, windowMs, strategy, per } : undefined;
}

function readRetry(r: Reader, value: unknown, path: string): RetryConfig | undefined {
  const raw = r.object(value, path, ['attempts', 'backoff', 'initial_delay', 'on']);
  if (!raw) return undefined;
  const attempts = r.integer(raw.attempts, `${path}.attempts`, 1, 10);
  const backoff =
    raw.backoff === undefined ? 'fixed' : r.oneOf(raw.backoff, `${path}.backoff`, ['fixed', 'exponential'] as const);
  const initialDelayMs = r.duration(raw.initial_delay, `${path}.initial_delay`);
  let on: number[] | undefined = [502, 503, 504];
  if (raw.on !== undefined) {
    if (!Array.isArray(raw.on) || raw.on.length === 0) {
      on = r.fail(`${path}.on`, 'must be a non-empty list of status codes');
    } else {
      const codes = raw.on.map((code: unknown, i: number) => r.integer(code, `${path}.on[${i}]`, 100, 599));
      on = codes.every((c) => c !== undefined) ? (codes as number[]) : undefined;
    }
  }
  return attempts && backoff && initialDelayMs && on ? { attempts, backoff, initialDelayMs, on } : undefined;
}

function readHealthCheck(r: Reader, value: unknown, path: string): HealthCheckConfig | undefined {
  const raw = r.object(value, path, ['path', 'interval', 'unhealthy_threshold']);
  if (!raw) return undefined;
  const checkPath = r.string(raw.path, `${path}.path`);
  if (checkPath !== undefined && !checkPath.startsWith('/')) r.fail(`${path}.path`, 'must start with "/"');
  const intervalMs = r.duration(raw.interval, `${path}.interval`);
  const unhealthyThreshold =
    raw.unhealthy_threshold === undefined ? 3 : r.integer(raw.unhealthy_threshold, `${path}.unhealthy_threshold`, 1, 100);
  return checkPath?.startsWith('/') && intervalMs && unhealthyThreshold
    ? { path: checkPath, intervalMs, unhealthyThreshold }
    : undefined;
}

function readHeaderTransform(r: Reader, value: unknown, path: string): HeaderTransformConfig | undefined {
  const raw = r.object(value, path, ['add', 'remove']);
  if (!raw) return undefined;
  const add = raw.add === undefined ? {} : r.stringMap(raw.add, `${path}.add`);
  const remove = raw.remove === undefined ? [] : r.stringList(raw.remove, `${path}.remove`);
  return add && remove ? { add, remove } : undefined;
}

function readRequestTransform(r: Reader, value: unknown, path: string): RequestTransformConfig | undefined {
  const raw = r.object(value, path, ['headers', 'body']);
  if (!raw) return undefined;
  const result: RequestTransformConfig = {};
  if (raw.headers !== undefined) result.headers = readHeaderTransform(r, raw.headers, `${path}.headers`);
  if (raw.body !== undefined) {
    const body = r.object(raw.body, `${path}.body`, ['mapping']);
    const mapping = body ? r.stringMap(body.mapping, `${path}.body.mapping`) : undefined;
    if (mapping) result.body = { mapping };
  }
  return result;
}

function readResponseTransform(r: Reader, value: unknown, path: string): ResponseTransformConfig | undefined {
  const raw = r.object(value, path, ['headers', 'body']);
  if (!raw) return undefined;
  const result: ResponseTransformConfig = {};
  if (raw.headers !== undefined) result.headers = readHeaderTransform(r, raw.headers, `${path}.headers`);
  if (raw.body !== undefined) {
    const body = r.object(raw.body, `${path}.body`, ['envelope']);
    const envelope = body ? readEnvelope(r, body.envelope, `${path}.body.envelope`) : undefined;
    if (envelope) result.body = { envelope };
  }
  return result;
}

/** An envelope is a nested mapping whose leaves are literals or `$variables`. */
function readEnvelope(r: Reader, value: unknown, path: string): Record<string, unknown> | undefined {
  const raw = r.object(value, path, Object.keys(value ?? {}));
  if (!raw) return undefined;
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) readEnvelope(r, item, `${path}.${key}`);
    else if (typeof item === 'string') r.template(item, `${path}.${key}`);
  }
  return raw;
}

function readAuth(r: Reader, value: unknown, path: string): AuthConfig | undefined {
  const raw = r.object(value, path, ['type', 'header', 'keys']);
  if (!raw) return undefined;
  const type = r.oneOf(raw.type, `${path}.type`, ['api_key'] as const);
  const header = r.string(raw.header, `${path}.header`);
  const keys = r.stringList(raw.keys, `${path}.keys`, { nonEmpty: true });
  return type && header && keys ? { type, header: header.toLowerCase(), keys } : undefined;
}

function readCircuitBreaker(r: Reader, value: unknown, path: string): CircuitBreakerConfig | undefined {
  const raw = r.object(value, path, ['threshold', 'window', 'cooldown']);
  if (!raw) return undefined;
  const threshold = r.integer(raw.threshold, `${path}.threshold`, 1);
  const windowMs = r.duration(raw.window, `${path}.window`);
  const cooldownMs = r.duration(raw.cooldown, `${path}.cooldown`);
  return threshold && windowMs && cooldownMs ? { threshold, windowMs, cooldownMs } : undefined;
}
