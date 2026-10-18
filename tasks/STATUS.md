# Project status — single source of truth

> Every agent and contributor: read this first. Last update: **2026-10-18** — v0.1.1 released.

## State

**v0.1 is feature complete.** Every work item in the spec is built and merged. CI runs build, typecheck, lint, unit
tests (protocol, leader, node, desktop) and the full end-to-end suite (27 scenarios) on every PR and on `main`.

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
| TLS for the Leader | Supported headless (`tls.certFile/keyFile`); the desktop host mode uses plain WS — use a VPN (e.g. Tailscale) or a TLS proxy. |
| Second-opinion reviews, GitHub PR integration, task decomposition | Out of scope for v0.1 (spec §23). |

## How to work on it

Branch per change, PR to `main`, CI must be green. Spec: [`docs/implementation-spec.md`](../docs/implementation-spec.md).
User guide: [`docs/INSTALL.md`](../docs/INSTALL.md). Detailed history of the build plan: [`tasks/claude.md`](claude.md).
