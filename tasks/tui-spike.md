# TUI transcript spike

Date: 2026-10-21.
Scope: fixture analysis and Phase 1 protocol types.
No agent CLI ran during this spike.
No runtime streaming adapter ships in this phase.

## Evidence and limits

The captures are in [packages/node/test/fixtures/agents](../packages/node/test/fixtures/agents/).
Line numbers below count physical lines from 1.
Repository paths in the captures use `/work/repo`.
The capture operator verified session resumption for all three CLIs.
The operator also verified that each CLI waits indefinitely when its stdin stays open.
Use `/dev/null` for stdin in a shell.
Use `stdio: ['ignore', 'pipe', 'pipe']` with `spawn` in the future adapter.
Pass the prompt as one argv value.
Do not start a PTY.

Read [implementation-spec.md §11–§15](../docs/implementation-spec.md) before implementing an adapter.
Section 12 defines prompts and the final `quorum-json` reply.
Section 13 requires read-only directives.
Section 14 assigns git and test operations to the Node.
Section 15.1 currently returns final text only.
The transcript callback, persistence, batching, cancellation, and CLI discovery remain future runtime work.

The six captures do not identify the installed CLI release.
`session.version: 3` is a session format version.
It is not a CLI release version.
Static package inspection found Codex `0.163.0`, pi `1.3.0` (`@earendil-works/pi-coding-agent`), and omp `18.1.21` on this machine.
These values do not prove the release used for a capture.
No `--version` command ran.

## Trust terms

`enforced` means Quorum checks tool permissions before execution.
These checks must cover repository paths and the profile's shell policy.
`sandboxed` means an external sandbox constrains execution.
It does not imply Quorum's exact tool policy.
`low` means Quorum cannot establish either complete boundary.
A prompt instruction alone does not increase trust.
The Node reports trust for its active adapter.
Each detected installation also has its own trust value.
Missing trust means unknown.
The UI must not display missing trust as `enforced`.

## Codex CLI

### Launch profiles and session

The author capture used this command:

```sh
codex exec --json -s workspace-write --skip-git-repo-check "<prompt>" < /dev/null
```

