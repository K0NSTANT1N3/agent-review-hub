# MVP backlog

This is a specification-only starter repository. Claim a task in a GitHub issue before implementing it.

## Shared contracts

- [ ] Define TypeScript schemas for owners, machines, sessions, candidates, reviews, and messages.
- [ ] Define connector enrollment, authentication, project authorization, and heartbeat messages.
- [ ] Define start/resume/status/result adapter operations and structured reviewer verdicts.
- [ ] Specify which events complete a turn and which terminal states release a review reservation.

## Coordinator

- [ ] Implement SQLite persistence and a durable task/review queue.
- [ ] Reserve the author when queueing a review; attach a reviewer atomically later and reject competing claims.
- [ ] Route messages only between the mapped sessions; deduplicate deliveries.
- [ ] Select reviewers by owner, availability, capacity, project access, and capability tags.
- [ ] Implement bounded review rounds, deadlines, cancellation, and escalation.
- [ ] Restore reservations and reconcile in-flight work after restart or disconnect.

## Local connector and Claude Code adapter

- [ ] Launch new sessions and capture their native IDs.
- [ ] Resume exact existing sessions and serialize their turns.
- [ ] Capture candidate artifacts and verification evidence before final delivery.
- [ ] Report status and measured usage; preserve unknown quota as unknown.
- [ ] Keep provider credentials local and reconcile uncertain invocation outcomes.

## Desktop client

- [ ] Add task submission and a team/session roster.
- [ ] Show paired sessions, queue state, findings, round count, usage, and deadlines.
- [ ] Deliver approved results and actionable human escalations.
- [ ] Show disconnects and recovery without hiding pending work.

## Acceptance demo

- [ ] Two owners connect their own local agents to one coordinator.
- [ ] A candidate is reviewed before final delivery to its developer.
- [ ] A requested change returns to the original author session.
- [ ] The revision returns to the same reviewer session.
- [ ] An unrelated request uses separate sessions while the first pair stays reserved.
- [ ] The author remains reserved while its review waits for an eligible reviewer.
- [ ] Stale, duplicate, wrong-session, and wrong-candidate messages cannot alter the current review.
- [ ] Restart restores ownership; a dropped connector does not cause silent reassignment.
- [ ] A bounded loop escalates instead of running indefinitely.

## Review

Starter documentation prepared. No application code, dependencies, or executable tests have been added yet.
