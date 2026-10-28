import { describe, expect, it } from "bun:test"

import { mayDefineWorkflow } from "../src/loader"

const SPEC = "@syn7xx/opencode-dynamic-workflows/workflow"
const IMPORT = `import { defineWorkflow } from "${SPEC}"\n`

/**
 * Every shape from which the loader can resolve a config (`mod.default ?? mod.workflow`) — or which calls the
 * authoring API and so must be reported when it breaks. Missing one of these silently unregisters a Workflow, so
 * this table is the filter's contract.
 */
const ENTRYPOINTS: Record<string, string> = {
  "default export of defineWorkflow": `${IMPORT}export default defineWorkflow({ meta: {}, run() {} })\n`,
  "bare default config": `export default { meta: { name: "b" }, run() {} }\n`,
  "default export re-export": `export { default } from "./impl.ts"\n`,
  "star re-export": `export * from "./impl.ts"\n`,
  "namespace re-export as workflow": `export * as workflow from "./impl.ts"\n`,
  "export list naming workflow": `const w = { meta: {}, run() {} }\nexport { w as workflow }\n`,
  "declared workflow export": `export const workflow = { meta: {}, run() {} }\n`,
  "exported workflow function": `export async function workflow() { return 1 }\n`,
  "export assignment": `export = { meta: {}, run() {} }\n`,
  "commonjs assignment": `module.exports = { meta: {}, run() {} }\n`,
  "comment between export and default": `export /* generated */ default { meta: {}, run() {} }\n`,
  "line comment between export and default": `export // generated\ndefault { meta: {}, run() {} }\n`,
  "broken entrypoint calling the API": `const w = null\ndefineWorkflow(w)\n`,
}

/** Named-value modules a decomposed Workflow imports: no entrypoint shape, so discovery must never import them. */
const HELPERS: Record<string, string> = {
  "z-schema helper": `import { z } from "${SPEC}"\nexport const S = z.object({ n: z.number() })\n`,
  "type-only import": `import type { AgentFn } from "${SPEC}"\nexport type Y = AgentFn\n`,
  "constant helper": `export const AGENT = "a"\nexport const TOOL = "t"\n`,
  "type alias": `export type X = string\n`,
  "export list of helpers": `const S = 1, T = 2\nexport { S, T }\n`,
  "derived value": `const x = 1\nexport const y = x + 1\n`,
  "type re-export": `export type { X } from "./types.ts"\n`,
}

describe("mayDefineWorkflow (the discovery pre-filter)", () => {
  for (const [shape, source] of Object.entries(ENTRYPOINTS)) {
    it(`keeps an entrypoint: ${shape}`, () => {
      expect(mayDefineWorkflow(source)).toBe(true)
    })
  }

  for (const [shape, source] of Object.entries(HELPERS)) {
    it(`skips a helper: ${shape}`, () => {
      expect(mayDefineWorkflow(source)).toBe(false)
    })
  }
})
