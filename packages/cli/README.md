# @quorum/cli

`quorum`: drive a Quorum team from a terminal, a script or a coding agent. Submit tasks, follow them, read reviews.

Not on the npm registry yet: build the package files from the repository and install them as shown in [Run on a VPS](https://github.com/K0NSTANT1N3/agent-review-hub/blob/main/docs/INSTALL.md#101-install-the-programs). The `@quorum` scope on npm belongs to a different organization, so do not `npm install` `@quorum/*` from the registry.

```bash
export QUORUM_URL=https://quorum.example.com QUORUM_TOKEN=qrm_...
quorum --help
```

Get a token from the desktop app (Settings > Agent CLI access) or with `quorum-leader add-token --id <agent id>`. See the [README](https://github.com/K0NSTANT1N3/agent-review-hub#readme) for every command.
