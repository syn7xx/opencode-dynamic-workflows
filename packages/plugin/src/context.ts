import { createCapabilities } from "./capabilities"
import { formatModel, toHostModel, type EngineHost, type HostMessage, type HostPermissionRule } from "./host"
import { emptyUsage, type Unit, type Usage } from "./protocol"
import { DEFAULT_SUBAGENT, runUnit, stringifyError, type UnitRunResult } from "./runner"
import { toUnitOutput } from "./runs"
import { AbortError, defaultConcurrency, Semaphore } from "./scheduler"
import { resolveJsonSchema } from "./schema-bridge"
import type { UnitBinding, UnitIndex } from "./units"
/**
 * The context factory — assembles the {@link WorkflowContext} handed to a Workflow's `run`.
 *
 * Semantics (pinned by the tests): one shared {@link Semaphore} caps in-flight Units across
 * the whole Run, so `parallel` (a barrier) and `pipeline` (no barrier between items) draw from the same limiter
 *; a failed Unit resolves to `null` and is recorded in `ctx.errors` rather than throwing; the budget is
 * advisory unless the Workflow asks for a hard one; the Run's signal stops queued AND in-flight Units.
 *
 * New on V2: Units run through {@link runUnit} on public session APIs; hard limits stop a runaway script with a
 * legible error; and a resumed Run replays the Units a previous Run already finished (start-order replay).
 */
import type {
  AgentOpts,
  AskOptions,
  AskQuestion,
  UnitReceipt,
  UnitToolCall,
  WorkflowContext,
  WorkflowError,
  z,
} from "./workflow"

export interface EngineEvents {
  onLog?: (message: string) => void
  onPhase?: (title: string) => void
  /** Every Unit transition (queued, running, repairing, settled). */
  onUnit?: (unit: Unit) => void
  /** The Unit session exists; `stop` ends just this Unit. */
  onUnitSession?: (unitId: string, sessionID: string, stop: () => void) => void
}

export interface EngineState {
  logs: string[]
  phases: string[]
  currentPhase: string | null
  errors: WorkflowError[]
  unitCount: number
  /** Output tokens of completed Units — what `ctx.budget.spent()` reports. */
  tokensSpent: number
  usage: Usage
  /** Units started and not yet settled — including ones the script never awaited. */
  inflight: Set<Promise<unknown>>
  /** Worktrees kept by `isolation: "worktree"` Units that changed something. */
  worktrees: Array<{ unit: string; directory: string; branch: string | null }>
}

export function createEngineState(): EngineState {
  return {
    logs: [],
    phases: [],
    currentPhase: null,
    errors: [],
    unitCount: 0,
    tokensSpent: 0,
    usage: emptyUsage(),
    inflight: new Set(),
    worktrees: [],
  }
}

export interface RunLimits {
  maxUnits: number
  maxItemsPerCall: number
  maxUnitSteps: number
}

export const DEFAULT_LIMITS: RunLimits = { maxUnits: 1_000, maxItemsPerCall: 4_096, maxUnitSteps: 250 }

/**
 * How much of one tool call's input and output a {@link UnitReceipt} keeps (characters, per string; counted in
 * UTF-16 code units).
 *
 * Deliberately far larger than the 160-character audit clips in `capabilities.ts`, which would truncate nearly
 * every interesting call: a tool call is the EVIDENCE a Workflow asserts on, so a whole shell command, a diff hunk
 * or an edited file body has to survive intact. 4 000 characters covers those, while keeping a Unit that read a
 * megabyte file from flooding the Run's memory.
 */
const MAX_TOOL_CALL_TEXT = 4_000

