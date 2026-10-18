> ## ⛔ STOPPED — Leader handed over to Claude (2026-10-18)
> Codex-1 hit its usage limit. **Claude now owns `packages/leader` and all remaining L-items.**
> If you are Codex-1 and were resumed automatically: **do not continue L5+, do not push to `codex-leader/*`.**
> Read [`tasks/STATUS.md`](STATUS.md). Your uncommitted L5 work was preserved and is being folded into Claude's PRs.
> Checkboxes below are kept for history; live progress is tracked in [`tasks/claude.md`](claude.md).

# Codex-1 — Leader (coordinator server)

You are **Codex-1**. You build the **Leader**: package `packages/leader`.
Two other agents work on this repository **at the same time**:

- **Claude**: scaffold, shared protocol, end-to-end tests, Claude Code adapter, integration.
- **Codex-2**: the Node daemon (`packages/node`), the opencode/mock adapters, then the desktop app.

You do not talk to them directly. You coordinate only through **git, pull requests, and GitHub issues**, following the rules below.

---

## 1. Read first (in this order)

1. `docs/implementation-spec.md` — **the authoritative spec**. Sections you must know fully: §3, §6.1, §6.3, §7, §8, §9, §10, §11, §13, §14.3, §14.4, §17, §19, §20, §21.1.
2. This file.
3. `tasks/codex-2-node.md` §2–§4 (the same shared rules, so you know where the other side's boundaries are).

Where `README.md`, `docs/architecture.md`, or `tasks/todo.md` disagree with `docs/implementation-spec.md`, **the spec wins**. In particular: after approval and passing tests, the Leader squash-merges into `main` itself (spec §14.3).

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

**Codex-1 (you)** — the Leader: DB, state machine, locks, WS hub, event handlers, scheduler, budgets, liveness, merge worker, REST API, UI WS, directives, CLI.

**Codex-2**
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

---

## 4. Working rules (shared)

1. **Branches:** `codex-leader/<short-topic>`, `codex-node/<short-topic>`, `claude/<short-topic>`. Never commit directly to `main`.
2. **PRs:** one PR per numbered work item below (or smaller). Title: `[L3] locks + sendToSession`. The body lists the spec sections implemented, the tests added, and anything deferred. Rebase on `main` right before opening and again before merge.
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

## 5. Your work items (in order)

Dependencies: **L1 and L2 can start immediately**, before Claude's protocol PR (C1) lands. In L2, use a local `TaskState` union and replace it with the protocol export once `contract-v1` is on `main`. **L3 onward depend on C1.**

Every work item must include vitest tests in `packages/leader/test/`. Use an in-memory or temp-file SQLite DB per test.

### L1 — Database layer · spec §7
- [x] `src/db/schema.sql`: exactly the tables, columns, CHECKs, indexes and partial unique index from spec §7.
- [x] `src/db/migrations.ts`: applies the schema with a `schema_version` table (version 1). Idempotent on re-run. Enables WAL and foreign keys.
- [x] `src/db/repo.ts`: typed functions for every read and write used later (agents, sessions, tasks, conversations, issues, messages, task_events, usage_ledger, directives, merge_queue). No raw SQL outside `src/db/`.
- [x] `withTx(fn)` helper using better-sqlite3 transactions. All mutations go through it.
- **Accept:** tests insert/read every table; CHECK constraints reject a locked session without a lock, a conversation whose reviewer agent equals its author agent, and a second active conversation for the same task.

### L2 — Task state machine · spec §8
- [x] `src/core/state-machine.ts`: the transition table T1–T33 as data (`from[]`, `to`, `id`).
- [x] `transition(db, taskId, to, { reason, actor, data })`: asserts the pair is allowed (else throws `IllegalTransitionError`), updates `state`, `state_entered_at`, `updated_at` and `paused_from_state`/`pause_reason` where relevant, and inserts `task_events`, all in one transaction.
- [x] Side effects are **not** inside `transition()`. Handlers (L5) call `transition()` and then the effects, inside the same `withTx`.
- [x] The "author needed but lost → PAUSED directly" rule (end of spec §8.2) as a helper `enterAuthorState(task, intended)`.
- **Accept:** a test iterates **every** (from,to) pair of the 12 states. Listed pairs succeed, all others throw. Every success writes exactly one `task_events` row.

### L3 — Locks, leases, `sendToSession` · spec §3, §10.1, §9.4 lock fields
- [x] `src/core/locks.ts`: `lockSession(sid, kind, ref, role)`, `releaseSession(sid, toState: 'idle'|'lost')`, `extendLease(agentId, aliveSids)`.
- [x] `sendToSession(sid, command)` exactly per §10.1 steps 1–5 (lock check by `taskId`/`directiveId`, conversation participant check, `seq` assignment, insert into `messages` as `to_node`, hand off to the hub through an injected `deliver(agentId, frame)` function).
- [x] `sendToAgent(agentId, command)` for `session.open` / `session.close` only.
- **Accept:** tests for each rejection in spec §21.1 bullet 2; `seq` strictly increasing per conversation; invariants §3.1–§3.4 hold under random interleavings (property-style test with 200 random operations).

### L4 — Node hub (WebSocket `/ws/node`) · spec §11.1, §11.2, §10.2
- [x] fastify + `ws` server on `config.listen` (supports `port: 0`). Optional TLS from `config.tls`.
- [x] `hello` auth: sha256(token) == `agents.token_hash` and not revoked → `welcome`, else `reject`. A new connection for the same agentId wins, and the old one gets `reject {already_connected}`.
- [x] On `hello`: store settings, mark online, reconcile sessions (a locked session not reported alive → loss handler from L6 via an injected callback), resend all unacked `to_node` messages for that agent.
- [x] Reliable delivery: resend unacked every `resendUnackedSec`; `sent_at`/`acked_at` bookkeeping; inbound `evt` dedupe by `msgId` (store `from_node` rows); **ack only after the handler's transaction commits**.
- [x] Heartbeat processing per §10.2 (settings, `human_idle_sec`, `rate_limited_until`, lease extension, missing-session loss).
- [x] `test/helpers/fake-node.ts`: a scriptable WS client speaking the protocol, used by L4–L9 tests.
- **Accept:** duplicate `evt` applied once; leader restart → node reconnect → unacked commands redelivered; bad token rejected; heartbeat extends leases.

### L5 — Event handlers · spec §8.2, §8.3, §11.5
- [ ] `src/core/handlers.ts`: one function per event type in §11.5. Each runs in one `withTx`: stale-event guard → ledger write (L6 budget API) → state transition → side-effect commands via `sendToSession`.
- [ ] `author.submitted`: T2/T3/T4/T5/T6, file/diff bookkeeping, issue responses stored (`author_response`, `author_note`), overlap warning (§14.4).
- [ ] `review.completed`: issue bookkeeping and **effective verdict** exactly per §8.3 → T8/T9/T10. Issue codes `I1, I2…` assigned per task.
- [ ] `author.synced`: T19/T20/T21. `session.opened`: lock + send the pending work command (§9.4). `session.compacted`: update `context_tokens`. `author.checkpoint`: update `head_commit`. `directive.completed`. `session.lost`.
- [ ] `turn.failed` policy per §11.5 (retries, RATE_LIMITED → §10.5, CANCELLED ignored, GIT_ERROR → FAILED).
- [ ] Command builders: construct `author.start`, `author.revise`, `author.sync`, `review.start`, `review.rereview` payloads from task + issues (including `suggestions`, `testFailure`, `priorIssues`, `estimated`).
- **Accept:** unit tests for §21.1 bullet 4; fake-node tests driving scenarios 2, 3, 4, 12, 16, 17, 21 at the Leader level.

### L6 — Scheduler, budgets, liveness · spec §9, §10.3–§10.5, §7 token accounting
- [ ] `src/core/budget.ts`: ledger kind own/lent, `lentToday` with `dayBoundaryTz`, `budgetRemaining`, cost estimates, EMA update + clamp [0.25, 4].
- [ ] `src/core/scheduler.ts`: `schedule()` per §9 steps 1–5; effective priority with aging; author assignment §9.2 (own/pool); reviewer assignment §9.3 (hard filters, score, tie-breakers); session selection §9.4 including `session.open` flow, 60s open timeout, and the 5-minute per-agent backoff.
- [ ] Runs every `tickMs`, and is also triggered (debounced to once per event loop turn) after events that change eligibility.
- [ ] Expiry pass §10.3; loss handler §10.4 (author vs reviewer vs directive); rate limits §10.5; PAUSED grace T24/T25; `task.needs_attention` for no reviewer after `noReviewerNotifyAfterSec`.
- [ ] Inject a clock (`now: () => number`) into scheduler/budget/liveness for tests. Production uses `Date.now`.
- **Accept:** §21.1 bullets 3 and 5; fake-node tests for scenarios 5, 6, 7, 8, 9, 10, 11.

### L7 — Merge worker · spec §14.3, §14.4, §6.3
- [ ] `src/git/leader-git.ts`: clone if missing; all git ops via `execFile` with a 5-minute timeout; reads `quorum.json` from `origin/<main>`; lockfile-hash–based `setupCommand`.
- [ ] `src/core/merge-worker.ts`: strictly serial loop over `merge_queue` (FIFO by `approved_at`), exactly the §14.3 algorithm including commit trailers, push retry, branch deletion → T13–T18.
- **Accept:** tests with a temp bare repo: clean squash merge lands on `main` with trailers; conflict → SYNCING; failing tests → AUTHORING with a system issue; non-fast-forward push is retried.

### L8 — REST API, UI WebSocket, directives, CLI · spec §17, §13
- [ ] All endpoints in the §17 table, with request/response zod schemas from `@quorum/protocol` `api.ts`, bearer auth, permission checks (requester/admin), and error format.
- [ ] `GET /api/tasks/:id/diff` computed in the Leader clone after `git fetch`.
- [ ] `/ws/ui?token=` pushing the listed event types after each committed change.
- [ ] Directives §13 including `409 SESSION_LOCKED` and read-only profile.
- [ ] CLI `src/cli.ts` (bin `quorum-leader`): `start --config`, `add-agent --id --owner` (prints token once; stores sha256), `revoke-agent --id`, `list-agents`.
- **Accept:** fastify `inject` tests for every endpoint, including 401/403/404/409 cases; scenario 18 at Leader level.

### L9 — `startLeader` wiring + restart recovery · spec §4, §11.2, §21.2 #15
- [ ] `startLeader(config)` builds DB → hub → handlers → scheduler → merge worker → REST, and returns `LeaderHandle`. `close()` shuts everything down cleanly (tests must not leak handles).
- [ ] On start, all agents are `offline` until `hello`. A task left in `MERGING` goes back to `MERGE_QUEUED`.
- [ ] Structured pino logging per spec §20 (fields `taskId, sid, conversationId, msgId, agentId`).
- **Accept:** a fake-node test kills and restarts the Leader mid-review, and the flow completes with no duplicate effects. Then notify Claude (comment on the C2 tracking issue) that e2e scenarios may be enabled.

---

## 6. Out of scope for you
- Anything in `packages/node`, `packages/desktop`, `packages/protocol`, `e2e`.
- An LLM inside the Leader (spec §23). The Leader makes **zero** model calls.
- GitHub PR integration, multi-repo, Docker sandbox.

## 7. Done when
All L1–L9 checkboxes are ticked and merged, CI is green, and Claude's e2e scenarios that depend only on the Leader + mock nodes pass. Tell Claude by commenting on the C2 tracking issue: `Leader complete: L1–L9 merged`.
