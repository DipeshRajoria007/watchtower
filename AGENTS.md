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
1. `npm --prefix sidecar run build`
2. `npm --prefix sidecar run test`
3. `npm run build`
4. `cargo check --manifest-path src-tauri/Cargo.toml`

## Guardrails
- Keep orchestrator non-destructive.
- Restrict repo operations to configured allowlisted repo paths.
- Prefer deterministic Codex output parsing (`--output-last-message` + schema).
- Keep owner-facing Slack replies concise and human (no verbose execution audit text).
