/**
 * The Workflows GUI bundle entry — the default export the host evaluates through `evaluatePluginBundle`
 * (`./gui-experimental`). Built to `dist/gui-experimental.cjs` by `script/build-gui.ts`.
 *
 * It is `Plugin.define({ i18n, setup })`: the declaration (`./index.ts`) plus the window setup (`./renderer.tsx`).
 * This is the third surface for the same server-side Workflows, beside the TUI plugin and the Gateway web app.
 */
import { Plugin } from "@opencode/plugin/gui"

import { catalog } from "./i18n/catalog"
import setup from "./renderer"

export default Plugin.define({ i18n: catalog, setup })
