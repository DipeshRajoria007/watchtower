# Watchtower Architecture Flow

```mermaid
flowchart LR
  %% External systems
  U[Slack User] --> S[Slack Workspace]
  C[Codex CLI] <--> G[GitHub]

  %% Desktop host
  subgraph T[Tauri Desktop App (macOS)]
    SUP[Sidecar Supervisor\nstart/restart/backoff]
    UI[React Dashboard UI]
    IPC[tauri invoke/event bridge]
    NTF[macOS Notification Plugin]
  end

  %% Shared persistence
  subgraph DB[SQLite watchtower.db]
    AS[(app_settings)]
    J[(jobs)]
    JL[(job_logs)]
    E[(events)]
  end

  %% Node sidecar
  subgraph SC[Node Sidecar]
    SK[SocketSlackClient\n(Bolt Socket Mode)]
    Q[Queue + maxConcurrentJobs]
    NRM[normalizeTask\nmention + intent + pr context]
    DD{Duplicate event\nor dedupe key?}
    RT[routeTask]

    PR[PR Review Workflow]
    PRG{PR context/org/repo\nvalid?}
    PRX[runCodex\nfrontend-pr-review + comment-it]

    BF[Bug Fix Workflow]
    BFG{Bug-fix channel\nallowlisted?}
    CL[classifyRepo\n(thread + threshold)]
    BFC{Repo confident?}
    BFX[runCodex\nfix + tests + PR]

    UNK[Unknown Workflow\n(desktop notify only)]
  end

  %% Supervisor and settings gate
  SUP -->|reads| AS
  SUP -->|settings complete| SK
  SUP -->|streams stdout/stderr| IPC
  SUP -->|WATCHTOWER_NOTIFY payload| NTF

  %% UI and DB access
  UI <-->|get_dashboard_data/get_app_settings/save_app_settings/get_job_logs| IPC
  IPC --> DB
  IPC -->|sidecar-log events| UI

  %% Slack intake
  S -->|app_mention/message| SK
  SK --> Q --> NRM --> DD
  DD -->|yes| E
  DD -->|no| RT
  DD -->|record event| E

  %% PR review path
  RT --> PR --> PRG
  PRG -->|missing/blocked| NTF
  PRG -->|missing PR URL| S
  PRG -->|ok| PRX
  PRX --> C
  PRX -->|success/failure summary| S

  %% Bug fix path
  RT --> BF --> BFG
  BFG -->|no| JL
  BFG -->|yes| CL --> BFC
  BFC -->|uncertain| NTF
  BFC -->|confident| BFX
  BFX --> C
  BFX -->|success/failure summary| S

  %% Unknown path
  RT --> UNK --> NTF

  %% Persistence of run lifecycle
  RT --> J
  PR --> JL
  BF --> JL
  PRX --> J
  BFX --> J
```

## Notes
- Sidecar starts only when `app_settings` is complete.
- Tauri and sidecar both use the same SQLite DB (`jobs`, `job_logs`, `events`, `app_settings`).
- All Slack-triggered work is queued and constrained by `maxConcurrentJobs`.
- Both PR review and bug-fix workflows execute Codex with strict JSON output schemas.
- Desktop notifications are emitted by sidecar stdout (`WATCHTOWER_NOTIFY::...`) and shown by Tauri.
