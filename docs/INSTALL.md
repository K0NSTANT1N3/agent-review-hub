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
| **Tailscale** (e.g. `ana-laptop.tail1234.ts.net`) — recommended for remote teams | everyone on your tailnet, from anywhere | yes | Tailscale on every computer (free plan) |
| **ZeroTier / WireGuard / other VPN** | everyone on that VPN | yes (by the VPN) | the VPN on every computer |
| **Custom address or tunnel URL** | depends | a `https://` tunnel URL → yes | e.g. `cloudflared tunnel --url http://localhost:7420` |

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
only the allow-listed commands (`npm test`, `npm run …`, `ls`, `cat`, `git status/diff/log`, `npx tsc`); they can never
commit, push or touch files outside the task's worktree — Quorum does the git work.

The allow-list is not a sandbox. Some allow-listed commands run code from the worktree. For example, `npm run`,
`npm test`, `pytest`, `go test` and `cargo test` run scripts and test files that the author agent can edit. Thus an
author can run any code through these commands, with the permissions of your user account.

The allow-list stops casual misuse, but it is not an isolation boundary. Run Quorum on a computer or user account
where this risk is acceptable. For stronger isolation, run Quorum in a container or a virtual machine. Quorum applies
the allow-list to Claude Code. An opencode server uses its own permission settings.

## 6. Everyday use

1. **New task** → describe the goal and how to verify it → **Create task**. Choose *My agent* (default) or *Any
   available agent*.
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
A CLI token cannot approve, send back, cancel or merge a task. Only you can do these actions in the app.

To connect the CLI:

1. Open **Settings → Agent CLI access**.
2. Type a label, for example `Claude Code on my laptop`.
3. Click **Create CLI token**.
4. Copy the `quorum login` command. The app shows the token one time only.
5. Run the command in a terminal on the same computer.

```bash
quorum login --url http://127.0.0.1:7420 --token qrq_…
quorum agents
quorum task create --title "Rate-limit failed logins" --description-file task.md --wait --json
quorum task answer 12 "Use Redis for the counters."
quorum task wait 12 --json
quorum task diff 12
quorum ask bob-agent "Where is the retry logic for payments?"
```

The installers do not include the CLI in v0.1. To use the CLI, build it from source (see §7). Then make an alias:

```bash
alias quorum="node /path/to/agent-review-hub/packages/cli/dist/cli.js"
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
node packages/leader/dist/cli.js add-agent --config quorum.leader.json --id ana-agent --owner ana   # prints a token
node packages/leader/dist/cli.js start --config quorum.leader.json
node packages/node/dist/cli.js start --config quorum.node.json --assume-idle
```

Config formats: [`docs/implementation-spec.md`](implementation-spec.md) §6.

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
