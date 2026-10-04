You are a senior backend engineer. Independently architect and plan a time-boxed take-home project. Another engineer (Claude) is producing its own plan in parallel without seeing yours; afterwards the two plans will be compared and reconciled, so think for yourself and make concrete calls rather than hedging.

## Situation
- Take-home: build "GatewayKit", a config-driven API gateway. Full requirements text (extracted from the PDF) is below between REQUIREMENTS markers.
- Hard window: 14:00-16:00 ET today (2 hours total, including docs and submission). Graded later in a 30-min code walkthrough.
- Recruiter email adds: "Prioritize: focus on Core Requirements first (port 8080, /health, basic proxying). Architecture over volume: a few features built cleanly beat a brittle implementation of many. Stick to the language's standard library and a YAML parser. No existing API gateway or proxy frameworks."

## Fixed decisions (do not revisit)
- TypeScript run directly on Node 24 (native type stripping: erasable syntax only - no enums, namespaces, parameter properties). node:http / node:https for server and upstream client, node:test for tests. Only runtime dependency: `yaml`. Dev-only typescript + @types/node for typechecking are acceptable.
- Work is tracked as GitHub issues; one branch + PR per issue, merged with merge commits so history tells the story.
- Claude implements. After the core lands, Claude may run 2-3 parallel subagents in separate git worktrees, so issue boundaries must minimize merge conflicts. You (Codex) will review every PR.

## What to produce (markdown only; do not write files or code beyond short type signatures)
1. **Problem reading** - what actually matters for the grade and why (5-8 bullets).
2. **Architecture** - module/file layout; the core abstractions with TypeScript type signatures; request lifecycle and the ORDER of pipeline stages with justification; how a new config feature gets added; concurrency model; failure-mode handling (upstream down, timeout, malformed config, 50 concurrent requests on a rate-limited route); body buffering vs streaming policy.
3. **Ambiguity calls** - enumerate every ambiguity you find in the config/spec (aim for exhaustive) and your decision for each, one line each.
4. **Issue backlog** - ordered list. For each issue: title, priority (P0-P3), estimated minutes, depends-on, files it owns, testable acceptance criteria, and whether it can run in parallel with others.
5. **Timeline 14:00-16:00** - with an explicit cut line: what you would deliberately NOT build and why.
6. **Top 5 risks** to finishing well, with mitigations.

Be concrete and opinionated. Target 1500-2200 words.

=====REQUIREMENTS START=====
(the full text of the take-home PDF was pasted here)
=====REQUIREMENTS END=====
