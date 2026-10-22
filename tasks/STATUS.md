# Project status — single source of truth

> Every agent and contributor: read this first. Last update: **2026-10-21** — TUI and agent transcripts on `feat/tui-agent-transcripts`.

## State

**v0.1 is feature complete.** Every work item in the spec is built and merged. CI runs build, typecheck, lint, unit
tests (protocol, leader, node, desktop) and the full end-to-end suite (32 scenarios) on every PR and on `main`.

Acceptance (spec §21.3) was run with **real Claude Code on both sides** (headless Leader + two Nodes on one machine,
demo repo): the author agent implemented the task (~13k tokens), tests passed, the reviewer agent approved, and the
Leader squash-merged with `Quorum-Task/Author/Reviewer/Requested-By` trailers and deleted the branch — 36 seconds end
to end. The packaged Linux app (AppImage/deb) was smoke-tested: in-process Leader, Node daemon and UI all running. The Release
workflow built all installers on GitHub runners: `Quorum-0.1.0-linux-x86_64.AppImage`, `…-linux-amd64.deb`,
`…-mac-arm64.dmg`, `…-win-x64.exe`.

## Since v0.1.0 (in v0.1.1)

* Every desktop screen was rendered against a live two-member team (real Leader/Nodes, mock agents, two review
  rounds → merge); fixed blank timeline rows, an overflowing task board and the back link.
