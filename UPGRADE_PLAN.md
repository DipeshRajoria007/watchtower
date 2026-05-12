# Watchtower Upgrade Plan

Status: Proposal — open to feedback.
Scope: architectural upgrades to make Watchtower quicker, more accurate, and more versatile, plus a prioritized list of new features.

This document is a planning artifact, not a commitment. Each item is an independent proposal with a rough impact/effort estimate so the team can pick the ones worth shipping.

---

## 1. Purpose

Watchtower today is a working multi-agent system: Slack mentions in, PRs out, with a planner→coder→reviewer→security→performance→verifier pipeline isolated in per-thread git worktrees. It works, but the pipeline is serial, context-heavy, and built around one-shot subprocess calls rather than an iterative tool-use loop.

This document catalogs the gaps against a modern agent-loop architecture (streaming tool use, subagents, prompt caching, MCP, hooks) and proposes concrete upgrades grouped by theme: **speed, accuracy, versatility**. It closes with a priority matrix and a suggested first sprint.

---

## 2. Executive Summary

**What's strong today** — keep these:

- Backend-agnostic agent layer (`sidecar/src/backends/types.ts`): Claude Code and Codex are pluggable behind a clean `AgentBackend` contract.
- Git worktree isolation per `(repo, threadTs)` with symlinked `node_modules` (`sidecar/src/workspaces/workspaceManager.ts`).
- Slack Socket Mode + catchup poller (`sidecar/src/slack/mentionCatchup.ts`) — no missed mentions.
- SQLite with WAL mode and rich schema (jobs, job_logs, agent_pipeline_runs, job_diffs, learning_signals).
- Multi-agent pipeline already exists (`sidecar/src/agents/pipeline.ts`).
- Failure Doctor classifies 23 error categories and posts remediation hints (`sidecar/src/learning/failureDoctor.ts`).

**The core mismatch**: Watchtower runs each agent as a **one-shot subprocess call with a giant prompt**, not as an **iterative tool-use loop**. Every stage re-serializes all prior stage outputs into its prompt. There's no prompt caching, no streaming UI, no parallelism between independent stages, and no subagent primitive.

**Highest-leverage fixes** (detail below):

1. Prompt caching — 40–60% token reduction, ~1–2s TTFT improvement.
2. Parallel reviewer + security + performance — ~50% pipeline wall-time cut.
3. Context compaction via `summaryForNext` — stops late-stage context explosion.
4. Streaming Tauri events — replaces 2–5s UI polling.
5. Tool-use loop for agents — bigger accuracy step than any prompt tweak.
6. MCP client — the single biggest versatility unlock.

---

## 3. Current Architecture Snapshot

```
┌──────────────────────────────────────────────────────────┐
│ Slack (Socket Mode + catchup)                            │  sidecar/src/slack/
├──────────────────────────────────────────────────────────┤
│ Router: intent parsing, classification, access control   │  sidecar/src/router/
├──────────────────────────────────────────────────────────┤
│ Workflows: prReview, implementation, informational, ...  │  sidecar/src/workflows/
├──────────────────────────────────────────────────────────┤
│ Multi-agent pipeline: planner → coder → reviewer →       │  sidecar/src/agents/
│   security → performance → verifier                      │
├──────────────────────────────────────────────────────────┤
│ Backends: Claude Code | Codex                            │  sidecar/src/backends/
├──────────────────────────────────────────────────────────┤
│ Workspaces (git worktree), GitHub (gh CLI), State (SQL)  │  sidecar/src/{workspaces,github,state}/
├──────────────────────────────────────────────────────────┤
│ Learning: failure doctor, self-learning, personality     │  sidecar/src/learning/
└──────────────────────────────────────────────────────────┘
              ▲                                   ▲
              │                                   │
        Tauri shell ───────────────────► React UI (polling)
       (sidecar supervision,              (Runs, Launchpad,
        DB-backed commands)                Intelligence, ...)
```

---

## 4. Gap Analysis

