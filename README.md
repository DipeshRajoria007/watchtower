# Watchtower

Watchtower is a macOS-only Tauri desktop automation app that listens to Slack mentions via Socket Mode and routes tasks to Codex workflows.

## Features

- macOS-only desktop runtime with tray + launch-on-login
- Node sidecar orchestrator supervised by Tauri
- Slack mention routing for PR review and bug-fix workflows
- Guardrails for repo selection, timeout handling, dedupe, and retries
- SQLite-backed settings and run history
- Per-job execution trace with step-by-step logs + live sidecar stream in UI

## Quick Start

1. Install root deps: `npm install`
2. Install sidecar deps: `npm --prefix sidecar install`
3. Run app: `npm run tauri:dev`
4. Open **Settings** tab in app and fill required values:
   - Slack bot/app tokens
   - owner IDs and bot user ID
   - bug-fix channel IDs (comma separated, e.g. `C01...,C02...`)
   - `newton-web` and `newton-api` absolute local paths
   - concurrency/timeouts/classifier threshold
5. Save settings. Sidecar starts automatically once settings are complete.

## Build (macOS)

- `npm run tauri:build:mac`

## Notes

- Supported platform: macOS only.
- Runtime workflow config is no longer loaded from `.env`; it is managed from the app Settings page.
- Mention events are listened across all channels where the bot is present; bug-fix auto-run is restricted to configured bug-fix channel IDs.
- Owner-authored bot mentions (`ownerSlackUserIds`) run in owner-autopilot mode, bypassing workflow guardrails.
- Unknown/random non-owner requests get a tagged Codex-generated dark-humor thread reply (low reasoning effort) plus reaction and desktop notification.
- For Slack reactions on unknown-task replies, ensure bot scope `reactions:write` is granted.
- `gh auth login` is recommended for GitHub auth. If unavailable, Codex GitHub MCP auth can be used.
