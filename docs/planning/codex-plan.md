# Codex (gpt-6-astra) independent plan (14:03 ET, written before seeing Claude plan)

**Recommendation:** ship a streaming gateway with dependable routing, deadlines, API-key authentication, both rate-limit strategies, and weighted target selection. Defer transformations, retries, circuit breaking, and active health checks. The priority is behavior you can explain and demonstrate under failure.

**1. Problem reading — what matters for the grade**

- **The core is the admission ticket.** Startup, `/health`, forwarding, method filtering, and unmatched-route behavior must work before extension work starts.
- **Configuration independence is essential.** Test unrelated route names, methods, upstream addresses, and limits—not just the supplied example.
- **Architecture means understandable boundaries.** An explicit pipeline and isolated stateful policies demonstrate extensibility without building a middleware framework.
- **Failure behavior is a feature.** Connection refusal, stalled responses, cancellations, and concurrent requests deserve acceptance tests.
- **Scope honesty beats silent partial support.** The supplied configuration must load; deferred features need startup warnings and an accurate support checklist.
- **History and explanation are deliverables.** Each issue should produce a reviewable capability, tests, and a rationale that feeds `DECISIONS.md`.
- **The walkthrough rewards ownership.** Claude implements; Codex reviews every pull request; the candidate must understand the resulting code.

**2. Architecture — explicit orchestration, isolated policies**

Use this layout:

| Files | Responsibility |
|---|---|
| `src/main.ts` | Configuration location, startup, signals |
| `src/config.ts`, `contracts.ts` | Parse unknown input; normalize core configuration; shared contracts |
| `src/router.ts` | Path precedence and method decisions |
| `src/server.ts`, `assemble.ts` | Request lifecycle; compile and connect route policies |
| `src/proxy.ts`, `headers.ts` | Upstream transport, deadlines, cancellation, header sanitation |
| `src/features/{auth,rate-limit,balance}.ts` | Feature validation and route-local state |
| `test/*.test.ts`, `test/helpers.ts` | Unit tests and self-contained upstream servers |

Use module imports with explicit `.ts` extensions, type-only imports, and separate typechecking: native stripping does not typecheck or implement `tsconfig` path aliases. [Node TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html)

`GatewayConfig` contains normalized routes, stable route identities, parsed durations, and feature blocks awaiting their owning feature’s validation. Core contracts:

```ts
type Rejection = { status: number; error: string; retryAfterSeconds?: number };
type Context = { request: IncomingMessage; clientIp: string; nowMs: number };
type Guard = (context: Context) => Rejection | undefined;
type Target = { url: URL; weight: number };
type Policies = { authorize: Guard; admit: Guard; select: () => Target };

declare function parseConfig(value: unknown): GatewayConfig;
declare function createGateway(
  config: GatewayConfig,
  policies: ReadonlyMap<string, Policies>
): Server;
```

Compile policies before listening. Configuration stays immutable; counters and selection cursors live inside per-route closures. Inject a monotonic clock for deterministic limiter tests.

The request order is:

**Health bypass → route selection → method check → authentication → rate admission → target selection → header sanitation → streaming proxy → cleanup.**

Health reports process liveness without depending on upstreams. Routing before method checks gives correct `404` versus `405`. Authentication precedes rate admission so rejected credentials do not consume legitimate traffic’s quota. Rejected requests never advance the balancing cursor or contact an upstream.

If later implemented, circuit admission belongs after rate admission; request transformation precedes transport; retries remain inside transport; response transformation precedes downstream headers. Do not create empty implementations for these future stages.

**Concurrency:** use one Node process. Limiter check-and-record and target selection execute synchronously, without an intervening `await`. With an empty bucket allowing ten requests, fifty simultaneous requests must yield ten admissions and forty rejections. State is process-local; horizontal coordination is explicitly unsupported.

**Failures:** connection, name-resolution, and TLS failures produce `502`; deadline expiry produces `504`. Unexpected internal failures produce sanitized `500` responses. Once downstream headers are committed, terminate a broken response rather than attempting another status. Client abandonment cancels upstream work. Finalization must release timers and resources exactly once.

