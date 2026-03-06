# Watchtower

> Watchtower turns Slack mentions into local engineering workflows running on your Mac.
> It can review PRs, attempt bug fixes, accept owner override tasks, answer `wt` operator commands, recover missed mentions after sleep, and show every step in a desktop dashboard.

## What This App Does In A Nutshell

Watchtower is a macOS Tauri app with a Node sidecar that lives in Slack through Socket Mode.
You mention the bot, DM it, or issue a `wt` command; Watchtower classifies the request, runs the right Codex workflow against local repositories, replies back in the same Slack thread, and stores the full execution trail in SQLite.

Why this is worth reading further:

- It is Slack-native: mentions and DMs are the control plane.
- It is local-first: workflows run on your machine against real local repos.
- It is observable: dashboard, live logs, failures, metrics, and learning signals are all visible.
- It is not a one-trick bot anymore: PR review, bug-fix, owner-autopilot, dev-assist, and fallback handling all live in one desktop app.

## Workflow Surface

### PR Review

- Detects review requests from Slack mentions.
- Extracts PR context from the thread.
- Maps supported repositories to local paths.
- Runs Codex with a strict JSON schema and posts the review result back to Slack.

### Bug Fix

- Runs only in configured bug/update channels.
- Classifies the thread into `newton-web` or `newton-api`.
- Uses Codex to implement the fix, run tests, and open a PR when possible.
- Skips safely when repo confidence is too low.

### Owner Autopilot

- If a configured owner directly tags the bot, Watchtower can bypass normal workflow guardrails.
- It can execute broader local tasks across the configured workspace.
- Lightweight owner pings get a direct presence reply instead of a full run.

### Dev Assist

- `wt` commands turn Slack into an operator console for Watchtower.
- Supports status, runs, failures, traces, diagnosis, mission tracking, trust levels, replay/fork, skills, digest/feed toggles, incident mode, and more.

### Unknown Task Handling

- Unsupported or vague requests do not silently disappear.
- Watchtower generates a short personality-aware Slack reply, reacts to the thread, and raises a desktop notification.
- Channel personality can shift over time using explicit commands or reaction feedback.

## How It Works

1. The Tauri desktop app boots on macOS, opens the tray app, loads settings from SQLite, and supervises the Node sidecar.
2. The sidecar connects to Slack through Socket Mode, listens to mentions and DMs, and also runs missed-mention catch-up scans after sleep/restarts.
3. Each event is deduped, queued, normalized, and routed into the matching workflow.
4. Workflows call Codex locally, post status back to Slack, and persist jobs, logs, feedback, and learning state in SQLite.
5. The React dashboard reads the same database and shows active jobs, failures, metrics, recommendations, learning insights, channel heat, and live sidecar logs.

## Desktop App Highlights

- Tray app with launch-on-login.
- Settings-driven runtime configuration stored in SQLite, not `.env`.
- Per-job trace logs plus live sidecar log stream.
- Dashboard metrics for throughput, failures, streaks, catch-up recovery, and chaos index.
- Learning/ops state for personality profiles, intent corrections, missions, replay requests, policy packs, incident mode, and digest/feed settings.

## Quick Start

1. Install root dependencies: `npm install`
2. Install sidecar dependencies: `npm --prefix sidecar install`
3. Start the app: `npm run tauri:dev`
4. Open the Settings drawer in the app and fill in:
   - Slack bot token
   - Slack app token
   - owner Slack user IDs
   - bot user ID
   - bug/update channel IDs (comma separated)
   - absolute local paths for `newton-web` and `newton-api`
   - concurrency, timeout, and repo-classifier settings
5. Save settings. The sidecar starts automatically once configuration is complete.

## Useful Commands

- Start desktop app: `npm run tauri:dev`
- Build macOS app bundle: `npm run tauri:build:mac`
- Run sidecar directly: `npm run sidecar:dev`
- Run sidecar tests: `npm run sidecar:test`

## Example Dev-Assist Commands

- `wt help`
- `wt status`
- `wt runs 10`
- `wt failures 10`
- `wt trace <jobId> 50`
- `wt diagnose <jobId>`
- `wt personality set professional channel`
- `wt mission start <goal>`
- `wt mission run --swarm`
- `wt trust channel execute`
- `wt replay <jobId>`
- `wt fork <jobId>`
- `wt feed on`
- `wt digest 10:30`
- `wt incident on`

## Current Constraints

- macOS only.
- Repository routing is currently opinionated around `newton-web` and `newton-api`.
- Automated PR review currently allowlists the `Newton-School` GitHub org.
- Unknown-task reaction posting requires Slack scope `reactions:write`.
- GitHub auth works best with `gh auth login`; if unavailable, Codex GitHub MCP auth can be used.
