/**
 * `@syn7xx/opencode-dynamic-workflows/workflow` — the author-facing surface.
 *
 * A Workflow is a TypeScript module that exports `defineWorkflow({ meta, run })`. Authors import
 * `defineWorkflow` and `z` from here; the plugin engine injects a live {@link WorkflowContext} at run time.
 *
 * This module is intentionally thin (just `zod`): durable Workflow files (`.opencode/workflows/*.ts`) and inline
 * modules both import it, and the loader points that import at the plugin's own copy, so authors and the engine
 * share one module (and one zod). The orchestration primitives live in the plugin engine, not here.
 *
 * `z` is zod 4: its built-in `z.toJSONSchema` is how a Unit's `schema` becomes the input of its `workflow_result`
 * tool.
 */
import { z } from "zod"

export { z }

/**
 * Declares a Workflow: its identity plus optional UX/typing metadata. Generic over the optional `args` zod
 * schema `S`: when supplied, the Run's `args` are validated against it before any Unit launches and `ctx.args`
 * is typed as `z.infer<S>` (see {@link DefineWorkflowConfig}).
 */
export interface WorkflowMeta<S extends z.ZodType = z.ZodType> {
  /** Unique name — the registry key and the `/workflow` dispatcher argument. */
  name: string
  /** One line; shown in the permission dialog / workflow list. */
  description: string
  /** Optional longer "when to use this" shown in the workflow list. */
  whenToUse?: string
  /** One entry per `phase()` the run will declare (titles matched exactly for grouping). */
  phases?: { title: string; detail?: string }[]
  /** Units in flight at once for this Workflow. Can lower the plugin's `maxConcurrentUnits` (default 5), not raise it. */
  concurrency?: number
  /**
   * Optional per-Unit prompt deadline (ms) for this Workflow's Units (a Unit's own `agent({ timeoutMs })`
   * overrides it). On expiry the Unit is cancelled and fails `null` rather than hanging the Run.
   *
   * **Omit it and Units run for as long as they take** — there is no engine default, because a Unit that
   * legitimately runs for hours is the normal case here, not the pathological one. Set this only when you want
   * a Unit to fail fast, and size it to the work rather than to your patience: a timeout is not retried.
   */
  unitTimeout?: number
  /**
   * Output-token ceiling, surfaced to `run` as `ctx.budget.total`. A number is ADVISORY: it informs author
   * decisions (loop until `ctx.budget.remaining()` is low) and over-budget Units still run. `{ tokens, hard: true }`
   * makes it a hard stop: once spent, the Run ends with a legible "budget exhausted" error.
   */
  budget?: number | { tokens: number; hard?: boolean }
  /**
   * Permission rules applied to every Unit session of this Workflow, after the subagent's own rules (last match
   * wins). Use them to allow exactly what the Units need, e.g. `{ action: "edit", resource: "src/**", effect: "allow" }`.
   */
  permissions?: PermissionRule[]
  /** Hard limits (defaults: 1000 Units per Run, 4096 items per parallel/pipeline call, 250 model steps per Unit). */
  limits?: { maxUnits?: number; maxItemsPerCall?: number; maxUnitSteps?: number }
  /**
   * Zod schema for the Run's `args`. When present, the caller's `args` are validated against it before any Unit
   * launches — invalid input fails the Run immediately, naming the offending field — and `ctx.args` is typed
   * as the schema's inferred type. Omit it for an untyped/unchecked `args` (`ctx.args` is then `unknown`).
   */
  args?: S
  /** How this Workflow's questions and permission requests are handled. */
  interaction?: InteractionPolicy
}

/** How a Run's interactions are handled — per Workflow, overriding the engine's defaults. */
export interface InteractionPolicy {
  /**
   * What happens when a Unit's tool call hits an `ask` permission rule:
   * - `ask` (default) — with a surface attached, a person decides (TUI panel, web app); headless, it is denied
   *   with a message the Unit can act on. Never hangs a headless Run.
   * - `auto` — allowed once, silently (opt-in; prefer explicit `meta.permissions` rules).
   * - `deny` — always denied with a message.
   */
  permissions?: "ask" | "auto" | "deny"
  /**
   * How long a human has before automation takes an interaction back — **opt-in, with no default**.
   *
   * Omit it and a published question waits until a person answers it, hands it to automation on purpose, or
   * the Run is stopped. That is the right default because most questions worth interrupting someone for are
   * worth waiting for: a deadline hands the decision to a machine precisely when the person it was asked of
   * stepped away, which is the situation asking existed to avoid. Set it when the answer genuinely expires —
   * a deploy window, a batch that must go out tonight.
   *
   * A Run with nobody attached never publishes at all: `ctx.ask` resolves to its declared `fallback` at once,
   * so this knob has nothing to do with headless safety.
   */
  graceMs?: number
}

