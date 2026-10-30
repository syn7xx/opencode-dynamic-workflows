/**
 * The GUI plugin's data layer: one controller per location, over the shared workflow RPC (protocol v1).
 *
 * It reuses the same host-agnostic core the TUI does (`src/ui/`): `WorkflowSync` keeps a `SyncState` current, the
 * actions call the same RPC methods. Nothing here is DOM- or terminal-specific, so it stays testable and small.
 *
 * A controller is reactive (Solid signals) and long-lived: it holds the event subscription, the attach heartbeat
 * that says "a person is here", and a 1 s tick that keeps elapsed times moving while a Run is live. `dispose`
 * detaches, stops the timers and aborts the subscription.
 */
import type { OpenCodeClient } from "@opencode/client/promise"
import { createSignal, type Accessor } from "solid-js"

import type { PendingInteraction, Run, Unit, WorkflowListing } from "../protocol"
import { WorkflowRpc } from "../service/rpc"
import { bindApi, errorText, type WorkflowApi } from "../ui/api"
import { cleanupPending, cleanupRun, type CleanupOutcome } from "../ui/cleanup"
import { anyLive, emptyState, type SyncState } from "../ui/state"
import { WorkflowSync } from "../ui/sync"

const HEARTBEAT_MS = 20_000
const ATTACH_TTL_MS = 45_000

export interface ControllerDeps {
  readonly client: OpenCodeClient
  /** The canonical location directory; undefined binds the RPC to the server's default location. */
  readonly directory: string | undefined
  /** A stable per-window id prefix for the attach surface. */
  readonly pluginId: string
  /** Aborts when the plugin is reloaded or the window closes. */
  readonly signal: AbortSignal
  /** What a Run raised: a question awaiting a person (with the interaction), or a Run that ended. */
  readonly onNotice?: (notice: { run: Run; interaction?: PendingInteraction; ended: boolean }) => void
}

/** A one-use pairing code from `POST /v1/pair`. */
export type PairingCode = { code: string; expiresAt: number; url: string }

export class WorkflowController {
  readonly state: Accessor<SyncState>
  readonly error: Accessor<string | null>
  readonly saved: Accessor<readonly WorkflowListing[]>
  readonly now: Accessor<number>
  readonly webUrl: Accessor<string | null>

  private readonly deps: ControllerDeps
  private readonly api: WorkflowApi
  private readonly sync: WorkflowSync
  private readonly surface: string
  private readonly setState: (value: SyncState) => SyncState
  private readonly setError: (value: string | null) => string | null
  private readonly setSaved: (value: readonly WorkflowListing[]) => readonly WorkflowListing[]
  private readonly setNow: (value: number) => number
  private readonly setWebUrl: (value: string | null) => string | null
  private savedLoads = 0
  private beat: ReturnType<typeof setInterval> | undefined
  private tick: ReturnType<typeof setInterval> | undefined

  constructor(deps: ControllerDeps) {
    this.deps = deps
    this.surface = `gui:${deps.pluginId}:${Math.random().toString(36).slice(2, 10)}`
    const location = deps.directory ? { directory: deps.directory } : undefined
    const { api, events } = bindApi(deps.client.rpc(WorkflowRpc as never), location)
    this.api = api
    const [state, setState] = createSignal<SyncState>(emptyState())
    const [error, setError] = createSignal<string | null>(null)
    const [saved, setSaved] = createSignal<readonly WorkflowListing[]>([])
    const [now, setNow] = createSignal<number>(Date.now())
    const [webUrl, setWebUrl] = createSignal<string | null>(null)
    this.state = state
    this.error = error
    this.saved = saved
    this.now = now
    this.webUrl = webUrl
    this.setState = setState
    this.setError = setError
    this.setSaved = setSaved
    this.setNow = setNow
    this.setWebUrl = setWebUrl
    this.sync = new WorkflowSync({
      api,
      events,
      onState: (next) => {
        this.setState(next)
        this.setWebUrl(next.webUrl ?? null)
      },
      onNotice: (effect) => {
        const run = this.sync.current.runs[effect.runId]?.run
        if (!run) return
        this.deps.onNotice?.({
          run,
          ...(effect.kind === "waiting" ? { interaction: effect.interaction } : {}),
          ended: effect.kind === "ended",
        })
      },
      onError: (message) => this.setError(message),
    })
  }

  /** Start reading the location: subscribe, snapshot, and open the heartbeat. */
  start(): void {
    void this.sync.start()
    void this.heartbeat()
    void this.loadSaved()
    this.beat = setInterval(() => void this.heartbeat(), HEARTBEAT_MS)
    this.tick = setInterval(() => {
      if (anyLive(this.sync.current)) this.setNow(Date.now())
    }, 1_000)
    this.deps.signal.addEventListener("abort", () => this.dispose(), { once: true })
  }

