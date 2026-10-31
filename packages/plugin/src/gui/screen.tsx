/**
 * The Workflows screen for the GUI panel: it owns the navigation stack (`src/ui/nav.ts`), the cursor and answer mode,
 * and composes the four views — `library.tsx`, `run.tsx`, `unit.tsx`, `answer.tsx`. It mirrors the TUI's screen
 * (`src/tui/views.tsx`) in DOM/Solid: the same shared core (`src/ui/`), only the rendering differs.
 */
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"

import type { LibraryEntry, PendingInteraction, WorkflowListing } from "../protocol"
import { confirm, pick, startAnswer, submitText, toggle, type AnswerState, type AnswerStep } from "../ui/answer"
import { savedArgs, shortId, unitName, workflowName, type Tone } from "../ui/format"
import {
  current,
  cursor,
  cycleFilter,
  filterEntries,
  initialNav,
  pop,
  popTo,
  push,
  setCursor,
  type Nav,
} from "../ui/nav"
import type { AnswerBindings } from "./answer"
import type { PluginContext } from "./context"
import { replyInteraction, startSaved, useSaved } from "./flows"
import { LibraryPane } from "./library"
import type { WorkflowController } from "./model"
import { RunPane } from "./run"
import { UnitPane } from "./unit"

export interface ScreenProps {
  ctx: PluginContext
  controller: WorkflowController
  /** Library rows: every Run of the location (page) or of one session (panel). */
  entries: Accessor<LibraryEntry[]>
  /** Saved Workflows, listed after the Runs. */
  saved: Accessor<readonly WorkflowListing[]>
  title: string
  /** The server that hosts this panel's sessions, for opening a Unit's or the Run's session as a tab. */
  serverID?: string
  /** The session the panel is scoped to, for a saved Workflow's "run in session" action. */
  originSessionID?: string
  /**
   * A Run to open on (and, with `answer`, straight into its pending question). Changing it re-seeds the navigation,
   * as the TUI's `start` does — how the composer badge jumps to the Run it stands for. `at` makes a repeat of the
   * same target a distinct change, so re-clicking the badge re-enters answer mode.
   */
  start?: Accessor<{ runId?: string; answer?: boolean; at?: number } | undefined>
  onClose: () => void
}

