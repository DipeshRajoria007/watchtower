# AGENTS.md

## Purpose
Watchtower is a macOS-only Tauri desktop app with a Node sidecar that listens to Slack mentions and runs autonomous developer workflows.

## Platform
- Supported OS: macOS only.
- Bundles: `app`, `dmg`.

## Repo Layout
- `src/` React desktop UI.
- `src-tauri/` Tauri Rust shell, sidecar supervision, tray/autostart, DB-backed UI commands.
- `sidecar/src/` Slack socket listener, router, workflows, Codex execution, learning engine.
- `sidecar/tests/` unit/integration tests for parser/workflows/store.

## Runbook
- Install deps:
  - `npm install`
  - `npm --prefix sidecar install`
- Run app in dev:
  - `npm run tauri:dev`
- Build sidecar only:
  - `npm --prefix sidecar run build`
- Test sidecar:
  - `npm --prefix sidecar run test`
- Build desktop app:
  - `npm run tauri:build:mac`

## Runtime Config
- Do not store secrets in repo files.
- Runtime settings are configured from the app Settings UI and persisted in app SQLite.
- Main DB path:
  - `~/Library/Application Support/com.dipesh.watchtower/watchtower.db`

## Slack Workflow Intents
- `PR_REVIEW`
- `BUG_FIX`
- `OWNER_AUTOPILOT`
- `DEV_ASSIST`
- `UNKNOWN`

## Dev Assistant Commands (Slack)
- `wt help`
- `wt status`
- `wt runs [n]`
- `wt failures [n]`
- `wt trace <jobId> [lines]`
- `wt diagnose <jobId>`
- `wt learn`
- `wt heat [n]`
- `wt personality set <mode> [channel|me]`
- `wt personality show [channel|me]`

## Quality Gate
Before merge:
1. `npm run lint` — zero ESLint violations
2. `npm run format:check` — Prettier formatting verified
3. `npm --prefix sidecar run build` — sidecar compiles
4. `npm --prefix sidecar run test` — all sidecar tests pass
5. `npm run build` — frontend TypeScript + Vite build
6. `cargo check --manifest-path src-tauri/Cargo.toml` — Rust compiles

## CI Pipeline
GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:
- **lint** — ESLint + Prettier check
- **typecheck** — sidecar build + frontend tsc
- **sidecar-test** — vitest
- **rust-check** — cargo check (macOS runner)

## Multi-Agent Pipeline
When `multiAgentEnabled` is true, workflows use a multi-agent pipeline instead of a single Codex call:
- Agents: planner, coder, reviewer, security, performance, verifier
- Pipeline orchestrator: `sidecar/src/agents/pipeline.ts`
- Agent prompts: `sidecar/src/agents/prompts.ts`
- Type definitions: `sidecar/src/agents/types.ts`
- Feature flag: `multiAgentEnabled` in app settings (default: false)

## Git Workflow
- Do not commit changes directly to `main`.
- For every change, create a branch with the `codex/` prefix, push it, open a pull request, and merge that pull request.
- Treat the pull request as the default delivery path unless the user explicitly asks for a different git workflow.

## Guardrails
- Keep orchestrator non-destructive.
- Restrict repo operations to configured allowlisted repo paths.
- Prefer deterministic Codex output parsing (`--output-last-message` + schema).
- Keep owner-facing Slack replies concise and human (no verbose execution audit text).