Use an explicit total deadline that destroys the upstream request. Node’s request timeout notification alone does not abort it. [Node HTTP documentation](https://nodejs.org/docs/latest-v24.x/api/http.html)

**Bodies:** stream both directions with backpressure; preserve arbitrary bytes and compression. Handle stream errors explicitly so upstream failure before headers can still produce gateway JSON. Close rejected uploads after sending their rejection. No body parsing, replay buffering, or automatic retry ships.

**Extending configuration:** add validation and a policy factory in the feature module, connect it in `assemble.ts`, and add policy tests plus an integration test. Only the integrator edits shared wiring.

**3. Ambiguity calls — decisions to document**

- **Port conflict:** honor `gateway.port`, default to `8080`; the supplied-config startup test must bind `8080`.
- **Configuration location:** positional command-line path wins over `GATEWAY_CONFIG`; otherwise use `gateway.yaml`.
- **Extracted formatting:** repair PDF indentation in the checked-in fixture; runtime accepts valid YAML only.
- **Malformed configuration:** exit unsuccessfully before listening, with field-path diagnostics and no secret values.
- **“Health regardless of config”:** bypass configured policies in a successfully started process; invalid startup configuration does not create a separate health server.
- **Health matching:** reserve `/health`; ignore its query string; GET succeeds, other methods receive `405`.
- **Uptime:** floor monotonic elapsed seconds since the listener became ready.
- **Missing fields:** require route path, methods, and upstream; default `strip_prefix` to false and global timeout to `30s`.
- **Empty routes:** valid; health works and ordinary requests return `404`.
- **Validation boundary:** reject duplicate YAML keys and unknown core keys; recognized deferred blocks generate startup warnings.
- **Durations:** accept positive finite values with `ms`, `s`, or `m`; reject unitless values and values outside safe timer bounds.
- **Numeric fields:** request counts, ports, and weights are positive integers; reject invalid ranges.
- **Route matching:** use case-sensitive, segment-boundary prefixes; `/api/users-extra` does not match `/api/users`.
- **Precedence:** longest matching path wins; duplicate canonical route paths are invalid.
- **Method precedence:** select the path first, then return `405` with `Allow`; never fall back to a shorter route.
- **Methods:** normalize configured method names to uppercase; do not infer HEAD or OPTIONS support.
- **Path representation:** match the raw pathname without decoding or normalization; preserve query bytes and repeated query parameters.
- **Trailing slashes:** canonicalize configured trailing slashes except root; preserve the incoming suffix.
- **Prefix stripping:** strip only the matched prefix; an empty remainder becomes `/`; root stripping preserves the leading slash.
- **Upstream forms:** require exactly one of `url` or nonempty `targets`; reject duplicate target URLs.
- **Upstream URL composition:** append the forwarded path to any configured base path; retain base-query parameters before incoming-query parameters.
- **Upstream protocols:** support HTTP and HTTPS with certificate verification; reject embedded credentials and fragments.
- **Proxy scope:** no redirect following, CONNECT tunneling, protocol upgrades, or automatic failover.
- **Headers:** remove hop-by-hop fields and fields named by `Connection` in both directions; preserve repeated `Set-Cookie`.
- **Authority and forwarding:** set upstream `Host`; replace untrusted forwarding headers with gateway-derived values.
- **Client identity:** use the socket address, normalize IPv4-mapped addresses, and ignore client-supplied forwarded addresses.
- **Timeout meaning:** route timeout replaces the global timeout; deadline covers connection establishment, upload, and response transfer.
- **Upstream errors:** ordinary upstream error statuses and bodies pass through unchanged.
- **Rate inheritance:** absent route policy inherits the complete global policy; route configuration replaces it wholesale; null is invalid.
- **Global limit meaning:** global configuration supplies route defaults; `per: global` shares a bucket within that route, not across all routes.
- **Fixed windows:** align windows to the injected monotonic clock’s origin.
- **Sliding windows:** retain accepted timestamps in an exact rolling window; expire timestamps at or before its lower boundary.
- **Accounting:** count admitted requests even if upstream work fails; authentication failures and rate rejections do not count.
- **Rate rejection:** return `429`, JSON error information, and integer `Retry-After`, rounded upward to earliest admission.
- **Limiter storage:** expire inactive buckets and cap identities per route; saturation rejects new identities with `503` rather than evicting active quotas.
- **Authentication:** header names are case-insensitive; keys are exact strings; missing, duplicate, or invalid credentials receive `401`.
- **Authentication configuration:** unsupported types and empty key lists fail startup; never silently bypass configured authentication.
- **Balancing:** default to round robin; weighted mode uses smooth weighted round robin with configuration-order ties and default weight one.
- **Selection failures:** failed requests still advance selection; balancing alone does not imply health awareness.
- **Reload and restart:** configuration is a startup snapshot; restart resets all in-memory policy state.

The following are **deferred semantics**, not claims of implemented support:

- **Retries:** attempts includes the initial request; initially permit GET/HEAD only, retry configured statuses, and share the original deadline across attempts and delays.
- **Backoff:** fixed repeats the initial delay; exponential doubles successive delays; no implicit jitter.
- **Active health:** probe each target with GET; successful responses are healthy; consecutive failures trip the threshold, and a successful probe restores eligibility.
- **Circuit breaker:** route-wide rolling failures include transport errors, timeouts, and upstream server errors; count final logical outcomes, excluding authentication, limiting, and client cancellation.
- **Recovery:** cooldown permits one probe; success clears breaker history, failure restarts cooldown; open responses include the specified `503` body.
- **Header transforms:** remove before adding; additions overwrite case-insensitively; timestamps use UTC ISO strings and `$route_path` means the configured route.
- **Body mapping:** produce a new JSON object; omit missing sources; use object-only dotted paths; reject conflicting or prototype-sensitive destinations.
- **Envelopes:** substitute recursively; `$body` preserves structured JSON; unknown variables fail validation.
- **Transformation failures:** require uncompressed JSON, cap buffering, reject invalid client JSON with `400`, and invalid upstream JSON with `502`; preserve bodyless HTTP semantics.

**4. Issue backlog — budgets include implementation and relevant tests**

These are planning estimates. Every issue gets its own branch and pull request, Codex review, and a merge commit. Parallel branches start from the merged core. Feature authors leave shared wiring and documentation to the integrator.

| Issue | Priority / minutes / dependencies | Ownership and testable acceptance | Parallel? |
|---|---|---|---|
| **A. Runnable streaming gateway** | P0 / 35 / none | Own package files, `src` core files listed above, `test/core.test.ts`, helpers, config fixture, initial run instructions. Startup on `8080`; exact health JSON; body/status forwarding; strip-prefix/query preservation; `404`; `405` with `Allow`; unrelated configuration passes. Targets-only routes initially use their first target with a warning. Configured auth remains closed until wired. | No; establishes contracts. |
| **B. Transport failure handling** | P0 / 25 / A | Own `proxy.ts`, `headers.ts`, shutdown in `main.ts`, `test/transport.test.ts`. Prove connection refusal, delayed headers, stalled body, premature upstream close, client cancellation, binary forwarding, cookie preservation, hop-by-hop removal, and resource cleanup. | Alongside C–E. |
| **C. API-key authentication** | P0 / 10 / A | Own `features/auth.ts`, `test/auth.test.ts`. Validate configuration; test missing/wrong/duplicate/correct keys and header casing; rejected requests cannot reach the mock upstream. | Alongside B, D, E. |
| **D. Fixed and sliding rate limits** | P1 / 25 / A | Own `features/rate-limit.ts`, `test/rate-limit.test.ts`. Test inheritance, route/IP isolation, shared route buckets, exact boundaries, retry timing, cleanup/capacity, and the simultaneous-request admission count. | Alongside B, C, E. |
| **E. Target balancing** | P1 / 15 / A | Own `features/balance.ts`, `test/balance.test.ts`. Test round-robin order, arbitrary weights, deterministic ties, independent route cursors, and a complete weighted cycle matching configured proportions. | Alongside B–D. |
| **F. Integrate reviewed policies** | P0 / 20 / B–E selected for release | Own `assemble.ts`, `test/integration.test.ts`. Wire factories; prove auth precedes limiting, denied requests never select targets, health bypasses policies, and warnings match actual support. Includes serial extension reviews and merges. | No shared-wiring parallelism. |
| **G. Acceptance and submission** | P0 / 35 / F | Own final README, `DECISIONS.md`, `test/acceptance.test.ts`. Single `npm test` command includes typechecking and tests; clean-install run succeeds; supplied and unrelated configurations work; support checklist, limitations, history, and repository access are verified. | Final stage; documentation notes accumulate earlier. |

**5. Timeline — 14:00–16:00 ET**

| Time | Work |
|---|---|
| 14:00–14:05 | Create issues; freeze contracts, ownership, and scope. |
| 14:05–14:40 | Claude builds A; Codex reviews; merge the working core. |
| 14:40–15:05 | Claude owns B; separate worktrees handle C, D, and E. |
| 15:05–15:25 | Finish serial reviews, merge accepted work, integrate through F. |
| 15:25–15:40 | Run acceptance scenarios and resolve release-blocking failures. |
| 15:40–15:55 | Finish documentation, rehearse explanations, verify clean setup. |
| 15:55–16:00 | Verify submitted repository reference and submit. |

**Cut line: no new feature implementation after 15:05.** Unfinished optional work stays unmerged. If the core slips, drop balancing first, then rate limiting; preserve transport correctness, authentication safety, and submission time.

Do not build transformations, retries, breakers, active probes, hot reload, distributed state, deployment infrastructure, or a plugin framework. Their interactions create more verification work than their implementation size suggests. Document each omission.

**6. Top five finishing risks**

- **Core work expands before anything runs.** Land the end-to-end path first; treat advanced policy work as dependent on that milestone.
- **Node stream lifecycle mistakes.** Test both pre-header and mid-body failures, cancellation, and exactly-once cleanup; do not confuse request completion with client abandonment.
- **Parallel work collides during integration.** Freeze contracts, assign exclusive feature files, and give one owner all shared wiring.
- **Tests accidentally encode the example configuration.** Use unrelated paths, injected clocks, arbitrary policy values, and upstream servers on ephemeral ports.
- **Features consume review and submission time.** Enforce the cut line; keep incomplete branches out of the release; write decisions as work proceeds.
