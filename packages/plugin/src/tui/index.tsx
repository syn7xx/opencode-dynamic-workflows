/**
 * The TUI plugin entry (`@syn7xx/opencode-workflows-plugin/tui`). Published precompiled (`script/build-tui.ts` →
 * `dist/tui.js`): OpenCode's runtime Solid transform skips `node_modules`, so an installed package's TSX would
 * not render.
 */
import { Plugin } from "@opencode/plugin/tui"

import { setupWorkflowsTui } from "./app"

export default Plugin.define({
  id: "opencode-workflows.tui",
  setup: (context) => setupWorkflowsTui(context),
})
