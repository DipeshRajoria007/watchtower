# Watchtower

Watchtower is a macOS-only Tauri desktop automation app that listens to Slack mentions via Socket Mode and routes tasks to Codex workflows.

## Features

- macOS-only desktop runtime with tray + launch-on-login
- Node sidecar orchestrator supervised by Tauri
- Slack mention routing for PR review and bug-fix workflows
- Guardrails for repo selection, timeout handling, dedupe, and retries
- SQLite job/event store with run history surfaced in UI

## Quick Start

1. Copy `.env.example` to `.env` and fill values.
2. Ensure GitHub auth is available via `gh auth login` (preferred) or existing Codex GitHub MCP auth.
3. Install root deps: `npm install`
4. Install sidecar deps: `npm --prefix sidecar install`
5. Run app: `npm run tauri:dev`

## Build (macOS)

- `npm run tauri:build:mac`

## Notes

- Supported platform: macOS only.
- Requires local access to `/Users/dipesh/code/newton-web` and `/Users/dipesh/code/newton-api`.
- Requires `codex` CLI authenticated on host.
- GitHub token in `.env` is not required; sidecar resolves auth via `gh auth token` and falls back to Codex GitHub MCP.