  dispose(): void {
    if (this.beat) clearInterval(this.beat)
    if (this.tick) clearInterval(this.tick)
    this.beat = undefined
    this.tick = undefined
    void this.api.detach({ surface: this.surface }).catch(() => {})
    this.sync.stop()
  }

  // --- reads -------------------------------------------------------------------------------------------------

  async refresh(): Promise<void> {
    await Promise.all([this.sync.resync("refresh"), this.loadSaved()])
  }

  open(runId: string): Promise<void> {
    return this.sync.open(runId)
  }

  /** Reload a Unit with its full output (the snapshot may elide it). Null when the read fails. */
  async loadUnit(runId: string, unitId: string): Promise<Unit | null> {
    try {
      return (await this.api.getUnit({ runId, unitId })).unit
    } catch {
      return null
    }
  }

  /** Re-read the saved (durable) Workflows; keeps only the newest overlapping load's answer. */
  async loadSaved(): Promise<void> {
    const load = ++this.savedLoads
    try {
      const { workflows } = await this.api.listWorkflows()
      if (load === this.savedLoads) this.setSaved(workflows)
    } catch (error) {
      if (load === this.savedLoads) this.setError(`saved Workflows: ${errorText(error)}`)
    }
  }

  // --- actions -----------------------------------------------------------------------------------------------

  /** Run `work`, reporting a failure on the shared error line; undefined on failure. */
  private async guard<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work()
    } catch (error) {
      this.setError(`${label}: ${errorText(error)}`)
      return undefined
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.api.attach({ surface: this.surface, ttlMs: ATTACH_TTL_MS })
    } catch (error) {
      if (!this.deps.signal.aborted) this.setError(`attach: ${errorText(error)}`)
    }
    await this.sync.poll()
  }

  async startSaved(name: string, parentSessionID?: string): Promise<string | null> {
    return (
      (
        await this.guard("Start", () =>
          this.api.startRun({ name, args: {}, ...(parentSessionID ? { parentSessionID } : {}) }),
        )
      )?.runId ?? null
    )
  }

  async stopRun(runId: string): Promise<void> {
    await this.guard("Stop", () => this.api.stopRun({ runId }))
  }

  async resumeRun(runId: string): Promise<string | null> {
    return (await this.guard("Resume", () => this.api.resumeRun({ runId })))?.runId ?? null
  }

  /** Save the Run's script as a durable Workflow, then reload the saved list. Null on failure. */
  async saveRun(runId: string, name?: string): Promise<{ key: string; path: string } | null> {
    const saved = await this.guard("Save", () => this.api.saveRun({ runId, ...(name ? { name } : {}) }))
    if (saved) await this.loadSaved()
    return saved ?? null
  }

  async stopUnit(runId: string, unitId: string): Promise<void> {
    await this.guard("Stop Unit", () => this.api.stopUnit({ runId, unitId }))
  }

  async restartUnit(runId: string, unitId: string): Promise<void> {
    await this.guard("Restart Unit", () => this.api.restartUnit({ runId, unitId }))
  }

  /** Delete one terminal Run's Unit sessions; `remove` is the host's `session.remove`. Null on failure. */
  async cleanupRun(run: Run, remove: (sessionID: string) => Promise<void>): Promise<CleanupOutcome | null> {
    const outcome = await this.guard("Clean up", () => cleanupRun(run, { api: this.api, remove }))
    if (outcome) await this.sync.hydrate(run.runId)
    return outcome ?? null
  }

  /** Delete the Unit sessions of every finished Run marked for cleanup. Null on failure. */
  async cleanupPending(remove: (sessionID: string) => Promise<void>): Promise<CleanupOutcome[] | null> {
    const finished = Object.values(this.sync.current.runs)
      .map((slot) => slot.entry)
      .filter((entry) => !entry.live)
    const outcomes = await this.guard("Clean up", () => cleanupPending(finished, { api: this.api, remove }))
    if (outcomes) await this.sync.resync("cleanup")
    return outcomes ?? null
  }

  async pair(): Promise<PairingCode | null> {
    return (await this.guard("Pair", () => this.api.pair())) ?? null
  }

  // --- answers -----------------------------------------------------------------------------------------------

  /** Answer a pending interaction. Resolves to an error message, or null when the answer was accepted. */
  async reply(runId: string, interactionId: string, answers: string[][]): Promise<string | null> {
    try {
      await this.api.replyInteraction({ runId, interactionId, answers })
      return null
    } catch (error) {
      return errorText(error)
    }
  }

  /** Dismiss a pending interaction. Resolves to an error message, or null when it was dismissed. */
  async dismiss(runId: string, interactionId: string): Promise<string | null> {
    try {
      await this.api.cancelInteraction({ runId, interactionId })
      return null
    } catch (error) {
      return errorText(error)
    }
  }
}
