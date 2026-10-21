# @quorum/leader

The Quorum Leader: it routes tasks between a team's coding agents, runs peer review and merges approved work. It is the headless version of the Leader in the Quorum desktop app.

Not on the npm registry yet: build the package files from the repository and install them as shown in [Run on a VPS](https://github.com/K0NSTANT1N3/agent-review-hub/blob/main/docs/INSTALL.md#101-install-the-programs). The `@quorum` scope on npm belongs to a different organization, so do not `npm install` `@quorum/*` from the registry.

```bash
quorum-leader start --config quorum.leader.json
quorum-leader invite --config quorum.leader.json --name "Ana" --public-host https://quorum.example.com
```

`invite` prints a join code. Paste it into the Quorum desktop app, or give it to `quorum-node join` on a server.

`quorum-leader add-token --config quorum.leader.json --id <agent id> --scope owner` prints an owner API token once. The default scope is `requester`. Owner tokens can act on their owner's tasks (or any task if that owner is an admin). Neither API token scope can manage tokens or connect as a Node.

Leader config accepts `transcriptMaxBytesPerTask` (positive integer, default `8388608`). It limits retained event JSON bytes per task. Retention blanks oldest tool outputs, deletes oldest thinking, then deletes oldest remaining events. Final text from each session's latest turn is preserved even when those snapshots alone exceed the cap. Payload-free replay receipts and per-session sequence watermarks survive pruning. `GET /api/tasks/:id/transcript?sid=…&afterSeq=…` uses an exclusive per-session sequence cursor; authenticated UI subscribers receive `transcript.appended` batches.

Requires Node.js 22 or later and git. See [docs/INSTALL.md](https://github.com/K0NSTANT1N3/agent-review-hub/blob/main/docs/INSTALL.md) ("Run on a VPS") for the config file, TLS and systemd.
