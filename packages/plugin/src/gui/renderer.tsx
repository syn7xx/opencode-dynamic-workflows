/**
 * The Workflows GUI plugin's window entry: `Plugin.Setup<typeof definition>`. The host evaluates this to register
 * the side panel, the session-header strip, the composer badge, the "+"-menu item and the commands; each window runs
 * its own instance, so each keeps its own attach heartbeat ("a person is here"), event subscription and toasts.
 *
 * Controllers are shared per location directory, so several sessions of one project share one subscription. Every
 * surface reads the same host-agnostic core in `src/ui/`; this file is only wiring.
 */
import { Command, ComposerPill, MenuItem, Panel, Slot, Style, type Plugin } from "@opencode/plugin/gui"
import { onCleanup } from "solid-js"

import type { PendingInteraction, Run } from "../protocol"
import { workflowName } from "../ui/format"
import { sessionEntries } from "../ui/state"
import type { PluginContext } from "./context"
import { cleanupPending, pairDevice } from "./flows"
import type definition from "./index"
import { WorkflowController } from "./model"
import { RunPanelView, SessionStripView, type SessionRefLike } from "./views"

import css from "./styles.css?inline"

/** The panel's tab id; the host key is `${plugin}:${PANEL}`. */
export const PANEL = "runs"

const sessionRef = (session: { id: string; directory: string; server: { id: string } }): SessionRefLike => ({
  id: session.id,
  directory: session.directory,
  server: session.server.id,
})

