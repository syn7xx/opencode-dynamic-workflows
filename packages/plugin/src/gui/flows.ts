/**
 * The GUI plugin's flows: user actions that need both the host context (`ctx`) and a controller. Kept out of the
 * components so the views stay about rendering and the actions read the same wherever they are triggered (a command,
 * a button or a menu row).
 */
import type { PendingInteraction, Run, WorkflowListing } from "../protocol"
import { findForm, formAnswer } from "../ui/answer"
import { savedArgs, workflowName } from "../ui/format"
import type { PluginContext } from "./context"
import type { WorkflowController } from "./model"

/**
 * Answer or dismiss a pending interaction. A native OpenCode form is answered through OpenCode's own form API (the
 * server refuses `replyInteraction` for it); every other interaction goes through the controller. Resolves to an
 * error message, or null when it was accepted.
 */
export async function replyInteraction(
  ctx: PluginContext,
  controller: WorkflowController,
  interaction: PendingInteraction,
  answers: string[][] | null,
): Promise<string | null> {
  if (!interaction.form) {
    return answers === null
      ? controller.dismiss(interaction.runId, interaction.interactionId)
      : controller.reply(interaction.runId, interaction.interactionId, answers)
  }
  const formID = interaction.form.formID
  try {
    const forms = await ctx.client.session.form.list({ sessionID: interaction.sessionID })
    const form = findForm(forms, formID)
    if (!form) return "the form is no longer pending"
    if (answers === null) {
      await ctx.client.session.form.cancel({ sessionID: interaction.sessionID, formID })
      return null
    }
    const mapped = formAnswer(form.fields, answers)
    if ("error" in mapped) return mapped.error
    await ctx.client.session.form.reply({ sessionID: interaction.sessionID, formID, answer: mapped.answer })
    return null
  } catch (error) {
    return String(error)
  }
}

/** Delete the Unit sessions of every finished Run marked for cleanup, and report the outcome. */
export async function cleanupPending(ctx: PluginContext, controller: WorkflowController): Promise<void> {
  const outcomes = await controller.cleanupPending((id) => ctx.client.session.remove({ sessionID: id }))
  if (!outcomes) return
  const deleted = outcomes.reduce((sum, outcome) => sum + outcome.deleted, 0)
  ctx.toast.show({
    title: outcomes.length === 0 ? ctx.t("toast.noSaved") : ctx.t("toast.cleaned", { runs: outcomes.length, deleted }),
    variant: outcomes.length === 0 ? "default" : "success",
  })
}

/** Ask for a one-use pairing code and show it, so a browser on another device can pair. */
export async function pairDevice(ctx: PluginContext, controller: WorkflowController): Promise<void> {
  const out = await controller.pair()
  if (!out) return
  ctx.dialogs.alert({
    title: ctx.t("pair.title"),
    description: ctx.t("pair.body", {
      url: out.url,
      code: out.code,
      time: new Date(out.expiresAt).toLocaleTimeString(),
    }),
  })
}

/**
 * Start a saved Workflow as-is (no request, empty args), when it needs none. Opens its Run. Returns the Run's id, or
 * null when the Workflow needs args or the start failed.
 */
export async function startSaved(
  ctx: PluginContext,
  controller: WorkflowController,
  listing: WorkflowListing,
): Promise<string | null> {
  if (!savedArgs(listing).startable) return null
  const runId = await controller.startSaved(listing.key)
  if (runId) ctx.toast.show({ title: ctx.t("toast.started", { name: listing.key }), variant: "success" })
  return runId
}

/**
 * Ask what a saved Workflow should do, then hand the request to an agent session via the server's slash command (the
 * same path the TUI takes): the agent builds the args and runs it. Opens the session the request was sent to.
 */
export async function useSaved(
  ctx: PluginContext,
  listing: WorkflowListing,
  sessionID: string | undefined,
  serverID: string | undefined,
): Promise<void> {
  const request = await ctx.dialogs.prompt({
    title: ctx.t("saved.runTitle", { key: listing.key }),
    description: ctx.t("saved.runDescription", { description: listing.description }),
    placeholder: listing.whenToUse ?? ctx.t("saved.runPlaceholder"),
  })
  if (request === undefined) return
  const target = sessionID ?? (await newSession(ctx, listing.key))
  if (!target) return
  // `/workflow` and `/workflows` are the plugin's own commands: such a key goes through `/workflow <key> <request>`.
  const name = listing.key.replaceAll(":", "/")
  const command =
    name === "workflow" || name === "workflows"
      ? { name: "workflow", text: `${listing.key} ${request}`.trim() }
      : { name, text: request }
  try {
    await ctx.client.session.command({ sessionID: target, ...command, delivery: "queue" })
  } catch (error) {
    ctx.toast.show({
      title: ctx.t("saved.failed", { action: ctx.t("action.runInSession"), error: String(error) }),
      variant: "error",
    })
    return
  }
  if (serverID) ctx.tabs.open({ server: serverID, id: target }, { focus: true })
  ctx.toast.show({ title: ctx.t("toast.sent", { command: command.name }), variant: "success" })
}

async function newSession(ctx: PluginContext, title: string): Promise<string | null> {
  try {
    return (await ctx.client.session.create({ title })).id
  } catch {
    return null
  }
}

/** Save a finished Run's script as a durable Workflow under a name the person chooses. */
export async function saveRun(
  ctx: PluginContext,
  controller: WorkflowController,
  runId: string,
  suggested: string,
): Promise<void> {
  const name = await ctx.dialogs.prompt({
    title: ctx.t("action.save"),
    description: ctx.t("saved.saveDescription"),
    value: suggested,
  })
  if (!name) return
  const saved = await controller.saveRun(runId, name)
  if (saved) ctx.toast.show({ title: ctx.t("toast.saved", { key: saved.key }), variant: "success" })
}

/** Delete a terminal Run's Unit sessions, after a confirmation. */
export async function deleteUnits(ctx: PluginContext, controller: WorkflowController, run: Run): Promise<void> {
  const targets = [...new Set(run.units.map((unit) => unit.sessionID).filter((id): id is string => !!id))]
  if (targets.length === 0) {
    ctx.toast.show({ title: ctx.t("toast.noSessions") })
    return
  }
  const ok = await ctx.dialogs.confirm({
    title: ctx.t("confirm.deleteTitle"),
    description: ctx.t("confirm.deleteBody", { count: targets.length, name: workflowName(run) }),
    confirm: ctx.t("confirm.delete"),
    danger: true,
  })
  if (!ok) return
  const outcome = await controller.cleanupRun(run, (id) => ctx.client.session.remove({ sessionID: id }))
  if (outcome)
    ctx.toast.show({
      title: ctx.t("toast.cleaned", { runs: 1, deleted: outcome.deleted }),
      variant: outcome.failures.length ? "default" : "success",
    })
}
