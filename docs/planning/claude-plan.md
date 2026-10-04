# Claude independent plan (14:00 ET, written before seeing Codex plan)


## 1. Problem reading
- Graded on judgment, not volume: 35% architecture/prioritization, 25% code quality, 25% production thinking, 15% communication.
- Core (8080, /health, proxy, 404/405, any valid config) is pass/fail. It must be bulletproof before anything else.
- Graders swap the config file, so nothing can be hardcoded, and validation of a *different* config has to be strict and helpful.
- The rubric names production scenarios outright: upstream down, malformed config, 50 concurrent requests on a rate-limited route. Each needs a test that proves it.
- "Extend with a new config feature in an afternoon" is the extensibility bar. The plugin contract is the centerpiece of the walkthrough.
- Commit history and DECISIONS.md are graded, so small PRs with a clear "why" beat one big dump.

## 2. Architecture

### Core abstraction: the server is a function (Finagle-style)
```ts
type Body = Readable | Buffer | undefined;
interface GatewayRequest {
  method: string; path: string /* upstream path, after strip_prefix */; originalPath: string;
  query: string; headers: IncomingHttpHeaders; body: Body;
  clientIp: string; receivedAt: Date; requestId: string; route: CompiledRoute; signal: AbortSignal;
}
interface GatewayResponse { status: number; headers: OutgoingHttpHeaders; body: Body; }
type Handler = (req: GatewayRequest) => Promise<GatewayResponse>;
type Middleware = (next: Handler) => Handler;
interface Plugin {                        // one per config feature
  name: string;
  build(route: RouteConfig, ctx: BuildContext): Middleware | undefined; // undefined => feature not configured on route
}
class GatewayError extends Error { status; code; headers?; body? } // thrown anywhere, rendered once as JSON
```
- Retry calls `next` again. Transforms map request and response objects. Breaker and rate limiter short-circuit by throwing GatewayError.
- Every plugin can be unit tested with a fake `next` and an injected clock, with no sockets.
- Adding a feature takes one plugin file, a schema and validation entry, and one line in the ordered registry.

### Layout
```
src/main.ts                 entry: config path = argv[2] ?? GATEWAY_CONFIG ?? ./gateway.yaml; SIGTERM graceful drain
src/config/{types,load,validate,duration}.ts
src/server.ts               node:http server; /health; route match; 404/405; render GatewayResponse/GatewayError; access log
src/router.ts               longest-prefix match on segment boundary
src/pipeline.ts             Handler/Middleware/Plugin types, compose(), GatewayError
src/proxy/forward.ts        terminal Handler: node:http(s) request, hop-by-hop strip, X-Forwarded-*, per-attempt timeout
src/upstream/{balancer,health}.ts
src/plugins/index.ts        ORDERED registry
src/plugins/{rate-limit,auth,request-transform,response-transform,circuit-breaker,retry}.ts
mock/upstream.ts            mock server factory + CLI (ports 3001-3006)
test/unit/*.test.ts, test/integration/*.test.ts
```

### Pipeline order (outer → inner) and why
0. Server: `GET /health` is reserved and answered before routing → route match (404) → method check (405 with `Allow`).
1. **rate-limit**: cheapest rejection, and it also caps API-key brute force.
2. **auth**: 401 before any work or upstream cost.
3. **request-transform**: runs once per logical request, not once per retry.
4. **response-transform**: wraps the final upstream response. Gateway-generated errors are thrown, so they skip it.
5. **circuit-breaker**: sits outside retry, so one failure means one failed logical request (what the client saw).
6. **retry**: re-invokes the terminal handler, with the body buffered.
7. terminal **forward**: pick a target (load balancer, skipping unhealthy ones) → upstream request with per-attempt timeout.

### Concurrency model
- Node runs on one event loop, so the rate limiter's check-and-increment is a single synchronous block and atomic. 50 concurrent requests give exactly N passes.
- Scaling to several processes would need a shared store such as Redis. That goes in DECISIONS as the next step.
- Rate-limit buckets live in a Map with a periodic sweep on an unref'd timer, so memory stays bounded when client IPs churn.
- Upstream calls use a keep-alive `http.Agent`.

### Failure modes
| Scenario | Behavior |
|---|---|
| Upstream connection refused/reset | 502 `bad_gateway` |
| Upstream timeout | Abort the request, return 504 `gateway_timeout` |
| Client disconnects | Abort the upstream request (AbortSignal) |
| Malformed config | Collect *all* errors with paths (`routes[2].upstream.targets[0].url`), print them, exit 1 before binding the port. **Unknown keys fail**: a typo like `auht:` would otherwise leave a route silently unprotected. |
| Breaker open | 503 `{error:"service_unavailable",retry_after}` + `Retry-After` |
| Rate limited | 429 + `Retry-After` + `X-RateLimit-Limit/Remaining/Reset` |
| Unhandled bug | 500, logged with requestId; the process stays up |

### Body policy
Stream by default (pipe). Buffer only when a stage needs it (retry, body transform), with a 10 MB cap → 413.