const setup: Plugin.Setup<typeof definition> = (ctx) => {
  ctx.add(Style, css)

  const controllers = new Map<string, WorkflowController>()
  const controllerFor = (directory: string | undefined): WorkflowController => {
    const key = directory ?? ""
    const existing = controllers.get(key)
    if (existing) return existing
    const controller = new WorkflowController({
      client: ctx.client,
      directory,
      pluginId: ctx.id,
      signal: ctx.signal,
      onNotice: (notice) => notify(ctx, notice),
    })
    controller.start()
    controllers.set(key, controller)
    return controller
  }

  // A controller for the window's default location, so commands work before any panel has opened.
  const defaultController = () => controllerFor(ctx.sessions.current()?.directory)

  const openPanel = () => {
    const session = ctx.sessions.current()
    if (!session) {
      ctx.toast.show({ title: ctx.t("panel.title"), description: ctx.t("toast.nothingWaiting") })
      return
    }
    void controllerFor(session.directory)
    // `select` adds the tab and selects it (keeping the preview tab), and opens the side region.
    ctx.layout.open(`${ctx.id}:${PANEL}`, session, { tab: "select" })
  }

  /** Open the panel on a Run's session: focus that session's tab when it is open, then show the panel there. */
  const openPanelFor = (sessionID: string) => {
    const ref = ctx.sessions.list().find((candidate) => candidate.id === sessionID)
    if (!ref) {
      // The Run's session is not an open tab: reveal it as one; the panel follows the route.
      const current = ctx.sessions.current()
      if (current) ctx.tabs.open({ server: current.server.id, id: sessionID }, { focus: true })
      return
    }
    void controllerFor(ref.location?.directory)
    ctx.tabs.open({ server: ref.server.id, id: ref.id }, { focus: true })
    ctx.layout.open(`${ctx.id}:${PANEL}`, ref, { tab: "select" })
  }

  const panelTab = {
    id: PANEL,
    get title() {
      return ctx.t("panel.title")
    },
    label: () => (
      <span class="wf-tab-label">
        <ctx.ui.Icon name="task" size="small" />
        <span>{ctx.t("panel.title")}</span>
      </span>
    ),
  }

  ctx.add(Panel, {
    id: PANEL,
    region: "side",
    wide: true,
    mobile: {
      get title() {
        return ctx.t("panel.title")
      },
      order: 40,
      kind: "menu",
      icon: "task",
    },
    list: () => [panelTab],
    render: (panel) => (
      <RunPanelView
        ctx={ctx}
        session={() => sessionRef(panel.session)}
        controller={() => controllerFor(panel.session.directory)}
        onClose={() => ctx.layout.close(`${ctx.id}:${PANEL}`, panel.session)}
      />
    ),
  })

  // A compact strip on the session header: the live Runs of the session in view.
  ctx.add(Slot, {
    at: "session.header",
    render: (input) => (
      <SessionStripView
        ctx={ctx}
        session={() => (input.session ? sessionRef(input.session) : undefined)}
        controllerFor={controllerFor}
        onOpen={openPanel}
      />
    ),
  })

  // The side region's "+" menu item: how the panel is reopened after it is closed. Without it, a closed panel has
  // no way back from the UI.
  ctx.add(MenuItem, (): MenuItem | undefined => {
    const session = ctx.sessions.current()
    if (!session) return undefined
    return {
      menu: "session.panel",
      id: "open",
      get title() {
        return ctx.t("panel.title")
      },
      opened: ctx.layout.state(`${ctx.id}:${PANEL}`, session) !== "closed",
      icon: "task",
      keybind: `${ctx.id}.open`,
      order: 10,
      run: openPanel,
    }
  })

  // A persistent badge above the composer, shown ONLY while the session in view has a Waiting Run: it keeps the
  // waiting state visible where the person is looking, with no toast to miss and no panel open.
  ctx.add(ComposerPill, {
    id: "waiting",
    order: 20,
    show: (input) => {
      const waiting = sessionEntries(controllerFor(input.session.directory).state(), input.session.id).filter(
        (entry) => entry.waiting,
      )
      if (waiting.length === 0) return undefined
      return {
        label: ctx.plural("pill.waiting", waiting.length),
        icon: "warning",
        tone: "warning",
        title: ctx.t("pill.title"),
        rows: waiting.map((entry) => ({
          id: entry.runId,
          label: workflowName(entry),
          icon: "task",
          tone: "warning",
          ...(entry.currentPhase ? { detail: entry.currentPhase } : {}),
          run: () => openPanelFor(input.session.id),
        })),
      }
    },
  })

  const group = () => ctx.t("panel.title")
  ctx.add(Command, () => ({
    id: "open",
    get title() {
      return ctx.t("command.open")
    },
    group: group(),
    keywords: "workflow run panel library",
    slash: { name: "workflows" },
    run: openPanel,
  }))
  ctx.add(Command, () => ({
    id: "answer",
    get title() {
      return ctx.t("command.answer")
    },
    group: group(),
    keywords: "workflow answer waiting question",
    run: openPanel,
  }))
  ctx.add(Command, () => ({
    id: "cleanup",
    get title() {
      return ctx.t("command.cleanup")
    },
    group: group(),
    keywords: "workflow cleanup delete sessions",
    run: () => void cleanupPending(ctx, defaultController()),
  }))
  ctx.add(Command, () => ({
    id: "pair",
    get title() {
      return ctx.t("command.pair")
    },
    group: group(),
    keywords: "workflow pair browser device",
    run: () => void pairDevice(ctx, defaultController()),
  }))

  onCleanup(() => {
    for (const controller of controllers.values()) controller.dispose()
    controllers.clear()
  })
}

/**
 * What a Run raised: a toast for a Run that ended; for a waiting question, only a system notification (the waiting
 * state itself is carried by the composer badge and the header strip, so a transient toast would just flash).
 */
function notify(ctx: PluginContext, notice: { run: Run; interaction?: PendingInteraction; ended: boolean }): void {
  const { run, interaction, ended } = notice
  const name = workflowName(run)
  const title = ctx.t("toast.notification", { name })
  if (ended) {
    const variant = run.status === "succeeded" ? "success" : run.status === "failed" ? "error" : "default"
    ctx.toast.show({ title: ctx.t("toast.finished", { name, status: run.status }), variant })
    void ctx.attention.notify({ title, message: `${name} ${run.status}`, id: run.runId })
    return
  }
  const message = interaction?.questions[0]?.prompt ?? interaction?.kind ?? ctx.t("toast.needsYou")
  const ref = ctx.sessions.list().find((candidate) => candidate.id === run.parentSessionID)
  void ctx.attention.notify({
    title,
    message,
    id: `${run.runId}:${interaction?.interactionId ?? ""}`,
    ...(ref ? { session: { server: ref.server.id, id: ref.id } } : {}),
  })
}

export default setup
