/**
 * The GUI Run view: the status header (phases, budget), the action row (stop / resume / save / delete), the pending
 * interaction, the Unit list, the result and the activity tail. The parent owns selection, answer mode and navigation.
 */
import { For, Show, createMemo } from "solid-js"

import { formatElapsed, formatTokens, meter, settledUnits } from "../progress"
import type { Run, Unit } from "../protocol"
import { isTerminal } from "../runs"
import {
  elapsedOf,
  formatCost,
  runStatus,
  totalTokens,
  unitElapsed,
  unitName,
  unitStatus,
  workflowName,
} from "../ui/format"
import { AnswerView, type AnswerBindings } from "./answer"
import type { PluginContext } from "./context"
import { deleteUnits, saveRun } from "./flows"
import { phaseLine, prettyJson, toneClass } from "./format"
import type { WorkflowController } from "./model"

export function RunPane(props: {
  ctx: PluginContext
  controller: WorkflowController
  run: Run
  activity: readonly { message: string; kind: string; time: number }[] | null
  cursor: number
  /** The answer session state, or null while the Run is not being answered. */
  answer: AnswerBindings | null
  onAnswer: () => void
  onUnitClick: (index: number) => void
  onOpenSession: (sessionID: string) => void
}) {
  const ctx = props.ctx
  const controller = props.controller
  const look = () => runStatus(props.run)
  const phases = createMemo(() => phaseLine(props.run))
  const figures = () =>
    [
      formatElapsed(elapsedOf(props.run, controller.now())),
      `${formatTokens(totalTokens(props.run.usage))} ${ctx.t("label.tokens")}`,
      formatCost(props.run.usage.cost),
    ].join(" · ")
  const result = () => prettyJson(props.run.resultPreview)
  const lastError = () => props.run.errors[props.run.errors.length - 1]
  const activityLines = () =>
    (props.activity ?? props.run.logs.map((message) => ({ message, kind: "log", time: props.run.startedAt }))).slice(-5)
  const terminal = () => isTerminal(props.run.status)
  const waitingFirst = () => props.run.interactions[0]

  return (
    <>
      <div class="wf-card" data-accent={look().tone}>
        <div class="wf-card-line">
          <span class="wf-card-title">
            <span class={toneClass(look().tone)}>
              {look().glyph} {look().word}
            </span>{" "}
            {workflowName(props.run)}
          </span>
          <span class="wf-figs">{figures()}</span>
        </div>
        <Show when={props.run.workflow.description}>
          <div class="wf-muted">{props.run.workflow.description}</div>
        </Show>
        <Show when={phases().length > 0}>
          <div class="wf-phases">
            <For each={phases()}>
              {(part, index) => (
                <span class={toneClass(part.tone)}>
                  {part.text}
                  <Show when={index() < phases().length - 1}>
                    <span class="wf-crumb-sep"> ── </span>
                  </Show>
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={props.run.budget.total !== null}>
          <div class="wf-muted">
            {ctx.t("label.budget", {
              meter: meter(props.run.tokensSpent / (props.run.budget.total || 1), 10),
              spent: formatTokens(props.run.tokensSpent),
              total: formatTokens(props.run.budget.total ?? 0),
            })}
          </div>
        </Show>
      </div>

      <div class="wf-actions">
        <Show when={!terminal()}>
          <ctx.ui.Button
            size="small"
            variant="danger"
            icon="stop"
            onClick={() => void controller.stopRun(props.run.runId)}
          >
            {ctx.t("action.stop")}
          </ctx.ui.Button>
        </Show>
        <Show when={terminal()}>
          <ctx.ui.Button
            size="small"
            variant="neutral"
            icon="outline-rotate-clockwise"
            onClick={async () => {
              const runId = await controller.resumeRun(props.run.runId)
              if (runId)
                ctx.toast.show({ title: ctx.t("toast.resumed", { name: workflowName(props.run) }), variant: "success" })
            }}
          >
            {ctx.t("action.resume")}
          </ctx.ui.Button>
          <ctx.ui.Button
            size="small"
            variant="neutral"
            icon="download"
            onClick={() => void saveRun(ctx, controller, props.run.runId, props.run.workflow.name)}
          >
            {ctx.t("action.save")}
          </ctx.ui.Button>
          <ctx.ui.Button
            size="small"
            variant="danger"
            icon="trash"
            onClick={() => void deleteUnits(ctx, controller, props.run)}
          >
            {ctx.t("action.deleteUnits")}
          </ctx.ui.Button>
        </Show>
        <ctx.ui.Button
          size="small"
          variant="ghost-muted"
          icon="prompt"
          onClick={() => props.onOpenSession(props.run.parentSessionID)}
        >
          {ctx.t("action.parentSession")}
        </ctx.ui.Button>
      </div>

      <Show
        when={props.answer}
        fallback={
          <Show when={waitingFirst()}>
            <div class="wf-waiting">
              <span>
                △ {waitingFirst()!.questions[0]?.header ?? waitingFirst()!.kind}:{" "}
                {waitingFirst()!.questions[0]?.prompt ?? ""}
              </span>
              <ctx.ui.Button size="small" variant="contrast" onClick={() => props.onAnswer()}>
                {ctx.t("action.answer")}
              </ctx.ui.Button>
            </div>
          </Show>
        }
      >
        <AnswerView ctx={ctx} answer={props.answer!} />
      </Show>

      <div class="wf-section">
        {ctx.t("section.units")}{" "}
        {props.run.units.length ? (
          <span class="wf-muted">{`${settledUnits(props.run)} of ${props.run.units.length}`}</span>
        ) : null}
      </div>
      <Show when={props.run.units.length > 0} fallback={<div class="wf-empty">{ctx.t("units.none")}</div>}>
        <For each={props.run.units}>
          {(unit, index) => (
            <button
              type="button"
              class="wf-row"
              data-selected={index() === props.cursor && !props.answer}
              onClick={() => props.onUnitClick(index())}
            >
              <UnitRow controller={controller} unit={unit} />
            </button>
          )}
        </For>
      </Show>

      <Show when={lastError()}>
        <div class="wf-card" data-accent="error">
          <div class="wf-card-title wf-tone-error">✗ {ctx.t("label.errors", { count: props.run.errors.length })}</div>
          <div>{lastError()!.error}</div>
        </div>
      </Show>

      <Show when={result()}>
        <div class="wf-section">{ctx.t("section.result")}</div>
        <div class="wf-code">{result()}</div>
      </Show>

      <Show when={activityLines().length > 0}>
        <div class="wf-section">{ctx.t("section.activity")}</div>
        <div class="wf-code wf-muted">
          <For each={activityLines()}>{(entry) => <div>{entry.message}</div>}</For>
        </div>
      </Show>
    </>
  )
}

function UnitRow(props: { controller: WorkflowController; unit: Unit }) {
  const look = () => unitStatus(props.unit.status)
  const figures = () =>
    [
      unitElapsed(props.unit, props.controller.now()),
      props.unit.status === "replayed" ? "" : formatCost(props.unit.usage.cost),
    ]
      .filter(Boolean)
      .join(" · ")
  return (
    <>
      <span class={`wf-status ${toneClass(look().tone)}`}>
        {look().glyph} {look().word}
      </span>
      <span class="wf-name">{unitName(props.unit)}</span>
      <span class="wf-figs">{figures()}</span>
    </>
  )
}