## 3. Ambiguity calls
1. Route match: longest prefix on a segment boundary (`/api/users` matches `/api/users/1`, not `/api/usersX`).
2. Path matches but method doesn't → 405 + `Allow`. HEAD is not implied by GET; methods are matched exactly as listed.
3. `/health` is reserved: GET → 200 even if a route claims `/health`; other methods → 405.
4. `strip_prefix: true` on an exact match: `/api/products` → `/`. The query string is always preserved.
5. Upstream URL with a base path (`http://h:1/base`) is joined as `/base` + forwarded path.
6. Host header is rewritten to the upstream host. X-Forwarded-For/Proto/Host are added and appended.
7. `per: ip` = socket remote address. X-Forwarded-For can be spoofed; trusting it needs a trusted-proxy list.
8. `global_rate_limit` is the *default policy*: each route without an override gets its own buckets. It is not one gateway-wide budget.
9. A route's `rate_limit` replaces the global one; the two don't stack.
10. Fixed window is epoch-aligned (`floor(now/window)`). Sliding window is an exact sliding log, bounded at `requests` timestamps per key.
11. Timeout applies per attempt. Route `upstream.timeout` > `global_timeout`.
12. `retry.attempts` = total attempts including the first (3 → 1 try + 2 retries).
13. Retry only idempotent methods (GET/HEAD/PUT/DELETE/OPTIONS). Retrying a POST to /api/orders could double-create an order.
14. Retry triggers on the configured status codes *and* on gateway-generated 502 (connection error) and 504 (timeout).
15. Exponential backoff: `initial_delay * 2^(n-1)`, no jitter, so tests stay deterministic. Jitter is listed as a next step.
16. Breaker failure = upstream status >= 500, connection error, or timeout. 4xx is not a failure.
17. Breaker trips when failures within the trailing `window` reach `threshold`. After `cooldown`, half-open lets exactly one probe through. Success closes it; failure re-opens with a fresh cooldown.
18. Breaker scope: per route.
19. Load balancing over healthy targets only. If all are unhealthy, fail open and use all of them (Envoy's "panic" behavior). A health checker that's wrong shouldn't black-hole traffic.
20. Weighted round robin uses smooth weighting (nginx's algorithm): 3:1 is spread as a,a,b,a, not a,a,a,b.
21. A single `upstream.url` is normalized to `targets: [{url, weight: 1}]`, so there's one code path.
22. Health check: GET `target + path` every `interval`; 2xx = healthy. Unhealthy after `unhealthy_threshold` consecutive failures; healthy again after 1 success. Targets start healthy.
23. Auth: missing or invalid key → 401 `{error:"unauthorized"}` (it doesn't say which). Keys are compared in constant time. The key header is stripped before forwarding.
24. `$request_time` / `$response_time` = ISO-8601 UTC timestamps.
25. Body `mapping` builds a NEW object containing only the mapped fields. A missing source path omits the destination. `$literal:x` inserts "x". Non-JSON bodies pass through untouched; invalid JSON with a JSON content-type → 400.
26. Envelope `$body` = parsed JSON when JSON, raw string otherwise. `$route_path` = the route's configured path. It applies to every upstream response, error codes included, and keeps the status. It doesn't apply to gateway-generated errors.
27. Header add/remove is case-insensitive; remove runs before add.
28. Missing `gateway.port` → 8080. Missing `global_timeout` → 30s. Missing `global_rate_limit` → no default limit.
29. Duplicate route paths → config error.

## 4. Issue backlog (ordered)
| # | Pri | Title | Est | Depends | Parallel lane |
|---|---|---|---|---|---|
| 1 | P0 | Scaffold + strict config loader/validator | 15m | — | serial |
| 2 | P0 | Core proxy: server, /health, router, 404/405, forward, strip_prefix, timeouts 502/504, mock upstream, integration tests | 25m | 1 | serial |
| 3 | P1 | Rate limiting: fixed + sliding, ip/global, concurrency test | 20m | 2 | A |
| 4 | P1 | API-key auth | 10m | 2 | B |
| 5 | P1 | Retry with backoff (idempotent only) | 15m | 2 | B |
| 6 | P1 | Circuit breaker | 15m | 2 | B |
| 7 | P2 | Load balancing (round robin, smooth weighted) | 15m | 2 | C |
| 8 | P2 | Active health checks | 15m | 7 | C |
| 9 | P2 | Header transforms (request + response, `$request_time`) | 10m | 2 | A |
| 10 | P3 | Body transforms (mapping + envelope) | 20m | 9 | A |
| 11 | P0 | README + DECISIONS.md | 15m | all | serial, last |

Each plugin issue's acceptance criteria: a unit test with a fake `next` and injected clock, plus one integration test against the mock upstream.

## 5. Timeline
- 14:00–14:20: reconcile plans, create issues, commit the plan.
- 14:20–15:00: #1, #2 (serial; Codex reviews #2).
- 15:00–15:35: lanes A/B/C in parallel worktrees. Codex reviews each PR; I merge one at a time.
- 15:35–15:50: README, DECISIONS, full test run.
- 15:50–16:00: buffer and submit.
- **Cut line:** at 15:30 whatever isn't merged gets cut, in this order: #10, then #8, then #9. Never cut tests or docs to make room for a feature.

## 6. Risks
1. Planning overrun → hard stop at 14:20.
2. Merge conflicts between lanes → the core defines all config types and validation up front; each lane owns its own files; the registry is the only shared line.
3. Flaky timing tests → injected clock, no sleeps over ~50ms.
4. Code you can't explain in the walkthrough → small PRs, each with a "why" summary.
5. Codex review latency at xhigh → reviews run in the background. If a review lags, merge on green tests and apply its findings in a follow-up commit.
