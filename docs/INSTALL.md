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
| macOS | `Quorum-x.y.z-mac-arm64.dmg` | Builds are unsigned: the first time, right-click the app → **Open** → **Open**. |
| Windows | `Quorum-x.y.z-win-x64.exe` | Builds are unsigned: on the SmartScreen prompt choose **More info → Run anyway**. |

Building it yourself instead: see [§7](#7-building-from-source).

## 3. Host a team (one person)

1. Open Quorum → **Host a team**.
2. Fill in your name, the **team repository** URL and its main branch.
3. **Leader port** (default 7420) and **the address teammates use to reach you**:
   * same office / Wi-Fi: your LAN IP (the app suggests it);
   * remote teams: a VPN such as **Tailscale** (use your Tailscale IP/name), or forward the port on your router;
   * allow the port through your firewall (`sudo ufw allow 7420/tcp`, macOS/Windows firewall prompt → Allow).
4. Choose your agent settings (see [§5](#5-agent-settings)) → **Start hosting**.
5. **Team → Invite a teammate**: type their name → **Create join code** → send the code privately (it contains
   their secret token). Inviting the same name again replaces their token.

The host's computer must be on (with Quorum running) for the team to work. Its data lives in the app data folder
(shown in **Settings**); the Leader keeps all tasks, reviews and history there.

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
| "Connecting to the Leader…" forever | The host's app is closed, the address/port is wrong, or a firewall blocks it. From your machine: `curl http://HOST:7420/api/health` must print `{"ok":true}`. |
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
* The Leader listens on plain HTTP/WebSocket. Expose it only on a trusted network or VPN, or put it behind a TLS
  reverse proxy (or set `tls.certFile`/`tls.keyFile` in headless mode) and use `wss://`.
