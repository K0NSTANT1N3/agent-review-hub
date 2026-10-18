# @quorum/node

The Quorum agent Node: it runs one person's coding agent (Claude Code or opencode) for a Quorum team, without the desktop app. Use it on a VPS or any headless machine.

```bash
npm install -g @quorum/node
quorum-node join 'quorum1....' --data-dir ~/.quorum
quorum-node start --config quorum.node.json
```

`join` turns a join code from the host (desktop app "Invite" or `quorum-leader invite`) into `quorum.node.json` (mode 0600, it holds the agent token) and prints the start command.

Requires Node.js 22 or later, git, and a logged-in agent CLI. See [docs/INSTALL.md](https://github.com/K0NSTANT1N3/agent-review-hub/blob/main/docs/INSTALL.md) ("Run on a VPS").
