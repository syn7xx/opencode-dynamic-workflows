/**
 * The GUI plugin's surfaces: the side-panel Run view and the session-header strip. Each is a thin wrapper that scopes
 * the shared screen (`./screen`) to a session's Runs and wires the panel frame.
 *
 * Both read the routed session through accessors, never a snapshot: the host calls `Panel.render` once and delivers
 * the next session through the same reactive getter when the user switches sessions, so reading `session.id` at render
 * time would freeze the surface on the session it mounted on.
 */
import { Show, createSignal, type Accessor } from "solid-js"

import { stripText } from "../ui/format"
import { sessionEntries } from "../ui/state"
import type { PluginContext } from "./context"
import type { WorkflowController } from "./model"
import { WorkflowsScreen } from "./screen"

export interface SessionRefLike {
  readonly id: string
  readonly directory: string
  /** The server id of the session's server, for opening Unit/parent sessions as tabs. */
  readonly server: string
}

/** The side-panel view: the Workflows screen scoped to this session's Runs. */
export function RunPanelView(props: {
  ctx: PluginContext
  session: Accessor<SessionRefLike>
  controller: Accessor<WorkflowController>
  /** A Run to open on (and into its pending question), seeded by the composer badge; re-seeds on change. */
  start?: Accessor<{ runId?: string; answer?: boolean } | undefined>
  /** Close the panel tab (the host owns the tab; this removes it from the strip). */
  onClose: () => void
}) {
  // The host mounts this render once and delivers the next session through the getter, so key the screen by session
  // id: a switch remounts it with fresh props (the controller and the origin session both belong to one session).
  return (
    <Show when={props.session().id} keyed fallback={null}>
      {(sessionID) => (
        <WorkflowsScreen
          ctx={props.ctx}
          controller={props.controller()}
          entries={() => sessionEntries(props.controller().state(), sessionID)}
          saved={() => props.controller().saved()}
          serverID={props.session().server}
          originSessionID={sessionID}
          {...(props.start ? { start: props.start } : {})}
          title={props.ctx.t("panel.titleSession")}
          onClose={props.onClose}
        />
      )}
    </Show>
  )
}

/** The session-header strip: one line for the live Runs of the session in view; a click opens the panel. */
export function SessionStripView(props: {
  ctx: PluginContext
  session: Accessor<SessionRefLike | undefined>
  controllerFor: (directory: string | undefined) => WorkflowController
  onOpen: () => void
}) {
  const [hover, setHover] = createSignal(false)
  const controller = () => {
    const session = props.session()
    return session ? props.controllerFor(session.directory) : undefined
  }
  const entries = () => {
    const session = props.session()
    return session && controller() ? sessionEntries(controller()!.state(), session.id) : []
  }
  const live = () => entries().filter((entry) => entry.live)
  const waiting = () => live().some((entry) => entry.waiting)
  const text = () => {
    const c = controller()
    return c ? stripText(live(), c.now(), hover() ? 120 : 64) : ""
  }
  return (
    <Show when={live().length > 0}>
      <button
        type="button"
        data-component="workflows-strip"
        data-waiting={waiting()}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => props.onOpen()}
        title={props.ctx.t("command.openPanel")}
      >
        <span class="wf-strip-text">{text()}</span>
      </button>
    </Show>
  )
}
