# Why Watchtower And miniOG Exist

This memo is meant to answer a simple question for future us:

Why did we build `miniOG` and `Watchtower`, and what product idea were we actually chasing?

It is not a setup guide. It is a memory document for the team so we do not reduce this project to "a Slack bot" or "a Tauri app" and forget the actual thesis.

## Short Version

`miniOG` is the teammate-facing surface.

It is the AI persona that shows up in Slack, reads thread context, drafts replies, reviews PRs, follows up with people, reacts in-thread, and handles small execution tasks in a way that feels like a direct engineering teammate.

`Watchtower` is the runtime and control plane behind it.

It is the macOS desktop app plus Node sidecar that connects Slack to the local machine, routes requests into the right workflow, runs Codex against real repositories, stores logs/settings/history in SQLite, and gives the operator visibility into what the AI is doing.

The big idea is:

Instead of asking engineers to leave their real workflow and open "an AI tool", bring the AI into the place where engineering coordination already happens, then back it with a local execution system that is observable and controllable.

## The Original Trigger

The clearest origin signal in the project history came on March 3, 2026.

The internal announcement for Watchtower said the idea came up after a review request landed in Slack while the owner was AFK. That is the root problem:

- important engineering work was already being coordinated in Slack
- requests were time-sensitive and thread-based
- the right repos existed on the local machine
- but the response path still depended too much on one human being being online at the right moment

So the first real question was not "how do we build an AI app?"

It was:

How do we make Slack mentions executable, without losing context, safety, or operator visibility?

## The Problem We Were Actually Solving

There were a few overlapping pain points:

- Slack had become the coordination layer for engineering work: PR review asks, bug reports, follow-ups, status checks, owner pings.
- The context for the work lived across Slack threads, GitHub PRs, and local repos.
- AI tools were useful, but they were still too detached from the real place where the work started.
- Asking an engineer to manually translate a Slack thread into an AI prompt added friction and delay.
- Fully remote automation would have been harder to trust because the real repos, local auth, and existing tooling already lived on the developer machine.

That led to a local-first, Slack-native product direction.

## Why There Are Two Names

The split between `miniOG` and `Watchtower` is useful, because they solve different product problems.

### miniOG

`miniOG` is the AI coworker.

It is the part people talk to. In the codebase, it shows up as:

- Slack mention handling with direct, teammate-like tone
- the `/miniog` command
- the desktop Launchpad target for free-form task execution
- reply, follow-up, review, drafting, and lightweight action-taking behavior

The role of miniOG is not "be a general chatbot."

Its role is:

- read the latest ask in a Slack-native way
- use thread context for disambiguation
- act like a concise engineering teammate
- do something useful immediately

By March 12, 2026, the launchpad request history showed miniOG being used for:

- replying in an existing Slack thread with thread context
- tagging the right person in follow-up
- kicking off a PR review after posting a reply
- reacting to a message with an emoji
- deleting and reposting a message correctly
- taking a raw bug description and attempting a real engineering workflow

That is an important clue: miniOG was becoming an ambient Slack operator, not just a one-shot answer bot.

### Watchtower

`Watchtower` is the execution system.

It exists because a teammate-facing AI becomes unreliable very quickly if it has no operating model, no job history, and no trusted bridge into the local machine.

Watchtower provides:

- Slack Socket Mode intake
- workflow routing
- owner override / autopilot
- local Codex execution against real repos
- queueing and concurrency control
- SQLite-backed settings, logs, jobs, and learning state
- desktop dashboard, tray presence, notifications, and operational visibility

If miniOG is the face, Watchtower is the nervous system.

## The Core Product Bet

The project is built on one strong belief:

The best internal AI tools do not start as standalone apps. They start by attaching themselves to an existing high-frequency workflow surface, then earning trust through constrained execution and visibility.

In this case, that workflow surface was Slack.

That led to several concrete product bets.

## Product Bets And Principles

### 1. Slack should be the control plane

The team was already coordinating work in Slack. That meant the AI should not require people to copy context into another tool just to get help.

The mention, DM, slash-command, and thread model became the interface.

### 2. Local-first execution is a feature, not a compromise

The real repos, auth state, GitHub tooling, and developer context already lived on the machine.

So instead of building a remote orchestration system first, the project chose:

- local repo paths
- local Codex execution
- local SQLite state
- local observability through the desktop app

This made the system more practical faster.

### 3. The AI has to feel like a teammate, not a dashboard

The prompt and workflow changes across March 5 to March 13 show a strong pattern: reduce bot-like behavior, remove NPC energy, enforce serious tone in work threads, and keep replies concise.

That matters because trust is not only about correctness. It is also about whether the AI speaks in a way that fits real team communication.

### 4. Execution needs guardrails, but operators need an override

Watchtower added allowlists, intent routing, bug-fix channel restrictions, deterministic output parsing, and owner-specific bypasses.

That is the right shape for internal AI systems:

- default behavior should be bounded
- trusted operators should have a faster path when needed

### 5. Observability is not optional

The dashboard, job history, live logs, failure traces, metrics, and notification system are not decoration.

They are what turns "an AI that did something" into "a system we can actually operate."

### 6. Unknown requests should still produce useful behavior

A lot of AI systems fail awkwardly when a request does not map cleanly to a workflow.

Watchtower explicitly handles this case:

- generate a short human reply
- react in thread
- notify the desktop operator

That is a pragmatic product choice. Even the fallback path should feel intentional.

### 7. Learning should come from real usage, not just prompt theory

