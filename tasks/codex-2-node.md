> ## Scope update (2026-10-18)
> Codex-1 has stopped; Claude took over the Leader **and the desktop app (D1–D4)**.
> **Codex-2: finish N1–N9 only, then stop.** Skip §6 (desktop) — it is now Claude's.
> First: open PRs for N1–N3 (#14), apply the fix requested on N4 (#15), then N5 (see #13) → N9.
> Leave a comment on #14 when you stop, naming the last N item merged. Read [`tasks/STATUS.md`](STATUS.md).

# Codex-2 — Node daemon, adapters, then Desktop app

You are **Codex-2**. You build the **Node daemon** (`packages/node`), the **mock** and **opencode** adapters, and then (phase 3) the **Electron desktop app** (`packages/desktop`).
Two other agents work on this repository **at the same time**:

- **Claude**: scaffold, shared protocol, end-to-end tests, Claude Code adapter, integration.
- **Codex-1**: the Leader server (`packages/leader`).

You do not talk to them directly. You coordinate only through **git, pull requests, and GitHub issues**, following the rules below.

---

## 1. Read first (in this order)

1. `docs/implementation-spec.md` — **the authoritative spec**. Sections you must know fully: §3, §6.2, §6.3, §11, §12, §14.1, §14.2, §15, §16, §18, §19, §20, §21.
2. This file.
3. `tasks/codex-1-leader.md` §2–§4 (the same shared rules, so you know where the other side's boundaries are).

Where `README.md`, `docs/architecture.md`, or `tasks/todo.md` disagree with `docs/implementation-spec.md`, **the spec wins**.

"Quorum" is the spec's codename. Package names are `@quorum/*`, and CLI binaries are `quorum-leader` / `quorum-node`.

---

## 2. Ownership map (shared — identical in both task files)

| Path | Owner | Others may… |
|---|---|---|
| root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.eslintrc*`, `vitest.workspace.ts`, `.github/workflows/*` | **Claude** | request changes via issue |
| `packages/protocol/**` | **Claude** | request changes via issue labeled `protocol-change` |
| `packages/leader/**` | **Codex-1** | read only |
| `packages/node/**` except `src/adapters/claude-code.ts` | **Codex-2** | read only |
| `packages/node/src/adapters/claude-code.ts` (+ its test) | **Claude** | read only |
| `packages/desktop/**` | **Codex-2** (phase 3) | read only |
| `e2e/**` | **Claude** | read only; owners may add a *new* scenario file in a PR that Claude reviews |
| `docs/**`, `tasks/**` | **Claude** | edit only your own task file's checkboxes |

**Never edit a file you do not own.** If you need a change there, open a GitHub issue (§4).

### What each agent delivers

**Claude**
- C0 *(first, blocking, small)*: monorepo scaffold, CI, and package skeletons that compile, with the exact exported stubs from §3.
- C1: `packages/protocol` — every zod schema/type from spec §6, §7 (enums), §11, §12, §17. Tagged `contract-v1` when merged.
- C2: `e2e/` harness (spec §21.2) + toy fixture project + mock scripts; enables each scenario as its dependencies land.
- C3: `packages/node/src/adapters/claude-code.ts` (spec §15.2).
- C4: reviews every PR for spec conformance; triages e2e failures into owner-labeled issues.
- C5: manual acceptance (spec §21.3), docs, and the final README update.

**Codex-1** — the Leader: DB, state machine, locks, WS hub, event handlers, scheduler, budgets, liveness, merge worker, REST API, UI WS, directives, CLI.

**Codex-2 (you)**
- Node daemon: git worktrees, test runner, journal, prompts, output parsing, adapter interface, mock adapter, WS client, command runner, daemon/CLI, opencode adapter.
- Phase 3: the Electron desktop app.

---

## 3. Cross-package contracts (shared — do not change without a `protocol-change` issue)

All wire types come **only** from `@quorum/protocol`. Never redefine a protocol type locally. If it's missing, file an issue and use a temporary local type marked `// TODO(protocol): #<issue>`. Remove it once the issue is resolved.

Exports that must exist exactly like this (stubs created by Claude in C0; owners implement them):

```ts
// @quorum/leader  (packages/leader/src/index.ts) — owner Codex-1
export interface LeaderHandle {
  port: number                  // actual bound port (config may pass 0)
  url: string                   // e.g. "ws://127.0.0.1:54321"
  close(): Promise<void>        // stops scheduler, merge worker, servers; closes DB
}
export function startLeader(config: LeaderConfig): Promise<LeaderHandle>
export function addAgent(dbPath: string, args: { id: string; owner: string }): Promise<{ token: string }>

// @quorum/node  (packages/node/src/index.ts) — owner Codex-2
export interface DaemonHandle {
  stop(): Promise<void>
  status(): NodeStatus
  updateSettings(patch: Partial<OwnerSettings>): void
}
export function startDaemon(config: NodeConfig, opts?: {
  idleSeconds?: () => number | null       // desktop passes powerMonitor; headless omits
  adapter?: AgentAdapter                  // tests may inject; otherwise built from config.adapter
}): Promise<DaemonHandle>
export type { AgentAdapter, Profile, TurnResult } from './adapters/types.js'
export { AdapterError } from './adapters/types.js'
```

`LeaderConfig`, `NodeConfig`, `OwnerSettings`, and `NodeStatus` are exported by `@quorum/protocol` (`src/config.ts`, `src/frames.ts`).

The Leader and the Node interact **only** over the WebSocket protocol (spec §11). Neither package imports the other.

**Adapter interface ownership:** you write `src/adapters/types.ts` **exactly** as in spec §15.1 in work item N5 (no extra members). Claude's `claude-code.ts` implements that interface. If it needs a change, use an issue labeled `owner:codex-node`.

---

## 4. Working rules (shared)

1. **Branches:** `codex-leader/<short-topic>`, `codex-node/<short-topic>`, `claude/<short-topic>`. Never commit directly to `main`.
2. **PRs:** one PR per numbered work item below (or smaller). Title: `[N3] node journal`. The body lists the spec sections implemented, the tests added, and anything deferred. Rebase on `main` right before opening and again before merge.
3. **Merging:** a PR merges once CI is green and Claude has reviewed it. If there's no review within one work session, the owner may merge their own PR when CI is green **and** it touches only their own paths.
4. **CI must stay green on `main`:** `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`.
5. **Issues** (create the labels if missing):
   - `protocol-change`: you need a schema added or changed in `@quorum/protocol`. Include the exact proposed zod/TS.
   - `owner:codex-leader`, `owner:codex-node`, `owner:claude`: bug or request for that owner.
   - `spec-question`: the spec is ambiguous. Include your proposed interpretation, then **proceed with it**. Don't block.
6. **At the start of every work session:** `git pull`, read open issues labeled with your owner tag and `protocol-change`, and fix your assigned bugs before new work.
7. **No real LLM calls in automated tests.** Tests use fakes or the mock adapter.
8. **No secrets in the repo.** Example configs use placeholders. Never commit `.db` files or tokens.
9. **Style:** TypeScript strict, ESM, no `any` in public or core code, `execFile` with argument arrays (never shell strings) except the project `setupCommand`/`testCommand`. Short comments only where the *why* isn't obvious.
10. **Mark progress** by ticking the checkboxes in your own task file, in the same PR as the work.

---

## 5. Your work items — Phase 1–2: Node daemon (in order)

Dependencies: **N1, N2 and N3 can start immediately**, before Claude's protocol PR (C1) lands. **N4 onward depend on C1.**

Every work item must include vitest tests in `packages/node/test/`. Git tests use a **temporary bare repo** plus a clone created in `os.tmpdir()`. Build a reusable helper `test/helpers/temp-repo.ts`.

### N1 — Git worktree operations · spec §14.1, §14.2
- [x] `src/git/git.ts`: `git(cwd, args, {timeoutMs})` over `execFile`, returning `{code, stdout, stderr}`, plus `-c user.name/-c user.email` injection for commits.
- [x] `src/git/worktrees.ts`: one exported function per row of the §14.2 table: `ensureBaseClone`, `createWorktree(sid)`, `prepareAuthorNewBranch`, `prepareAuthorExistingBranch`, `ensureCleanBeforeAuthorTurn`, `commitAndPushAfterAuthorTurn` (returns the commit or null), `diffInfo(base)` (`filesChanged`, `diffLines` via `--numstat`), `prepareReviewer(headCommit)`, `resetIfReviewerModified`, `syncWithMain` (returns `{hadConflicts, conflictedFiles}` and leaves conflicts in place for the agent), `finishSync` (marker scan + commit + push), `releaseWorktree`, `removeWorktree`.
- [x] Worktree path is always `{workspaceDir}/worktrees/{sid}` and never changes for a sid.
- **Accept:** tests cover each function, including a real merge conflict and conflict-marker detection, and push to the temp bare remote.

### N2 — Project config + test runner · spec §6.3, §14.2 (last paragraph)
- [ ] `src/runner/project-config.ts`: read `quorum.json` via `git show origin/<main>:quorum.json` (never from the worktree). Missing → defaults (no test → passed with `"no testCommand configured"`).
- [ ] `src/runner/tests.ts`: `runSetupIfNeeded(worktree)` (lockfile hash stored in `{worktree}/.git`-adjacent node data, not in the repo) and `runTests(worktree)` → `TestResult` (`sh -c` / `cmd /c`, `testTimeoutSec`, kill the process tree on timeout, `outputTail` = last 200 lines capped at 20 KB).
- **Accept:** tests for passing, failing, timing out, missing config, and a config changed only on a branch being ignored.

### N3 — Node journal · spec §11.3
- [ ] `src/journal.ts`: better-sqlite3 at `{dataDir}/node.db` with the `inbox`, `outbox`, `sessions` tables from §11.3. API: `recordCommand`, `markRunning`, `markDone(resultEvtMsgId)`, `enqueueEvent`, `markAcked`, `unackedEvents()`, `isProcessed(msgId)`, session CRUD.
- [ ] `recoverOnStartup()`: every `running` inbox row → enqueue `turn.failed {code:'INTERRUPTED'}` and mark it done.
- **Accept:** a restart-simulation test (open, write, close, reopen) proves recovery and dedupe.

### N4 — Prompts + output parsing · spec §12
- [ ] `src/prompts/`: one function per prompt §12.2–§12.9, with the exact text structure from the spec: the `<peer_content source="…">` wrapping, and the preamble's peer-content rule and git prohibition. Large-diff fallback uses `maxDiffLinesInPrompt`.
- [ ] Escape `</peer_content>` inside peer text (e.g. replace with `<\/peer_content>`) so peer text can't close the wrapper.
- [ ] `src/output/parse.ts`: extract the **last** ```` ```quorum-json ```` block, validate with the schema from `@quorum/protocol/agent-output`, and produce the retry prompt text from §12.1 on failure. Extra validation: `responses` must cover exactly the supplied blocking issue codes; `previousIssues` must cover exactly the supplied prior codes.
- **Accept:** snapshot tests for every prompt; parser tests for valid, missing, multiple, malformed, and coverage-mismatch cases.

### N5 — Adapter interface + mock adapter · spec §15.1, §15.4
- [ ] `src/adapters/types.ts` exactly per §15.1 (`Profile`, `TurnResult`, `AdapterError`, `AgentAdapter`).
- [ ] `src/adapters/mock.ts`: full §15.4 script format (`match` by `taskTitleContains` / `any`, per-(sid,taskId) turn index, `writeFiles`, `reply` → wrapped in a quorum-json block, `rawReply`, `failTurnWith`, `delayMs`, `tokensPerTurn`, `contextTokens` growth so compaction can be tested). The mock must find the taskId/title from the prompt text, so add a stable first line to every prompt in N4: `QUORUM-TASK: <id> <title>` (or `QUORUM-DIRECTIVE: <id>`).
- [ ] `src/adapters/index.ts`: `createAdapter(config.adapter)` factory for `mock` | `opencode` | `claude-code`. Import `claude-code.ts` lazily so a missing SDK doesn't break mock-only use.
- **Accept:** mock tests cover each behavior.

### N6 — Leader client (WebSocket) · spec §11.1, §11.2, §10.2
- [ ] `src/ws/leader-client.ts`: connect, `hello` (settings + SessionReports), handle `welcome`/`reject`; exponential backoff 1s→30s with jitter; refuse `ws://` to non-localhost unless `--insecure`.
- [ ] Inbound `cmd`: if already processed → re-ack only; else journal **then** ack, then dispatch.
- [ ] Outbound `evt`: always via the journal outbox; resend unacked every `resendUnackedSec` and on reconnect.
- [ ] Heartbeat every `heartbeatIntervalSec` with `NodeStatus` (`humanIdleSec` from the `idleSeconds` option, or null/large with `--assume-idle`).
- [ ] `test/helpers/fake-leader.ts`: a scriptable WS server speaking the protocol, used by N6–N8 tests.
- **Accept:** reconnect after a server restart resends unacked events; duplicate command executed once; reject handling.

### N7 — Command runner · spec §16.2, §11.4, §11.5, §11.6
- [ ] `src/runner/command-runner.ts`: per-sid FIFO queue (one command at a time per sid, concurrent across sids).
- [ ] A handler for every command in §11.4 that produces exactly the events in §11.5:
  - `session.open` → worktree + setup + `adapter.createSession` → `session.opened`
  - `author.start` / `author.revise` → prepare branch → turn → parse/retry → commit+push (+ `author.checkpoint` after **every** turn, including retries) → `diffInfo` → tests → `author.submitted`
  - `author.sync` → `syncWithMain` → (conflicts? agent turn §12.8 → `finishSync`) → tests → `author.synced`
  - `review.start` / `review.rereview` → `prepareReviewer` → diff for the prompt → turn → parse/retry → `resetIfReviewerModified` → `review.completed`
  - `directive.run` → `directive.completed`
  - `task.cancel` → abort the in-flight turn → `turn.failed {CANCELLED}` → release worktree
  - `session.close` → remove worktree + `closeSession` → `session.closed`
- [ ] Usage is summed across retry turns and reported in the result event. `contextTokens` is persisted per session.
- [ ] Compaction §11.6 runs before any command when over `contextPressurePct` (same sid, new nativeId) → `session.compacted`.
- [ ] Turn timeout `turnTimeoutSec` → abort → `turn.failed {TIMEOUT}`. Adapter errors map to `turn.failed` codes. Git failures map to `GIT_ERROR`.
- **Accept:** fake-leader + mock adapter + temp repo tests for every command, including invalid-output retry, cancel mid-turn, timeout, compaction, and a sync with conflicts.

### N8 — Daemon + CLI · spec §16.1, §16.3, §3 contract
- [ ] `src/daemon.ts` implements `startDaemon` / `DaemonHandle` exactly as in §3 of this file, with the startup order from spec §16.1.
- [ ] `updateSettings` takes effect on the next heartbeat.
- [ ] `src/cli.ts` (bin `quorum-node`): `start --config <path> [--assume-idle] [--insecure]`.
- [ ] pino logs with `taskId, sid, conversationId, msgId, agentId`.
- **Accept:** fake-leader test of a full author flow and a full review flow through `startDaemon`. Then comment on Claude's C2 tracking issue: `Node daemon ready: N1–N8 merged`.

### N9 — opencode adapter · spec §15.3
- [ ] `src/adapters/opencode.ts` per §15.3 (create session, post message, poll until the last assistant message has `finish: "stop"`, concatenate text parts, usage from token fields or the chars/4 estimate, 2 retries on retryable errors).
- [ ] Before coding, verify endpoint shapes against the opencode server's own docs/SDK for the installed version, and record what you verified in the PR body.
- **Accept:** tests against a local fake HTTP server reproducing the observed response shapes. A manual check against a real `opencode serve` is described in the PR.

---

## 6. ~~Phase 3: Desktop app~~ — MOVED TO CLAUDE (see tasks/claude.md). Kept for reference only.

Start D1 as soon as N8 is merged. The Leader REST API may not exist yet, so build against `@quorum/protocol` `api.ts` types with a **mock API client**, then switch to the real one once Codex-1's L8 is merged.

### D1 — Electron shell
- [ ] Electron + Vite + React + TypeScript. The main process embeds `startDaemon(config, { idleSeconds: () => powerMonitor.getSystemIdleTime() })`.
- [ ] Config stored in `app.getPath('userData')/quorum.node.json`. The token is stored with Electron `safeStorage` when available.
- [ ] Preload exposes typed IPC only: `getLocalStatus`, `getConfig`, `saveConfig`, `updateSettings`, `restartDaemon`. `contextIsolation: true`, `nodeIntegration: false`.

### D2 — API layer
- [ ] `src/renderer/api/client.ts`: REST client for every §17 endpoint, plus `/ws/ui` subscription with auto-reconnect. Responses validated with protocol schemas.
- [ ] `src/renderer/api/mock-client.ts` with the same interface and fixture data, selectable with `QUORUM_MOCK_API=1`.

### D3 — Screens (spec §18 items 1–8)
- [ ] First-run setup, Dashboard, Tasks board, New task form, Task detail (timeline, issue cards, diff2html viewer with full/per-round delta selector, permission-aware action buttons, escalation reason, blocked-author answer box), Sessions, Directives, Settings (opencode warning).
- [ ] OS notifications: my task MERGED, my task ESCALATED / needs attention, my agent rate-limited.

### D4 — Packaging
- [ ] `pnpm --filter @quorum/desktop dev` and `build` work on Linux (AppImage) and macOS (dmg). Windows is best effort.
- **Accept (D1–D4):** component tests for the task detail and board with the mock client; a manual run against a real Leader is described in the PR with screenshots.

---

## 7. Out of scope for you
- Anything in `packages/leader`, `packages/protocol`, `e2e`, and `packages/node/src/adapters/claude-code.ts`.
- Task decomposition, multi-repo, GitHub PR integration, Docker sandbox (spec §23).

## 8. Done when
N1–N9 and D1–D4 are ticked and merged, CI is green, and Claude's e2e scenarios that depend on the Node pass. Comment on the C2 tracking issue: `Node + desktop complete`.
