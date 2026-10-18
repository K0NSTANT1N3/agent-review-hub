# @quorum/leader

The Quorum Leader: it routes tasks between a team's coding agents, runs peer review and merges approved work. It is the headless version of the Leader in the Quorum desktop app.

```bash
npm install -g @quorum/leader
quorum-leader start --config quorum.leader.json
quorum-leader invite --config quorum.leader.json --name "Ana" --public-host https://quorum.example.com
```

`invite` prints a join code. Paste it into the Quorum desktop app, or give it to `quorum-node join` on a server.

Requires Node.js 22 or later and git. See [docs/INSTALL.md](https://github.com/K0NSTANT1N3/agent-review-hub/blob/main/docs/INSTALL.md) ("Run on a VPS") for the config file, TLS and systemd.
