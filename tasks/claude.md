# Claude — work plan (Leader, integration, desktop, release)

Read [`STATUS.md`](STATUS.md) first. This file is Claude's sequential plan; any agent picking it up continues from the first unchecked box. Spec: [`docs/implementation-spec.md`](../docs/implementation-spec.md).

## Ownership (current)

| Path | Owner |
|---|---|
| root config, `.github/**`, `packages/protocol/**`, `e2e/**`, `docs/**`, `tasks/**` | Claude |
| `packages/leader/**` | **Claude** (taken over from Codex-1) |
| `packages/node/**` except `src/adapters/claude-code.ts` | Codex-2 (until it stops after N9, then Claude) |
| `packages/node/src/adapters/claude-code.ts` | Claude |
| `packages/desktop/**` | **Claude** (moved from Codex-2) |

## Done

- [x] C0 scaffold (#5) · C1 protocol `contract-v1` (#6) · C1.1 `API_ROUTES` (#7) · C2 e2e harness (#11)
- [x] Reviews: L1 #3, L2 #4, L3 #8, L4 #10, N4 #15 · spec clarifications (#2, #9, §8.3)

## Sequence

### Leader (spec §7–§14, §17, §20)
- [x] **L3** merge PR #8 (rebased on main).
- [x] **L4** fix the poison-message loop (unknown `sid` → record + ack, not close), add a handler-failure poison counter, merge PR #10.
- [x] **L5** event handlers + command builders (adopt Codex-1 WIP: `core/commands.ts`, `handlers.ts`, `review.ts`, `usage.ts`), plus issue #12 rules (system issues auto-resolve; reviewers get all open reviewer/human issues), stale-event guard, `turn.failed` policy, overlap warning.
- [x] **L6** `budget.ts` (lent/own ledger, day boundary, EMA) + `scheduler.ts` (§9 author/reviewer/session selection, aging, `session.open` flow, backoff) + liveness (§10.3–§10.5, PAUSED grace, needs-attention).
- [x] **L7** `git/leader-git.ts` + `core/merge-worker.ts` (§14.3 serial squash merge, tests, trailers, push retry, conflicts → SYNCING) + system-issue auto-resolve on passing merge tests.
- [x] **L8** REST (`API_ROUTES`, bearer auth, requester/admin perms, error format, diff endpoint), `/ws/ui` push, directives (§13), CLI `quorum-leader start|add-agent|revoke-agent|list-agents`.
- [x] **L9** `startLeader` wiring, restart recovery (MERGING → MERGE_QUEUED named op), pino logging, clean `close()`.

### Node (only if Codex-2 stops before finishing)
- [x] Merge C3 PR #16.
- [x] Review/merge N1–N8. N9 (opencode) remains with Codex-2 — see STATUS.md.

### Integration
- [x] **I1** e2e scenarios #1–#21 green in CI (`pnpm e2e`); fix cross-package bugs.
- [x] **I2** two-terminal manual run with mock adapters (`quorum-leader start` + 2× `quorum-node start`).

### Desktop app (`packages/desktop`, spec §18 + Host mode)
- [x] **D1** Electron + Vite + React shell; main process embeds `startDaemon`; typed preload IPC; config in `userData`; token via `safeStorage`.
- [x] **D2** **Host mode**: main process can also run `startLeader` (team repo URL, port, admin list), create agent tokens from the UI (`addAgent`), show join codes (URL + token) to share with teammates.
- [x] **D3** API layer: REST client from `API_ROUTES` + `/ws/ui` subscription with reconnect.
- [x] **D4** Screens: first-run (Host / Join), Dashboard, Tasks board, New task, Task detail (timeline, issues, diff viewer, actions), Sessions, Directives, Settings; OS notifications.
- [x] **D5** Claude Code readiness check in Settings (SDK present, logged in) and adapter selection.

### Release
- [x] **R1** electron-builder config: Linux AppImage + deb, macOS dmg, Windows NSIS; `release.yml` workflow building on tag `v*` for all three OSes; artifacts attached to a GitHub Release.
- [x] **R2** `docs/INSTALL.md` (host & join walkthrough, firewall/port, Claude Code login) and README "Getting started".

### Acceptance
- [x] **A1** real Claude Code end-to-end on a demo repo: authored → tested → reviewed (approve) → squash-merged with trailers in 36 s. Results in STATUS.md.
