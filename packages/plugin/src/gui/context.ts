/**
 * The GUI plugin's context alias: the SDK's window `Context`, typed from the plugin's own `definition` so the exact
 * catalogs are available. Split out so components can `import type` the context without pulling the entrypoint (and
 * its setup) into their chunk.
 */
import type { SetupContext } from "@opencode/plugin/gui"

import type definition from "./index"

/** The context a component reads with `usePlugin<typeof definition>()`, or receives as a prop. */
export type PluginContext = SetupContext<typeof definition>
