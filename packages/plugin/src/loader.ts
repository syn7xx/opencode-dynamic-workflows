/**
 * The Workflow loader — turns Workflow source into a live `defineWorkflow` config, without `eval`.
 *
 * Checked against an installed (non-workspace) package inside the host's embedded Bun:
 *
 * - A Workflow's `import … from "<authoring package>"` cannot rely on the user's project: the authoring module
 *   ships inside this plugin. The authoring specifier is rewritten to this plugin's own resolved module,
 *   so the Workflow and the engine share ONE module instance (and one zod).
 * - Each module is written to a fresh directory named by its content hash. The host's resolver caches directory
 *   listings, so a new file in an already-read directory is not found; a new directory always is. The same bytes
 *   map to the same directory, so re-running an unchanged Workflow reuses its module.
 * - A durable Workflow that imports its own relative files is bundled with `Bun.build` into one module, with the
 *   authoring specifiers kept external — its relative imports are inlined. The bundled bytes are the ones passed
 *   in (the journal's snapshot when resuming, else the file on disk), and the file's real path only anchors
 *   resolution of those relative imports.
 * - Runtime `Bun.plugin` resolvers do not work in the host; they are not used.
 *
 * Inline source is model-authored code. Loading it runs it with the service's full privileges; the gate in
 * front of this (`workflow_inline` approval) is where that risk is managed, not here.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { DefineWorkflowConfig } from "./workflow"

/** The import specifier that means "the authoring API". */
export const AUTHORING_SPECIFIERS = ["@syn7xx/opencode-dynamic-workflows/workflow"] as const

/** This plugin's own authoring module, wherever the host installed the package. */
export const AUTHORING_PATH = path.join(import.meta.dir, "workflow", "index.ts")

/** Bump when the loader's output for the same bytes would differ. */
const LOADER_VERSION = "3"

export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache")
  return path.join(base, "opencode-dynamic-workflows", "workflows")
}

/** Escape a literal string for a `RegExp` source. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
}

/** Matches exactly one authoring specifier (module resolution, not substring). */
const AUTHORING_FILTER = new RegExp(`^(${AUTHORING_SPECIFIERS.map(escapeRegExp).join("|")})$`)

const SPECIFIER_PATTERN = new RegExp(
  `(from\\s*|import\\s*\\(\\s*|import\\s+)(["'])(${AUTHORING_SPECIFIERS.map(escapeRegExp).join("|")})\\2`,
  "g",
)

/** Point every authoring import at this plugin's module. Other imports are untouched. */
export function rewriteAuthoringImports(source: string, target = AUTHORING_PATH): string {
  // Forward slashes: a Windows path's backslashes would be read as escapes inside the string literal.
  const specifier = target.replaceAll("\\", "/")
  return source.replace(
    SPECIFIER_PATTERN,
    (_match, lead: string, quote: string) => `${lead}${quote}${specifier}${quote}`,
  )
}

/**
 * Point an already-resolved authoring import back at the portable specifier.
 *
 * `Bun.build` emits the resolved `AUTHORING_PATH` for an `external` module (Bun 1.3 kept the original
 * specifier, 1.4 resolves it), so the bundled bytes differ across Bun versions and plugin installs even when the
 * Workflow is unchanged. Normalizing to the specifier makes the persisted bundle — the snapshot the journal keeps
 * and replays — a pure function of the Workflow, not of where this plugin happens to be installed.
 */
export function portableAuthoringImports(source: string, target = AUTHORING_PATH): string {
  const resolved = target.replaceAll("\\", "/")
  return source.split(resolved).join(AUTHORING_SPECIFIERS[0])
}

export function hasRelativeImports(source: string): boolean {
  return /(?:from\s*|import\s*\(\s*|import\s+)["']\.\.?\//.test(source)
}

/**
 * An "entrypoint-shaped export": every way {@link loadWorkflow} can find a config in a module — its `mod.default`
 * (`export default …`, `export *`, an export list or re-export naming `default`, `export =`, `module.exports`) and
 * its `mod.workflow` alias (a declaration or export list naming `workflow`).
 *
 * `defineWorkflow` is a signal of its own on purpose: a *broken* entrypoint — one that calls the API but does not
 * export a config — is still imported and still reported, instead of disappearing quietly.
 */
const ENTRYPOINT_SIGNAL = new RegExp(
  [
    String.raw`\bdefineWorkflow\b`,
    String.raw`\bexport\s+default\b`,
    String.raw`\bexport\s*\*`,
    String.raw`\bexport\s*\{[^}]*\b(?:default|workflow)\b`,
    String.raw`\bexport\s*=`,
    String.raw`\bexport\s+(?:async\s+)?(?:const|let|var|function|class)\s+workflow\b`,
    String.raw`\bmodule\.exports\b`,
  ].join("|"),
)

/** Blank comments, so a comment between two tokens reads as the gap the parser sees there. */
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ")
}

/**
 * Could this source be a durable Workflow entrypoint, judged by content and without running it?
 *
 * Discovery globs every `.ts` under a `workflows/` root, so helper/decomposition modules are candidates too. The
 * filter is deliberately NON-LOSSY — it only skips a file that confidently cannot be a Workflow, so no real
 * entrypoint is ever dropped by a folder or a filename:
 *
 * - an {@link ENTRYPOINT_SIGNAL} export — every shape the loader can resolve a config through;
 * - the same, with a comment between the tokens: the parser sees two adjacent tokens where the bytes have three.
 *   The plain test runs first, so blanking comments can only ADD keeps, never lose one.
 *
 * A helper that imports the authoring module only for `z` (schemas, types, constants) and exports named values
 * has no entrypoint-shaped export, so it is skipped before it is imported and the `lib/**` decomposition stays
 * quiet. A file that LOOKS like an entrypoint but fails to load is still imported and still reported.
 */
export function mayDefineWorkflow(source: string): boolean {
  return ENTRYPOINT_SIGNAL.test(source) || ENTRYPOINT_SIGNAL.test(blankComments(source))
}

export function isWorkflowConfig(value: unknown): value is DefineWorkflowConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DefineWorkflowConfig).run === "function" &&
    typeof (value as DefineWorkflowConfig).meta === "object"
  )
}

