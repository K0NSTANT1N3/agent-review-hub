# Project status — single source of truth

> **Every agent: read this file first, before your own task file.**
> Updated by Claude whenever a work item changes state. Last update: **2026-10-18** (Codex-1 handoff).

## Who is working

| Agent | State | Scope now |
|---|---|---|
| **Claude** | active | **Owns everything not listed for Codex-2**: scaffold/protocol/e2e (as before), **the whole Leader** (`packages/leader`, taken over from Codex-1), **the desktop app** (`packages/desktop`, taken over from Codex-2), integration, packaging, release. Plan: [`tasks/claude.md`](claude.md). |
| **Codex-2** | active, will stop after N9 | Node daemon only: **N1–N9** in [`tasks/codex-2-node.md`](codex-2-node.md). Desktop (D1–D4) is **no longer** Codex-2's. If Codex-2 stops early, Claude continues from the first unchecked N item. |
| **Codex-1** | **stopped (usage limit)** | **Nothing.** The Leader now belongs to Claude. If you are Codex-1 and were auto-resumed: **do not continue L5+ and do not push to `codex-leader/*`.** Your uncommitted L5 work in the `quorum-leader-l1` worktree was preserved and is being folded into Claude's Leader PRs. You may review open Leader PRs (comments only) or stop. |

## Goal (definition of done)

A desktop app (Linux AppImage/deb, macOS dmg, Windows installer) that each teammate installs. One teammate clicks **Host a team** (the app runs the Leader in-process); everyone else clicks **Join a team** (Leader URL + token). Each app runs a Node that drives that person's Claude Code (or opencode). Tasks typed into the app are authored by the requester's agent, reviewed by a teammate's idle agent, revised until approved, and squash-merged into `main` — exactly as specified in [`docs/implementation-spec.md`](../docs/implementation-spec.md).

## Done (on `main`)

| Item | What | PR |
|---|---|---|
| C0 | Monorepo scaffold, CI, contract stubs | #5 |
| C1 | `@quorum/protocol` `contract-v1` | #6 |
| C1.1 | `API_ROUTES` typed REST table | #7 |
| C2 | E2E harness + scenarios #1–#21 (skipped until Leader+Node exist) | #11 |
| L1 | Leader DB layer (Codex-1) | #3 |
| L2 | Task state machine (Codex-1) | #4 |

## Open / in progress

| Item | Owner | State | Where |
|---|---|---|---|
| L3 locks + `sendToSession` | Claude (from Codex-1) | approved, to merge | PR #8 |
| L4 node hub | Claude (from Codex-1) | needs poison-message fix | PR #10 |
| L5 event handlers | Claude | in progress (Codex-1 WIP adopted) | — |
| C3 Claude Code adapter | Claude | CI green, waiting for Codex-2 ack on `packages/node/package.json` | PR #16 |
| N1 git worktrees | Codex-2 | pushed, **no PR yet** | branch `codex-node/n1-git-worktrees` |
| N2 project config + tests runner | Codex-2 | pushed, **no PR yet** | branch `codex-node/n2-project-tests` |
| N3 journal | Codex-2 | pushed, **no PR yet** | branch `codex-node/n3-journal` |
| N4 prompts + parser | Codex-2 | one fix requested (blocked revise coverage) | PR #15 |

## To do (in order)

Claude's sequence (details in [`tasks/claude.md`](claude.md)):

1. **L3 → L4 → L5 → L6 → L7 → L8 → L9** — finish the Leader.
2. Review/merge Codex-2's N1–N9 as they arrive; merge C3.
3. **Integration**: enable e2e scenarios (`E2E_READY` flips automatically) and fix until green.
4. **D1–D5 desktop app**, including **Host mode** (Leader embedded in the app).
5. **R1 packaging & release**: electron-builder installers via a GitHub release workflow; install guide.
6. **A1 acceptance**: real Claude Code on two machines/profiles; final README.

Codex-2's sequence: N1–N3 PRs → N4 fix → N5 → N6 → N7 → N8 → N9, then stop.

## Open issues to know about

- #12 (Leader rules: system issues auto-resolve; reviewers see all open reviewer/human issues) — now Claude's, handled in L5.
- #13 (mock adapter behaviour the e2e expects) — Codex-2, N5.
- #14 (Codex-2: open PRs for N1–N3).

## Rules (unchanged)

Branch per item, PR per item, CI green before merge, spec is authoritative, never edit another owner's paths (ownership table: [`tasks/claude.md`](claude.md) §Ownership).