/** One permission rule, OpenCode's own shape. Later rules win. */
export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** A plain JSON Schema object, accepted wherever a zod schema is. */
export type JsonSchemaInput = { type?: unknown; [key: string]: unknown }

/** One question a script asks. The same shape the host uses, so both origins render through one pane. */
export interface AskQuestion {
  /** Short display header — the pane's panel title. */
  header: string
  /** The complete question text. */
  prompt: string
  /** The closed set of answers. A reply is matched by LABEL, per the host's own contract. */
  options: { label: string; description: string }[]
  /** Whether more than one label may be chosen. Defaults to false. */
  multiple?: boolean
  /** Whether a free-text answer is accepted alongside the offered labels. Defaults to false. */
  custom?: boolean
}

export interface AskOptions {
  /**
   * The answer to use when nobody can be asked — REQUIRED, not optional.
   *
   * A background run, `opencode serve`, and a CI run all have no one attached, and a Workflow that hangs
   * waiting for an answer nobody will give is worse than one that proceeds on a stated default. Declaring it
   * also makes the headless path a decision the author made rather than one the engine invented. Shaped like a
   * reply: one entry per question, each a list of chosen labels.
   */
  fallback: string[][]
  /**
   * How long to wait for a human before falling back, for THIS question only.
   *
   * Falls back to the Run's `meta.interaction.graceMs`, and with neither declared there is no deadline: the
   * question waits for the person it was asked of. See {@link InteractionPolicy.graceMs}.
   */
  graceMs?: number
}

/**
 * Ask the human a question mid-run, and block until they answer (or the grace expires).
 *
 * The point is the questions args cannot express: `meta.args` is fixed before the Run starts, so it can offer
 * "fast or thorough?" but not *"planning found 6 areas — 12 units — fast or thorough?"*. Same two options, far
 * better decision, and only answerable once the Run has computed something.
 *
 * Answers are matched by LABEL, per the host's own reply contract — so the offered labels are a closed set,
 * which is what makes the fallback well-typed and a later replay exact. The resolved value is always one entry
 * per question, in the order they were asked.
 */
export type AskFn = (form: AskQuestion | AskQuestion[], options: AskOptions) => Promise<string[][]>

/** A model as the author names it: `providerID` + `modelID` (+ an optional reasoning `variant`). */
export interface AgentModel {
  providerID: string
  modelID: string
  variant?: string
}

/**
 * Options for a single {@link AgentFn} call — one Unit of a Run. Generic over the optional `schema`: when a
 * zod schema is supplied, the Unit returns its inferred type instead of text (see {@link AgentFn}).
 */
