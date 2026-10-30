// Directory-plugin GUI entrypoint (`<dir>/gui-experimental.cjs`), mirroring the package's `./gui-experimental`
// export. OpenCode resolves it by path for a plugin configured as a local directory, and evaluates it as CommonJS.
// It re-exports the PRECOMPILED bundle: run `bun run build` first.
module.exports = require("./dist/gui-experimental.cjs")