| # | Gap | Evidence | Cost today |
|---|-----|----------|-----------|
| 1 | No prompt caching | Full context rebuilt per call in `agents/prompts.ts` | 3–5× token spend; slower TTFT |
| 2 | Strictly sequential pipeline | `agents/pipeline.ts` runs stages serially | 150s+ floor for 5-agent runs |
| 3 | Context explosion | Each stage gets `JSON.stringify` of all prior stages | Late stages blow context limits |
| 4 | Polling UI, not streaming | Frontend polls every 2–5s (`src/App.tsx`) | Feels laggy; step boundaries invisible |
| 5 | Blocking LLM intent classifier | `router/classifyIntent.ts` runs on every mention | +1–2s fixed latency per message |
| 6 | No trace ID propagation | jobId exists in DB but isn't threaded through calls | Can't correlate logs without grep |
| 7 | No per-agent timeouts | Timeout logic commented out in `agents/pipeline.ts` | One stuck stage hangs the pipeline |
| 8 | Retries are immediate | `sidecar/src/index.ts` retry loop, no backoff | Rapid cascading failures |
| 9 | Unbounded subprocess output buffering | `backends/runCodex.ts` buffers stdout in memory | OOM risk on malformed output |
| 10 | Zod only on output schemas | Event envelopes, job payloads are plain TS | Malformed events crash silently |
| 11 | No subagent primitive | Agents can't spawn parallel sub-tasks | No background verification |
| 12 | MCP absent | GitHub uses `gh` CLI, Slack uses Bolt directly | Can't plug in Figma/Linear/Sentry |
| 13 | Worktree creation is racy | No lock; existence check is non-atomic (`workspaces/workspaceManager.ts`) | Concurrent jobs on same thread collide |
| 14 | Personality profiles are stubs | Enum exists; hardcoded `'normal'` (`learning/selfLearning.ts`) | Reaction sentiment never shapes prompts |
| 15 | Learning is exact-phrase match | Token-slice keying in `learning/selfLearning.ts` | Intent corrections rarely hit new wording |

---

## 5. Upgrade Themes

### 5.1 Speed

#### 5.1.1 Anthropic prompt caching
Largest single lever. Add one `cache_control` breakpoint at the end of: system prompt + policy pack + repo manifest + prior-stage summaries.