export interface LoadOptions {
  cacheDir?: string
  /**
   * The Workflow's real file: anchors resolution of its relative imports, and enables bundling. Its text is
   * ignored — `source` is what gets bundled.
   */
  sourcePath?: string
  /** An already-bundled module to import verbatim (the journal's `execution.ts`), instead of bundling `source`. */
  executionSource?: string
}

export interface LoadedWorkflow {
  config: DefineWorkflowConfig
  /** The module file actually imported. */
  file: string
  sha256: string
  /**
   * The bundled module this load materialized, if any: the snapshot a resume handed in, or the bundle of a
   * Workflow with local imports. This is what the journal keeps so a resume reads none of the source files.
   */
  executionSource?: string
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

async function writeOnce(file: string, contents: string): Promise<void> {
  if (existsSync(file)) return
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, contents, "utf8")
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    if (!existsSync(file)) throw error
  }
}

/**
 * Bundle a Workflow into one self-contained module: its local imports are inlined, the authoring specifiers stay
 * external and are normalized to the portable specifier (see {@link portableAuthoringImports}).
 *
 * `source` is the entry's text — the journal's snapshot on a resume, the file on disk otherwise — and
 * `sourcePath` only anchors resolution of the entry's relative imports. Bundling the text we were handed, rather
 * than re-reading the file, is what makes a replay faithful after the file was edited.
 */
async function bundleWorkflow(sourcePath: string, source: string): Promise<string> {
  const entry = path.resolve(sourcePath)
  const build = await Bun.build({
    entrypoints: [sourcePath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "workflow-authoring",
        setup(builder) {
          // Serve the entry's text from `source`; every other module loads normally (returning nothing falls
          // through to Bun's own loader), so imports still resolve from the entry's real directory.
          builder.onLoad({ filter: /\.ts$/ }, (args) =>
            path.resolve(args.path) === entry ? { contents: source, loader: "ts" } : undefined,
          )
          builder.onResolve({ filter: AUTHORING_FILTER }, () => ({
            path: AUTHORING_PATH.replaceAll("\\", "/"),
            external: true,
          }))
        },
      },
    ],
  })
  if (!build.success) throw new Error(build.logs.map(String).join("\n") || "bundling the Workflow failed")
  const output = build.outputs[0]
  if (!output) throw new Error("bundling the Workflow produced no output")
  return portableAuthoringImports(await output.text())
}

/**
 * Materialize and import a Workflow module. Throws with a legible message when the source does not
 * `export default defineWorkflow({ meta, run })`.
 */
export async function loadWorkflow(source: string, options: LoadOptions = {}): Promise<LoadedWorkflow> {
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  // A bundled module is only needed when the entry imports its own files and we know where it lives; an inline
  // (or already-snapshotted) source is materialized as-is.
  const shouldBundle =
    options.executionSource === undefined && options.sourcePath !== undefined && hasRelativeImports(source)
  const executionSource =
    options.executionSource ?? (shouldBundle ? await bundleWorkflow(options.sourcePath!, source) : undefined)
  // The bytes that will be imported: the bundle when there is one, else the source. Keying the cache on them means
  // an edit to any file in the Workflow's graph (not just the entry) yields a new module.
  const materialized = rewriteAuthoringImports(executionSource ?? source)
  const digest = sha256(`${LOADER_VERSION}\0${materialized}`)
  const directory = path.join(cacheDir, digest.slice(0, 32))
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, executionSource !== undefined ? "workflow.js" : "workflow.ts")
  await writeOnce(file, materialized)

  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  const config = mod.default ?? mod.workflow
  if (!isWorkflowConfig(config)) throw new Error("workflow source must `export default defineWorkflow({ meta, run })`")
  return { config, file, sha256: sha256(source), ...(executionSource !== undefined ? { executionSource } : {}) }
}

/** Load a Workflow's config without running it (discovery, validation before a save). */
export async function loadWorkflowConfig(source: string, options: LoadOptions = {}): Promise<DefineWorkflowConfig> {
  return (await loadWorkflow(source, options)).config
}
