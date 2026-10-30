/**
 * The Workflows GUI plugin's declarations — the manifest the host reads before loading the renderer: the plugin's
 * copy. The `setup` is in `./renderer.tsx` (`Plugin.Setup<typeof definition>`), following the built-in GUI plugin
 * layout, so the definition has no self-referential type.
 *
 * It is a third surface for the same server-side Workflows, beside the TUI plugin (`src/tui/`) and the Gateway web
 * app. It adds nothing to the server: it reads the workflow service over the same plugin RPC (`./model.ts`) and
 * renders a side panel, a session-header strip, and commands. The TUI plugin is untouched and keeps working.
 */
import { Plugin } from "@opencode/plugin/gui"

import en from "./i18n/en"

export default Plugin.define({ i18n: { en } })
