import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

// The bundle hoists Solid's template creation to module scope, so evaluating it needs a DOM. Register one before the
// dynamic imports below pull the client Solid build (which reads `window` at module scope).
import "./happydom"

/**
 * The GUI bundle is what the desktop / web host loads and evaluates as CommonJS (`evaluatePluginBundle`): its default
 * export must be a `Plugin.define` with a window `setup` and an English catalog. This checks the built artifact the
 * way the host reads it, without a running desktop app.
 *
 * The bundle is built by `script/build-gui.ts`; when it is absent (a checkout that has not built), the test is
 * skipped so `bun test` needs no build step.
 */
const bundle = path.resolve(import.meta.dir, "..", "..", "dist", "gui-experimental.cjs")

test.skipIf(!existsSync(bundle))("the built GUI bundle is a valid Plugin.define", async () => {
  const code = readFileSync(bundle, "utf8")
  const provided: Record<string, object> = {
    "solid-js": await import("solid-js"),
    // The bundle runs in a browser window: the client build, not the server one Bun picks by default.
    "solid-js/web": await import("solid-js/web/dist/web.js"),
    "solid-js/store": await import("solid-js/store"),
    "@opencode/plugin/gui": await import("@opencode/plugin/gui"),
    "@opencode/plugin/rpc": await import("@opencode/plugin/rpc"),
  }
  const module = { exports: {} as { default?: unknown } }
  const requireShim = (name: string) => {
    const found = provided[name]
    if (!found) throw new Error(`the host does not provide module ${name}`)
    return found
  }
  // The host evaluates the bundle's text with its own `require`; mirror that here.
  new Function("exports", "require", "module", code)(module.exports, requireShim, module)

  const definition = module.exports.default as { setup?: unknown; i18n?: { en?: Record<string, string> } } | undefined
  expect(definition).toBeDefined()
  expect(typeof definition!.setup).toBe("function")
  expect(typeof definition!.i18n?.en).toBe("object")
  // Every key the screen reads must exist, so a missing key cannot slip out untranslated.
  for (const key of ["panel.title", "command.open", "action.answer", "toast.started"]) {
    expect(typeof definition!.i18n!.en![key]).toBe("string")
  }
})
