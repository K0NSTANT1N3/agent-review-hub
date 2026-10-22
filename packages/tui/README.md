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
before cancellation. Approve/send back/pause/cancel require an owner token:
`quorum-leader add-token --scope owner`. Settings → Agent CLI access creates requester tokens.
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