export interface AgentOpts<S extends z.ZodType | JsonSchemaInput | undefined = undefined> {
  /** Registered subagent name to run this Unit as. Defaults to `"general"`. */
  subagent?: string
  /** Alias of `subagent` (Claude Code naming). */
  agentType?: string
  /** Display label override. */
  label?: string
  /** Progress group for this Unit. */
  phase?: string
  /**
   * Model override: `{ providerID, modelID, variant? }`, `"provider/model#variant"`, or the sentinel
   * `"inherit"` (run on the model of the session that launched this Run — see {@link WorkflowContext.model}).
   *
   * Omit it and the Unit runs on the **subagent's own configured model** — the engine passes `agent:` to the
   * host, which resolves the model from that agent's config, so `subagent` already decides the model. This
   * only overrides that.
   *
   * The string form must be `"provider/model"` (or `"provider/model#variant"`): a value the engine cannot parse
   * into a provider and a model is not passed to the host — the Unit falls back to the subagent's model and a Run
   * log line names the bad value. A well-formed but unknown `provider/model` resolves however the host resolves an
   * unknown id.
   */
  model?: AgentModel | "inherit" | string
  /**
   * Reasoning-effort shorthand: the model's `variant` (e.g. `"low"`, `"high"`).
   *
   * With an explicit `model` it sets the variant only when that model names none (an explicit
   * `"provider/model#high"` still wins). Without a `model`, the Unit **inherits the model of the session that
   * launched this Run** (`ctx.model`) and this effort sets its variant — so effort alone is what "run on my
   * current model, at this reasoning level" needs. When no caller model is known (a headless/synthetic caller)
   * the effort cannot be applied and the Run logs a line saying so — it is never silently dropped.
   */
  effort?: string
  /**
   * Zod schema for a typed result. The Unit gets a `workflow_result` tool whose input is this schema; the engine
   * validates each call (the model can correct itself in the same turn), repairs in the same session when needed,
   * and resolves the Unit to the schema's inferred type (not text).
   */
  schema?: S
  /**
   * How many repair turns (in the same Unit session) to allow when no valid result arrived. Defaults to `2`.
   * Ignored when no `schema` is supplied.
   */
  retries?: number
  /**
   * Wall-clock ceiling (ms) for THIS Unit's prompt. On expiry the child prompt is cancelled and the Unit
   * resolves to `null` (recorded in {@link WorkflowContext.errors}) — so a hung subagent never blocks the Run.
   * Overrides the Run default ({@link WorkflowMeta.unitTimeout}). Omit to inherit it.
   */
  timeoutMs?: number
  /**
   * Run this Unit in another directory — typically a git worktree created for it. The directory must be an
   * OpenCode location where this plugin is active (commit the plugin config, or install it globally).
   */
  location?: string
  /**
   * `"worktree"`: run this Unit in a fresh git worktree of the project (for Units that edit files in parallel).
   * Removed afterwards when the Unit changed nothing; otherwise kept — see `ctx.worktrees()` to merge the work.
   * The plugin must be active in the worktree (configure it in a COMMITTED opencode.json, or globally).
   */
  isolation?: "worktree"
  /** Permission rules for this Unit's session, applied after the Workflow's `meta.permissions`. */
  permissions?: PermissionRule[]
}

/**
 * The value a Unit resolves to for a schema `S`: a zod schema's inferred type; the Unit's final text when no schema
 * was given; `unknown` for a plain JSON Schema (which is validated at run time).
 *
 * In a refinement loop (`draft = await agent(\`…${draft}\`)`), declare the loop variable as `string`, not
 * `string | null`: TypeScript otherwise reports circular inference for the values computed inside the loop.
 */
export type UnitValue<S extends z.ZodType | JsonSchemaInput | undefined> = S extends z.ZodType
  ? z.infer<S>
  : S extends undefined
    ? string
    : unknown

/**
 * Runs one Unit: prompts a (by default freshly-created) child session under the named subagent. With a
 * `schema`, it resolves to that schema's inferred type (validated structured output); without one, to the
 * Unit's final assistant text. Either way `null` on failure/skip (the drop is recorded in
 * {@link WorkflowContext.errors}).
 *
 * Passing `{ receipts: true }` resolves to a {@link UnitReceipt} instead — the same value, plus the Unit's id and
 * what its session actually did. The Unit itself is identical either way: one call, one Unit, one session.
 *
 * `receipts` is deliberately NOT part of {@link AgentOpts}: it lives in these overloads so the resolved type follows
 * the flag. Write `receipts: true` inline (or on an `as const` object) — a plain `boolean` variable cannot select
 * the receipt overload, which is the point: no call gets typed as a value while returning a receipt at run time.
 */
export interface AgentFn {
  <S extends z.ZodType | JsonSchemaInput | undefined = undefined>(
    prompt: string,
    opts: AgentOpts<S> & { receipts: true },
  ): Promise<UnitReceipt<UnitValue<S>>>
  <S extends z.ZodType | JsonSchemaInput | undefined = undefined>(
    prompt: string,
    opts?: AgentOpts<S> & { receipts?: false },
  ): Promise<UnitValue<S> | null>
}

