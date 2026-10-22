# Vendored files

## Node.js license

The installers include a Node.js runtime for the `quorum` and `quorum-tui` commands.
The Node.js license must go with that runtime.

- `node-LICENSE` is the `LICENSE` file of Node.js. It includes the third-party notices.
- `node-LICENSE.version` is the Node.js version of that file.

`scripts/stage-cli.mjs` copies `node-LICENSE` to `cli-stage/NODE-LICENSE`.
The build does not download the license. Thus, a build without network access can stage the CLI.
If the Node.js version of the build is different from `node-LICENSE.version`, the build shows a message.

### Refresh the license when you upgrade Node.js

Do these steps when the build starts to use a different Node.js version:

1. Use the new Node.js version in your shell. Make sure that `node --version` shows that version.
2. In `packages/desktop`, run these commands:

   ```bash
   version=$(node -p process.versions.node)
   curl -fsSL "https://raw.githubusercontent.com/nodejs/node/v$version/LICENSE" -o vendor/node-LICENSE
   echo "$version" > vendor/node-LICENSE.version
   ```

3. Make sure that `vendor/node-LICENSE` starts with `Node.js is licensed for use as follows:`.
4. Commit the two files.