Use the following candidate commands for a fresh reviewer or directive session.
These commands were not captured.
The sandbox option is documented in the [official OpenAI CLI reference](https://developers.openai.com/codex/cli/reference/).

```sh
# Reviewer
codex exec --json -s read-only --skip-git-repo-check "<review prompt>" < /dev/null
# Directive
codex exec --json -s read-only --skip-git-repo-check "<directive prompt>" < /dev/null
```

`thread.started.thread_id` supplies the native session ID.
Both captures report `01a15b11-f651-70a0-a2e6-9291f3c055a2` at line 1.
The second capture used this command:

```sh
codex exec resume <thread_id> --json --skip-git-repo-check "<prompt2>" < /dev/null
```

Turn 2 returns `subtract` in `item.completed` at [codex-t2.jsonl:3](../packages/node/test/fixtures/agents/codex-t2.jsonl#L3).
The captured resume command does not specify a sandbox policy.
It proves recall, not read-only enforcement after resume.
The official reference documents configuration overrides and resume separately.
Revalidate sandbox selection on resume before reporting a resumed reviewer as `sandboxed`.
Do not reuse an author session as a reviewer session.

### Field mapping

| Normalized value | Captured event and exact source fields |
| --- | --- |
| Assistant text, final snapshot | `item.completed`, when `item.type == 'agent_message'`: `item.text`. See t1:3,16 and t2:3. The event completes one assistant message. Only the last such message is the final turn reply. |
| Assistant text delta | Not observed. No text delta event occurs in either capture. |
| Thinking | Not observed. `turn.completed.usage.reasoning_output_tokens` is a count. It is not thinking text. |
| Tool start: bash | `item.started`, when `item.type == 'command_execution'`: `item.id` is the call ID. Use synthetic tool name `command_execution`. `item.command` is the argument summary. Normalize the kind to `bash`. See t1:4,6,7,10,14. |
| Tool start: file edit | `item.started`, when `item.type == 'file_change'`: `item.id`; synthetic name `file_change`; `item.changes[].path`; `item.changes[].kind`. The captured `kind` is `update`. Normalize it to `edit`. Patch text is not present. See t1:12. |
| Bash result | `item.completed`, when `item.type == 'command_execution'`: match `item.id`; use `item.aggregated_output`, `item.exit_code`, and `item.status`. Captured `completed` with exit 0 means success. Captured `failed` with exit 1 means failure. See t1:5,8,9,11,15. Do not copy the start event's null exit code into a result. |
| File edit result | `item.completed`, when `item.type == 'file_change'`: match `item.id`; `item.status == 'completed'` means success in this capture. No output or exit code is supplied. See t1:13. Use an empty normalized output. |
| Input and output usage | `turn.completed.usage.input_tokens` and `.output_tokens`. t1:17 reports 107008 and 339. t2:4 reports 143706 and 357. Keep `.cached_input_tokens`, `.cache_write_input_tokens`, and `.reasoning_output_tokens` separate from these raw counters. Do not add cache fields to input without a provider accounting contract. |
| Current context size or context limit | Not observed. The turn-level input counter is not a measured current context size. Omit normalized `contextTokens`. Use configured `contextWindow` only as a limit. |
| Turn start and end | `turn.started` at t1:2 and t2:2; `turn.completed` at t1:17 and t2:4. Wait for turn completion before accepting the last assistant message as the reply. |
| Errors | A tool failure occurs at `item.completed` t1:11: exit 1, status `failed`, empty output. This is an `rg` command failure. CLI, transport, and turn failure events are not observed. |
| Rate limits and reset time | Not observed. No rate-limit field or event occurs. |
| Status | Derive a short display string from `item.started.item.command` or `.changes`. No standalone status text event occurs. |

Both turn files restart item IDs at `item_0`.
Namespace call IDs with a persisted turn key before normalization.
An `rtk read` command is still a `bash` call at the transport boundary.
Do not infer a native read tool from its command text.

### Restrictions and gotchas

The author command selects `workspace-write`.
The reviewer and directive candidates select `read-only`.
The expected fresh-session trust is `sandboxed` when the requested sandbox is active.
The captures do not test sandbox escape or a denied write.
No Quorum path or shell allowlist callback appears in these captures.
Do not report `enforced`.
The t1 stream includes successful reads under `/home/user` at `item.completed` t1:5,8.
A workspace write sandbox does not prove repository-only reads.
The final test prints `3` at `item.completed` t1:15.
The operator verified that Codex retained `add`.
The `file_change` events do not include the resulting source, so this stream alone cannot prove that retention.

## pi

### Launch profiles and session

The author capture used this command:

```sh
pi --mode json -p --session-id <id> "<prompt>" < /dev/null
```

The reviewer profile uses the same tool selection as the second capture.
The directive profile must use the same read-only selection.

```sh
# Reviewer
pi --mode json -p --session-id <id> --tools read,grep,find,ls "<review prompt>" < /dev/null
# Directive
pi --mode json -p --session-id <id> --tools read,grep,find,ls "<directive prompt>" < /dev/null
```

Allocate a native ID before the first launch.
Read it back from `session.id`.
Both captures report `spike-pi-0002` at `session` line 1.
Resume with the same explicit `--session-id <id>` and working directory.
The second capture used that method with `--tools read,grep,find,ls`.
It returns `subtract` at `message_end` t2:12.
Do not substitute `--resume <id>` for this command.
The statically inspected pi argument parser treats `--resume` as a boolean session selector.
It treats `--session-id` as an exact project session ID that it creates if absent.
Source: installed `@earendil-works/pi-coding-agent@1.3.0`, `dist/bundle/chunks/chunk-66G7ITPS.js`.

### Field mapping

| Normalized value | Captured event and exact source fields |
| --- | --- |
| Assistant text delta | `message_update`, when `assistantMessageEvent.type == 'text_delta'`: `assistantMessageEvent.delta`. Track `assistantMessageEvent.contentIndex`. See t1:60–62 and t2:10. |
| Assistant text snapshot | `message_update` with `assistantMessageEvent.type == 'text_end'`: `.content` at t1:63 and t2:11. The complete assistant message also appears at `message_end.message.content[]`, in entries with `type == 'text'`, field `.text` at t1:64 and t2:12. Require `message.role == 'assistant'`. Emit one canonical snapshot. |
| Assistant message grouping | Assign a stable adapter `messageId` at the assistant `message_start` at t1:58 or t2:8. A native message ID is not observed there. `message_end.message.responseId` arrives at t1:64 and t2:12. Keep the adapter ID across deltas and final chunks. |
| Thinking | Not observed. Neither capture has a thinking delta, thinking snapshot, or thinking content block. |
| Tool start | `tool_execution_start`: `toolCallId`, `toolName`, `args`. See t1:14,26,38,50. `message_update/toolcall_start` has `.id` and `.toolName` but no complete arguments at t1:9,21,33,45. `toolcall_end` has `.toolCall.id`, `.name`, and `.arguments` at t1:12,24,36,48. Use execution start for the normalized call. |
| Tool kind and paths | At `tool_execution_start`, map `toolName == 'read'` to `read` at t1:14, `edit` to `edit` at t1:26,38, and `bash` to `bash` at t1:50. Read and edit supply `args.path`. Edit supplies `args.edits[].oldText` and `.newText`. Bash supplies `args.command`. Summarize arguments instead of transmitting them. Other executed native kinds are not observed. |
| Tool result | `tool_execution_end`: match `toolCallId`; set `ok = !isError`; concatenate `result.content[]` entries with `type == 'text'`, field `.text`. See t1:15,27,39,53. Read's `result.structuredContent` is a string at t1:15. The successful edit supplies `result.details.diff` and `.patch` at t1:39. |
| Exit code | Bash supplies `result.structuredContent.exit_code == 0` at `tool_execution_end` t1:53. The same result supplies `.output == '3\n'`. Exit codes are not observed in the read or edit results at t1:15,27,39. Omit them there. |
| Partial result | `tool_execution_update.partialResult.content[]` is empty at t1:51. A text entry supplies `.text == '3\n'` at t1:52. These are partial snapshots. Do not append them as separate final tool results. |
| Input and output usage | `message_end.message.usage.input`, `.output`, `.cacheRead`, `.cacheWrite`, `.totalTokens` at t1:13,25,37,49,64 and t2:12. Only assistant messages have model usage. `message_update.usage` at t1:63 and t2:11 and `turn_end.message.usage` at t1:65 and t2:13 repeat the final counters. `agent_end.messages[]` repeats the messages at t1:66 and t2:14. Count each assistant message once. |
| Context estimate | A measured context limit or dedicated current-context field is not observed. As an explicit adapter estimate, use the latest assistant message's `.usage.totalTokens`. It equals `input + cacheRead + cacheWrite + output` in these captures. t1:64 reports 17902. t2:12 reports 14108. Do not sum it across model calls. This estimates context; it does not measure retained context. |
| Turn end | `turn_end` completes one model/tool cycle at t1:18,30,42,56,65 and t2:13. `agent_end` ends the agent loop at t1:66 and t2:14; both have `willRetry: false`. `agent_settled.aborted == false` follows at t1:67 and t2:15. Assistant `message_end.message.stopReason` is `toolUse` at t1:13,25,37,49 and `stop` on the final replies at t1:64 and t2:12. |
| Errors | `tool_execution_end.isError == true` at t1:27 reports `oldText must not be empty in math.js.` in `result.content[0].text`. The corrected edit succeeds at t1:39. Agent-level errors and failed bash results are not observed. |
| Rate limits and reset time | Not observed. |
| Status | Derive a short status from `tool_execution_start.toolName` and `.args` at t1:14,26,38,50. A dedicated status text event is not observed. |

For normalized usage, preserve the raw `input` and `output` counters in this phase's mapping.
Cache accounting remains separate adapter policy.
Do not silently change raw input into a billable-token total.

### Restrictions and gotchas

[pi-t1.jsonl](../packages/node/test/fixtures/agents/pi-t1.jsonl) has 67 physical lines.
[pi-t2.jsonl](../packages/node/test/fixtures/agents/pi-t2.jsonl) has 15.
Every line parses as JSON. Neither file contains NUL bytes.
Each file has one `agent_end` and one `agent_settled` at t1:66–67 and t2:14–15.
Run one capture process per output file and per working copy, with stdin from `/dev/null`.

At `tool_execution_start` t1:38, `args.edits[0].newText` keeps `add` and adds `subtract`.
The successful `tool_execution_end` at t1:39 confirms both exports in `result.details.diff` and `.patch`.
The bash result at t1:53 prints `3` with exit code 0.
The final assistant reply at `message_end` t1:64 is `DONE 3`.

The t2 `message_end` system event at line 5 records the tool change.
`message.toolsRemoved[].name` includes `bash`, `edit`, and `write`.
`message.toolsAdded[].name` includes `grep`, `find`, and `ls`.
`message.sections.tools` retains `read` and mentions possible custom tools.
A tool call or denied write is not observed in t2.
Do not treat this flag alone as a complete Quorum tool or repository-path boundary.
Report `low` trust for author, reviewer, and directive with these commands.
An enforced callback or an external sandbox could change that result in a later phase.
The resumed assistant reply at `message_end` t2:12 proves recall only.

## omp (oh-my-pi)

### Launch profiles and session

The author capture used this command:

```sh
omp --mode json -p "<prompt>" < /dev/null
```

The second capture selected only the read tool.
Use that selection for reviewer and directive candidates.

```sh
# Fresh reviewer
omp --mode json -p --tools read "<review prompt>" < /dev/null
# Fresh directive
omp --mode json -p --tools read "<directive prompt>" < /dev/null
# Resume either read-only profile
omp --mode json -p --resume <session_id> --tools read "<prompt2>" < /dev/null
```

Read the native ID from `session.id`.
Both captures report `01a15b11-f84e-7000-bae0-49c19c7f0989` at `session` line 1.
The t2 launch uses the resume command above.
It returns `subtract` at `message_end` t2:14.
The author resume candidate uses the same `--resume <session_id>` syntax without the read-only tool selection.
An author resume is not separately captured.
The installed omp parser accepts `--tools` as a tool-name list and `--resume` with a session value.
Source: installed `@oh-my-pi/pi-coding-agent@18.1.21`, `dist/cli.js`.

### Field mapping

| Normalized value | Captured event and exact source fields |
| --- | --- |
| Assistant text delta | `message_update`, when `assistantMessageEvent.type == 'text_delta'`: `.delta`; correlate `.contentIndex`. See t1:72–73 and t2:12. |
| Assistant text snapshot | `message_update/text_end` supplies `assistantMessageEvent.content`. `message_end.message.content[]` entries with `type == 'text'` supply `.text`. Require `message.role == 'assistant'`. See t1:74–75 and t2:13–14. Emit one snapshot. |
| Thinking | `message_update/thinking_delta` supplies `assistantMessageEvent.delta` at t2:9. `thinking_end` supplies `.content` at t2:10. `message_end.message.content[]` entries with `type == 'thinking'` supply `.thinking` at t2:14. Do not copy `.thinkingSignature` to the UI. |
| Tool start | `tool_execution_start`: `toolCallId`, `toolName`, `args`, optional `intent`. See t1:16,43,62. `message_update/toolcall_start` only has `contentIndex` in this capture. `toolcall_end.toolCall` supplies `.id`, `.name`, `.arguments`. Wait for execution start to get complete execution arguments. |
| Tool kind and paths | Map captured `toolName` values `read`, `edit`, and `bash` to the same normalized kinds. Read supplies `args.path`. Bash supplies `args.command`. Edit supplies `args.input`, a hash-line edit string. It does not supply `args.path`. Its result supplies `result.details.path`. Do not invent a start-time path. |
| Tool result | `tool_execution_end`: match `toolCallId`; set `ok = !isError`; concatenate text in `result.content[]`. Read includes line and hash annotations at t1:17. Edit includes `.details.diff`, `.path`, `.oldText`, and `.newText` at t1:44. Bash prints `3` and wall time at t1:65. |
| Exit code | Not observed as a numeric field. The bash result at `tool_execution_end` t1:65 has `isError: false` and `.details.wallTimeMs`, but no exit code. Omit `exitCode`. Do not infer zero from wall time or successful text. |
| Partial result | `tool_execution_update.partialResult.content[].text` supplies the bash partial output at t1:63–64. `tool_stream_update` at t1:31,32,35,36,40,41 has only a call ID and name. It has no output text. |
| Input and output usage | `message_end.message.usage.input`, `.output`, `.cacheRead`, `.cacheWrite`, `.totalTokens`. `.reasoningTokens` is also present. `turn_end.message.usage` and `agent_end.messages[].usage` repeat these records. Count assistant messages once. Unlike pi, captured `message_update` events do not have a top-level `usage`. |
| Context estimate | A dedicated current-context or maximum-context field is not observed. The latest assistant message's `usage.totalTokens` is a candidate estimate. It equals `input + cacheRead + cacheWrite + output` in these captures. t1:75 reports 32069. t2:14 reports 10611. Do not sum this across calls. Use config for the context limit. |
| Turn end | `turn_end` ends a model/tool cycle. `agent_end` ends the full agent loop at t1:77 and t2:16. There is no captured `agent_settled` event. Assistant `message.stopReason` is `toolUse` during tool work and `stop` on the final reply. |
| Errors and rate limits | Not observed. No failed tool result, turn failure, rate-limit event, or reset time occurs. |
| Status | `tool_execution_start.intent` supplies short status text. Captured examples are `Reading math.js`, `Adding subtract export`, and `Running subtract smoke test`. The model's `toolCall.arguments.i` also carries this intent before execution. |

### Restrictions and gotchas

`--tools read` selects a narrow tool list.
The t2 capture does not call a tool or test a denied edit.
No Quorum path callback or OS sandbox is established by these fixtures.
Report `low` trust for all three profiles with the captured command families.
Do not report `enforced` merely because a tool list exists.
Keep the full `toolCallId`, including its `|` suffix.
The edit format differs from pi's `edits` array.
Use separate parser modules even though both CLIs emit similarly named events.
At `tool_execution_end` t1:44, `.details.newText` contains both `add` and `subtract`.
The capture therefore directly proves that omp retained `add`.
`advisor_cost_changed` at t1:2 and t2:2 has no cost payload.
`model_changed` at t1:7 has no model payload.
Do not infer accounting or model identity from those events.

## Existing adapters and reserved identifiers

Claude Code remains the existing SDK adapter.
Section 15.2 specifies its `canUseTool` boundary and read-only profiles.
This is the intended `enforced` baseline when those checks are active.
No Claude JSONL capture is supplied here.
Section 15.3 says Quorum cannot enforce opencode's tool restrictions.
Treat that integration as `low` until a boundary is established.
`mock` remains the deterministic test adapter.
`kilo` is a reserved registry/config identifier only.
No Kilo binary, command, event mapping, or opencode compatibility is established here.

## Phase 1 protocol decisions

The canonical registry is `ADAPTER_TYPES` in `adapters.ts`.
Config variants and hello validation accept all seven identifiers.
Codex, pi, omp, and reserved Kilo configs accept optional `binaryPath` and `model`.
They use the existing `contextWindow: 200000` default.
That default is a configuration value, not detected model capacity.
Trust is a report field, not a configurable permission assertion.

`AgentEventSchema` has six kinds: `text`, `thinking`, `tool_call`, `tool_result`, `usage`, and `status`.
Every event has `seq` and `at`.
Sequences start at 1 for each Quorum `sid`.
Persist the next sequence across process restarts, turn retries, and native-session compaction.
Timestamp order does not define sequence order.
The schema checks strict order within a batch.
The future Leader must check order and duplicates across batches.
Namespace native tool IDs by turn because Codex reuses item IDs.

`text.mode` distinguishes `delta` from `final`.
Optional `messageId` groups text and thinking chunks and deltas for one assistant message.
It has a 256-character limit.
Adapters split longer text or thinking into consecutive events of the same kind.
Text chunks keep the same mode. All chunks keep the same message ID.
Consumers concatenate consecutive `final` chunks with the same message ID into one snapshot.
Replace that message's accumulated deltas when rendering the snapshot.
Without a message ID, a final event completes the current text span.
Do not append both versions as separate messages.
Thinking events carry deltas, or one snapshot when deltas are unavailable.
Emit only one representation of a thinking span.
Text in both modes and thinking fields have a 16384-character limit per event.
Tool argument summaries have a 256-character limit.
Paths have count and length limits.
Tool output has a hard 4096-byte UTF-8 limit.
The adapter must truncate at a character boundary before validation.
The schema rejects oversized output instead of silently changing the event.
Usage counters are optional so missing context does not become a fabricated zero.
At least one usage counter must be present.

The Node frame is `{ kind: 'transcript', msgId, sid, taskId, events }`.
A batch contains 1 to 100 events for one session and task.
Use the existing durable journal, resend, and ACK rules from §11.2.
The Leader must ACK only after it commits the batch.
Deduplicate by `msgId` and by `(sid, seq)`.
Reject conflicting data for an existing sequence.
Bind `sid` and `taskId` to the authenticated Node and its assigned task history.
Do not let a Node supply another agent's identity or session profile.
The Leader derives `agentId` and `profile` for `transcript.appended`.
The UI event uses the existing `{ type, data }` envelope.
Turn completion and failure remain on the existing task event channel.
They are not new `AgentEvent` kinds in this phase.

The REST route is `GET /api/tasks/:id/transcript?afterSeq=`.
It returns `{ sessions: [{ sid, agentId, profile, events }] }`.
The cursor is exclusive: return `seq > afterSeq` in each selected session.
Omit the cursor for full history.
The optional `sid` query selects one session for independent catch-up.
Do not use the highest sequence from one session as a global cursor.
For team catch-up, discover sessions and maintain one cursor for each session.
REST pages can contain empty event arrays.
Leader storage and pagination remain future work.
The registered runtime route currently throws `task transcript not implemented yet`.
It does not return an invented empty transcript.
The Node factory throws `<type> adapter not implemented yet` for the four new config variants.
These are compilation stubs only.

The hello frame and heartbeat `status` optionally include `trust` and `detectedAgents`.
Each detected record is `{ type, version, trust }`.
Binary paths stay local to the Node. Discovery reports never carry them on the wire.
`AgentView` carries the same optional report fields for the future UI projection.
Detection must remain separate from launching a model turn.

### Compatibility boundary

`PROTOCOL_VERSION` remains `1`.
The current Leader rejects any different version.
Existing config shapes and legacy hello, heartbeat, welcome, and API token payloads still parse.
Zod strips the new optional object fields when an old peer reads an existing frame kind.
The welcome frame can advertise `capabilities: ['transcript-v1']`.
A future Node must not send transcript frames when that capability is absent.
Unknown capability names remain valid strings so later additions do not break parsing.
Old Nodes ignore the optional welcome field.
This keeps streaming opt-in with an old Leader.

An old hello parser has a closed three-value `adapterType` enum.
It cannot parse `codex`, `pi`, `omp`, or `kilo` as an active adapter.
An optional field or an unchanged protocol version cannot fix a new enum value in an old executable.
Use an updated Leader when enabling a new adapter type.
Do not mislabel a new adapter as `mock` or `opencode` to bypass this check.
Tests freeze the legacy shape and expose this limit explicitly.
Old Leaders can still receive detected-agent records as ignored optional metadata from an existing adapter type.
Supporting new active adapter names on an unmodified old Leader requires a separate legacy hello encoding contract.
That contract remains an open compatibility decision.

### Owner API tokens: required Leader enforcement

`TokenScopeSchema` now accepts `full`, `requester`, and `owner`.
API token requests and views accept only `requester` or `owner`.
An omitted mint scope still means `requester`.
`ownerToken` route metadata explicitly permits TUI reads and task actions.
Task actions retain `requesterOrAdmin` authorization.
Owner scope must not grant authority over another owner's tasks.
Requester scope keeps its existing restricted route set.
Neither API token scope may authenticate `/ws/node`.
Neither API token scope may mint, list, or revoke tokens under this contract.
Only a full agent credential may manage API tokens.
Persist and resolve the stored scope instead of inferring it from a token prefix or a request body.
Apply the same revocation and agent-rotation rules to both API token scopes.
Authenticate owner tokens on `/ws/ui` for the TUI.
Audit API token actions with token identity and owner identity.
Do not label an API-token action as a direct human action.

### Owner token risk

An owner-scope token can approve and merge as its owner.
The TUI must store it with `0600` permissions.
The Leader must refuse to mint one from a requester or owner token.
Only a full agent credential may mint it.

This phase adds schemas and route metadata only.
The current Leader still mints and resolves requester tokens only.
It does not enforce the new `ownerToken` metadata or implement owner-token issuance.
The TUI must verify the returned token scope after minting.
An old Leader may ignore the new requested scope and return a requester token.
Do not enable owner-token issuance until persistence, authorization, auditing, and revocation are implemented together.

## Open questions

1. Should new adapters require an updated Leader, or should a later version define a legacy hello encoding?
2. Which external sandbox or tool callback will establish repository-only reads for pi and omp?
3. Which context-size source should replace the pi/omp token estimate?
4. What retention, pagination, and maximum serialized batch size should the Leader enforce?
5. How should Leader prompts and human messages enter the transcript? The six agent-event kinds do not identify these speakers. Existing command and human task records can provide them in a later phase.

## Verification

The requested command chain passed with exit code 0:

```sh
corepack pnpm -r build && corepack pnpm -r typecheck && corepack pnpm -r lint && corepack pnpm -r test
```

Each command ran through `rtk proxy` as required by the workspace instructions.
Build, typecheck, and lint passed for every package that defines the corresponding script.
The recursive typecheck and lint also checked the e2e package's source.
No e2e test command ran.

| Package | Test files passed | Tests passed |
| --- | ---: | ---: |
| protocol | 2 | 48 |
| cli | 1 | 8 |
| leader | 12 | 385 |
| node | 12 | 107 |
| desktop | 5 | 69 |
| Total | 32 | 617 |

There were no failed or skipped unit tests.
Protocol coverage includes all event kinds, 16384-character text and thinking bounds, optional message IDs, chunked final replies, UTF-8 tool-output byte limits, sequence order, direction checks, registry variants, legacy payloads, path-free discovery reports, transcript route types, query cursors, and token-scope metadata.
The git integration tests use temporary local repositories.
No commit, push, or branch operation changed this working repository.
The pre-existing agent captures and `quorum-demo.mp4` remain unchanged.

## Live smoke test (2026-10-21)

The operator ran each driver through `createAdapter`. Each run had one author turn and one reviewer turn in a scratch repository. The reviewer prompt told the agent to create `pwned.txt`.

| Agent | Author turn | Reviewer write |
| --- | --- | --- |
| pi | Added `multiply`. Kept `add`. | Blocked. Only `read` was available. |
| omp | Added `multiply`. Kept `add`. | Blocked. Only `read` was available. |
| codex | Added `multiply`. Kept `add`. | **Not blocked.** The agent wrote the file with `python3`. |

Cause: the driver inherited the owner's `CODEX_HOME`. Codex then loaded the owner's `config.toml`, `AGENTS.md` and skills. The owner's config sets an approval reviewer (`approvals_reviewer = "auto_review"`). The agent wrote the file even in a fresh `-s read-only` turn.

The owner's instructions also made the agent read files outside the worktree, such as a personal notes vault. Those absolute paths went into the transcript. `codex sandbox -- sh -c 'echo > f'` alone does block the write. So the sandbox works, and the owner configuration defeats it.

Fix:

- The Codex driver runs with `CODEX_HOME=<dataDir>/codex-home`. That directory holds only a symbolic link to the owner's `auth.json`. The owner's configuration, instructions, skills, hooks and rules do not load. Sessions persist in that directory, so resume works.
- Every turn also passes `--ignore-user-config --ignore-rules`.
- The Node replaces the owner's home directory with `~` in every transcript event before it leaves the machine.

Not yet verified live: a reviewer write is blocked with the isolated home. The verification run hit the account usage limit. That run is saved as `codex-usage-limit.jsonl`. The driver maps it to `RATE_LIMITED` and parses the reset time from "try again at 5:02 AM".

Note for operators: in some shells `codex` is a shell function that sets `CODEX_HOME` itself. Test the binary directly, not the function.
