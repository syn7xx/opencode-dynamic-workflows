# opencode-dynamic-workflows — plugin package (OpenCode V2)

One package: the server plugin, the TUI plugin (`dist/tui.js`, precompiled), the GUI plugin
(`dist/gui-experimental.cjs`, precompiled; the desktop / web app half), the authoring API, the protocol,
the RPC contract, the Gateway and the built web app (`dist/web`). Target: OpenCode **2.1.0+** for the server and
TUI halves; the GUI plugin needs **2.2.0+** (the `@opencode/plugin/gui` SDK) and a desktop build that hosts
`./gui-experimental` bundles. Use V2 sources only (https://opencode.ai/v2/docs/, the installed `@opencode/*`
types) — never V1 docs.

## Layout

- `src/workflow/` — authoring API (`defineWorkflow`, `z`, context types). Published as `./workflow`; the loader
  points that import at the plugin's own copy.
- `src/protocol/` — protocol v1 zod schemas: the single source for types, RPC validation and
  `docs/protocol/schemas/*.json` (`bun run script/protocol-schemas.ts`; a test fails when stale).
- Engine (host-independent, tested with `test/fake-host.ts`): `host.ts` (the narrow OpenCode slice),
  `runner.ts` (one Unit: create → prompt → wait → context → repair), `units.ts` (Unit index),
  `context.ts` (`ctx`), `orchestrator.ts` (a Run), `broker.ts` (interactions), `runs.ts` (store + events),
  `journal.ts`, `loader.ts`, `registry.ts`, `scheduler.ts`, `capabilities.ts`, `schema-bridge.ts`,
  `engine-global.ts` (process-wide state on `globalThis`).
- `src/service/` — `service.ts` (the one application boundary), `rpc.ts` (plugin RPC contract), `config.ts`.
- `src/host/` — the V2 adapter: `plugin.ts` (tools, hooks, events, RPC, commands), `description.ts`,
  `format.ts`.
- `src/gateway/` — HTTP + SSE Gateway (process singleton) and token auth.
- `src/ui/` — the surfaces' shared, host-agnostic core: `state.ts`, `sync.ts`, `api.ts`, `nav.ts`, `format.ts`,
  `answer.ts`, `cleanup.ts`. Nothing here imports `@opentui/*` or the DOM; the TUI (`src/tui/`) and the GUI
  (`src/gui/`) both build on it.
- `src/tui/` — the TUI plugin (built by `script/build-tui.ts`).
- `src/gui/` — the GUI plugin: `index.ts` (declarations), `renderer.tsx` (setup), `bundle.tsx` (the
  `./gui-experimental` entry), `model.ts` (controller), `screen.tsx` + `library.tsx`/`run.tsx`/`unit.tsx`/
  `answer.tsx` (views), `views.tsx` (panel/strip surfaces), `styles.css`, `i18n/` (built by `script/build-gui.ts`).
- Root `server.ts`, `rpc.ts`, `tui.*`, `gui-experimental.cjs` — directory-plugin entry shims (OpenCode resolves
  `<dir>/server`, `<dir>/tui`, `<dir>/rpc`, `<dir>/gui-experimental.cjs` by path for directory plugins; packages via exports).

## Commands (repo root)

- `bun run typecheck`, `bun test` — no OpenCode needed.
- `bun test ./packages/plugin/test/live --timeout 300000` — real OpenCode on a private `opencode serve` with
  its own database (harness in `test/live/harness.ts`; cheap model by default).

## Conventions

- The engine never imports `@opencode/*`: only `src/host/`, `src/service/rpc.ts`, `src/gateway/` and
  `src/tui/` do. Extend `host.ts` instead of reaching past it.
- Units are unlinked sessions; their identity is create-time `metadata.workflow` (the plugin does not rely on
  updating metadata later). Mutable Unit state lives in the Unit index, the store and the journal.
- Tools use `options: { codemode: false }`.
- A journal error is never a Run error; a Run's terminal state is journaled before `run.ended` is published.
- Protocol changes within v1 are additive only.
