Closes #

## What
<!-- One or two sentences: what this PR adds or changes. -->

## Why
<!-- The problem it solves and why it matters now (tier, what it unblocks). -->

## Decisions and trade-offs
<!-- Calls made where the spec was ambiguous, alternatives rejected, known limitations. These feed DECISIONS.md. -->

## Testing
- [ ] One concern per PR; no unrelated changes
- [ ] `npm test` passes (typecheck + all tests)
- [ ] Unit tests cover the feature in isolation (injected clock, no sleeps)
- [ ] Integration test exercises it end to end through the gateway against a mock upstream
- [ ] Works with a config unrelated to `config/gateway.yaml`

## Manual QA
<!-- Run the real gateway (`node src/main.ts <config>`) against `npm run mock`, exercise the feature, paste commands + output. -->

## Merge gate
- [ ] Fresh eyes: Codex review run (it did not write this code); findings addressed or answered
- [ ] Manual QA output posted

## Follow-ups
<!-- Anything deliberately left out of this PR. -->
