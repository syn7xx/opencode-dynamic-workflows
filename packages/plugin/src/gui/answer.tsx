/**
 * The GUI answer view: a pending interaction rendered as numbered, clickable options (with a text field for a
 * `custom` answer). It holds no logic — the answer state machine is the shared `src/ui/answer.ts`, driven by the
 * screen that owns the interaction. The screen passes one `AnswerBindings` object, so the Run view does not thread a
 * dozen callbacks through.
 */
import { For, Show } from "solid-js"

import type { PendingInteraction } from "../protocol"
import { currentQuestion, rows, type AnswerState } from "../ui/answer"
import type { PluginContext } from "./context"
import { formatBytes } from "./format"

/** Everything the answer view needs: the state machine, the interaction and the callbacks the screen owns. */
export interface AnswerBindings {
  readonly state: AnswerState
  readonly interaction: PendingInteraction
  readonly sending: boolean
  readonly typing: string
  onTyping(text: string): void
  /** Move the highlight to a row, without choosing it. */
  onMove(index: number): void
  /** Choose a row: for `multiple` it toggles; for a single choice it advances. */
  onPick(index: number): void
  /** Confirm a `multiple` question's toggled set and advance. */
  onConfirm(): void
  onText(text: string): void
  onDismiss(): void
}

export function AnswerView(props: { ctx: PluginContext; answer: AnswerBindings }) {
  const ctx = props.ctx
  const state = () => props.answer.state
  const question = () => currentQuestion(state())
  const multiple = () => question()?.multiple === true
  const kindLabel = () => {
    const interaction = props.answer.interaction
    if (interaction.kind === "permission") return ctx.t("ask.kindPermission")
    if (interaction.approval)
      return ctx.t(interaction.approval.action === "save" ? "ask.kindApprovalSave" : "ask.kindApprovalRun")
    if (interaction.form) return ctx.t("ask.kindForm")
    return interaction.origin === "script" ? ctx.t("ask.kindScript") : ctx.t("ask.kindUnit")
  }
  return (
    <div class="wf-answer">
      <div class="wf-q-head">
        △ {kindLabel()}
        {question()?.header ? ` · ${question()!.header}` : ""}
        {state().questions.length > 1 ? `  (${state().index + 1} of ${state().questions.length})` : ""}
      </div>
      <div class="wf-prompt">{question()?.prompt ?? ""}</div>
      <Show when={props.answer.interaction.permission}>
        {(permission) => (
          <div class="wf-muted">
            {permission().action}: {permission().resources.join(", ") || ctx.t("ask.noResource")}
          </div>
        )}
      </Show>
      <Show when={props.answer.interaction.approval}>
        {(approval) => (
          <div class="wf-approval">
            <div class="wf-muted">
              {ctx.t("ask.approvalMeta", { size: formatBytes(approval().bytes), sha: approval().sha256.slice(0, 12) })}
              {approval().target ? ` → ${approval().target}` : ""}
            </div>
            <ctx.ui.Code content={approval().source} language="ts" />
          </div>
        )}
      </Show>
      <div>
        <For each={rows(state())}>
          {(row, index) => (
            <button
              type="button"
              class="wf-option"
              data-active={index() === state().cursor && !state().typing}
              onMouseMove={() => props.answer.onMove(index())}
              onClick={() => props.answer.onPick(index())}
            >
              <span>{index() + 1}.</span>
              <span class="wf-opt-label">
                <Show when={multiple() && row.kind === "option"}>
                  <span>{row.kind === "option" && row.checked ? "[✓] " : "[ ] "}</span>
                </Show>
                {row.kind === "custom" ? (row.typed.length ? row.typed.join(", ") : row.label) : row.label}
                <Show when={row.kind === "option" && row.description}>
                  <span class="wf-opt-desc"> — {row.kind === "option" ? row.description : ""}</span>
                </Show>
              </span>
              <Show when={row.kind === "option" && !multiple() && row.checked}>
                <span class="wf-check">✓</span>
              </Show>
            </button>
          )}
        </For>
      </div>
      <Show when={state().typing}>
        <ctx.ui.TextInput
          value={props.answer.typing}
          onInput={(text) => props.answer.onTyping(text)}
          label={ctx.t("ask.typeOwn")}
          placeholder={ctx.t("ask.placeholder")}
          autofocus
          onSubmit={(text: string) => props.answer.onText(text)}
        />
      </Show>
      <div class="wf-head-actions">
        <Show when={multiple() && !state().typing}>
          <ctx.ui.Button
            size="small"
            variant="contrast"
            onClick={() => props.answer.onConfirm()}
            disabled={props.answer.sending}
          >
            {ctx.t("action.choose")}
          </ctx.ui.Button>
        </Show>
        <ctx.ui.Button
          size="small"
          variant="ghost-muted"
          onClick={() => props.answer.onDismiss()}
          disabled={props.answer.sending}
        >
          {ctx.t("action.dismiss")}
        </ctx.ui.Button>
        <Show when={props.answer.sending}>
          <span class="wf-muted">{ctx.t("ask.sending")}</span>
        </Show>
      </div>
    </div>
  )
}