export function WorkflowsScreen(props: ScreenProps) {
  const ctx = props.ctx
  const controller = props.controller
  const initial = () => {
    const start = props.start?.()
    return initialNav(start?.runId ? { runId: start.runId } : {})
  }
  const [nav, setNav] = createSignal<Nav>(initial())
  const [answer, setAnswer] = createSignal<AnswerState | null>(null)
  const [autoAnswer, setAutoAnswer] = createSignal(props.start?.()?.answer === true)
  const [typingText, setTypingText] = createSignal("")
  const [note, setNote] = createSignal<{ text: string; tone: Tone } | null>(null)
  const [sending, setSending] = createSignal(false)

  const view = () => current(nav())
  const viewRunId = () => {
    const v = view()
    return v.kind === "library" ? null : v.runId
  }
  const slot = () => {
    const runId = viewRunId()
    return runId ? controller.state().runs[runId] : undefined
  }
  const run = () => slot()?.run ?? null
  const entries = createMemo(() =>
    filterEntries(props.entries(), nav().filter).toSorted((a, b) => Number(b.live) - Number(a.live)),
  )
  // Saved Workflows follow the Runs under the "all" filter; one cursor walks both.
  const saved = () => (nav().filter === "all" ? props.saved() : [])
  const libraryRows = () => entries().length + saved().length
  const selectedSaved = (): WorkflowListing | undefined => {
    if (view().kind !== "library") return undefined
    const index = cursor(nav(), libraryRows()) - entries().length
    return index >= 0 ? saved()[index] : undefined
  }
  const units = () => run()?.units ?? []
  const viewUnit = () => {
    const v = view()
    return v.kind === "unit" ? run()?.units.find((unit) => unit.unitId === v.unitId) : undefined
  }
  const pendingInteraction = () => {
    const state = answer()
    return state ? run()?.interactions.find((candidate) => candidate.interactionId === state.interactionId) : undefined
  }
  // The bindings the answer view renders: built once from the current answer state and the screen's callbacks.
  const answerBindings = createMemo<AnswerBindings | null>(() => {
    const state = answer()
    if (!state) return null
    return {
      state,
      interaction: pendingInteraction()!,
      sending: sending(),
      typing: typingText(),
      onTyping: setTypingText,
      onMove: (index) => setAnswer({ ...state, cursor: index }),
      onPick: (index) => {
        // A `multiple` question toggles the row; a single choice takes it and advances.
        if (state.questions[state.index]?.multiple) setAnswer(toggle({ ...state, cursor: index }))
        else void step(pick(state, index + 1))
      },
      onConfirm: () => void step(confirm(state)),
      onText: (text) => {
        void step(submitText(state, text))
        setTypingText("")
      },
      onDismiss: () => void dismissAnswer(),
    }
  })

  // A Run view reads the Run in full (and its activity) when it opens.
  createEffect(
    on(viewRunId, (runId) => {
      if (runId) void controller.open(runId).catch(() => {})
    }),
  )
  // A navigation change clears the last note; leave answer mode if the interaction was settled elsewhere.
  createEffect(
    on(
      () => JSON.stringify(view()),
      () => setNote(null),
      { defer: true },
    ),
  )
  createEffect(() => {
    if (answer() && run() && !pendingInteraction() && !sending()) {
      setAnswer(null)
      setNote({ text: ctx.t("ask.settledElsewhere"), tone: "muted" })
    }
  })
  // A new `start` (the composer badge jumping to a Run) re-seeds the navigation and enters answer mode when asked.
  createEffect(
    on(
      () => JSON.stringify(props.start?.() ?? {}),
      () => {
        setNav(initial())
        setAnswer(null)
        setAutoAnswer(props.start?.()?.answer === true)
      },
      { defer: true },
    ),
  )
  // `/workflows answer` and the composer badge open a Run straight into answer mode.
  createEffect(() => {
    const shown = run()
    if (!autoAnswer() || !shown) return
    const first = shown.interactions[0]
    if (first) beginAnswer(first)
    setAutoAnswer(false)
  })

  function beginAnswer(interaction: PendingInteraction | undefined) {
    if (!interaction) return
    setNote(null)
    setTypingText("")
    setAnswer(startAnswer(interaction))
  }

  async function step(result: AnswerStep) {
    setAnswer(result.state)
    if (!result.submit) return
    const interaction = pendingInteraction()
    if (!interaction) {
      setAnswer(null)
      return
    }
    setSending(true)
    const error = await replyInteraction(ctx, controller, interaction, result.submit)
    setSending(false)
    if (error) {
      setNote({ text: ctx.t("ask.notSent", { error }), tone: "error" })
      setAnswer(startAnswer(interaction))
      return
    }
    setAnswer(null)
    setNote({ text: ctx.t("ask.answerSent"), tone: "success" })
  }

  async function dismissAnswer() {
    const interaction = pendingInteraction()
    if (!interaction) return
    setSending(true)
    const error = await replyInteraction(ctx, controller, interaction, null)
    setSending(false)
    setAnswer(null)
    setNote(
      error
        ? { text: ctx.t("ask.notDismissed", { error }), tone: "error" }
        : { text: ctx.t("ask.dismissed"), tone: "muted" },
    )
  }

  const openSelectedUnit = () => {
    const v = view()
    if (v.kind !== "run") return
    const unit = units()[cursor(nav(), units().length)]
    if (unit) setNav(push(nav(), { kind: "unit", runId: v.runId, unitId: unit.unitId }))
  }

  function goBack() {
    const previous = pop(nav())
    if (previous) setNav(previous)
    else props.onClose()
  }

  /** Jump back to a breadcrumb: drop every view above it, keeping the one clicked. */
  function goToDepth(depth: number) {
    setNav(popTo(nav(), depth))
  }

  /** Open a session (a Unit's transcript, or the Run's parent) as a tab, the way the TUI focuses it. */
  function openSession(sessionID: string) {
    if (props.serverID) ctx.tabs.open({ server: props.serverID, id: sessionID }, { focus: true })
  }

  const openRun = (runId: string) => setNav(push(nav(), { kind: "run", runId }))

  function pickLibraryRow(index: number) {
    if (cursor(nav(), libraryRows()) !== index) {
      setNav(setCursor(nav(), index, libraryRows()))
      return
    }
    const listing = selectedSaved()
    if (listing) {
      void chooseSaved(listing)
      return
    }
    const entry = entries()[index]
    if (entry) openRun(entry.runId)
  }

  function clickUnit(index: number) {
    if (cursor(nav(), units().length) === index) openSelectedUnit()
    else setNav(setCursor(nav(), index, units().length))
  }

  /** A saved Workflow offers the two TUI paths as one dialog: run it in a session, or start it as-is. */
  async function chooseSaved(listing: WorkflowListing) {
    const runInSession = "run-in-session"
    const startNow = "start-now"
    const startable = savedArgs(listing).startable
    const choice = await ctx.dialogs.select<string>({
      title: ctx.t("saved.runTitle", { key: listing.key }),
      options: [
        { title: ctx.t("action.runInSession"), description: listing.description, value: runInSession },
        ...(startable ? [{ title: ctx.t("action.startNow"), value: startNow }] : []),
      ],
    })
    if (choice === runInSession) {
      void useSaved(ctx, listing, props.originSessionID, props.serverID)
      return
    }
    if (choice === startNow) {
      const runId = await startSaved(ctx, controller, listing)
      if (runId) openRun(runId)
    }
  }

  const crumbs = () => {
    const v = view()
    const parts = [props.title]
    const shown = run()
    if (v.kind !== "library") parts.push(shown ? `${workflowName(shown)} ${shortId(shown.runId)}` : shortId(v.runId))
    if (v.kind === "unit") parts.push(viewUnit() ? unitName(viewUnit()!) : ctx.t("label.unit"))
    return parts
  }

  const webLink = () => {
    const base = controller.webUrl()?.replace(/\/$/, "")
    if (!base) return null
    const v = view()
    return v.kind === "library" ? base : `${base}/runs/${v.runId}`
  }

  return (
    <div data-component="workflows-panel">
      <div class="wf-head">
        <div class="wf-crumbs">
          <For each={crumbs()}>
            {(part, index) => (
              <>
                <Show when={index() > 0}>
                  <span class="wf-crumb-sep">›</span>
                </Show>
                <Show
                  when={index() === crumbs().length - 1}
                  fallback={
                    <button
                      type="button"
                      class="wf-crumb"
                      onClick={() => goToDepth(index() + 1)}
                      title={ctx.t("action.back")}
                    >
                      {part}
                    </button>
                  }
                >
                  <b>{part}</b>
                </Show>
              </>
            )}
          </For>
        </div>
        <div class="wf-head-actions">
          <Show when={view().kind === "library" && nav().filter !== "all"}>
            <span class="wf-muted">{nav().filter}</span>
          </Show>
          <Show when={view().kind === "library"}>
            <ctx.ui.Tooltip value={ctx.t("action.filter")}>
              <ctx.ui.IconButton
                icon="align-right"
                label={ctx.t("action.filter")}
                variant="ghost-muted"
                onClick={() => setNav(cycleFilter(nav()))}
              />
            </ctx.ui.Tooltip>
          </Show>
          <Show when={webLink()}>
            {(link) => (
              <ctx.ui.IconButton
                icon="globe"
                label={ctx.t("action.openBrowser")}
                variant="ghost-muted"
                onClick={() => ctx.system.openExternal(link())}
              />
            )}
          </Show>
          <ctx.ui.Tooltip value={ctx.t("action.refresh")}>
            <ctx.ui.IconButton
              icon="refresh"
              label={ctx.t("action.refresh")}
              variant="ghost-muted"
              onClick={() => void controller.refresh()}
            />
          </ctx.ui.Tooltip>
        </div>
      </div>

      <Show when={controller.error()}>
        {(message) => (
          <div class="wf-note" data-tone="error">
            {message()}
          </div>
        )}
      </Show>
      <Show when={note()}>
        {(n) => (
          <div class="wf-note" data-tone={n().tone}>
            {n().text}
          </div>
        )}
      </Show>

      <div class="wf-body">
        <Switch>
          <Match when={view().kind === "library"}>
            <LibraryPane
              ctx={ctx}
              controller={controller}
              entries={entries()}
              saved={saved()}
              filter={nav().filter}
              cursor={cursor(nav(), libraryRows())}
              onPick={pickLibraryRow}
            />
          </Match>
          <Match when={view().kind === "run"}>
            <Show when={run()} fallback={<div class="wf-empty">{ctx.t("panel.loading")}</div>}>
              <RunPane
                ctx={ctx}
                controller={controller}
                run={run()!}
                activity={slot()?.activity ?? null}
                cursor={cursor(nav(), units().length)}
                answer={answerBindings()}
                onAnswer={() => beginAnswer(run()?.interactions[0])}
                onUnitClick={clickUnit}
                onOpenSession={openSession}
              />
            </Show>
          </Match>
          <Match when={view().kind === "unit"}>
            <Show when={run() && viewUnit()} fallback={<div class="wf-empty">{ctx.t("panel.loading")}</div>}>
              <UnitPane
                ctx={ctx}
                controller={controller}
                run={run()!}
                unit={viewUnit()!}
                onBack={goBack}
                onOpenSession={openSession}
              />
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
