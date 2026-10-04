# Decisions

How GatewayKit was built in a two-hour window: what got built first and why, the architecture, the calls made where the spec was ambiguous, and what's next. The working plan is in [`docs/PLAN.md`](docs/PLAN.md), and every change has a PR with its own trade-offs, a review and manual QA.

## 1. How I prioritized

The rubric weighs judgment (35%) and production thinking (25%) above volume, and says outright that nobody finishes. So the order was:

1. **Core first, and it had to be solid** (#1): port 8080, `/health`, proxying, 404, 405, strict config. That part is pass/fail, and every feature sits on top of it.
2. **Features that protect the system and are named in the rubric**: rate limiting ("50 requests hit a rate-limited route simultaneously"), auth, and the failure modes in the core (upstream down → 502, slow → 504).
3. **Resilience** that needs the core's contracts: load balancing, circuit breaker, retry, health checks.
4. **Transforms last.** They touch the most code and reduce the least risk.

Issues carry a tier label (impact and what blocks what) instead of time estimates. Optional work had a hard cut line: anything not reviewed, integrated and merged by then was left out. It started at 15:20 and moved to 15:30 once all Tier 1 work had merged early.

## 2. Architecture

**The server is a function.** `Handler = (req) => Promise<GatewayResponse>`, and every config feature is a `Middleware = (next: Handler) => Handler`.

- Short-circuiting features (auth, rate limit, an open breaker) throw a `GatewayError`, which is rendered once as JSON.
- Retry calls `next` again. Transforms map the request or response object.
- Every feature is unit-tested with a fake `next` and an injected clock, without sockets.

The rejected alternative was Express-style `(req, res, next)`. Once a middleware has written to `res`, retries and response transforms become hacks. Codex's independent plan argued for plain guard functions instead of middleware. I kept middleware because guards can't express "call the upstream again" or "map the response" without new contracts each time.

**Request lifecycle.** Each route compiles once at startup into a single composed handler. The order is fixed in [`src/plugins/index.ts`](src/plugins/index.ts):

`/health` (reserved) → route match (404) → method (405 + Allow) → auth → rate limit → response transform → request transform → circuit breaker → retry → forward (load balancer → upstream)

- **Auth before rate limiting**, so unauthenticated traffic can't drain a shared `per: global` bucket.
- **Breaker outside retry**, so one client request counts as one failure.
- **Response transform outside retry**, so it maps only the final response.

**Adding a feature** means a validator entry, one plugin file, one registry line and its tests. Several features were built in parallel by separate agents this way without touching each other's files.

**Body ownership.** A handler resolves when upstream headers arrive. Whoever receives a response owns its body stream and must consume it or `destroy()` it. The forwarder keeps the request deadline armed until the body finishes, so a stalled stream can't outlive the timeout.

**Concurrency.** Node runs one event loop, and every check-and-update of shared state (rate buckets, balancer cursor, breaker) is a synchronous block with no `await` between the check and the update. So 50 simultaneous requests against a limit of 10 admit exactly 10, and a test asserts it. State lives in one process; running several instances would need a shared store such as Redis.

## 3. Production thinking

| Scenario | Behavior |
|---|---|
| Malformed config | Every problem is listed with its YAML path, then exit 1 before the port is bound. Unknown keys are errors, because `auht:` must not silently disable auth. |
| Upstream down | 502 JSON; internal error details are logged, not leaked |
| Upstream slow | 504 once the route's deadline passes (one deadline per request, covering the body) |
| Client disconnects | The upstream request is aborted |
| Configured feature not built | Startup warning. `auth` fails **closed** (503), so a configured security policy is never skipped. |
| Request smuggling | Body framing is always re-declared on the upstream request (see §5) |
| Path tricks | Dot segments are resolved before routing, so `/public/../internal` can't dodge a route's policies |
| Forwarded headers | `X-Forwarded-For` comes from the socket, not the client, because this gateway is the edge |

## 4. Calls on ambiguities in the spec

- Route matching uses the longest prefix on segment boundaries: `/api/users` matches `/api/users/1`, not `/api/usersX`.
- `GET /health` is reserved even if a route claims `/health`.
- `global_rate_limit` is the *default policy*: each route gets its own buckets, and a route's `rate_limit` replaces the default rather than stacking on it.
- `per: ip` is the socket address; trusting `X-Forwarded-For` would need a trusted-proxy list.
- `timeout` is one deadline for the whole client request, retries included (Envoy's semantics). Otherwise 3 attempts × 5s plus backoff turns a 5s timeout into 18s.
- Retry covers idempotent methods only. POST is never retried, because a retried POST to `/api/orders` can create an order twice.
- If every target fails its health check, the gateway sends traffic to all of them (Envoy's panic mode) rather than black-holing the route.
- `$request_time` and `$response_time` are ISO-8601 UTC timestamps.

## 5. How I used AI tools

- **Two independent plans, then reconciliation.** Claude and Codex (gpt-6-astra) each wrote an architecture and backlog without seeing the other's ([`docs/planning/`](docs/planning/)). Claude reconciled them in [`docs/PLAN.md`](docs/PLAN.md). Codex accepted all seven of Claude's resolutions and added three blockers that were folded in: who owns the response body, file ownership per parallel lane, and a stricter cut line.
- **Codex as the reviewer on every PR.** It reviews code it didn't write, with standing rules in [`AGENTS.md`](AGENTS.md), and gets an adversarial re-review after fixes. Real defects it caught:
  - **Request smuggling in the core (P1).** Stripping the hop-by-hop `Transfer-Encoding` header left a chunked GET body unframed, so the upstream parsed it as a second request that skipped auth. The adversarial re-review then found a second way in (`Connection: content-length`). Both are fixed, each with a regression test confirmed to fail without its fix.
  - **Credential leak in auth (P1).** With `auth.header: X-Request-Id`, the key was copied into the forwarded request id. That config is now a startup error.
  - **Circuit breaker (P2).** Slow failures from before a recovery could re-open a freshly closed circuit. Each request now carries the circuit "generation" it was admitted in.
  - **Config validation (6 × P2).** Header syntax, prototype-polluting mapping paths, envelope lists, cyclic YAML aliases.
- **Parallel feature lanes.** After the core contracts were frozen, Claude subagents built features in separate git worktrees, one issue per PR. I'm the integrator: I merge serially and own the shared files.
- **Course corrections.** The first core PR was ~1,900 lines and mixed five concerns, so it was closed and split into a three-PR stack. The PR template was rewritten after a quick evidence review: description/code mismatch is the measurable risk, and checkbox lists turn into ceremony.
- **Merge gate.** Tests green, a Codex review (re-reviewed after fixes), and my own manual QA against the real gateway process. Each PR has one comment holding both. QA caught a test that silently proved nothing: `fetch` normalizes `..` on the client side, so the dot-segment test never exercised the gateway.
- **Parallelism has a cost.** At peak, five agents and five reviews ran at once, and PRs arrived faster than they could be reviewed well. I capped work in flight at three and merged strictly by tier.
- **What the AI didn't decide:** scope, the cut line, and the "base before breadth" pause came from me.

## 6. Built, partial, and next

**Built** (each merged only after a Codex review, any re-reviews, and my own QA against the real process). The [README checklist](README.md#feature-checklist) has per-feature behavior.

| Tier | Feature | PR |
|---|---|---|
| 1 | Core: strict config, routing, `/health`, 404/405, streaming proxy, deadlines | #13, #14, #15 |
| 1 | Rate limiting (fixed and sliding, per IP and global) | #19 |
| 1 | Load balancing (round robin, smooth weighted) | #18 |
| 1 | API-key auth | #17 |
| 1 | Transport hardening and graceful shutdown | #22 |
| 2 | Circuit breaker | #20 |
| 2 | Retry with backoff (idempotent only, shared deadline) | #24 |
| 3 | Active health checks | #21 |
| 3 | Header transforms | #23 |
| — | CI (GitHub Actions) and runnable manual QA (`npm run qa`) | #25, #26 |

**Not built:** body transforms (`request_transform.body.mapping`, `response_transform.body.envelope`, #10). Their config is fully validated at startup (unsafe mapping paths, unknown `$variables` and cyclic aliases are all rejected), and the gateway logs a warning that they aren't applied. They were last in priority: they need body buffering, JSON parsing and new failure modes (invalid client JSON → 400, invalid upstream JSON → 502) for the least risk reduction.

**Known limitations** (all deliberate, all documented on their PRs):
- Node keeps only the first `Authorization` header when duplicates arrive. It isn't a bypass, since the request still needs a valid key; fixing it means carrying `headersDistinct` through the request contract.
- A 504 that the forwarder raises because earlier middleware used up the whole deadline counts as a breaker failure, although no upstream was contacted. Retry handles its own case (a slow upload is a 408).
- Health state changes aren't logged, because `BuildContext` has no logger yet.
- Response transforms can't remove the `X-RateLimit-*` headers, because rate limiting wraps them.
- All state is in-process. Limits and breaker state reset on restart and aren't shared between instances.

**Next, with more time:**
- Body transforms (#10), on the same buffering path that retry now uses
- A shared store (e.g. Redis) so limits and breaker state hold across instances
- Passive health checks (eject a target after real-traffic failures) alongside the active probes
- Hot config reload, with an atomic swap of compiled routes
- Retry jitter, plus per-try timeouts inside the overall deadline
- A logger in `BuildContext`, and per-route latency and status metrics
- HTTPS upstream tests (the code path exists; no TLS mock yet)
