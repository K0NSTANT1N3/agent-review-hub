# Project status — single source of truth

> Every agent and contributor: read this first. Last update: **2026-10-18** — v0.2.0 released.

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

## In v0.2.0

* **See the team at a glance.** The Dashboard shows which agent works on which task, who waits for whom (author on
  reviewer, task on a free agent, a human or a rate-limit reset) and the task queue in the order the scheduler tries
  it, with what blocks each task (#55, #69, #82). Task cards and Task Detail explain why a task waits (#72, #76).
* **Task board:** search, filter, sort and a narrow layout (#83, #84).
* **Drive Quorum from your agent:** the scoped `quorum` CLI and requester API tokens (Settings → Agent CLI access).
  Sessions keep their role, so a reviewer session is never reused for authoring (#48).
* **Run it on a server:** `quorum-leader invite`, `quorum-node join`, npm-ready packages and a VPS guide (#56).
* **Scheduler:** reserves reviewer capacity before admitting new authors, so reviews are not starved under load
  (#68, #75); shared git ref updates are serialized (#79); a cancelled task's branch is deleted reliably (#80).
* **Security:** Bash file reads stay inside the task worktree (#77); the UI WebSocket token is no longer in the URL
  (#78); the desktop app refuses to send credentials to a remote Leader over plain `ws://` (#81).
* **Fixes:** send-back, sandbox hardening, recovery, auth loop, restart race, reset, merge retry, shutdown, opencode
  abort (#46, #49); the Diff tab no longer blanks the app when the first commit arrives (#89).
* **Tests and docs:** packaged-app smoke test in CI (#61), load test (#64, #71), architecture overview (#62), MIT
  license (#65), README rewrite and new demo video (#66, #67, #85–#88).

## In v0.1.3

> Superseded in v0.2.0: remote teammates now need an `https://` address; plain LAN/VPN join codes stop working (#81).

* **Works with any VPN, no external server required.** Host a team lists the computer's addresses labelled by
  network (local, Tailscale incl. its stable MagicDNS name, ZeroTier, WireGuard, other VPN; container bridges hidden).
* **Only accept connections through this address**: the Leader binds to the chosen VPN/LAN address only; the host's
  own agent connects through it. Friendly error if the VPN isn't connected.
* Teammates who can't connect get a hint for the team's network type. Join codes remain the only way in (no discovery).

## In v0.1.2

* **Fix:** teammates joining over a LAN (plain `ws://` to a non-localhost address) were refused by the Node's ws://
  guard; the desktop app now allows the address the host chose. Covered by a real-daemon LAN join test.
* **No VPN needed:** the host's address may be a tunnel URL (`cloudflared tunnel --url http://localhost:7420`, ngrok);
  join codes then use encrypted `wss://`. Verified end to end through a live Cloudflare quick tunnel. The Team page
  shows whether connections are encrypted. See docs/INSTALL.md → Connecting teammates.

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
