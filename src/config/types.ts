// Normalized, validated configuration. Everything downstream of the loader
// consumes these types, never raw YAML: durations are milliseconds, upstreams
// are always a target list, and route-level defaults are already resolved.

export type RateLimitStrategy = 'fixed_window' | 'sliding_window';
export type RateLimitKey = 'ip' | 'global';
export type BalanceStrategy = 'round_robin' | 'weighted_round_robin';
export type BackoffStrategy = 'fixed' | 'exponential';

export interface RateLimitConfig {
  requests: number;
  windowMs: number;
  strategy: RateLimitStrategy;
  per: RateLimitKey;
}

export interface TargetConfig {
  url: URL;
  weight: number;
}

export interface UpstreamConfig {
  /** A single `upstream.url` is normalized to one target with weight 1. */
  targets: TargetConfig[];
  balance: BalanceStrategy;
}

export interface RetryConfig {
  /** Total attempts, including the first one. */
  attempts: number;
  backoff: BackoffStrategy;
  initialDelayMs: number;
  on: number[];
}

export interface HealthCheckConfig {
  path: string;
  intervalMs: number;
  unhealthyThreshold: number;
}

export interface HeaderTransformConfig {
  add: Record<string, string>;
  remove: string[];
}

export interface RequestTransformConfig {
  headers?: HeaderTransformConfig;
  body?: { mapping: Record<string, string> };
}

export interface ResponseTransformConfig {
  headers?: HeaderTransformConfig;
  body?: { envelope: Record<string, unknown> };
}

export interface AuthConfig {
  type: 'api_key';
  header: string;
  keys: string[];
}

export interface CircuitBreakerConfig {
  threshold: number;
  windowMs: number;
  cooldownMs: number;
}

/** Optional per-route features, keyed by their YAML name. */
export interface RouteFeatures {
  rate_limit?: RateLimitConfig;
  retry?: RetryConfig;
  health_check?: HealthCheckConfig;
  request_transform?: RequestTransformConfig;
  response_transform?: ResponseTransformConfig;
  auth?: AuthConfig;
  circuit_breaker?: CircuitBreakerConfig;
}

export type FeatureName = keyof RouteFeatures;

export interface RouteConfig {
  /** Canonical prefix: leading slash, no trailing slash (except "/"). */
  path: string;
  methods: string[];
  stripPrefix: boolean;
  upstream: UpstreamConfig;
  /** Whole-request deadline: `upstream.timeout`, else `gateway.global_timeout`. */
  timeoutMs: number;
  /** `rate_limit` is already resolved against `global_rate_limit`. */
  features: RouteFeatures;
}

export interface GatewayConfig {
  port: number;
  routes: RouteConfig[];
}
