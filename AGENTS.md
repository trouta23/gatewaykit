# GatewayKit: notes for AI agents

TypeScript run directly on Node 24 (no build step). `npm test` typechecks and runs the full suite. Architecture and pipeline order: `docs/PLAN.md`.

## Code Review Rules
- **Security policies must fail closed.** A configured feature that guards access (auth) must never be skipped or bypassed by a code path, header or path trick. Flag any path where a request reaches an upstream without passing the route's configured policies.
- **Upstream calls are bounded and sanitized.** Every upstream request honors the request deadline, and failures map to 502/504 JSON without leaking internal error details. Flag unbounded waits, leaked timers, and response bodies that are neither consumed nor destroyed.
- **Validate at startup, not per request.** Config problems belong in `src/config/validate.ts` with a path-qualified message. Flag runtime code that can throw on config a validator should have rejected.
- **Shared state is synchronous.** Check-and-update of in-memory state (rate limit buckets, balancer cursors, breaker state) must not await between the check and the update.
- **Never log secrets.** API keys and credential headers must not appear in logs, errors, or forwarded headers.
