/**
 * Which service owns a Run — resolved by `runId`, across every location in the process.
 *
 * OpenCode runs one plugin instance per location (project directory), and a single Run belongs to exactly one of
 * them. A surface, however, is bound to its OWN location: the TUI to the default location, the desktop GUI panel to
 * the directory of the session in view, and a Unit may run in a worktree that is yet another location. A run-scoped
 * call (answering an interaction, stopping a Run, reading its result) must therefore reach the instance that OWNS
 * the Run, not the instance the call happened to land on — otherwise the request finds no waiter and fails with
 * "that interaction is not pending".
 *
 * The Gateway already routes this way (`serviceForRun` in `gateway/server.ts`); this is the same resolver, shared so
 * the plugin RPC (the GUI panel and any third party) behaves identically. Instances see each other through
 * `engineGlobal().locations` (see {@link locationSlot}); a live Run is found in its store, a finished one in its
 * journal, exactly as the Gateway does.
 */
import { engineGlobal } from "../engine-global"
import type { WorkflowService } from "./service"

/** The shape the plugin stores in a location slot (`ServiceSlot` in `host/plugin.ts`); read structurally here. */
interface Slot {
  service?: WorkflowService
}

function services(): WorkflowService[] {
  const found: WorkflowService[] = []
  for (const slot of engineGlobal().locations.values()) {
    const service = (slot.state.service as Slot | undefined)?.service
    if (service) found.push(service)
  }
  return found
}

/** The service whose store holds `runId` (a live Run), or null. */
export function serviceForRun(runId: string): WorkflowService | null {
  for (const service of services()) if (service.deps.store.get(runId)) return service
  return null
}

/** The service that owns `runId`: a live Run from its store, else its journaled record, else null. */
export async function locateServiceForRun(runId: string): Promise<WorkflowService | null> {
  const live = serviceForRun(runId)
  if (live) return live
  for (const service of services()) if (await service.deps.journal.read(runId)) return service
  return null
}