/** `text`, cut to {@link MAX_TOOL_CALL_TEXT}, with a trailing ellipsis when it had to be clipped. */
function clipToolText(text: string): string {
  if (text.length <= MAX_TOOL_CALL_TEXT) return text
  // Neither half of a surrogate pair is text on its own: back off one unit rather than end the clip mid-emoji.
  let end = MAX_TOOL_CALL_TEXT - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/**
 * A tool call's input or result as text: a string as-is, content parts joined, anything else as JSON. A local
 * mirror of `service.ts`'s private `textOf`, which reads the same host shapes (that one also feeds posts and
 * transcripts); kept here so this path imports nothing from the service layer.
 */
function toolText(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const texts = value
      .map((entry) =>
        entry && typeof entry === "object" && "text" in entry ? String((entry as { text: unknown }).text) : "",
      )
      .filter(Boolean)
    if (texts.length > 0) return texts.join("")
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * What {@link runOne} hands back: the value `agent()` resolves to, plus the two facts a receipt needs — the Unit's
 * id, and the session it settled with (`null` when it never had one).
 */
interface UnitOutcome {
  value: unknown
  unitId: string
  /** The Unit's name in progress (label else subagent, prefixed) — for a legible read-failure message. */
  label: string | null
  sessionID: string | null
  /**
   * True when the Unit came back from a previous Run's record instead of running live. A replayed Unit has no
   * session of its own; its {@link UnitOutcome.sessionID} is the one the ORIGINAL Run recorded, carried only so a
   * receipt can read that session's tool calls.
   */
  replayed: boolean
}

/** One Unit a previous Run recorded, in {@link ReplayPlan}. */
export interface ReplayUnit {
  prompt: string
  status: Unit["status"]
  output?: string
  schema: boolean
  subagent: string
  /**
   * The session the original Run recorded. Carried only for a replayed Unit's receipt: the Unit itself keeps
   * `sessionID: null` (it did not run in this Run), while the receipt can still read the evidence the original
   * session left behind.
   */
  sessionID?: string
}

/** What a previous Run recorded, for resume. Keyed by Unit ordinal (start order). */
export interface ReplayPlan {
  units: Map<number, ReplayUnit>
  /** Answers to `ctx.ask`, in the order they were asked; `null` means the author's fallback was used. */
  answers: Array<string[][] | null>
  rerunFailed: boolean
  /** Set once the script diverges from the record; from then on everything runs live. */
  diverged: boolean
  onDiverge?: (message: string) => void
}

export interface CreateContextInput<A> {
  host: EngineHost
  index: UnitIndex
  runId: string
  workflow: string
  location: string
  parentSessionID: string
  args: A
  state: EngineState
  events?: EngineEvents
  concurrency?: number
  budget?: number | null
  hardBudget?: boolean
  signal?: AbortSignal
  unitTimeout?: number
  /** Publish `ctx.ask` (the broker). Absent ⇒ the fallback answers at once — the headless contract. */
  ask?: (form: AskQuestion[], options: AskOptions) => Promise<string[][]>
  /** Route a Unit model's `workflow_question` call to the broker. */
  askAgent?: (unitId: string, sessionID: string) => UnitBinding["ask"]
  permissionPolicy?: UnitBinding["permissionPolicy"]
  /** Workflow-level rules applied to every Unit session. */
  permissions?: HostPermissionRule[]
  limits?: Partial<RunLimits>
  /** A limit was hit: the orchestrator stops the Run with this message. */
  onLimit?: (message: string) => void
  replay?: ReplayPlan
  /** Share another context's limiter (a nested Workflow runs under its parent's concurrency cap). */
  limiter?: Semaphore
  /** Prefix for Unit labels and phase titles (a nested Workflow's `name › `). */
  prefix?: string
  /** Cross-Run Unit slots (process-wide limiter). */
  slot?: (providerID: string | undefined, signal: AbortSignal) => Promise<() => void>
  /** Extra context members (capabilities) merged onto the context. */
  extend?: Record<string, unknown>
}

function newUnit(input: {
  runId: string
  unitId: string
  ordinal: number
  label: string | null
  subagent: string
  phase: string | null
  prompt: string
  model: string | null
  schema: boolean
}): Unit {
  return {
    unitId: input.unitId,
    runId: input.runId,
    ordinal: input.ordinal,
    label: input.label,
    subagent: input.subagent,
    phase: input.phase,
    status: "queued",
    sessionID: null,
    location: null,
    prompt: input.prompt,
    model: { requested: input.model, resolved: null },
    schema: input.schema,
    resultPath: null,
    attempts: [],
    usage: emptyUsage(),
    startedAt: null,
    endedAt: null,
  }
}

const noAgentQuestions: UnitBinding["ask"] = async () => null

/** A Unit could not be set up (e.g. no worktree): it fails as a value like any other Unit. */
class UnitSetupError extends Error {}

export function createWorkflowContext<A>(input: CreateContextInput<A>): WorkflowContext<A> {
  const { state, events } = input
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...input.limits }
  const concurrency = Number.isFinite(input.concurrency) ? (input.concurrency as number) : defaultConcurrency()
  const limiter = input.limiter ?? new Semaphore(concurrency)
  const prefix = input.prefix ?? ""
  const signal = input.signal ?? new AbortController().signal
  const budgetTotal = input.budget == null ? null : input.budget
  const budget: WorkflowContext<A>["budget"] = {
    total: budgetTotal,
    spent: () => state.tokensSpent,
    remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - state.tokensSpent)),
  }
  let limitHit = false
  const hitLimit = (message: string) => {
    if (limitHit) return
    limitHit = true
    state.logs.push(message)
    input.onLimit?.(message)
  }
  const emit = (unit: Unit) => events?.onUnit?.({ ...unit, model: { ...unit.model }, attempts: [...unit.attempts] })

  const replayed = (
    unit: Unit,
    record: NonNullable<ReturnType<ReplayPlan["units"]["get"]>>,
    schema: z.ZodType | undefined,
  ): { value: unknown } | null => {
    if (record.status !== "succeeded" && record.status !== "replayed") return null
    if (record.output === undefined) return { value: schema ? null : "" }
    if (!schema) return { value: record.output }
    try {
      const parsed = schema.safeParse(JSON.parse(record.output))
      return parsed.success ? { value: parsed.data } : null
    } catch {
      return null
    }
  }

  const runOne = async (prompt: string, opts: AgentOpts<z.ZodType> = {}) => {
    state.unitCount += 1
    const ordinal = state.unitCount
    const unitId = crypto.randomUUID()
    const subagent = opts.subagent ?? opts.agentType ?? DEFAULT_SUBAGENT
    const phase = opts.phase !== undefined ? `${prefix}${opts.phase}` : state.currentPhase
    const label = opts.label ? `${prefix}${opts.label}` : prefix ? `${prefix}${subagent}` : null
    const model = toHostModel(opts.model)
    const withVariant = model && opts.effort && !model.variant ? { ...model, variant: opts.effort } : model
    /** The session the Unit settled with, once one exists — where a receipt reads its calls from. For a replayed
     * Unit this is the session the ORIGINAL Run recorded (see the replay branch below), never a new one. */
    let sessionID: string | null = null
    /** Set when this Unit comes back from the previous Run's record (replay), so its receipt reads the old session. */
    let wasReplayed = false
    /** Every return goes through here: the value `agent()` returns, plus what a receipt carries. */
    const outcome = (value: unknown): UnitOutcome => ({ value, unitId, label, sessionID, replayed: wasReplayed })
    let schema: z.ZodType | undefined
    try {
      schema = resolveJsonSchema(opts.schema)
    } catch (error) {
      const message = `agent({ schema }) is not a zod schema or a JSON Schema: ${stringifyError(error)}`
      state.errors.push({ unit: label ?? subagent, prompt, subagent, error: message })
      return outcome(null)
    }
    const unit = newUnit({
      runId: input.runId,
      unitId,
      ordinal,
      label,
      subagent,
      phase,
      prompt,
      model: formatModel(withVariant),
      schema: schema !== undefined,
    })

    if (ordinal > limits.maxUnits) {
      hitLimit(`limit reached: this Run tried to start more than ${limits.maxUnits} Units (limits.maxUnits)`)
    }
    if (input.hardBudget && budgetTotal !== null && state.tokensSpent >= budgetTotal) {
      hitLimit(`budget exhausted: ${state.tokensSpent} of ${budgetTotal} output tokens spent (meta.budget, hard)`)
    }

    // Resume: a Unit the previous Run already finished comes back from the record, in start order.
    const plan = input.replay
    if (plan && !plan.diverged) {
      const record = plan.units.get(ordinal)
      if (record && record.prompt === prompt) {
        const value = replayed(unit, record, schema)
        if (value) {
          const done: Unit = {
            ...unit,
            status: "replayed",
            resultPath: "replay",
            output: toUnitOutput(value.value),
            startedAt: Date.now(),
            endedAt: Date.now(),
          }
          emit(done)
          // The replayed Unit's receipt reads the ORIGINAL session's calls; the Unit itself stays `sessionID: null`.
          wasReplayed = true
          sessionID = record.sessionID ?? null
          return outcome(value.value)
        }
        if (!plan.rerunFailed) {
          const error = "replayed failure from the resumed Run"
          emit({ ...unit, status: "failed", error, startedAt: Date.now(), endedAt: Date.now() })
          state.errors.push({ unit: label ?? subagent, prompt, subagent, error })
          // A failed Unit's receipt is still its evidence — and this one did not run here, so it reads the ORIGINAL
          // session exactly like a replayed success. `value` stays `null`: the failure is the recorded truth.
          wasReplayed = true
          sessionID = record.sessionID ?? null
          return outcome(null)
        }
      } else if (record) {
        plan.diverged = true
        plan.onDiverge?.(
          `resume diverged at Unit ${ordinal}: the script asked for a different prompt than the recorded Run; running live from here`,
        )
      }
    }

    emit(unit)
    try {
      const value = await limiter.run(async () => {
        let current: Unit = { ...unit, status: "running", startedAt: Date.now() }
        emit(current)
        let worktree: { directory: string; branch: string | null; base: string | null } | null = null
        if (opts.isolation === "worktree" && !opts.location) {
          if (!input.host.worktree) throw new UnitSetupError('isolation: "worktree" is not available on this host')
          try {
            worktree = await input.host.worktree.create(`wf-${input.runId.slice(0, 8)}-${ordinal}`)
          } catch (error) {
            throw new UnitSetupError(`could not create a worktree: ${stringifyError(error)}`)
          }
        }
        const unitLocation = opts.location ?? worktree?.directory
        const result: UnitRunResult = await runUnit(input.host, input.index, {
          runId: input.runId,
          unitId,
          workflow: input.workflow,
          location: input.location,
          ...(unitLocation ? { unitLocation } : {}),
          ...(unitLocation && input.host.worktree
            ? {
                checkLocation: async (directory: string) =>
                  (await input.host.worktree!.pluginActive(directory))
                    ? null
                    : `the workflow plugin is not active in ${directory}; configure it in a committed opencode.json (or globally) so Units there can use it`,
              }
            : {}),
          parentSessionID: input.parentSessionID,
          ordinal,
          prompt,
          subagent,
          label,
          ...(withVariant ? { model: withVariant } : {}),
          ...(schema ? { schema } : {}),
          ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
          ...((opts.timeoutMs ?? input.unitTimeout) ? { timeoutMs: opts.timeoutMs ?? input.unitTimeout } : {}),
          signal,
          ...(input.slot ? { slot: input.slot } : {}),
          maxSteps: limits.maxUnitSteps,
          permissions: [...(input.permissions ?? []), ...(opts.permissions ?? [])],
          ask: noAgentQuestions,
          permissionPolicy: input.permissionPolicy ?? (() => "deny"),
          onSession: (id, stop, resolved) => {
            sessionID = id
            current = {
              ...current,
              sessionID: id,
              location: unitLocation ?? input.location,
              model: { requested: current.model.requested, resolved: formatModel(resolved) },
            }
            const binding = input.index.get(id)
            if (binding && input.askAgent) binding.ask = input.askAgent(unitId, id)
            emit(current)
            events?.onUnitSession?.(unitId, id, stop)
          },
          ...(input.hardBudget && budgetTotal !== null
            ? { mayContinue: (unitOutput: number) => state.tokensSpent + unitOutput < budgetTotal }
            : {}),
          onRepairing: () => {
            current = { ...current, status: "repairing" }
            emit(current)
          },
        })

        if (worktree && input.host.worktree) {
          const tree = worktree
          const changed = await input.host.worktree.changed(tree.directory, tree.base).catch(() => true)
          if (changed) {
            state.worktrees.push({ unit: label ?? subagent, directory: tree.directory, branch: tree.branch })
            events?.onLog?.(
              `kept worktree ${tree.directory}${tree.branch ? ` (branch ${tree.branch})` : ""} for ${label ?? subagent}`,
            )
          } else {
            await input.host.worktree.remove(tree.directory).catch(() => {})
          }
        }
        const usage = result.usage
        state.usage = {
          tokens: {
            input: state.usage.tokens.input + usage.tokens.input,
            output: state.usage.tokens.output + usage.tokens.output,
            reasoning: state.usage.tokens.reasoning + usage.tokens.reasoning,
            cacheRead: state.usage.tokens.cacheRead + usage.tokens.cacheRead,
            cacheWrite: state.usage.tokens.cacheWrite + usage.tokens.cacheWrite,
          },
          cost: state.usage.cost + usage.cost,
        }
        state.tokensSpent += usage.tokens.output
        // The session this Unit settled with — the same value `onSession` and the settled Unit carry. A Unit whose
        // session never existed (a replay, a setup failure) keeps `null`.
        sessionID = result.sessionID ?? current.sessionID
        const settled: Unit = {
          ...current,
          sessionID,
          status: result.ok ? "succeeded" : result.stopped ? "stopped" : "failed",
          model: { requested: current.model.requested, resolved: formatModel(result.model) },
          resultPath: result.ok ? result.path : null,
          attempts: result.attempts,
          usage,
          endedAt: Date.now(),
          ...(result.ok ? { output: toUnitOutput(result.value) } : { error: result.error }),
        }
        emit(settled)
        if (input.hardBudget && budgetTotal !== null && state.tokensSpent >= budgetTotal) {
          hitLimit(`budget exhausted: ${state.tokensSpent} of ${budgetTotal} output tokens spent (meta.budget, hard)`)
        }
        if (result.ok) return result.value
        state.errors.push({ unit: label ?? subagent, prompt, subagent, error: result.error })
        return null
      }, signal)
      return outcome(value)
    } catch (err) {
      if (err instanceof UnitSetupError) {
        emit({ ...unit, status: "failed", error: err.message, endedAt: Date.now() })
        state.errors.push({ unit: label ?? subagent, prompt, subagent, error: err.message })
        return outcome(null)
      }
      if (err instanceof AbortError) {
        const error = stringifyError(err)
        emit({ ...unit, status: "stopped", error, endedAt: Date.now() })
        state.errors.push({ unit: label ?? subagent, prompt, subagent, error })
        return outcome(null)
      }
      throw err
    }
  }

  /**
   * The one trace of a replayed Unit whose evidence is unavailable. `[]` on its own reads exactly like "the Unit
   * called no tools", so a Run notice is the only way the author (or whoever reads the Run later) can tell. A notice,
   * not `state.errors`: the Unit did not drop, and no Run outcome may change.
   *
   * Guarded because reporting a failure must never become one: a host logger that throws would turn a promised `[]`
   * into the rejection this whole path exists to prevent.
   */
  const noteUnknown = (outcome: UnitOutcome, reason: string): void => {
    try {
      events?.onLog?.(
        `replayed Unit ${outcome.label ?? outcome.unitId}: its tool calls are unknown, not "none" — ${reason}`,
      )
    } catch {
      // A logger this hostile has nothing to add to the Run's state.
    }
  }

  /**
   * Read the tool calls a Unit's session recorded, straight from the host transcript — never from the model's own
   * account of what it did.
   *
   * The two paths deliberately differ, because they answer different questions:
   *
   * - A Unit that ran in THIS Run: a session that cannot be READ throws instead of reporting no calls. The session has
   *   just been used, so a read failure is a surprise, and an assertion like "the migration really ran" must never
   *   pass on one.
   * - A Unit replayed from a previous Run: anything that goes wrong yields `[]` (unknown), never a throw — a failed
   *   read AND a transcript whose shape the host never promised. That session may legitimately be gone (another
   *   process, another machine, another project, a reset database), and failing here would break a resumed Workflow
   *   that worked before this evidence was readable at all. The replayed path is best-effort by contract; the live
   *   path stays strict.
   */
  const readToolCalls = async (outcome: UnitOutcome, sessionID: string): Promise<UnitToolCall[]> => {
    // A replayed Unit's evidence can never fail the resumed Run, so every step below is guarded by this flag.
    const bestEffort = outcome.replayed
    let messages: readonly HostMessage[]
    try {
      messages = await input.host.session.context({ sessionID })
    } catch (error) {
      if (bestEffort) {
        noteUnknown(outcome, `its original session could not be read (${stringifyError(error)})`)
        return []
      }
      throw new Error(
        `agent({ receipts }): reading the session of Unit ${outcome.label ?? outcome.unitId} failed: ${stringifyError(error)}`,
        { cause: error },
      )
    }
    try {
      const calls: UnitToolCall[] = []
      for (const message of messages) {
        for (const part of message.content ?? []) {
          if (part.type !== "tool") continue
          calls.push({
            name: part.name ?? "tool",
            input: clipToolText(toolText(part.state?.input)),
            // Deliberately differs from `toTranscript`: a receipt falls back to the call's error message, the Gateway
            // transcript shows the host's raw text.
            output: clipToolText(toolText(part.state?.content) || (part.state?.error?.message ?? "")),
            successful: part.state?.status === "completed" && !part.state?.error,
          })
        }
      }
      return calls
    } catch (error) {
      // The host resolved something the type says it cannot (no list, a message whose `content` is not a list). On the
      // live path that is a real error; on the replayed path it must not become a rejection either.
      if (bestEffort) {
        noteUnknown(outcome, "the host returned a transcript the engine cannot read")
        return []
      }
      throw error
    }
  }

  /**
   * The receipt `agent(…, { receipts: true })` resolves to. `toolCalls` is a lazily memoized getter: the transcript is
   * read on first access and never before, so a Workflow that only wants the value pays nothing. A Unit that never
   * had a session (a setup failure, a Unit skipped before creating one) has nothing to read and reports `[]` without
   * a host call; a replayed Unit instead carries the id the original Run recorded, so its receipt can still read the
   * earlier session — and reports `[]` (unknown) when that session is gone or cannot be read.
   */
  const receiptOf = (outcome: UnitOutcome): UnitReceipt<unknown> => {
    const { sessionID } = outcome
    let toolCalls: Promise<UnitToolCall[]> | undefined
    const receipt = { value: outcome.value, unitId: outcome.unitId } as UnitReceipt<unknown>
    Object.defineProperty(receipt, "toolCalls", {
      // NON-ENUMERABLE, deliberately: a receipt is often just `return`ed, and everything downstream of a Run
      // serializes its result (`previewResult` for the store, `result.json` in the journal, `JSON.stringify` in a
      // script). An enumerable getter would be read by every one of those — a transcript read nobody asked for, and
      // `JSON.stringify` would journal `"toolCalls": {}` (a promise is not JSON), which is evidence-shaped but empty.
      // The trade-off is that `{ ...receipt }` does not copy `toolCalls`; copying a lazy promise like that would be
      // useless anyway. `structuredClone(receipt)` works, and yields `{ value, unitId }`.
      enumerable: false,
      configurable: true,
      get() {
        if (!toolCalls) {
          if (!sessionID && outcome.replayed) {
            // Nothing to read at all: a replayed Unit whose Run recorded no session for it. Neutral wording on purpose —
            // it may never have created one, or the Run that did may no longer be journaled. Still unknown, still
            // reported, never silently "no tools".
            noteUnknown(
              outcome,
              "no session is recorded for it (it never created one, or its Run is no longer journaled)",
            )
          }
          toolCalls = sessionID ? readToolCalls(outcome, sessionID) : Promise.resolve([])
          // A guard, not a swallow: an awaiting author still gets the rejection, but an incidental read of this
          // property can never leave it unhandled.
          toolCalls.catch(() => {})
        }
        return toolCalls
      },
    })
    return receipt
  }

  const agent = ((prompt: string, opts: AgentOpts<z.ZodType> & { receipts?: boolean } = {}) => {
    // `receipts` is engine-level only: it decides what `agent()` RESOLVES to, and never reaches the Unit's options.
    const { receipts, ...unitOpts } = opts
    const task = runOne(prompt, unitOpts)
    const result = receipts ? task.then(receiptOf) : task.then((outcome) => outcome.value)
    // Track and return the SAME promise. The author may never await it (fire-and-forget Units are supported), so the
    // tracked promise has to be the one they hold: an unhandled rejection is marked handled here, and the drain in
    // `runWorkflow`'s `finally` waits for exactly what ran — not a copy of it that settles a microtask later.
    state.inflight.add(result)
    result.finally(() => state.inflight.delete(result)).catch(() => {})
    return result
  }) as WorkflowContext<A>["agent"]

  const checkItems = (count: number, what: string) => {
    if (count > limits.maxItemsPerCall) {
      throw new Error(
        `limit reached: ${what} got ${count} items; the limit is ${limits.maxItemsPerCall} (limits.maxItemsPerCall)`,
      )
    }
  }

  const parallel: WorkflowContext<A>["parallel"] = async (thunks) => {
    checkItems(thunks.length, "parallel")
    const settled = await Promise.allSettled(thunks.map((thunk) => thunk()))
    return settled.map((r, index) => {
      if (r.status === "fulfilled") return r.value
      state.errors.push({
        unit: `parallel#${index}`,
        prompt: "(unavailable: the parallel thunk threw outside agent())",
        subagent: "(unknown)",
        error: stringifyError(r.reason),
      })
      return null
    })
  }

  const pipeline = (async (
    items: unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>
  ) => {
    checkItems(items.length, "pipeline")
    const runItem = async (item: unknown, index: number) => {
      let value: unknown = item
      for (const stage of stages) {
        try {
          value = await stage(value, item, index)
        } catch (err) {
          state.errors.push({
            unit: `pipeline#${index}`,
            prompt: "(unavailable: a pipeline stage threw outside agent())",
            subagent: "(unknown)",
            error: stringifyError(err),
          })
          return null
        }
      }
      return value
    }
    return Promise.all(items.map((item, index) => runItem(item, index)))
  }) as WorkflowContext<A>["pipeline"]

  function collect<T>(xs: Array<T | null>): T[] {
    return xs.filter((x): x is T => x !== null)
  }

  const log: WorkflowContext<A>["log"] = (message) => {
    state.logs.push(message)
    events?.onLog?.(message)
  }

  const phase: WorkflowContext<A>["phase"] = (raw) => {
    const title = `${prefix}${raw}`
    state.currentPhase = title
    state.phases.push(title)
    events?.onPhase?.(title)
  }

  const ask: WorkflowContext<A>["ask"] = async (form, options) => {
    const questions = Array.isArray(form) ? form : [form]
    if (questions.length === 0) return []
    const plan = input.replay
    if (plan && !plan.diverged && plan.answers.length > 0) {
      const recorded = plan.answers.shift()!
      const { coerceAnswers, toInteractionQuestions } = await import("./broker")
      const coerced = coerceAnswers(toInteractionQuestions(questions), recorded ?? options.fallback)
      if (coerced) return coerced
      plan.diverged = true
      plan.onDiverge?.(
        "resume diverged at a ctx.ask: the recorded answer does not fit the question; asking live from here",
      )
    }
    if (!input.ask) {
      const { coerceAnswers, toInteractionQuestions } = await import("./broker")
      const fallback = coerceAnswers(toInteractionQuestions(questions), options.fallback)
      if (!fallback) {
        throw new Error(
          "ctx.ask: `fallback` must have one entry per question, each drawn from that question's offered labels",
        )
      }
      return fallback
    }
    return input.ask(questions, options)
  }

  return {
    ...createCapabilities({
      location: input.location,
      signal,
      audit: () => {},
      disabled: "capabilities are only available inside a Run",
    }),
    ...input.extend,
    agent,
    ask,
    parallel,
    pipeline,
    collect,
    get errors() {
      return state.errors
    },
    args: input.args,
    log,
    phase,
    budget,
    signal,
    worktrees: () => state.worktrees.map((entry) => ({ ...entry })),
  } as unknown as WorkflowContext<A>
}
