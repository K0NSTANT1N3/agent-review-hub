# Architecture

## Components

**Desktop client:** developers submit tasks and inspect sessions, review pairings, findings, and outcomes.

**Shared coordinator:** a deterministic service owns the queue, scheduler, SQLite state, authenticated owners, review mappings, and audit events. It can run on one team member's host for the first demo.

**Local connector:** each developer runs a connector under their own account. It registers capabilities and availability, launches or resumes local coding-agent sessions, collects structured results, and forwards routing envelopes. Provider credentials stay on that developer's machine.

**Agent adapter:** translates connector operations into a supported coding-agent CLI/SDK. Start with Claude Code. Do not automate unrelated browser chat tabs.

## Persistent records

| Record | Minimum fields |
| --- | --- |
| Owner / machine | ID, authenticated connector identity, capabilities, connection state, last heartbeat |
| Agent session | Owner, machine, adapter, native session ID, workspace, task/context summary, execution state, reserved review ID, usage counters |
| Task | ID, owner, project, request, author session, status |
| Candidate | ID, task ID, immutable revision or content hash, change summary, artifact references, verification evidence |
| Review | ID, author session, reviewer session, candidate ID, status, round count, deadline, budget policy |
| Message | Unique ID, review ID, round ID, candidate ID, sender session, recipient session, type, payload, acknowledgement state |

Review IDs belong to the coordinator. Native session IDs belong to the coding-agent provider and are namespaced by owner, machine, adapter, and workspace.

## State and routing

```text
candidate_ready -> queued -> reviewing -> approved -> delivered
                              |
                              +-> changes_requested -> revising -> reviewing
                              |
                              +-> blocked / escalated / cancelled
```

Each transition and its audit event are persisted together. On candidate submission, create the review and reserve its author session in one transaction before queueing it. When a reviewer becomes available, atomically reserve that reviewer and attach the pair while checking that the author reservation still belongs to this review. Keep the author reserved throughout the queued wait. A session can belong to at most one open review.

Keep execution state separate from reservation state: an idle process can still own a reserved review session. Only the coordinator closes or reassigns a review; a quiet session must not silently become eligible for unrelated work.

Route messages from the stored pair, not from IDs invented in model output. Validate the authenticated sender, message type, current round, and candidate revision. Reject mismatched or stale replies. Deduplicate by message ID and serialize turns within each native session.

## Reviewer selection

Filter for connected owners, compatible adapters, project access, available capacity, a different developer from the author, and budget policy. Prefer suitable capability tags, low queue depth, and fair use across the roster. If no reviewer is eligible, leave the work queued with an explanation.

Resume the mapped reviewer for every round of the same review. Create a fresh session for unrelated requests. Store context summaries and tags explicitly; the scheduler does not infer hidden knowledge perfectly.

## Recovery and completion

Heartbeats identify disconnected connectors. Persist requests before delivery and retry acknowledged/idempotent operations safely. An uncertain agent invocation must be reconciled before resending it, to avoid duplicate runs and spending.

After restart, restore review ownership from SQLite. If a native session cannot be resumed, pause or explicitly record a replacement with a handoff summary. Never silently route the old conversation into a random session.

Approval releases reservations only for the reviewed candidate. Any later source change creates a new candidate requiring another review. Maximum rounds, deadline, explicit cancellation, or budget exhaustion cause escalation with both agents' evidence and history. Keep publishing under human control in the MVP.

## Trust boundary

Use a per-team enrollment mechanism and per-connector credentials before accepting remote connections. The coordinator must authorize project access and session ownership on every operation. Do not share provider login tokens between developers or commit transcripts and credentials into Git.

This architecture enforces message routing and final-result delivery. It does not claim that a model always follows instructions, that routing prevents filesystem conflicts, or that review catches every defect.
