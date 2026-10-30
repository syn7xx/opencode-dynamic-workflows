/**
 * The GUI Unit view: one Unit's header, prompt and output (full output loaded on demand when the snapshot elided
 * it). The parent owns the Run and the back action.
 */
import { Show, createEffect, createSignal, on } from "solid-js"

import { formatElapsed } from "../progress"
import type { Run, Unit } from "../protocol"
import { formatCost, unitName, unitStatus } from "../ui/format"
import type { PluginContext } from "./context"
import { isUnitTerminal, prettyJson, toneClass } from "./format"
import type { WorkflowController } from "./model"

export function UnitPane(props: {
  ctx: PluginContext
  controller: WorkflowController
  run: Run
  unit: Unit
  onBack: () => void
  onOpenSession: (sessionID: string) => void
}) {
  const ctx = props.ctx
  const [full, setFull] = createSignal<string | null>(null)
  createEffect(
    on(
      () => `${props.unit.unitId}:${props.unit.outputElided ? "elided" : "inline"}:${props.unit.status}`,
      () => {
        setFull(null)
        if (!props.unit.outputElided) return
        void props.controller.loadUnit(props.run.runId, props.unit.unitId).then((unit) => setFull(unit?.output ?? null))
      },
    ),
  )
  const look = () => unitStatus(props.unit.status)
  const model = () => props.unit.model.resolved ?? props.unit.model.requested
  const details = () =>
    [props.unit.subagent, model() ?? "", props.unit.phase ?? "", props.unit.schema ? ctx.t("unit.typed") : ""]
      .filter(Boolean)
      .join(" · ")
  const figures = () =>
    [
      props.unit.startedAt
        ? formatElapsed((props.unit.endedAt ?? props.controller.now()) - props.unit.startedAt)
        : ctx.t("unit.notStarted"),
      formatCost(props.unit.usage.cost),
    ].join(" · ")
  // The full output when it was loaded, the snapshot's otherwise; pretty-printed when the Unit's result is typed JSON.
  const output = () => prettyJson(full() ?? props.unit.output)
  const typed = () => !!props.unit.schema && /^[[{]/.test(output()?.trim() ?? "")

  return (
    <>
      <div class="wf-actions">
        <ctx.ui.Button size="small" variant="ghost-muted" icon="arrow-left" onClick={props.onBack}>
          {ctx.t("action.back")}
        </ctx.ui.Button>
        <Show when={props.unit.sessionID}>
          <ctx.ui.Button
            size="small"
            variant="ghost-muted"
            icon="prompt"
            onClick={() => props.onOpenSession(props.unit.sessionID!)}
          >
            {ctx.t("action.transcript")}
          </ctx.ui.Button>
        </Show>
        <Show when={!isUnitTerminal(props.unit.status)}>
          <ctx.ui.Button
            size="small"
            variant="neutral"
            icon="stop"
            onClick={() => void props.controller.stopUnit(props.run.runId, props.unit.unitId)}
          >
            {ctx.t("action.stopUnit")}
          </ctx.ui.Button>
          <ctx.ui.Button
            size="small"
            variant="neutral"
            icon="outline-rotate-clockwise"
            onClick={() => void props.controller.restartUnit(props.run.runId, props.unit.unitId)}
          >
            {ctx.t("action.restartUnit")}
          </ctx.ui.Button>
        </Show>
      </div>
      <div class="wf-card" data-accent={look().tone}>
        <div class="wf-card-line">
          <span class="wf-card-title">
            <span class={toneClass(look().tone)}>
              {look().glyph} {look().word}
            </span>{" "}
            {unitName(props.unit)}
          </span>
          <span class="wf-figs">{figures()}</span>
        </div>
        <div class="wf-muted">{details()}</div>
        <Show when={props.unit.error}>
          <div class="wf-tone-error">✗ {props.unit.error}</div>
        </Show>
      </div>
      <div class="wf-section">{ctx.t("section.prompt")}</div>
      <div class="wf-code wf-muted">{props.unit.prompt}</div>
      <div class="wf-section">{ctx.t("section.output")}</div>
      <Show when={output()} fallback={<div class="wf-empty">{ctx.t("unit.noOutput")}</div>}>
        <Show when={typed()} fallback={<div class="wf-code">{output()}</div>}>
          <ctx.ui.Code content={output()!} language="json" />
        </Show>
      </Show>
    </>
  )
}
