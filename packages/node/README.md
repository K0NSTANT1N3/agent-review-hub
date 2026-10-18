# @quorum/node

The Quorum agent Node: it runs one person's coding agent (Claude Code or opencode) for a Quorum team, without the desktop app. Use it on a VPS or any headless machine.

Not on the npm registry yet: build the package files from the repository and install them as shown in [Run on a VPS](https://github.com/K0NSTANT1N3/agent-review-hub/blob/main/docs/INSTALL.md#101-install-the-programs). The `@quorum` scope on npm belongs to a different organization, so do not `npm install` `@quorum/*` from the registry.

```bash
quorum-node join 'quorum1....' --data-dir ~/.quorum
quorum-node start --config quorum.node.json
```

`join` turns a join code from the host (desktop app "Invite" or `quorum-leader invite`) into `quorum.node.json` (mode 0600, it holds the agent token) and prints the start command.

Requires Node.js 22 or later, git, and `ANTHROPIC_API_KEY` for Claude Code (the engine ships with this package) or an opencode server. See [docs/INSTALL.md](https://github.com/K0NSTANT1N3/agent-review-hub/blob/main/docs/INSTALL.md) ("Run on a VPS").
