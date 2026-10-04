# GatewayKit — Game Plan

Two independent plans were written before any code: one by Claude, one by Codex (gpt-6-astra). Neither saw the other's. Both are kept verbatim in [`docs/planning/`](planning/). This document reconciles them. Where they disagreed, the table below records which call won and why.

## Where the plans disagreed

| Topic | Claude | Codex | Resolution |
|---|---|---|---|
| **Scope** | Build all ~12 features across parallel lanes; cut at 15:30 | Ship core + auth + rate limit + balancing; defer retry, breaker, health checks, transforms; cut at 15:05 | **Tiered.** Tier 1 = Codex's scope, always shipped. Tier 2/3 run only once Tier 1 is merged. The architecture has a documented slot for every feature, so anything unbuilt is a known next step rather than a gap. |
| **Pipeline shape** | `Middleware = (next: Handler) => Handler` onion | Explicit guard functions (`authorize`, `admit`, `select`), "no plugin framework" | **Middleware.** Guards can't express retries (call `next` again) or response transforms (map the response) without new contracts. That fails the "add a config feature in an afternoon" bar. `compose()` is ~10 lines, not a framework. |
| **Auth vs rate-limit order** | Rate limit first (caps key brute force) | Auth first (unauthenticated traffic can't drain a shared `per: global` bucket) | **Auth first.** Starving legitimate users through a shared bucket is a practical attack. Brute-forcing high-entropy API keys is not. This matches Kong's plugin ordering. |
| **Timeout semantics** | Per attempt | One deadline for the whole logical request, covering retries and backoff | **One total deadline** (Envoy's route-timeout semantics). Otherwise 3 attempts × 5s + backoff turns a 5s timeout into 18s. Retries only start if budget remains. |
| **Transport hardening** | Folded into the core issue | Its own issue: stalled bodies, mid-stream failures, cancellation, cleanup exactly once | **Its own issue.** It's the "what happens when an upstream is down" part of the rubric and deserves dedicated tests. |
| **Config features not yet built** | Unknown keys fail startup | Unknown keys fail; known-but-unbuilt blocks warn; auth fails *closed* until wired | **Codex's rule.** Unknown key → startup error (a typo like `auht:` must not silently leave a route unprotected). Known-but-unimplemented block → loud startup warning. A security block that isn't enforced → requests rejected, never forwarded unprotected. |
| **Retryable methods** | All idempotent (GET/HEAD/OPTIONS/PUT/DELETE) | GET/HEAD only | **RFC 9110 idempotent set.** The example config retries a route that accepts PUT. PUT is idempotent by definition. POST is never retried. |

## Architecture

```ts
interface GatewayRequest {            // immutable view of one client request
  method; originalPath; upstreamPath; query; headers; body /* Readable | Buffer */;
  clientIp; receivedAt; requestId; route: CompiledRoute; deadline: number; signal: AbortSignal;
}
interface GatewayResponse { status: number; headers: OutgoingHttpHeaders; body: Readable | Buffer | undefined }
type Handler    = (req: GatewayRequest) => Promise<GatewayResponse>;
type Middleware = (next: Handler) => Handler;
interface Plugin { name: string; build(route: RouteConfig, ctx: BuildContext): Middleware | undefined }
class GatewayError extends Error { status; code; headers? }   // thrown anywhere, rendered once as JSON
```

**Request lifecycle (outer → inner)**
1. `GET /health` is reserved and answered before routing, so policies never apply to it.
2. Route match: longest prefix on a segment boundary → 404.
3. Method check → 405 with `Allow`.
4. **auth** → 401
5. **rate-limit** → 429 + `Retry-After`
6. *response-transform*: maps the final upstream response. Gateway errors are thrown, so they bypass it.
7. *request-transform*: runs once per logical request.
8. *circuit-breaker*: one count per logical request, so it sits outside retry → 503 + `retry_after`
9. *retry*: re-invokes `next` while the deadline allows.
10. **forward**: the final step. The load balancer picks a target, then the upstream request streams with the remaining deadline → 502/504.

Routes are compiled once at startup. Each one becomes a single composed `Handler` built from the ordered plugin registry, and per-route state (rate buckets, balancer cursor, breaker) lives in closures. Adding a feature means: a validator entry, a plugin file, one registry line, and tests.

**Response lifecycle contract** (added after Codex's review):
- A `Handler` resolves once upstream **headers** arrive. Ownership of `response.body` passes to the caller, and exactly one consumer may read or destroy it.
- The forwarder keeps the deadline armed until the body stream ends. On expiry it destroys the stream, so a stalled body can't outlive the timeout. The deadline timer and the client-abort listener are released exactly once.
- After headers have gone to the client, a failure can only destroy the connection; no second status is possible.
- Middleware that discards a response (retry) must `destroy()` its body. Retry replays an immutable `Buffer` of the request body, never the live stream.
- The circuit breaker classifies an attempt at header time: status ≥ 500, a connection error or a timeout counts as a failure. Failures after headers are a documented limitation.

**Concurrency.** One Node process means one event loop. Limiter check-and-record and target selection are synchronous blocks with no `await` in the middle, so 50 simultaneous requests against an empty 10-request bucket admit exactly 10. State is process-local. Coordinating several instances would need a shared store, which is documented as a next step.

**Bodies.** Requests and responses stream both ways with backpressure. A body is buffered (with a size cap → 413) only when a stage has to read it or replay it.

## Backlog

Each issue gets one branch and one PR. Every PR gets a Codex review before it's merged with a merge commit.

| # | Tier | Issue | Lane |
|---|---|---|---|
| 1 | 1 | Core gateway: strict config, router, /health, 404/405, streaming proxy, strip_prefix, deadline → 502/504, mock upstream, `npm test` (typecheck + tests) | serial |
| 2 | 1 | Transport hardening: client abort → upstream abort, mid-body failures, hop-by-hop both ways, X-Forwarded-*, Set-Cookie, graceful shutdown | A |
| 3 | 1 | API-key auth (fail closed, constant-time compare) | B |
| 4 | 1 | Rate limiting: fixed + sliding, ip/global, inheritance, 50-concurrent test, idle-bucket sweep | C |
| 5 | 1 | Load balancing: round robin + smooth weighted round robin | B |
| 6 | 2 | Retry with fixed/exponential backoff (idempotent only, shared deadline) | A |
| 7 | 2 | Circuit breaker (closed/open/half-open, 503 body) | B |
| 8 | 3 | Header transforms (request + response, `$request_time`) | C |
| 9 | 3 | Active health checks feeding the balancer | C |
| 10 | 3 | Body transforms (mapping + envelope) | — |
| 11 | 1 | README, DECISIONS.md, acceptance test against an unrelated config | serial, last |

**File ownership for parallel lanes** (added after Codex's review). Contracts are frozen when #1 merges: `src/pipeline.ts` and all of `src/config/` (every feature block is validated in #1), so lanes never touch them.

| Lane | Issues | Owns |
|---|---|---|
| A | #2 → #6 | `src/proxy/*`, shutdown in `src/main.ts`, `src/plugins/retry.ts` |
| B | #3 → #5 → #7 | `src/plugins/auth.ts`, `src/upstream/balancer.ts`, `src/plugins/circuit-breaker.ts` |
| C | #4 → #8 | `src/plugins/rate-limit.ts`, `src/plugins/headers.ts` |

Each lane edits only its own pre-placed slot line in `src/plugins/index.ts`. Claude is the sole integrator: it merges serially and owns README/DECISIONS. A feature counts as done only once a wired integration test passes.

## Timeline (ET)

| Time | Work |
|---|---|
| 14:00–14:15 | Independent plans → reconciliation → issues |
| 14:15–14:50 | #1 core (Claude, serial). Codex reviews; merge. |
| 14:50–15:20 | Lanes A/B/C in parallel worktrees; Codex reviews each PR; merged one at a time |
| **15:30** | **Cut line: optional features that aren't reviewed, integrated and merged by now are cut** (moved from 15:20 at 14:53, after all Tier 1 work had merged) |
| 15:20–15:45 | #11 docs + acceptance run against an unrelated config; clean-install check |
| 15:45–16:00 | Buffer, then submit |

If #1 slips past 15:00, Tier 2/3 are dropped outright. Tests and docs are never cut to make room for a feature.