/** A dropped Unit, surfaced via {@link WorkflowContext.errors} (no silent drops). */
export interface WorkflowError {
  /** Human-facing identifier of the Unit that dropped: its `label`, else the resolved subagent name. */
  unit: string
  /** The prompt the dropped Unit was given. */
  prompt: string
  /** The subagent the dropped Unit ran (or would have run) as. */
  subagent: string
  /** The stringified failure reason. */
  error: string
}

/**
 * Run a list of Units concurrently and wait for all to settle (a **barrier**). Bounded by the workflow's
 * `meta.concurrency` (or the plugin default), so a fan-out never exceeds the limiter. Results are returned
 * **positionally aligned** to `thunks`; a Unit that fails/throws resolves to `null` in its slot (the fan-out
 * is not aborted) and is appended to {@link WorkflowContext.errors}. With `receipts` the slot is a receipt whose
 * `value` is `null`, so `collect()` keeps it. Pair with {@link CollectFn} to drop the nulls with type-narrowing.
 */
export type ParallelFn = <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>

/**
 * Drop the `null` slots from a {@link ParallelFn} result **and type-narrow** to the non-null element type
 * (so the result is `T[]`, not `(T | null)[]` — unlike `.filter(Boolean)` under strict null checks). The
 * dropped Units remain visible in {@link WorkflowContext.errors}.
 */
export type CollectFn = <T>(xs: Array<T | null>) => T[]

/**
 * One {@link PipelineFn} stage. Receives the running value (`prev` — the previous stage's result, or the
 * original item for stage 1), the original `item`, and its `index`. Returns the next running value (sync or
 * async). A stage that **throws** collapses that item to `null` and skips its remaining stages ; other
 * items keep flowing. (A Unit that *fails* via `agent()` returns `null` without throwing, so it flows on as
 * `null` rather than dropping the item.)
 */
export type PipelineStage<P, R, I> = (prev: P, item: I, index: number) => R | Promise<R>

/**
 * Run each item down a chain of stages **independently — no barrier between items** (the default for staged
 * work): item A can be in stage 3 while item B is still in stage 1. The overloads thread each stage's resolved
 * return type into the next stage's `prev`, so a typed chain stays typed end-to-end; the result is
 * `Array<lastStageResult | null>` (the `| null` is the per-item drop). Past four stages it falls back to the
 * variadic form (results typed loosely). Bounding is uniform with everything else: a stage's Units go through
 * {@link AgentFn}, which draws from the one shared limiter.
 */
export interface PipelineFn {
  <I, A>(items: I[], s1: PipelineStage<I, A, I>): Promise<Array<Awaited<A> | null>>
  <I, A, B>(
    items: I[],
    s1: PipelineStage<I, A, I>,
    s2: PipelineStage<Awaited<A>, B, I>,
  ): Promise<Array<Awaited<B> | null>>
  <I, A, B, C>(
    items: I[],
    s1: PipelineStage<I, A, I>,
    s2: PipelineStage<Awaited<A>, B, I>,
    s3: PipelineStage<Awaited<B>, C, I>,
  ): Promise<Array<Awaited<C> | null>>
  <I, A, B, C, D>(
    items: I[],
    s1: PipelineStage<I, A, I>,
    s2: PipelineStage<Awaited<A>, B, I>,
    s3: PipelineStage<Awaited<B>, C, I>,
    s4: PipelineStage<Awaited<C>, D, I>,
  ): Promise<Array<Awaited<D> | null>>
  <I>(items: I[], ...stages: Array<PipelineStage<any, any, I>>): Promise<Array<unknown>>
}

/** What `ctx.$` resolves to. A non-zero `exitCode` is a value, not a throw. */
export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Project-confined helpers, stopped with the Run and recorded in its activity. Not a sandbox: see the security
 * docs. Disabled for inline Workflows when the plugin option `inlineCapabilities` is `false`.
 */
