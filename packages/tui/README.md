# quorum-tui

Full-screen Ink client for one Quorum Leader. Node 22 or later required.

Install the desktop app. Open **Settings > Install command-line tool** and confirm.
Open a new terminal:

```sh
quorum login --url https://leader.example.com --token '<token>'
quorum tui
quorum-tui --help
```

The desktop installers include Node.js. For local npm package files, Node 22 or later is required.
The npm packages are prepared but not published. Do not install the unrelated registry packages under `@quorum`.

Flags override `QUORUM_URL` / `QUORUM_TOKEN`, then the existing `quorum` CLI login.
Config path: `QUORUM_CONFIG`, else `$XDG_CONFIG_HOME/quorum/cli.json`, else
`~/.config/quorum/cli.json`. JSON format: `{ "url": "https://leader.example.com", "token": "…" }`.
The UI warns when the file is group/world readable. Set `NO_COLOR` to disable colors.
`quorum-tui` needs an interactive terminal (stdin and stdout must be TTYs).
The Leader hostname labels the team because the REST API has no team-name field.

Tab cycles Agents, Tasks, Chat, Input. At 80×24, the focused pane uses the full width.
Use ↑/↓ to select tasks or an agent. Enter opens a task, asks the selected agent,
or sends the input. `m` cycles answer author, send back, and ask an agent.
`i` focuses the message input. Esc leaves input or dismisses an error.

`a` approves, `s` starts a send-back comment, `p` pauses/resumes, `c` asks for y/n
before cancellation. Approve/send back/pause/cancel require an owner token.
All team members can make one in the desktop app: open **Settings → Agent CLI access**,
select **Terminal UI (owner)**, click **Create terminal UI token**, then click
**Save for quorum tui**. The app writes the token to the CLI config file with mode 0600.
The `quorum` CLI reads the same file, so scripts on this computer also get owner permissions.
On a headless Leader, the host can use `quorum-leader add-token --scope owner`.
`t` confirms y/n, pauses the task, waits for local pause cleanup and all in-flight work,
then hands the terminal to that session's native agent TUI. Exit the agent to return;
Quorum checks git, resumes the task, and reloads its transcript. Attach always
selects the task's author session. Reviewer and directive sessions stay read-only and
cannot be attached. The agent starts without Quorum's own credentials (`QUORUM_*`
variables are removed from its environment). The confirmation does not send anything until `y`.

Start with `--node-config /path/to/quorum.node.json` or `QUORUM_NODE_CONFIG` for attach.
This is the **local Node config containing its own Node token**, separate from the
Leader API token. On Unix it must have mode 0600. The Node must be running on this
machine; copying a remote Node config does not enable remote attach. The client
connects only to `~/.quorum/control/<sha256(absoluteDataDir)[0:24]>.sock` (Windows: a local named pipe), never
to a TCP control port. Native IDs and resume details never go to the Leader/team.
The task still requires an owner token for pause/resume.

Supported: `claude --resume ID`, `codex resume ID` (with the driver's
`<dataDir>/codex-home`), `pi --session-id ID`, `omp --resume ID`. Configured binaryPath
is honored for Codex/pi/omp. Mock and OpenCode have no attach support. Missing
binaries, remote sessions and refused pauses have inline errors. A session without
a native ID must complete its first turn before attaching.

Interactive tool policies belong to the native CLI. On return, Quorum runs the
runner's git guard even for Claude: manual commits/branch switches restore the
original HEAD/branch and warn; any guard failure blocks future turns with GIT_ERROR.
Remote-ref changes (possible pushes) also block the session and are **not** undone.
Stop the Node, inspect the repository and remote, then retire the affected session
before resuming work with a new session. A dropped attach connection or Node restart
during attach also leaves the session blocked. See `docs/implementation-spec.md`
for limitations, including conservative remote-ref checks and transcript replay.

`n` asks for a title and description, creating a normal-priority task in own mode.
`/` filters tasks. PgUp stops following; PgDn returns to following at the bottom.
`?` shows help; `q` quits outside input; Ctrl+C always quits.

The client reads messages, task events and session transcripts, then applies live
UI WebSocket events. Reconnecting reloads REST state to recover missed events.
Transcript replay is deduplicated by session/sequence; final chunks replace deltas.
Older Leaders without the transcript route show messages only. Chat times use UTC.
Tool output stays collapsed to one line. Usage counters are reported as supplied;
input-token counts are never substituted for context size.

Tests use fake clients/sockets and fixture transcripts; no agent CLI is launched.
