# Installing and using Quorum

Quorum is a desktop app for teams whose members each use a coding agent (Claude Code). When you give your
agent a task, its work is **reviewed by a teammate's idle agent** before anything reaches `main`. A small
coordinator — the **Leader** — routes work between agents, keeps every review conversation paired to the right
sessions, and squash-merges approved work.

One teammate **hosts** (their app runs the Leader); everyone else **joins** with a join code.

---

## 1. Before you start (everyone)

1. **Git access to the team repository** from your computer (SSH key or credential helper), e.g.
   `git ls-remote git@github.com:team/project.git` works in a terminal.
2. **Claude Code, logged in.** Install Claude Code and run `claude` once to sign in. Quorum ships its own copy of
   the Claude Code engine and uses the same login. (Using opencode instead? Start `opencode serve` and pick
   “opencode server” in the app.)
3. **The repository has a `quorum.json` on `main`** (optional but recommended) telling Quorum how to test:

   ```json
   { "setupCommand": "npm ci", "testCommand": "npm test", "testTimeoutSec": 900 }
   ```

   Without it, changes are reviewed but not tested. Quorum always reads this file from `main`, never from a task branch.

## 2. Install the app

Download the installer for your system from the project's **Releases** page:

| System | File | Notes |
|---|---|---|
| Linux | `Quorum-x.y.z-linux-x86_64.AppImage` | `chmod +x` it and run, or install the `.deb` with `sudo apt install ./Quorum-…amd64.deb` |
| macOS | `Quorum-x.y.z-mac-arm64.dmg` | Builds are unsigned. Do the [macOS first-run steps](#macos-first-run) below. |
| Windows | `Quorum-x.y.z-win-x64.exe` | Builds are unsigned: on the SmartScreen prompt choose **More info → Run anyway**. |

### Install the command-line tools

The v0.1.5 installers include `quorum`, `quorum-tui` and Node.js.
You do not need a source checkout or a separate Node.js installation.

1. Install the app in a permanent location. On macOS, copy **Quorum.app** from the DMG to **Applications**.
2. Open Quorum. Host or join a team.
3. Open **Settings**. Click **Install command-line tool**.
4. Read the confirmation. Click **Install**.
5. Open a new terminal. Run:

   ```bash
   quorum --version
   quorum tui --help
   ```

On macOS and Linux, the action makes `quorum` and `quorum-tui` symlinks in `~/.local/bin`.
If this directory is not on PATH, the confirmation names the shell file that the action will update
(`~/.zshrc`, `~/.bashrc`, or a fish configuration file).
On Windows, the action adds the private CLI directory to your user PATH. Open a new terminal from the Start menu.
If an existing terminal app keeps the old PATH, close that app and open it again.

The tools use a private copy in the Quorum data folder. On Linux, they continue to work after an AppImage closes.
After you update Quorum, click **Install command-line tool** again to update the commands.
The action does not replace an unrelated command with the same name. Move that command before you try again.
If your shell does not read the named shell file, add `~/.local/bin` to PATH in your shell configuration.

To remove the commands on macOS or Linux, delete the two symlinks and the `command-line` directory in the Quorum data folder.
Remove the line marked `# Quorum command-line tools` from the shell file if you no longer need it.
On Windows, remove the CLI directory from your user PATH, then delete that directory.

### macOS first run

The app is unsigned, so macOS blocks it the first time. Do these steps one time only.

macOS 14 and earlier:

1. In Finder, right-click the Quorum app.
2. Click **Open**.
3. In the dialog, click **Open** again.

macOS 15 and later (right-click > **Open** does not work on these versions):

1. Open the Quorum app. macOS blocks the app and shows a warning.
2. Close the warning.
3. Open **System Settings > Privacy & Security**.
4. Go to the **Security** section.
5. Click **Open Anyway** next to the message about Quorum.
6. Confirm the request. macOS can ask for your login password.

Building it yourself instead: see [§7](#7-building-from-source).

## 3. Host a team (one person)

1. Open Quorum → **Host a team**.
2. Fill in your name, the **team repository** URL and its main branch.
3. **Leader port** (default 7420) and **the address teammates use to reach you** — see
   [Connecting teammates](#connecting-teammates) below. On the same Wi-Fi/office network just keep the suggested
   local address.
4. Choose your agent settings (see [§5](#5-agent-settings)) → **Start hosting**.
5. **Team → Invite a teammate**: type their name → **Create join code** → send the code privately (it contains
   their secret token). Inviting the same name again replaces their token.

The host's computer must be on (with Quorum running) for the team to work. Its data lives in the app data folder
(shown in **Settings**); the Leader keeps all tasks, reviews and history there.

### Connecting teammates

There is no automatic discovery: **join codes are the only way in**. A join code contains the host's address; a
teammate's app connects to exactly that address. So the host's computer must be reachable at it. In **Host a team**
Quorum lists every address this computer has, labelled by network, and you pick one:

| Option in the list | Who can reach the host | Encrypted | What you need |
|---|---|---|---|
| **Local network** (e.g. `192.168.1.20`) | people on the same Wi-Fi / office | no (stays in your network) | nothing |
| **Tailscale** (e.g. `ana-laptop.tail1234.ts.net`) — recommended for remote teams | everyone on your tailnet, from anywhere | yes (by the VPN) | Tailscale on every computer (free plan) |
| **ZeroTier / WireGuard / other VPN** | everyone on that VPN | yes (by the VPN) | the VPN on every computer |
| **Custom address or tunnel URL** | depends | a `https://` tunnel URL → yes | e.g. `cloudflared tunnel --url http://localhost:7420` |

Wi-Fi/LAN and VPN connections need no extra Quorum setup. Quorum allows plain `ws://` over private network
addresses and VPN addresses (including Tailscale's `100.64.0.0/10` and `*.ts.net` names). A plain public internet
address is also allowed, but is not encrypted; the app warns you to prefer a VPN or a TLS tunnel for public access.
Tunnel URLs beginning with `https://` continue to use encrypted `wss://` connections.

Quorum works with **any** VPN — it doesn't install or control one; it only shows the addresses your computer already
has. If no VPN shows up, connect it and reopen Host a team.

**Only accept connections through this address** (on by default for VPN addresses): the Leader listens on that
address only, so other networks you're on (café, office Wi-Fi) can't reach it at all. If the VPN isn't connected when
Quorum starts, the dashboard says so — connect it and click **Restart**.

#### Setting up Tailscale (free)

1. **Host:** install [Tailscale](https://tailscale.com/download), sign in (Google / Microsoft / GitHub / Apple account).
2. **Host:** in the Tailscale admin page, **share** your computer with each teammate (or invite them to your tailnet).
3. **Teammates:** install Tailscale, sign in, accept the share.
4. **Host:** open Quorum → **Host a team** → pick the Tailscale name (it's pre-selected) → Start hosting → invite
   teammates as usual. The name never changes, so join codes keep working.

If a teammate can't connect, their dashboard explains which network the team uses and what to check.

## 4. Join a team (everyone else)

1. Open Quorum → **Join a team**.
2. Paste the join code, choose your agent settings → **Join team**.
3. The sidebar shows **connected** once the Leader is reachable.

## 5. Agent settings

| Setting | Meaning |
|---|---|
| Coding agent | Claude Code (recommended), an opencode server, or Mock (testing only). Optional model override. |
| Lend my agent | **Only when I'm idle** (default): teammates' work runs only while you're away from keyboard and mouse for the chosen minutes. **Always** / **Never** (your own tasks still run). |
| Daily token budget for teammates | Upper bound on tokens your agent spends on other people's work per day. Your own tasks don't count. |
| Parallel sessions | How many conversations your agent may run at once (each in its own git worktree). |
| Expertise tags | e.g. `frontend, go` — the Leader prefers reviewers whose tags match the task. |

**Pause my agent** (Dashboard) stops it taking any work until you resume.

Reviewers are always **read-only** (they can read the repository but not change it). Authors may edit files and run
only the allow-listed commands (`npm test`, `npm run …`, `ls`, `git status/diff/log`, `npx tsc`); they can never
commit, push or touch files outside the task's worktree — Quorum does the git work.

The allow-list is not a sandbox. Some allow-listed commands run code from the worktree. For example, `npm run`,
`npm test`, `pytest`, `go test` and `cargo test` run scripts and test files that the author agent can edit. Thus an
author can run any code through these commands, with the permissions of your user account.

The allow-list stops casual misuse, but it is not an isolation boundary. Run Quorum on a computer or user account
where this risk is acceptable. For stronger isolation, run Quorum in a container or a virtual machine. Quorum applies
the allow-list to Claude Code. An opencode server uses its own permission settings.

### Choose an agent

The Node `adapter` object selects the agent. Desktop Settings and `quorum-node join --adapter`
support `claude-code`, `codex`, `pi`, `omp`, `kilo`, `opencode` and `mock`.
Use `custom` in `quorum.node.json` for another CLI. Custom adapters need no new Node code.

Adapter config examples (`binaryPath` and `model` are optional):

```json
{ "type": "codex", "binaryPath": "/usr/local/bin/codex", "model": "<model>" }
{ "type": "pi", "binaryPath": "/usr/local/bin/pi", "model": "<model>" }
{ "type": "omp", "binaryPath": "/usr/local/bin/omp" }
{ "type": "kilo", "model": "openrouter/openai/gpt-4.1-mini" }
```

If `binaryPath` is not set, the Node starts `codex`, `pi`, `omp` or `kilo` from `PATH`.
The default `contextWindow` is `200000`.

The Node sends a trust value. You cannot set trust in the config.

| Trust | Meaning |
|---|---|
| `enforced` | Quorum does a check of tool permissions before each tool call. Claude Code and mock have this trust. |
| `sandboxed` | An external sandbox is a limit on the agent. Codex has this trust. Quorum does not apply its tool callback. |
| `low` | Quorum cannot apply a full tool or sandbox limit. pi, omp, opencode, Kilo and custom have this trust. |

If trust is missing, the UI must not show `enforced`.

Quorum does not do a check of the tools for pi and omp. For reviewer and directive turns, the adapter sends a `--tools` list (`read,grep,find,ls` for pi, `read,grep,glob` for omp). That list is not a Quorum tool check.

Codex isolation:

- The Node sets `CODEX_HOME` to `<dataDir>/codex-home`.
- That directory holds a link to the owner `auth.json` (or a copy if a link is not possible).
- The agent does not read the owner `config.toml`, `AGENTS.md`, skills, hooks or rules.
- Each turn also has `--ignore-user-config --ignore-rules`.
- Before you use Codex with Quorum, run `codex login`.

Kilo setup (tested with CLI 7.8.15):

```sh
npm install -g @kilocode/cli
kilo --version
kilo auth login
quorum-node join <join-code> --adapter kilo --model <provider/model>
```

Kilo can use provider API-key environment variables such as `OPENROUTER_API_KEY`.
Set a model explicitly when the provider needs one. Quorum does not import the owner's default model.
Each profile uses a separate home under `<dataDir>/kilo-home/<profile>`.
Quorum copies only API/OAuth login records from the owner's XDG `kilo/auth.json`.
It does not import personal instructions, skills, MCP, plugins, approval settings or native sessions.
Every launch disables project config and external skills. Each launch uses the `quorum` agent.
Reviewer and directive turns allow only `read`, `glob`, `grep` and `list`. All other permissions default to deny.
The same rules apply on resume. Author turns also allow edits and bash.
Kilo applies these native permissions. They are not an OS sandbox or Quorum's full path/command policy.

Custom CLI example (replace `my-agent` and its flags with your CLI's real options):

```json
{
  "type": "custom",
  "profiles": {
    "author": {
      "command": "my-agent",
      "args": ["--json", "--write", "--", "{prompt}"],
      "resume": { "command": "my-agent", "args": ["--json", "--write", "--session", "{sessionId}", "--", "{prompt}"] }
    },
    "reviewer": {
      "command": "my-agent",
      "args": ["--json", "--read-only", "--", "{prompt}"],
      "resume": { "command": "my-agent", "args": ["--json", "--read-only", "--session", "{sessionId}", "--", "{prompt}"] }
    },
    "directive": {
      "command": "my-agent",
      "args": ["--json", "--read-only", "--", "{prompt}"],
      "resume": { "command": "my-agent", "args": ["--json", "--read-only", "--session", "{sessionId}", "--", "{prompt}"] }
    }
  },
  "sessionIdPath": "session.id",
  "eventTypePath": "type",
  "mapping": {
    "text": { "event": "text", "text": "text", "mode": "final", "messageId": "messageId" },
    "tool_call": { "event": "call", "id": "id", "name": "name", "argsSummary": "summary" },
    "tool_result": { "event": "result", "id": "id", "output": "output", "ok": "ok", "exitCode": "exitCode" },
    "usage": { "event": "usage", "inputTokens": "tokens.input", "outputTokens": "tokens.output", "contextTokens": "tokens.context" },
    "turn_end": { "event": "done" }
  }
}
```

Templates contain an executable and argv values. Quorum never uses a shell or splits an argv value.
It substitutes `{prompt}` and `{sessionId}` once inside each argument. A fresh session ID is an empty string.
If `resume` is absent, Quorum uses that profile's base template for resumed turns.
Use separate fresh/resume templates if the CLI rejects an empty session argument.
Set read-only flags in **both** reviewer and directive templates, including their resume templates.
Custom adapters inherit the Node environment. Configure the CLI's own config isolation in its argv or wrapper executable.
Quorum cannot infer arbitrary CLI permission semantics. Custom trust is always `low`.

Paths use dotted own properties, such as `message.content.0.text`. They are not JSONPath expressions.
`eventTypePath` defaults to `type`. Each mapping's `event` matches that field exactly.
Text supports `final` snapshots (default) or `delta` chunks. Usage records add input/output counters;
the latest context counter replaces the previous estimate. Emit each usage record once.
Tool mappings and usage are optional. A successful turn needs text, a nonempty session ID,
a matching `turn_end` record and a zero process exit code. Turn end controls completion; it is not a transcript event.
Custom CLIs must write one JSON object per line. Malformed lines remain bounded failure diagnostics.

The Node finds agent binaries on `PATH` and at a `binaryPath` in the config.
It does `--version` on each binary. It does not start a model turn.
Hello and heartbeat can include `detectedAgents` records `{ type, version, trust }`.
Binary paths stay on the Node.

## 6. Everyday use

1. **New task** → describe the goal and how to verify it → **Create task**. Choose *My agent* (default) or *Any
   available agent*.
   For important work, select **Require my approval before merge** (it is on by default for *Urgent*). After the
   reviewer agent approves, the task stops at *Needs attention* with the note "This task needs your approval before it
   merges". Check the diff, then click **Approve & merge** or **Send back**.
2. Watch it on **Tasks**: *Authoring* → *In review* → *Merging* → *Merged*. Review feedback goes back to your agent
   automatically and the same reviewer re-checks only what changed.
3. **Needs decision** means a human must act — open the task:
   * the author agent asked a question → type the answer → **Answer and continue**;
   * reviewers and author disagree, or the review limit was hit → **Approve & merge** or **Send back** with instructions;
   * other actions: **Reassign reviewer**, **Pause/Resume**, **Cancel task**.
4. **Diff** tab shows the whole change or just what changed in each review round. **Timeline** shows every step.
5. **Ask an agent** sends a read-only question to any teammate's agent (e.g. "where is retry logic implemented?").

You get desktop notifications when your task is merged, needs a decision, or your agent hits a usage limit.

### Let a coding agent use Quorum (the `quorum` CLI)

The `quorum` CLI lets a coding agent or a script use Quorum as you.
The CLI can create tasks, wait for tasks, read diffs, answer a blocked author agent and ask agents.
A CLI (requester) token cannot approve, send back, pause, cancel or merge a task.
You can do these actions in the app, or in the terminal UI with an owner token (see [Use the terminal UI](#use-the-terminal-ui)).

First, install the command-line tools (see §2). Then connect the CLI:

1. Open **Settings → Agent CLI access**.
2. Keep the token type **CLI (requester)**.
3. Type a label, for example `Claude Code on my laptop`.
4. Click **Create CLI token**.
5. Copy the `quorum login` command. The app shows the token one time only.
6. Run the command in a terminal on the same computer.

```bash
quorum login --url http://127.0.0.1:7420 --token qrq_…
quorum agents
quorum task create --title "Rate-limit failed logins" --description-file task.md --wait --json
quorum task answer 12 "Use Redis for the counters."
quorum task wait 12 --json
quorum task diff 12
quorum ask bob-agent "Where is the retry logic for payments?"
```

Agents use `--json` and the exit code:

| Exit code | Meaning | What the agent does |
|---|---|---|
| 0 | The task merged, or the agent answered. | Continue. |
| 3 | A person must act. If `question` is in the output, the author agent asked a question. | Get the answer from the user. Then run `quorum task answer`. |
| 4 | The task failed or was cancelled. | Read `lastTestOutput` and tell the user. |
| 5 | The wait stopped at `--timeout`. | Run `quorum task wait <id>` again. |
| 6 | The token is missing, not valid, or does not have permission. | Tell the user. |
| 1, 2 | Error or incorrect command. | Read the message on stderr. |

To stop a token, click **Revoke** in **Settings → Agent CLI access**. When the host invites you again, Quorum also revokes your CLI tokens.
On a headless Leader, the host can make a token with `quorum-leader add-token --config quorum.leader.json --id <agent id>`.

### Use the terminal UI

`quorum-tui` is a terminal program for one Leader.
The program shows the agents, the tasks and the transcript of the selected task.

To start the terminal UI:

1. Install the command-line tools (see §2).
2. Save an owner token for the terminal UI (see [Make an owner token](#make-an-owner-token)).
   A requester login from `quorum login` also starts the UI, but it cannot approve, send back, pause or cancel.
3. Run the program in an interactive terminal:

   ```bash
   quorum tui
   ```

Use `quorum tui --url https://leader.example.com --token '<token>'` to override the saved login.
Do not use `--token` with an owner token, because the shell history keeps the command.
`quorum-tui` remains available as a separate command.
Run `quorum tui --help` to see the options without starting the UI.

The program accepts these flags:

* `--url` — Leader URL (`http://` or `https://`)
* `--token` — API token
* `--help` (`-h`) — help text
* `quorum --version` — CLI version; `quorum-tui --version` — standalone TUI version

The program reads the connection data in this order:

1. The `--url` and `--token` flags.
2. The `QUORUM_URL` and `QUORUM_TOKEN` environment variables.
3. The TUI login file (`tui.json`).
4. The `quorum` CLI login file (`cli.json`).

The program reads the URL and the token separately in this order.

The TUI login file path is `QUORUM_TUI_CONFIG`, then `$XDG_CONFIG_HOME/quorum/tui.json`, then `~/.config/quorum/tui.json`.
The app writes owner tokens to this file. The `quorum` CLI does not read this file.

The CLI login file path is `QUORUM_CONFIG`, then `$XDG_CONFIG_HOME/quorum/cli.json`, then `~/.config/quorum/cli.json`.
`quorum login` writes this file.

The two files have the same format: `{ "url": "https://leader.example.com", "token": "…" }`.

CAUTION: If the group or other users can read a login file, the TUI tells you.
Set the file mode to `0600`:

```bash
chmod 600 ~/.config/quorum/tui.json ~/.config/quorum/cli.json
```

A requester token can read data, create tasks, answer a blocked author and ask an agent.
An owner token can also approve, send back, pause and cancel the tasks of its owner. Attach (`t`, then `y`) also needs this permission.
An admin owner token can do these actions on all tasks.

#### Make an owner token

All team members can make an owner token in the app. You do not need the host.

1. Open **Settings → Agent CLI access**.
2. Select the token type **Terminal UI (owner)**.
3. Read the warning.
4. Type a label, for example `quorum tui on my laptop`.
5. Click **Create terminal UI token**.
6. Click **Save for quorum tui**.
   The app writes the Leader URL and the token to the TUI login file (`tui.json`) with mode `0600`.
   The app does not change the `quorum` CLI login file (`cli.json`).
7. Run `quorum tui`.

WARNING: An owner token can approve, send back, pause and cancel your tasks.
An approved task goes to the merge queue.
If you are a team admin, the token can do these actions on all tasks.
Keep the token secret, as you keep a password.

CAUTION: Do not put an owner token in `cli.json` or on a command line.
Coding agents use the `quorum` CLI, and the CLI reads `cli.json`.
The shell history keeps each command line.
If you do not save the token, click **Copy token only**.
Then set the `QUORUM_TOKEN` environment variable without a command line, for example with `read -rs QUORUM_TOKEN; export QUORUM_TOKEN`.

To stop an owner token, click **Revoke** in **Settings → Agent CLI access**.
The **Type** column shows the scope of each token.

On a headless Leader, the host can also make an owner token:

```bash
quorum-leader add-token --config quorum.leader.json --id <agent id> --scope owner
```

#### Attach and keyboard

To attach a local agent's native TUI, pass the local Node config as well:

```sh
node packages/tui/dist/cli.js --url https://leader.example.com --token '<owner API token>' --node-config /path/to/quorum.node.json
```

`QUORUM_NODE_CONFIG` is the environment alternative. The Node config holds the
Node's own token; keep it private (0600 on Unix). Start the Node on this machine.
`t` selects the task's author/participant, or the selected agent's task session
when the Agents pane is focused. Confirm with `y`; `n` or Esc cancels. Quorum pauses
the task, drains local work, leaves Ink's alternate screen, and runs the native
resume command with inherited terminal input/output. Exit that agent to return.
Quorum restores the screen, checks git, resumes the task and reloads the transcript.

Attach supports Claude Code, Codex, pi and omp. Codex uses the Node driver's
`<dataDir>/codex-home`. Attach opens the task's author session only. Reviewer and
directive sessions stay read-only and cannot attach. Remote sessions, mock and OpenCode
cannot attach. Native
session IDs stay on this machine; the Leader/team never receive them. Manual git
commits/branch switches trigger restoration and a blocked-session warning; possible
pushes block future turns without rewriting the remote. Inspect and retire a
blocked session before continuing. Details: [TUI README](../packages/tui/README.md).


`quorum-tui` must have a TTY on stdin and on stdout.

Keyboard:

| Key | Action |
|---|---|
| Tab / Shift+Tab | Change pane: Agents, Tasks, Chat, Input |
| ↑ / ↓ | Select a task, or an agent in the Agents pane |
| Enter | Open the chat, ask the selected agent, or send the input |
| `i` | Move to the message input |
| Esc | Leave input, close help, or dismiss an error |
| `m` | Change mode: answer author, send back, ask an agent |
| `a` | Approve the task |
| `s` | Start a send-back comment |
| `p` | Pause or resume the task |
| `t` | Attach local native agent session (then `y` or `n`; needs `--node-config`) |
| `c` | Cancel the task (then `y` or `n`) |
| `n` | Create a task (title, then description, own mode, priority 1 / normal) |
| `/` | Filter tasks |
| PgUp / PgDn | Scroll the chat. PgUp stops follow. PgDn can return to follow. |
| `?` | Show or hide help |
| `q` | Quit (not in input) |
| Ctrl+C | Quit |

If the terminal width is less than 110 columns, the TUI shows one pane at full width.
If the height is less than 28 rows, the layout is the same.
An 80×24 terminal is in this mode. Push the Tab key to select the next pane.

Set `NO_COLOR` to stop colors.
The header shows the Leader hostname as the team name.

## 7. Building from source

Requirements: Node.js 22+, Git, Python 3 and a C/C++ toolchain (for the native SQLite module).

```bash
git clone https://github.com/K0NSTANT1N3/agent-review-hub.git
cd agent-review-hub
corepack pnpm install
corepack pnpm -r build
corepack pnpm --filter @quorum/desktop dev     # run the app from source
corepack pnpm --filter @quorum/desktop dist    # build installers for this OS into packages/desktop/release
```

Maintainers: pushing a tag `vX.Y.Z` runs the **Release** workflow, which builds Linux, macOS and Windows installers
and attaches them to a GitHub Release.

### Headless mode (servers, CI, no GUI)

The Leader and Node also run as command-line programs:

```bash
node packages/leader/dist/cli.js start --config quorum.leader.json
node packages/leader/dist/cli.js invite --config quorum.leader.json --name Ana --public-host 192.168.1.20   # prints a join code
node packages/node/dist/cli.js join 'quorum1....' --config quorum.node.json                                  # writes the Node config
node packages/node/dist/cli.js start --config quorum.node.json
```

Config formats: [`docs/implementation-spec.md`](implementation-spec.md) §6. For a server setup with npm packages, TLS
and systemd, see [§10](#10-run-on-a-vps).

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "Connecting to the Leader…" forever | The host's app is closed, the address/port is wrong, a firewall blocks it, or a quick tunnel URL changed. From your machine: `curl http://HOST:7420/api/health` (or `curl https://TUNNEL/api/health`) must print `{"ok":true}`. |
| Agent stopped with a git error | Your computer can't clone/push the team repository — check `git ls-remote <repo>`. |
| Agent turns fail immediately | Claude Code isn't logged in: run `claude` once in a terminal and sign in. |
| "Rate-limited until …" | Your Claude usage limit was reached; the Leader routes work elsewhere and resumes your tasks after the reset. |
| Task stuck "Waiting for reviewer" | Nobody can review: teammates offline, lending set to *never*/*when idle* while they're active, or budgets used up. You can **Approve & merge** manually. |
| Merge conflicts | Handled automatically: the author's agent merges the latest `main`, the reviewer checks the conflict resolution, then it merges. |

Running two instances on one computer (e.g. to try hosting and joining): start the second with a separate data
folder: `QUORUM_USER_DATA=/tmp/quorum-2 ./Quorum.AppImage`.

## 9. Security notes

* Join codes and agent tokens are secrets; tokens are stored encrypted with the OS keychain where available and only
  their SHA-256 is kept by the Leader. Revoke a teammate by re-inviting them (rotates the token) or with
  `quorum-leader revoke-agent`.
* Agent-to-agent text is treated as untrusted data; tool permissions are enforced in code, not just in prompts.
* The author Bash allow-list is not a sandbox: test and script commands run code that the author agent can edit.
  See [§5](#5-agent-settings).
* The Leader itself speaks plain HTTP/WebSocket. That is fine on a LAN or VPN; for teammates on the internet use an
  HTTPS tunnel (cloudflared/ngrok), a TLS reverse proxy, or `tls.certFile`/`tls.keyFile` in headless mode, so
  connections use `wss://`. Avoid raw port forwarding.

## 10. Run on a VPS

You can run Quorum on a server (VPS) that has no desktop. The Leader, the agent Node and the `quorum` CLI are
command-line programs. You can put one, two or all three on a VPS.

Some examples:

* The host runs the Leader on a VPS. The team members use the desktop app on their computers.
* A team member runs an agent Node on a VPS. The agent can then work and do reviews when the computer of that person is off.
* A coding agent on a VPS uses the `quorum` CLI to give tasks to the team.

### 10.1 Install the programs

Requirements on the VPS:

* Linux with Node.js version 22 or more. Use `node --version` to see the version.
* Git, with access to the team repository. Use `git ls-remote <repository URL>` to make sure that access is correct.
* For an agent Node: a Claude API key (see [10.4](#104-log-in-to-claude-code-without-a-browser)), or an opencode server.

Make the npm package files from the repository, then install them with npm:

```bash
git clone https://github.com/K0NSTANT1N3/agent-review-hub.git && cd agent-review-hub
corepack pnpm install --filter '@quorum/leader...' --filter '@quorum/node...' --filter '@quorum/cli...'
for p in protocol leader node tui cli; do (cd packages/$p && corepack pnpm pack --pack-destination ../../dist-npm); done
npm install -g --allow-scripts=better-sqlite3 ./dist-npm/*.tgz
```

The `--filter` options install only the server packages. They do not download the desktop app (Electron).
`pnpm pack` builds each package before it makes the package file.

[npm 12 blocks dependency install scripts by default](https://docs.npmjs.com/cli/v12/commands/npm-install/).
`--allow-scripts=better-sqlite3` permits the SQLite native module to install. With an older npm version that does not support this option, omit it.

This installs three programs: `quorum-leader` (the Leader), `quorum-node` (the agent Node) and `quorum` (the CLI for coding agents and scripts).
Each program shows its commands with `--help`. The CLI also includes `quorum tui` and the separate `quorum-tui` command. Install all five package files together, because the other packages use `@quorum/protocol`.

CAUTION: Do not install `@quorum/...` packages from the npm registry. The maintainers did not publish Quorum to npm. The `@quorum` scope on npm belongs to a different organization.

The `@quorum/node` package contains its own copy of the Claude Code engine. You do not install Claude Code.

If npm cannot install `better-sqlite3`, install Python 3 and a C/C++ compiler (on Debian or Ubuntu: `sudo apt install python3 build-essential`). Then do the installation again.

We recommend that you make a user account for Quorum. Do not run Quorum as `root`:

```bash
sudo useradd --system --user-group --create-home --home-dir /var/lib/quorum --shell /usr/sbin/nologin quorum
sudo install -d -o root -g quorum -m 0750 /etc/quorum
sudo install -d -o quorum -g quorum -m 0700 /var/lib/quorum
```

### 10.2 Run the Leader on a VPS

1. Write the Leader configuration file `/etc/quorum/quorum.leader.json`:

   ```json
   {
     "listen": { "host": "0.0.0.0", "port": 7420 },
     "dbPath": "/var/lib/quorum/leader/leader.db",
     "repo": {
       "remoteUrl": "git@github.com:team/project.git",
       "mainBranch": "main",
       "clonePath": "/var/lib/quorum/leader/repo"
     },
     "admins": ["Ana"]
   }
   ```

   The Leader pushes the merged work to `main`. Thus the `quorum` user must have write access to the repository (for example, an SSH deploy key with write access).
   The owners in `admins` can do the human actions (for example, approve or cancel) on the tasks of all team members. All the fields are in [`docs/implementation-spec.md`](implementation-spec.md) §6.1.

   Give the service account permission to read the configuration:

   ```bash
   sudo chown root:quorum /etc/quorum/quorum.leader.json
   sudo chmod 640 /etc/quorum/quorum.leader.json
   ```

2. Select how the team members connect to the Leader. Use one of these three procedures:

   * **TLS certificate on the Leader.** Get a certificate for a domain name that points to the VPS (for example, with `certbot certonly --standalone -d quorum.example.com`). Add the two files to the configuration:

     ```json
     "tls": { "certFile": "/etc/quorum/tls/fullchain.pem", "keyFile": "/etc/quorum/tls/privkey.pem" }
     ```

     The `quorum` user must have permission to read the two files. The Leader reads the files when it starts. After you renew the certificate, restart the Leader.
   * **HTTPS tunnel.** Set `"host": "127.0.0.1"` in `listen`. Then run a tunnel on the VPS, for example `cloudflared tunnel --url http://localhost:7420`. A quick tunnel gets a new URL each time that it starts. For a permanent address, use a named tunnel.
   * **VPN.** Use a VPN such as Tailscale, set `listen.host` to the VPN address of the VPS, and give that address to the team. Do not use `ws://` on a public network without a VPN. `ws://` does not encrypt the tokens or the code.

3. Configure the firewall. Keep SSH access open, then select the rule for your connection method before you enable the firewall:

   ```bash
   sudo ufw allow OpenSSH
   ```

   * **TLS certificate on the Leader:** `sudo ufw allow 7420/tcp`.
   * **HTTPS tunnel:** no inbound rule for port 7420 is needed; the Leader listens on `127.0.0.1`.
   * **VPN:** allow the Leader port only on the VPN interface. For example, `sudo ufw allow in on wg0 to any port 7420 proto tcp`. Replace `wg0` with your VPN interface name.

   Then run `sudo ufw enable`.

4. Start the Leader one time to make sure that the configuration is correct:

   ```bash
   sudo -u quorum quorum-leader start --config /etc/quorum/quorum.leader.json
   ```

   From a different computer, check the address for your connection method. The response must be `{"ok":true}`:

   | Connection | Health check |
   |---|---|
   | TLS certificate | `curl https://quorum.example.com:7420/api/health` |
   | HTTPS tunnel | `curl https://your-tunnel.example.com/api/health` |
   | VPN (replace the example with the VPS VPN address) | `curl http://10.8.0.1:7420/api/health` |

   Then stop the Leader (Ctrl+C) and install the systemd service (see [10.5](#105-systemd-services)).

5. Make a join code for each team member:

   ```bash
   sudo -u quorum quorum-leader invite --config /etc/quorum/quorum.leader.json --name "Bo" --public-host quorum.example.com
   ```

   The command writes the join code on stdout. Send the join code to the team member privately, because it contains a secret token.
   For `--public-host`, use the domain name of the TLS-enabled VPS, the full `https://` URL of the tunnel, or the VPN address. With a TLS certificate or a tunnel, the join code uses `wss://` (encrypted).
   The team member pastes the join code in the desktop app (**Join a team**), or uses `quorum-node join` on a server.

   The host must also have an agent. Make a join code for the host and use it in the desktop app or on a VPS.

   If the Leader has an agent with this name, `invite` stops. To give the agent a new token, add `--rotate`. Then the agent cannot use its last token and its CLI tokens.

### 10.3 Run an agent Node on a VPS

1. Get a join code from the host (desktop app **Team > Invite a teammate**, or `quorum-leader invite`).

2. On the VPS, change the join code into a Node configuration file:

   ```bash
   sudo -u quorum quorum-node join 'quorum1.eyJ2Ijox...' --config /var/lib/quorum/quorum.node.json --data-dir /var/lib/quorum
   ```

   The command writes `quorum.node.json` with file mode 0600, because the file contains the agent token. Then the command shows the start command.
   The configuration is in the service account's writable data directory. The Node keeps its data and git worktrees in the `--data-dir` directory.

   On a server, the agent always does work for the team (`lendMode` is `always`). Other options:

   * `--adapter opencode --opencode-url http://127.0.0.1:4096 --provider anthropic --model <model id>` to use an opencode server.
   * `--model <name>` to select the Claude model.
   * `--lend-mode never` to use the agent only for your own tasks.
   * `--max-sessions <n>` and `--tags go,sql` (see [§5](#5-agent-settings)).

   Run `quorum-node join --help` to see all the options.

3. Log in to Claude Code (see [10.4](#104-log-in-to-claude-code-without-a-browser)).

4. Start the Node one time to make sure that the configuration is correct. Use the command that `quorum-node join` showed:

   ```bash
   sudo -u quorum env ANTHROPIC_API_KEY=sk-ant-... quorum-node start --config /var/lib/quorum/quorum.node.json
   ```

   The Leader shows the agent as `available` (for example, with `quorum agents`). Then stop the Node (Ctrl+C) and install the systemd service (see [10.5](#105-systemd-services)).

If the Leader URL uses `ws://` and the Leader is not on the same VPS, the start command contains `--insecure`. Use `--insecure` only on a LAN or a VPN.

The author agent can run test commands, and these commands run code from the repository. Thus run the Node on a VPS that does not keep other secrets (see [§5](#5-agent-settings)).

### 10.4 Log in to Claude Code without a browser

The agent Node uses the Claude Agent SDK. The SDK reads the `ANTHROPIC_API_KEY` environment variable.

1. Make an API key in the Claude Console: <https://platform.claude.com/settings/keys>.
2. Give the API key to the Node in the `ANTHROPIC_API_KEY` environment variable. With systemd, put the key in an environment file (see [10.5](#105-systemd-services)).

Your Claude Console account pays for each request that uses the API key.

Claude Code also has `claude setup-token`. This command makes a one-year token for a Claude subscription (the `CLAUDE_CODE_OAUTH_TOKEN` environment variable).
The Agent SDK documentation tells you this rule: a product built on the SDK must not use claude.ai login without approval from Anthropic. Thus we do not recommend `CLAUDE_CODE_OAUTH_TOKEN` for Quorum. We did not do a test of this procedure.

Sources: [Claude Code authentication](https://code.claude.com/docs/en/authentication) and [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

### 10.5 systemd services

These services start Quorum when the VPS starts, and restart it after a failure. Use `command -v quorum-leader` and `command -v quorum-node` to find the paths for `ExecStart`.
Install Node.js and the programs in locations that the `quorum` account can execute. The service's `PATH` must include the directory that contains `node`.

`/etc/systemd/system/quorum-leader.service`:

```ini
[Unit]
Description=Quorum Leader
After=network-online.target
Wants=network-online.target

[Service]
User=quorum
WorkingDirectory=/var/lib/quorum
ExecStart=/usr/local/bin/quorum-leader start --config /etc/quorum/quorum.leader.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/quorum-node.service`:

```ini
[Unit]
Description=Quorum agent Node
After=network-online.target quorum-leader.service
Wants=network-online.target

[Service]
User=quorum
WorkingDirectory=/var/lib/quorum
EnvironmentFile=/etc/quorum/node.env
ExecStart=/usr/local/bin/quorum-node start --config /var/lib/quorum/quorum.node.json
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/etc/quorum/node.env` contains the API key. Give permission to read the file only to root:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' | sudo tee /etc/quorum/node.env >/dev/null
sudo chmod 600 /etc/quorum/node.env
```

Reload systemd, then enable each service that runs on this VPS:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now quorum-leader   # on the VPS that hosts the Leader
sudo systemctl enable --now quorum-node     # on a VPS that runs an agent Node
journalctl -u quorum-node -f                # see the Node log
```

If the Leader is on a different VPS, remove `quorum-leader.service` from the `After=` line of the Node service. If the start command from `quorum-node join` contains `--insecure`, add `--insecure` to `ExecStart`.

### 10.6 Use the `quorum` CLI from a VPS

A coding agent on a VPS can use the `quorum` CLI. The agent can give tasks to the team and read the results.

1. Get a CLI token. The host can make one on the Leader VPS:

   ```bash
   sudo -u quorum quorum-leader add-token --config /etc/quorum/quorum.leader.json --id bo-agent --label "Claude Code on VPS"
   ```

   A team member can also make a token in the desktop app (**Settings > Agent CLI access**).
2. Give the Leader URL and the token to the CLI with environment variables:

   ```bash
   export QUORUM_URL=https://quorum.example.com:7420
   export QUORUM_TOKEN=qrq_...
   quorum agents
   quorum task create --title "Rate-limit failed logins" --description-file task.md --wait --json
   ```

`QUORUM_URL` accepts the `https://` address of the Leader or the `wss://` URL from the join code. The CLI uses the agent of the token as the requester.
The exit codes are in [§6](#let-a-coding-agent-use-quorum-the-quorum-cli).