- Wire in `backends/claudeCodeBackend.ts`. Mark the stable prefix with `cache_control: { type: "ephemeral" }`.
- Stable prefix = system prompt + serialized planner/coder output (doesn't change within a reviewer↔coder loop).
- Expose `cache_read_input_tokens` as a "cache hit rate" metric in the UI.

Expected: 40–60% token reduction on multi-stage runs; ~1–2s TTFT improvement when cache is warm.

#### 5.1.2 Parallelize independent stages
After the coder completes, `reviewer`, `security`, and `performance` are independent. Run with `Promise.all`. Verifier runs after all three.

DAG:
```
planner → coder → { reviewer ∥ security ∥ performance } → verifier
```

Add `sidecar/src/agents/agentDag.ts` to declare stage dependencies; the executor walks it level by level. Expected: ~50% pipeline wall-time reduction on typical runs.

#### 5.1.3 Fast-path intent classifier
Every mention currently does an LLM call. Most are classifiable with ~10 regex rules:

- PR URL present → `PR_REVIEW`
- Verbs build|fix|add|rewrite|refactor → `IMPLEMENTATION`
- Question marks only, no imperatives → `INFORMATIONAL`
- Greetings only → `CONVERSATIONAL`

Keep the LLM fallback for the ambiguous ~20%. Target: <50ms on most mentions.

#### 5.1.4 Status-message streaming
`agents/pipeline.ts` posts per-stage messages. Convert to **edits of a single pinned status message**:

```
🟡 Planning… 🟢 Coding… 🟡 Reviewing…
```

Same signal, no thread noise.

#### 5.1.5 Pre-warmed worktree
On sidecar start, pre-create a bare worktree for the most-used repo with `git fetch` pre-run. Cuts first-job latency 3–8s.

#### 5.1.6 Async batched logging
`store.appendJobLog()` currently writes to SQLite synchronously on a hot path. Buffer and flush every 250ms or on stage boundaries.

### 5.2 Accuracy

#### 5.2.1 Context compaction via `summaryForNext`
Instead of `JSON.stringify` of every prior output, add `summaryForNext: string` to every agent JSON schema. Later stages get the full output only when needed; otherwise they get the summary. Mirrors Claude Code's internal compaction.

Schema change lands in `sidecar/schemas/agent-*.schema.json`.

#### 5.2.2 Schema repair loop
`backends/runCodex.ts` parses JSON but doesn't validate against Zod. Add strict post-parse Zod validation; on failure, do **one repair call** with the validation error in the prompt (`"your output failed schema X at path Y — re-emit valid JSON"`). Eliminates most silent-failure modes.

#### 5.2.3 Verifier runs real commands
Today's verifier is a lightweight LLM check. Upgrade to run:

- `npm run lint`, `npm run test`, `npm run build` (discovered from `package.json`)
- Feed exit codes + failing output into a final LLM decision

Converts "LLM thinks the code is fine" into "the code actually builds and tests pass."

#### 5.2.4 Targeted reviewer↔coder repair
Currently the coder re-runs with reviewer feedback stuffed into context. Two improvements:

- **Targeted re-runs**: send only the specific files + specific findings, not the whole task.
- **Ceiling by criticality**: skip the retry loop if reviewer has only `info` / `low` findings; only `high` / `critical` trigger another coder pass.

#### 5.2.5 Embedding-based learning memory
`learning/selfLearning.ts` uses a naive tokenized phrase key. Cheap upgrade:

- Compute a small embedding (e.g. `text-embedding-3-small`) for each past correction.
- At mention time, find the nearest prior correction above a cosine threshold.
- Store `{intent_from, intent_to, repo, user, text_embedding}` instead of tokenized phrase keys.

Expected: roughly 5× correction hit rate.

#### 5.2.6 Zod-validate inbound events
Add Zod schemas for `SlackEventEnvelope`, `NormalizedTask`, and thread context payloads. Parse at the router boundary; reject malformed envelopes with a diagnostic log instead of crashing downstream.

#### 5.2.7 Failure-Doctor-driven retry strategy
`learning/failureDoctor.ts` already classifies errors. Route that classification back into retry policy:

- `NETWORK_DNS` / `429` → exponential backoff with jitter (1s, 4s, 15s)
- `NATIVE_MODULE_ABI_MISMATCH` → do not retry; surface immediately
- `CODEX_OUTPUT_SCHEMA` → one schema-repair attempt, then fail

Wire `diagnoseFailure()` output into the retry decision per attempt.

### 5.3 Versatility

#### 5.3.1 True tool-use loop for agents
Biggest accuracy step available. Instead of one-shot JSON out, give each agent a structured toolset and iterate until done:

- Tools: `read_file`, `grep`, `ls_dir`, `run_cmd(whitelisted)`, `apply_patch`.
- Backends that support tool use natively (Claude Code CLI) are mostly passthrough; Codex needs a thin adapter.
- Net effect: the coder reads only the files it cares about instead of getting them dumped into the prompt.

#### 5.3.2 Subagent primitive
First-class `spawnSubagent({ role, task, tools, budget })` for any stage:

- Coder spawns a test-runner subagent in parallel with its own iteration.
- Reviewer spawns a docs-check subagent while looking at code.
- PR review spawns one subagent per file for large PRs.

Implementation: subagents reuse pipeline machinery with `maxStages=1`, their own `AbortController`, and a short context window. Results merge back into the parent's context.

#### 5.3.3 MCP client in the sidecar
Single biggest versatility unlock. Add an MCP client so Watchtower can talk to:

- **Linear / Jira** — fetch ticket context, update statuses
- **Sentry** — pull stack traces for bug-fix requests
- **Figma** — fetch designs for implementation requests
- **Notion** — read/write project docs
- **Internal MCP servers** — customers plug in their own

MCP servers declared in app settings; sidecar spawns them on startup, registers tools, and makes them available to any agent. `slack/` and `github/` can optionally become MCP servers themselves.

#### 5.3.4 Hooks system
Settings-configured shell commands run by the harness at lifecycle points:

- `PreJobStart` — check Linear for blockers
- `PostCoderOutput` — run Prettier or custom linters
- `PrePrOpen` — gate PR creation on passing tests
- `OnFailure` — custom notifiers (PagerDuty, email)

Declared in `~/Library/Application Support/com.dipesh.watchtower/hooks.json`. Makes Watchtower extensible without code changes.

#### 5.3.5 Streaming event bus (Tauri + SSE)
Replace polling with pushed events:

- Sidecar emits `job.stage.started`, `job.stage.completed`, `job.log.line` via a local HTTP/SSE endpoint or Tauri's event emitter.
- Frontend subscribes; React state updates in real time.
- Pipeline diagram animates per stage.
- Cancel becomes instant (push, not poll).

Removes the 2s log poll and 5s dashboard poll.

#### 5.3.6 Interactive approval mode
The approval gate exists but is binary (`agents/pipeline.ts`). Improve:

- Planner emits a plan, posted to Slack with ✅ / ✏️ / ❌ interactive blocks.
- ✏️ opens a modal where the owner edits the plan.
- The edited plan feeds back into the coder stage.

#### 5.3.7 Policy pack DSL
Today policy packs are strings concatenated into prompts. Convert to structured YAML/JSON rules enforceable both as prompt instructions AND as post-hoc assertions over the diff:

```yaml
forbidden_globs: ["secrets/**", ".env*"]
required_checks: ["lint", "test"]
max_files_changed: 30
```

Policy violations become structured findings — not things the LLM might forget.

---

## 6. New Feature Ideas

1. **Inline PR review comments with fix suggestions** — reviewer findings posted as GitHub inline comments with ` ```suggestion ` blocks for one-click apply.
2. **"Explain this build failure" on PRs** — detect failing GitHub Actions runs on bot-authored PRs; auto-diagnose, propose a fix, commit it.
3. **Repo onboarding wizard** — on new repo allowlist, scan README / CLAUDE.md / AGENTS.md, detect test/build/lint commands and conventions, write a per-repo standing context used by the pipeline.
4. **Slack DM inbox as a 1:1 agent** — persistent thread with scoped memory. Useful for planning, Q&A, quick edits.
5. **Voice-note support** — Slack audio messages → Whisper (local or API) → same pipeline.
6. **Cost / latency dashboard** — per repo, per user, per agent. Charts in the Intelligence tab.
7. **"Try locally" handoff** — export a branch + `gh pr checkout` command + diff URL instead of creating a PR. For changes too subtle to merge blindly.
8. **Session replay** — full transcript of prompts, responses, tool calls per job. Scrollable timeline in the UI. Invaluable for debugging and prompt tuning.
9. **Cross-repo tasks** — a single mention spawns coordinated pipelines across N repos with a coordinator agent planning the split.
10. **Slash-command library expansion** — `wt diff <jobId>`, `wt rerun <jobId>`, `wt cancel <jobId>`, `wt ask <repo> <question>`, `wt plan <task>` (planner only).
11. **Rich findings export** — one-click export to Linear ticket, GitHub issue, Notion page, or JSON file from the run-detail view.

---

## 7. Priority Matrix

**High impact × Low effort** (start here):

- Prompt caching (5.1.1)
- Parallelize reviewer / security / performance (5.1.2)
- Fast-path intent classifier (5.1.3)
- Zod-validate inbound events (5.2.6)
- Context compaction `summaryForNext` (5.2.1)
- Schema repair loop (5.2.2)
- Failure-Doctor → retry-policy wiring (5.2.7)
- Streaming Tauri events replace polling (5.3.5)

**High impact × Medium effort**:

- Tool-use loop for agents (5.3.1)
- MCP client (5.3.3)
- Verifier runs real commands (5.2.3)
- Embedding-based learning (5.2.5)
- Hooks system (5.3.4)
- Inline PR comments with suggestions (feature #1)
- Repo onboarding wizard (feature #3)

**High impact × High effort**:

- Subagent primitive (5.3.2)
- Cross-repo coordinator (feature #9)
- Interactive approval modals (5.3.6)
- Policy pack DSL (5.3.7)

**Low-hanging but smaller**:

- Pre-warmed worktree (5.1.5)
- Async batched logging (5.1.6)
- Slash-command library expansion (feature #10)
- Cost / latency dashboard (feature #6)

---

## 8. Proposed First Sprint

Six items, scoped to ~2–3 weeks, together unlock the rest:

1. **Zod-validate inbound envelopes** (`sidecar/src/slack/socketClient.ts`) — ~1 day. Accuracy foundation.
2. **Add `summaryForNext` to every agent schema** + strip full JSON from downstream prompts — ~2 days. Cuts tokens 30–50%.
3. **Prompt caching in `backends/claudeCodeBackend.ts`** — ~2 days. Cuts tokens and TTFT.
4. **Parallel reviewer / security / performance** in `agents/pipeline.ts` — ~2–3 days. Halves pipeline wall time.
5. **Tauri streaming events** (sidecar emits `job-step`, frontend subscribes) — ~3–4 days. Killer UX improvement.
6. **Fast-path intent classifier** (`router/classifyIntent.ts`) — ~1 day. Removes 1–2s from every mention.

Recommend shipping #2 and #3 first — they're the foundation the others build on.

---

## 9. Implementation Notes

### 9.1 Migration & rollout
- Each upgrade lands behind a feature flag in app settings (pattern already established by `multiAgentEnabled`).
- Ship dark-launch → owner canary → default-on progression. Keep the old path for one release.
- Add a "what's new" panel in the UI surfacing flag state per release.

### 9.2 Instrumentation first
Before shipping any optimization, add the metric that proves it worked:
- Per-stage latency percentiles (P50/P95/P99) — for pipeline parallelization claims.
- Cache hit rate — for prompt caching.
- Retry attempts per error category — for Failure-Doctor wiring.
- Intent classifier LLM call rate — for fast-path classification.

### 9.3 Testing
- Pipeline upgrades need replay tests — capture real job transcripts and re-run them against candidate pipelines. Add to `sidecar/tests/`.
- Zod schema changes need a migration helper that validates existing SQLite rows on startup and quarantines bad rows.

### 9.4 Non-goals for this plan
- Rewriting the sidecar in Rust / moving off Node. Not in scope.
- Replacing `gh` CLI with octokit or an MCP server for GitHub — low priority until MCP client exists.
- Multi-tenant / hosted deployment — Watchtower is a local desktop app; keep it that way.

---

## 10. Open Questions

- Do we want Watchtower to remain macOS-only, or does MCP integration nudge us toward a cross-platform sidecar?
- Which MCP servers do we ship by default? (Proposed: GitHub, Linear, Sentry, Notion, Figma.)
- What's the threshold for "this PR is too big for the bot to merge"? (Relevant for the policy pack DSL.)
- Who owns the evaluation suite for pipeline replay tests?

---

## Appendix: References to the codebase

- Pipeline orchestrator: `sidecar/src/agents/pipeline.ts`
- Agent prompts: `sidecar/src/agents/prompts.ts`
- Agent types: `sidecar/src/agents/types.ts`
- Model profiles: `sidecar/src/codex/modelProfiles.ts`
- Backend contract: `sidecar/src/backends/types.ts`
- Claude Code backend: `sidecar/src/backends/claudeCodeBackend.ts`
- Codex runner: `sidecar/src/backends/runCodex.ts`
- Router / intent: `sidecar/src/router/` (intentParser, taskRouter, classifyIntent)
- Workflows: `sidecar/src/workflows/`
- Slack I/O: `sidecar/src/slack/` (socketClient, mentionCatchup, threadContext)
- Access control: `sidecar/src/access/control.ts`
- Job store: `sidecar/src/state/jobStore.ts`
- Active jobs: `sidecar/src/state/activeJobs.ts`
- Workspaces: `sidecar/src/workspaces/workspaceManager.ts`
- Failure doctor: `sidecar/src/learning/failureDoctor.ts`
- Self-learning: `sidecar/src/learning/selfLearning.ts`
- Frontend entry: `src/App.tsx`
- Tauri shell: `src-tauri/src/lib.rs`
