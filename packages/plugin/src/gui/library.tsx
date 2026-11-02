/**
 * The GUI library view: the Runs of a location (or one session) and the saved (durable) Workflows, grouped into
 * Live / Recent / Saved. A row is a button; the parent owns selection and click handling.
 */
import { For, Show } from "solid-js"

import { formatElapsed, phasePosition } from "../progress"
import type { LibraryEntry, WorkflowListing } from "../protocol"
import { elapsedOf, formatCost, runStatus, savedArgs, savedArgsText, workflowName } from "../ui/format"
import type { PluginContext } from "./context"
import { toneClass } from "./format"
import type { WorkflowController } from "./model"

export type LibraryRow = { kind: "run"; entry: LibraryEntry } | { kind: "saved"; listing: WorkflowListing }

export function LibraryPane(props: {
  ctx: PluginContext
  controller: WorkflowController
  entries: LibraryEntry[]
  saved: readonly WorkflowListing[]
  filter: string
  cursor: number
  onPick: (index: number) => void
}) {
  const items = (): LibraryRow[] => [
    ...props.entries.map((entry) => ({ kind: "run" as const, entry })),
    ...props.saved.map((listing) => ({ kind: "saved" as const, listing })),
  ]
  const group = (row: LibraryRow) =>
    row.kind === "saved"
      ? props.ctx.t("group.saved")
      : row.entry.live
        ? props.ctx.t("group.live")
        : props.ctx.t("group.recent")
  const groupOf = (index: number) => group(items()[index]!)
  const firstOfGroup = (index: number) => index === 0 || groupOf(index - 1) !== groupOf(index)

  return (
    <Show
      when={items().length > 0}
      fallback={<div class="wf-empty">{props.ctx.t(props.filter === "all" ? "panel.empty" : "panel.emptyFilter")}</div>}
    >
      <For each={items()}>
        {(row, index) => (
          <>
            <Show when={firstOfGroup(index())}>
              <div class="wf-group">{groupOf(index())}</div>
            </Show>
            <button
              type="button"
              class="wf-row"
              data-selected={index() === props.cursor}
              onClick={() => props.onPick(index())}
            >
              <Show
                when={row.kind === "run" ? (row as { entry: LibraryEntry }).entry : undefined}
                fallback={<SavedRow ctx={props.ctx} listing={(row as { listing: WorkflowListing }).listing} />}
              >
                {(entry) => <RunRow ctx={props.ctx} controller={props.controller} entry={entry()} />}
              </Show>
            </button>
          </>
        )}
      </For>
    </Show>
  )
}

function RunRow(props: { ctx: PluginContext; controller: WorkflowController; entry: LibraryEntry }) {
  const look = () => runStatus(props.entry)
  const figures = () =>
    [
      phasePosition(props.entry),
      props.entry.units ? `${props.entry.settledUnits}/${props.entry.units} ${props.ctx.t("label.units")}` : "",
      formatElapsed(elapsedOf(props.entry, props.controller.now())),
      formatCost(props.entry.usage.cost),
    ]
      .filter(Boolean)
      .join(" · ")
  return (
    <>
      <span class={`wf-status ${toneClass(look().tone)}`}>
        {look().glyph} {look().word}
      </span>
      <span class="wf-name">
        {workflowName(props.entry)}
        <Show when={props.entry.workflow.provenance === "inline"}>
          <span class="wf-tag"> {props.ctx.t("label.inline")}</span>
        </Show>
      </span>
      <span class="wf-figs">{figures()}</span>
    </>
  )
}

function SavedRow(props: { ctx: PluginContext; listing: WorkflowListing }) {
  const startable = () => savedArgs(props.listing).startable
  return (
    <>
      <span class="wf-status wf-tone-info">◇ {props.ctx.t("label.saved")}</span>
      <span class="wf-name">
        {props.listing.key}
        <Show when={props.listing.description}>
          <span class="wf-tag"> {props.listing.description}</span>
        </Show>
      </span>
      <span class="wf-figs" classList={{ "wf-tone-warning": !startable() }}>
        {savedArgsText(props.listing)}
      </span>
    </>
  )
}