Reaction feedback, intent corrections, personality profiles, trust policies, and mission threads show another clear bet:

the system should adapt from real operator feedback inside the workflow itself.

## How The System Connects To The Local Machine

At a high level, the loop is:

1. Slack mention, DM, slash command, or launchpad request comes in.
2. Watchtower normalizes the event and routes it to a workflow.
3. The sidecar runs Codex locally against an allowed workspace.
4. Results are posted back into Slack.
5. Jobs, logs, and settings are stored in SQLite.
6. The desktop app shows the operator what happened.

This architecture matters for the thesis.

The point was not just to answer in Slack. The point was to make Slack requests executable against the real local development environment.

That is why Watchtower is a desktop app with a sidecar instead of only a hosted bot.

## What Changed As The Idea Matured

The git history tells a useful story.

### March 3, 2026: the foundation

The project started by putting the full execution loop in place:

- Tauri shell
- tray + autostart behavior
- Slack Socket Mode sidecar
- routing for PR review and bug-fix workflows
- settings UI
- observability
- owner autopilot

This suggests the vision was never "just ship a chat window."

It was "ship an operator-grade local runtime for AI-assisted engineering work."

### March 4 to March 6: adaptation and ingress

Then the system learned to:

- adapt from Slack reactions
- improve prompt behavior
- accept direct messages
- support slash-command and shortcut ingress

That shows the product moving from infrastructure to usability.

### March 7 to March 8: Launchpad and miniOG

The desktop app then gained a launchpad, was moved into its own default workspace, and by March 8 could run miniOG tasks directly.

This is the point where the product clearly split into:

- `miniOG` as the execution persona
- `Watchtower` as the runtime/operator system

### March 10 to March 13: seriousness and fit

Routing quality improved, contextual tone improved, serious-mode handling was enforced, and humor-based Slack modes were removed.

That indicates a shift from "fun AI coworker" toward "reliable AI teammate that fits engineering culture."

### March 13, 2026: the next planned step

By March 13, 2026, the next product direction was becoming clear:

Watchtower should evolve from a single-agent executor into a multi-agent engineering pipeline.

The gist of that plan was:

- strengthen the engineering base first with linting, formatting, pre-commit hooks, CI, and better test coverage
- introduce specialized agent roles instead of one monolithic Codex prompt
- split work across planner, coder, reviewer, security, performance, and verifier stages depending on workflow type
- allow reviewer-to-coder feedback loops so the system can refine output before posting it back to Slack or GitHub
- abort early on critical findings instead of letting unsafe or low-quality output pass through
- roll the change out behind a feature flag so current workflows remain backward compatible
- persist pipeline runs in the database and expose them in the UI so operators can see step-by-step progress, findings, cost, and failure patterns

This matters because it adds a second-layer thesis to the product:

Watchtower should not only execute work from Slack. It should also apply specialized judgment before that work leaves the system.

## The Real Vision

The long-term vision is not only to automate PR review or fix isolated bugs.

The larger vision is:

Create an AI teammate that can sit inside the team's real communication layer, understand engineering context, execute work against real codebases, and remain observable enough that humans still feel in control.

In that framing:

- miniOG is the teammate
- Watchtower is the operating system for that teammate

## What This Project Is Not

It helps to say this clearly.

This project is not:

- a generic AI chatbot
- a pure Slack bot with no execution depth
- a hidden autonomous agent with no audit trail
- a replacement for engineers
- a remote orchestration platform pretending local context does not matter

It is closer to:

- a Slack-native engineering copilot
- a local execution bridge
- an operator console for AI-assisted work

## What The Team Should Learn From This

If the team wants to generate more AI-native internal tools, the pattern here is reusable.

### Start from a workflow that already exists

Do not begin with "where can we put AI?"

Begin with:

- where do requests already happen?
- where does context already accumulate?
- where does delay or handoff pain already exist?

### Separate the persona from the runtime

Most internal AI ideas get muddy because the interface, execution engine, safety layer, and observability layer are mixed together.

This project worked better once the split became clear:

- miniOG = user-facing teammate
- Watchtower = execution and operator infrastructure

### Keep the first version close to real work

The best early tasks were not abstract.

They were concrete:

- review this PR
- reply in this thread
- tag this person
- diagnose this failure
- fix this bug

That made the system legible and testable.

### Put trust ahead of scale

For internal AI, "can people see what happened?" matters earlier than "can this scale infinitely?"

That is why logs, queueing, settings, traces, and clear workflow boundaries were the right early investment.

### Design for handoff, not magic

The strongest internal AI products do not try to look magical.

They reduce friction around real team coordination.

That is the bigger idea behind this project.

## A One-Paragraph Version For Sharing

Watchtower was created because important engineering work was already being initiated in Slack, but acting on that work still depended too much on the right human being noticing the thread in time. The idea was to make Slack requests executable on a developer's local machine. miniOG became the teammate-facing AI surface inside Slack, while Watchtower became the local desktop runtime that listens to Slack, routes work, runs Codex against real repositories, and keeps everything observable through logs, history, and a dashboard. The project is fundamentally about building a trustworthy AI teammate inside an existing workflow, not about building a generic chatbot.

## Source Signals Used For This Memo

This memo was reconstructed from:

- the current Watchtower README and architecture doc
- git history from March 3 to March 13, 2026
- Watchtower job and launchpad records stored in `watchtower.db`
- owner/Slack messages captured by the system during development

If the product drifts, update this document before the memory disappears again.
