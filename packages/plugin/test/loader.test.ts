import { afterAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { AUTHORING_PATH, hasRelativeImports, loadWorkflow, rewriteAuthoringImports } from "../src/loader"

const cacheDir = await mkdtemp(path.join(os.tmpdir(), "wf-loader-"))
afterAll(() => rm(cacheDir, { recursive: true, force: true }))

const source = (specifier: string, name = "w") =>
  `import { defineWorkflow, z } from "${specifier}"\n` +
  `export default defineWorkflow({ meta: { name: "${name}", description: "d", args: z.object({ n: z.number() }) }, async run({ args }) { return args.n * 2 } })\n`

describe("loader", () => {
  it("rewrites the authoring specifier (static, dynamic, side-effect, type) and leaves others alone", () => {
    const input = [
      `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"`,
      `import type { AgentFn } from '@syn7xx/opencode-dynamic-workflows/workflow'`,
      `const m = await import("@syn7xx/opencode-dynamic-workflows/workflow")`,
      `import "@syn7xx/opencode-dynamic-workflows/workflow"`,
      `import fs from "node:fs"`,
    ].join("\n")
    const output = rewriteAuthoringImports(input, "/x/index.ts")
    expect(output.match(/\/x\/index\.ts/g)).toHaveLength(4)
    expect(output).toContain(`import fs from "node:fs"`)
    expect(output).toContain(`from '/x/index.ts'`)
    // A Windows path becomes forward slashes (backslashes would be escapes inside the string literal).
    expect(
      rewriteAuthoringImports(
        `import { z } from "@syn7xx/opencode-dynamic-workflows/workflow"`,
        "C:\\plug\\src\\workflow\\index.ts",
      ),
    ).toBe(`import { z } from "C:/plug/src/workflow/index.ts"`)
  })

  it("loads inline source that imports either authoring name, sharing the engine's module", async () => {
    for (const specifier of [
      "@syn7xx/opencode-dynamic-workflows/workflow",
      "@syn7xx/opencode-dynamic-workflows/workflow",
    ]) {
      const loaded = await loadWorkflow(source(specifier, specifier.replace(/\W/g, "")), { cacheDir })
      expect(await loaded.config.run({ args: { n: 21 } } as never)).toBe(42)
      expect(loaded.config.meta.args?.safeParse({ n: 1 }).success).toBe(true)
    }
  })

  it("writes each distinct source to its own directory and reuses it for identical bytes", async () => {
    const a = await loadWorkflow(source("@syn7xx/opencode-dynamic-workflows/workflow", "a1"), { cacheDir })
    const b = await loadWorkflow(source("@syn7xx/opencode-dynamic-workflows/workflow", "b1"), { cacheDir })
    const again = await loadWorkflow(source("@syn7xx/opencode-dynamic-workflows/workflow", "a1"), { cacheDir })
    expect(path.dirname(a.file)).not.toBe(path.dirname(b.file))
    expect(again.file).toBe(a.file)
  })

  it("bundles a durable file with relative imports and keeps the authoring module external", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "wf-durable-"))
    try {
      await mkdir(path.join(project, "lib"), { recursive: true })
      await writeFile(path.join(project, "lib", "helper.ts"), `export const triple = (n: number) => n * 3\n`)
      const file = path.join(project, "flow.ts")
      const text =
        `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\nimport { triple } from "./lib/helper"\n` +
        `export default defineWorkflow({ meta: { name: "rel", description: "d" }, async run() { return triple(5) } })\n`
      await writeFile(file, text)
      expect(hasRelativeImports(text)).toBe(true)
      const loaded = await loadWorkflow(text, { cacheDir, sourcePath: file })
      expect(loaded.file.endsWith("workflow.js")).toBe(true)
      expect(await loaded.config.run({} as never)).toBe(15)
      const bundled = await Bun.file(loaded.file).text()
      // The materialized module resolves the authoring specifier to this plugin's own module.
      expect(bundled).toContain(AUTHORING_PATH.replaceAll("\\", "/"))
      // The returned snapshot keeps the specifier PORTABLE, so its bytes do not depend on the install path.
      expect(loaded.executionSource).toContain("@syn7xx/opencode-dynamic-workflows/workflow")
      expect(loaded.executionSource).not.toContain(AUTHORING_PATH.replaceAll("\\", "/"))
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("keys a durable module by its whole graph: editing only a helper picks a fresh module", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "wf-graph-"))
    try {
      await mkdir(path.join(project, "lib"), { recursive: true })
      const helper = path.join(project, "lib", "helper.ts")
      const file = path.join(project, "flow.ts")
      const text =
        `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\nimport { value } from "./lib/helper"\n` +
        `export default defineWorkflow({ meta: { name: "graph", description: "d" }, async run() { return value() } })\n`
      await writeFile(file, text)
      await writeFile(helper, `export const value = () => "one"\n`)
      const first = await loadWorkflow(text, { cacheDir, sourcePath: file })
      expect(await first.config.run({} as never)).toBe("one")

      // The entry text is byte-for-byte unchanged; only the helper changed.
      await writeFile(helper, `export const value = () => "two"\n`)
      const second = await loadWorkflow(text, { cacheDir, sourcePath: file })
      expect(second.file).not.toBe(first.file)
      expect(await second.config.run({} as never)).toBe("two")
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("bundles the given source, not whatever is on disk at sourcePath (legacy resume stays faithful)", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "wf-legacy-"))
    try {
      await mkdir(path.join(project, "lib"), { recursive: true })
      await writeFile(path.join(project, "lib", "helper.ts"), `export const v = () => "H"\n`)
      const file = path.join(project, "flow.ts")
      const journaled =
        `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\nimport { v } from "./lib/helper"\n` +
        `export default defineWorkflow({ meta: { name: "j", description: "d" }, async run() { return "JOURNALED_" + v() } })\n`
      const edited =
        `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\nimport { v } from "./lib/helper"\n` +
        `export default defineWorkflow({ meta: { name: "j", description: "d" }, async run() { return "EDITED_" + v() } })\n`
      // The durable file on disk has been edited since the run; the resume must bundle the journaled text.
      await writeFile(file, edited)
      const loaded = await loadWorkflow(journaled, { cacheDir, sourcePath: file })
      expect(await loaded.config.run({} as never)).toBe("JOURNALED_H")
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("imports a journaled executionSource verbatim, without the original file or its lib/", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "wf-exec-"))
    try {
      await mkdir(path.join(project, "lib"), { recursive: true })
      await writeFile(path.join(project, "lib", "helper.ts"), `export const triple = (n: number) => n * 3\n`)
      const file = path.join(project, "flow.ts")
      const text =
        `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\nimport { triple } from "./lib/helper"\n` +
        `export default defineWorkflow({ meta: { name: "rel", description: "d" }, async run() { return triple(7) } })\n`
      await writeFile(file, text)
      const { executionSource } = await loadWorkflow(text, { cacheDir, sourcePath: file })
      expect(executionSource).toBeDefined()

      // The snapshot loads with no `sourcePath` at all (the durable file and its lib/ could be gone).
      const resumed = await loadWorkflow(text, { cacheDir, executionSource })
      expect(resumed.file.endsWith("workflow.js")).toBe(true)
      expect(await resumed.config.run({} as never)).toBe(21)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("rejects a module without a defineWorkflow default export", async () => {
    await expect(loadWorkflow(`export const x = 1\n`, { cacheDir })).rejects.toThrow("defineWorkflow")
    expect((await readdir(cacheDir)).length).toBeGreaterThan(0)
  })
})