export interface WorkflowCapabilities {
  /**
   * Run a shell command in the project (`sh -c`). As a tagged template, interpolations are shell-quoted:
   * ``await $`git log -1 ${ref}` ``. Options: `cwd` (inside the project), `timeoutMs` (default 120 s), `env`.
   */
  $: {
    (
      command: string,
      options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
    ): Promise<ShellResult>
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>
  }
  /** Files inside the project only (paths resolve through symlinks and may not leave it). */
  file: {
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    exists(path: string): Promise<boolean>
    /** Entry names; directories end in `/`. */
    list(path?: string): Promise<string[]>
    stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; modified: number }>
  }
  /** `fetch`, aborted when the Run stops. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/**
 * One tool call a Unit's session recorded — engine-owned, never model-authored. Engine-owned tools (this plugin's
 * `workflow_result` and `workflow_question`) appear alongside the model's own calls.
 */
export interface UnitToolCall {
  name: string
  /**
   * The call input rendered as JSON — possibly partial while the tool is still streaming — clipped to at most
   * 4 000 UTF-16 code units (a clipped value ends in `…`, and a surrogate pair is never split).
   */
  input: string
  /**
   * The host's raw result for the call, unmodified — its text, or JSON for a structured result — clipped to at most
   * 4 000 UTF-16 code units like {@link UnitToolCall.input} (a clipped value ends in `…`, and a surrogate pair is
   * never split). The call's `error.message` when it returned nothing at all.
   */
  output: string
  /**
   * The call **finished** (`status === "completed"` with no error) — NOT that the command succeeded: a `shell` call
   * that exits non-zero is still a finished call.
   *
   * No exit code is added to {@link UnitToolCall.output}: the receipt is the host's record, unmodified, so a failure
   * may or may not be readable from it. When it matters, assert on the command's effect instead (a file the Unit
   * wrote, a `ctx.$` check afterwards).
   */
  successful: boolean
}

/**
 * What `agent(…, { receipts: true })` resolves to. Never `null`: a failed Unit still reports what it did. That also
 * means `collect()` around a fan-out of receipts keeps failed Units — filter on `value`.
 */
export interface UnitReceipt<T> {
  /** The Unit's result — exactly what `agent()` would have returned without `receipts`. `null` on failure/skip. */
  value: T | null
  /** The Unit's stable id (a `Unit.unitId`). */
  unitId: string
  /**
   * The tool calls the Unit's session recorded. Read lazily on first access (memoized), so a Workflow that never
   * asks costs nothing extra. `[]` means one of two things: the Unit ran and called no tools, or there is nothing to
   * read — a Unit with no session (a setup failure), or a replayed Unit whose original session is gone, unreadable, or
   * absent because it failed before creating one. In those cases `[]` is *unknown*, not "did nothing".
   *
   * A replayed Unit (a recorded failure included, and across repeated resumes) reads the session the ORIGINAL Run
   * recorded, so a resumed Run can vouch for work the earlier Run did — and may therefore fail an assertion that
   * quietly passed on `[]` before. When that evidence is unavailable — no session was ever recorded, the read fails,
   * or the transcript is unreadable — it yields `[]` plus a Run log line, never a rejection. Only a Unit that ran in
   * THIS Run is strict: its session exists, so a read failure rejects rather than looking empty. `[]` on a replayed
   * Unit is not proof of innocence either — a check that must never be skipped belongs on a Run that actually ran the
   * Unit.
   *
   * Not enumerable: `JSON.stringify(receipt)` is `{ value, unitId }` and reads nothing. `{ ...receipt }` therefore
   * loses this property — copy it deliberately (`{ ...receipt, toolCalls: await receipt.toolCalls }`) or await it.
   */
  readonly toolCalls: Promise<UnitToolCall[]>
}

