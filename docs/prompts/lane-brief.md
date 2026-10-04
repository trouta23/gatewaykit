# Lane brief: GatewayKit feature implementation

You are implementing GitHub issues for GatewayKit, a config-driven API gateway (TypeScript, run directly on Node 24, no build step). This is a timed take-home: the hard deadline is 16:00 ET and optional features must be merged by 15:20. Work fast, but every line must be something the candidate can explain in a code walkthrough. Clarity beats cleverness.

## Read first (in your worktree)
- `docs/PLAN.md`: architecture, pipeline order, resolved ambiguities, file ownership.
- `src/pipeline.ts`: the `Handler` / `Middleware` / `Plugin` / `BuildContext` / `GatewayError` contracts.
- `src/server.ts`, `src/proxy/forward.ts`, `src/upstream/balancer.ts`: how requests flow.
- `src/config/types.ts`: your feature's config is already validated and normalized there (`route.features.<name>`, durations in ms).
- `test/helpers.ts`, `test/core.test.ts`: test conventions (`startGateway(rawConfig, options)`, `startMocks(...)`, `mock/upstream.ts` behaviors).
- `gh issue view <N>`: the acceptance criteria are the spec.

## Hard rules
1. Work ONLY inside your assigned worktree directory. Never cd into or modify `<repo>` itself or other worktrees.
2. **Frozen files**: `src/pipeline.ts`, `src/server.ts`, and everything in `src/config/`. Don't edit them. If you believe a contract change is required, stop and say so in your final report rather than editing.
3. Only touch the files your lane owns (listed in your task), plus your own test files. In `src/plugins/index.ts`, replace ONLY your feature's comment slot line with the plugin reference, keeping the comment as a trailing comment, e.g. `  authPlugin, // auth (#3): reject before any work is done or quota is spent`. Leave the blank lines between slots in place.
4. Plugin shape:
   ```ts
   export const fooPlugin: Plugin = {
     feature: 'foo',
     build(route, ctx) {
       const config = route.features.foo;
       if (!config) return undefined;
       // per-route state lives here, in the closure
       return (next) => async (req) => { ... };
     },
   };
   ```
   Use `ctx.now()` for time, never `Date.now()`, so tests can inject a clock. `unref()` any timer and register its cleanup with `ctx.onClose`. Reject by throwing `new GatewayError(status, code, { details, headers })`. Requests are immutable: derive new ones with spread. If you discard a response, `destroy()` its body stream.
5. **One concern per PR.** One issue = one branch = one PR. Aim for under ~300 changed lines excluding tests. No drive-by refactors or unrelated formatting.
6. Style: match the existing code. Comments explain *why*, not *what*. Explicit return types on exported functions. No `any`. English only in code, commits and PRs.
7. Tests (`node:test` + `node:assert/strict`): unit-test the plugin by calling `plugin.build(route, ctx)` with a route from `validateConfig({...}).routes[0]`, a fake `next`, and an injected clock. No sleeps over ~50ms; tests must be parallel-safe (ephemeral ports only). Add at least one integration test through the real gateway (`startGateway` + `startMocks`) using a config unrelated to `config/gateway.yaml`. `npm test` (typecheck + tests) must pass before you push.
8. Commits: small, imperative subject; the body explains why. End every commit message with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
9. **Manual QA is required before you open the PR.** Start the real gateway against mock upstreams on free ports (write a small temp YAML config into your worktree's `.qa/` folder, which you must not commit; `node src/main.ts .qa/qa.yaml`, plus `startMockUpstream` via a small script or `node mock/upstream.ts` if ports 3001-3006 are free). Exercise the feature with a script FILE run by `node` (`curl` and inline `fetch` in shell commands are blocked by a local hook, so write the requests to a `.qa/*.mjs` file and run it). Kill the processes afterwards. Paste the commands and trimmed output into the PR's "Manual QA" section.
10. Open the PR with `gh pr create --base main --title "<concise title>" --body-file <file>`. The body must follow the template from `git show origin/main:.github/pull_request_template.md`: `Closes #N`, What, Why, Decisions and trade-offs, Testing checkboxes, Manual QA, Merge gate (leave the Codex box unchecked; the integrator runs Codex). End the body with a blank line and then `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. **Don't merge** and don't run Codex yourself.
11. Your branch is based on `feat/1c-proxy-server`, the top of the core PR stack, which is not merged yet. Open your PR against `main` anyway; the integrator merges the stack first and the diff then shrinks to your commits.
12. When your lane has a second issue: `git fetch -q origin` and create the next branch from `feat/1c-proxy-server` (or from `origin/main` if `git merge-base --is-ancestor origin/feat/1c-proxy-server origin/main` succeeds), so each PR stays independent.

## Final report (your last message)
At most 150 words: PR URLs; decisions you made where the issue was ambiguous; anything you're unsure about; anything you couldn't do.