* Reviewer failover now prefers a reviewer who hasn't already dropped the task (#32), with fallback; conversation
  order is stable (#36).
* Codex-1 was auto-resumed after its limit and opened #41; superseded by #44 and closed (see the PR for why).

## In v0.1.3

* **Works with any VPN, no external server required.** Host a team lists the computer's addresses labelled by
  network (local, Tailscale incl. its stable MagicDNS name, ZeroTier, WireGuard, other VPN; container bridges hidden).
* **Only accept connections through this address**: the Leader binds to the chosen VPN/LAN address only; the host's
  own agent connects through it. Friendly error if the VPN isn't connected.
* Teammates who can't connect get a hint for the team's network type. Join codes remain the only way in (no discovery).

## In v0.1.4

* Plain connections work over Wi-Fi/LAN and private VPN addresses, including Tailscale's `100.64.0.0/10` and
  `*.ts.net` names. Public plaintext addresses are allowed with an in-app warning; HTTPS tunnel URLs remain encrypted.

## In v0.1.2

* **Fix:** teammates joining over a LAN (plain `ws://` to a non-localhost address) were refused by the Node's ws://
  guard; the desktop app now allows the address the host chose. Covered by a real-daemon LAN join test.
* **No VPN needed:** the host's address may be a tunnel URL (`cloudflared tunnel --url http://localhost:7420`, ngrok);
  join codes then use encrypted `wss://`. Verified end to end through a live Cloudflare quick tunnel. The Team page
  shows whether connections are encrypted. See docs/INSTALL.md → Connecting teammates.

## Unreleased (PR from feat/agent-cli)

| Change | Notes |
|---|---|
| Session profiles | Fixed: the Leader reused any idle session for any role, so after an agent reviewed, its own next task or any directive went to the reviewer session and failed. Sessions now keep their profile (schema v2). e2e #18b, #18c. |
| macOS worktree paths | Fixed: session worktree reuse failed when the data path contained a symlink (macOS `/var` → `/private/var`). |
| `quorum` CLI + API tokens | `packages/cli`; requester-scope tokens (create in Settings → Agent CLI access, or `quorum-leader add-token`). e2e #22–#24. |

## Unreleased (feat/tui-agent-transcripts)

| Change | Notes |
|---|---|
| TUI | `quorum-tui` (`packages/tui`) is a full-screen Ink client. It shows agents, tasks and transcripts. It uses the `quorum` CLI config. Approve, send back, pause and cancel need an owner token. |
| Transcripts | Node `transcript` frames (`transcript-v1`). REST `GET /api/tasks/:id/transcript`. UI event `transcript.appended`. The Node replaces the owner home path with `~` before the events go to the Leader. |
| New adapters | Codex, pi and omp CLI adapters. The Node starts a new command for each profile. The Node can resume a session. Trust: Codex `sandboxed`. pi and omp `low`. |
| Owner tokens | Scope `owner` on API tokens. `quorum-leader add-token --scope owner`. Owner tokens can act on the tasks of their owner. An admin owner token can act on all tasks. |
| Codex isolation | The driver sets `CODEX_HOME=<dataDir>/codex-home` with a link to `auth.json`. The agent does not read owner `config.toml`, `AGENTS.md` or skills. Turns also have `--ignore-user-config --ignore-rules`. |
| Known gaps | The operator did not complete a live check of Codex isolation (the account usage limit stopped the check). Kilo now has an isolated JSON CLI adapter (see below). omp cannot stop configured MCP servers. |

## Who did what

| Agent | Work |
|---|---|
| Claude | Scaffold & CI (C0), protocol `contract-v1` (C1, C1.1), e2e harness + 27 scenarios (C2), Claude Code adapter (C3), Leader L3 fixes–L9 (scheduler, budgets, liveness, merge worker, REST/UI API, CLI, wiring), integration fixes (I1), desktop app (D1–D5), packaging & release (R1), docs (R2), acceptance (A1) |
| Codex-1 | Leader L1 (DB), L2 (state machine), L3 (locks), L4 (node hub), most of L5 (handlers; adopted by Claude at handoff) — stopped at its usage limit |
| Codex-2 | Node N1–N9 (worktrees, project tests runner, journal, prompts/parser, adapter interface + mock, Leader client, command runner, daemon/CLI, opencode adapter) |

## Remaining / next ideas (not required for v0.1)

| Item | Notes |
|---|---|
| Code signing | Installers are unsigned (macOS: right-click → Open; Windows: More info → Run anyway). Add certificates to the Release workflow when available. |
| macOS Intel build | The Release workflow builds on `macos-latest` (Apple Silicon). Add an `macos-13` matrix entry for x64 if needed. |
| Ship the CLI | Bundle `quorum` with the installers or publish it to npm; today it runs from a source checkout. |
| Second-opinion reviews, GitHub PR integration, task decomposition | Out of scope for v0.1 (spec §23). |

## How to work on it

Branch per change, PR to `main`, CI must be green. Spec: [`docs/implementation-spec.md`](../docs/implementation-spec.md).
User guide: [`docs/INSTALL.md`](../docs/INSTALL.md). Detailed history of the build plan: [`tasks/claude.md`](claude.md).


## Unreleased (feat/kilo-adapter)

| Change | Notes |
| --- | --- |
| Kilo Code | CLI 7.8.15. JSON driver emits text, tools and usage. It resumes native sessions. Desktop Settings and `join --adapter kilo` support it. Trust: `low`. |
| Kilo isolation | Quorum owns HOME/XDG directories per profile. It imports provider logins only. Each turn disables personal/project config, external skills and plugins. Reviewer/directive permissions allow read/search tools only, including on resume. |
| Custom CLI | Config-only `custom` adapter. Each profile has argv and optional resume argv. Dotted JSON fields map text, tools, usage, session ID and completion. No shell. Trust: always `low`. |
| Evidence | Three real Kilo fixtures cover author edits, Node execution, resume recall and a reviewer write request. See `tasks/tui-spike.md`. |
| Verification | Full build/typecheck/lint/unit/e2e chain passed twice on final code. Each cycle: 868 unit tests; 35 e2e tests; 1 existing e2e TODO. Final live author, resumed author, and fresh/resumed reviewer/directive probes passed. |
| Known gaps | Kilo native permissions are not an OS sandbox. Author bash does not implement Quorum's command allowlist. Custom operators must supply isolation and read-only flags. Custom templates have no desktop editor. |