/** The context handed to a Workflow's `run`. */
export interface WorkflowContext<A = unknown> extends WorkflowCapabilities {
  /** Run one Unit as a named subagent (default `"general"`). */
  agent: AgentFn
  /** Fan a list of Units out concurrently (bounded barrier); failures become `null` slots + `errors`. */
  parallel: ParallelFn
  /** Run each item down a stage chain independently — NO barrier between items (the default for staged work). */
  pipeline: PipelineFn
  /** Drop `null` slots from a result array and type-narrow to the non-null element type. */
  collect: CollectFn
  /** The Units that have dropped so far (failed/threw), in the order they were recorded. */
  errors: ReadonlyArray<WorkflowError>
  /** The validated/whole `args` value passed to the Run. */
  args: A
  /** Emit a narrator progress line. */
  log: (message: string) => void
  /** Begin a named progress phase; subsequent `agent()` calls group under it. */
  phase: (title: string) => void
  /**
   * Ask the human a question mid-run, with a REQUIRED headless fallback.
   *
   * Blocks until someone answers, the grace period expires, or the Run aborts — whichever comes first. With no
   * surface attached it resolves to `options.fallback` immediately rather than stalling a headless Run.
   */
  ask: AskFn
  /**
   * Token budget: `total` is the ceiling (or null), `spent()` the running output-token sum, `remaining()` is
   * `max(0, total - spent())` (or Infinity when uncapped). Advisory unless `meta.budget` is `{ tokens, hard: true }`.
   */
  budget: { total: number | null; spent(): number; remaining(): number }
  /**
   * Run a SAVED Workflow (by key) as one step of this Run and get its result. It shares this Run's concurrency cap,
   * budget, errors and stop signal; its Units and phases show as `name › …`. Its args are validated against its
   * `meta.args` (an invalid call throws). One level only: calling `workflow` inside it throws.
   */
  workflow: (name: string, args?: unknown) => Promise<unknown>
  /** Worktrees kept by `isolation: "worktree"` Units that changed something, in the order they finished. */
  worktrees: () => ReadonlyArray<{ unit: string; directory: string; branch: string | null }>
  /** The Run's abort signal. Aborting stops launching queued Units AND interrupts in-flight Unit sessions; each dropped Unit is recorded in {@link errors}. */
  signal: AbortSignal
  /**
   * The model of the session that launched this Run, as `"provider/model#variant"` — or `null` when the caller
   * is not an ordinary session (a headless/synthetic starter).
   *
   * This is what `agent(prompt, { model: "inherit" })` resolves to, and what `agent(prompt, { effort })`
   * with no `model` inherits. Read it when a script wants to reason about the caller itself; otherwise the two
   * shorthands above already do the inheritance for you. Fixed at Run start, so every Unit sees the same value.
   */
  model: string | null
}

/**
 * A Workflow definition: declarative `meta` plus the `run` that orchestrates Units. Generic over the `meta.args`
 * schema `S` so `run`'s `ctx.args` is typed as `z.infer<S>` (or `unknown` when no schema is declared).
 */
export interface DefineWorkflowConfig<S extends z.ZodType = z.ZodType> {
  meta: WorkflowMeta<S>
  run: (ctx: WorkflowContext<z.infer<S>>) => Promise<unknown>
}

/**
 * Declares a Workflow. Validates `meta` and returns the config unchanged (identity), so the same shape works
 * for durable files (default-exported) and inline ad-hoc modules. No execution happens here — the engine
 * resolves the config and calls `run` with a live context. The `meta.args` schema (if any) drives both the
 * compile-time type of `ctx.args` and the engine's runtime validation of the caller's input.
 */
export function defineWorkflow<S extends z.ZodType = z.ZodType>(
  config: DefineWorkflowConfig<S>,
): DefineWorkflowConfig<S> {
  if (!config || typeof config !== "object") {
    throw new TypeError("defineWorkflow: expected a { meta, run } config object")
  }
  const { meta, run } = config
  if (!meta || typeof meta !== "object") {
    throw new TypeError("defineWorkflow: `meta` is required")
  }
  if (typeof meta.name !== "string" || meta.name.trim() === "") {
    throw new TypeError("defineWorkflow: `meta.name` must be a non-empty string")
  }
  // `:` joins the registry-key namespace and `/`/whitespace are reserved by the slash-command mapping, so a
  // name containing them would make the key non-injective or silently collide on a command — reject at the
  // single chokepoint (both durable + ad-hoc workflows pass through here).
  if (/[:/\\\s]/.test(meta.name)) {
    throw new TypeError(
      `defineWorkflow: \`meta.name\` must not contain ':', '/', '\\\\', or whitespace (got ${JSON.stringify(meta.name)})`,
    )
  }
  if (typeof meta.description !== "string" || meta.description.trim() === "") {
    throw new TypeError("defineWorkflow: `meta.description` must be a non-empty string")
  }
  if (typeof run !== "function") {
    throw new TypeError("defineWorkflow: `run` must be a function")
  }
  return config
}
