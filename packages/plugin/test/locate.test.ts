/**
 * The run-scoped resolver: a Run belongs to ONE location, but a surface may reply from another (the desktop GUI
 * panel is bound to the session's directory, which can be a worktree — a different OpenCode location from the
 * Run's). Before this, the plugin RPC answered on whichever instance the call landed on, so a reply from the wrong
 * location's instance found no waiter and failed with "that interaction is not pending". These tests pin the fix:
 * the resolver finds the owner by `runId`, live or journal-only, across every location.
 */
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createBroker } from "../src/broker"
import { engineGlobal, locationSlot, resetEngineGlobal } from "../src/engine-global"
import { createJournal, journalRoot } from "../src/journal"
import { newRun, createRunStore } from "../src/runs"
import { DEFAULT_CONFIG } from "../src/service/config"
import { locateServiceForRun, serviceForRun } from "../src/service/locate"
import { WorkflowService } from "../src/service/service"
import { createUnitIndex } from "../src/units"
import { createFakeHost } from "./fake-host"

const tempDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wf-locate-"))
  tempDirs.push(dir)
  return dir
}

/** A service for `location`, registered in the process-wide slot exactly as the plugin instance does. */
function registered(location: string): WorkflowService {
  const index = createUnitIndex()
  const store = createRunStore(location)
  const journal = createJournal(journalRoot(location), { onError: () => {} })
  const service = new WorkflowService({
    location,
    host: createFakeHost(index),
    index,
    store,
    journal,
    broker: createBroker({ store, attached: () => true }),
    config: DEFAULT_CONFIG,
    instance: "test",
    opencodeVersion: "2.1.0",
    approvals: { get: async () => false, set: async () => {} },
    gatewayUrl: () => null,
  })
  locationSlot(location).state.service = { service }
  return service
}

afterEach(async () => {
  resetEngineGlobal()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("locateServiceForRun", () => {
  it("finds the owner of a live Run in another location, not the caller's", async () => {
    const project = await tempDir()
    const owner = registered(project)
    const other = registered(path.join(project, ".testflow/_authors/SFATCAT-1"))
    owner.deps.store.create(
      newRun({
        runId: "run-1",
        workflow: { key: null, name: "w", description: "", provenance: "durable" },
        location: project,
        parentSessionID: "p",
      }),
    )
    expect(serviceForRun("run-1")).toBe(owner)
    expect(serviceForRun("run-1")).not.toBe(other)
  })

  it("returns null when no location holds the Run", async () => {
    const project = await tempDir()
    registered(project)
    registered(path.join(project, ".testflow/_ro/SFATCAT-1"))
    expect(serviceForRun("missing")).toBeNull()
  })

  it("falls back to the journal owner for a Run no store holds", async () => {
    const project = await tempDir()
    registered(project)
    const worktree = path.join(project, ".testflow/_ro/SFATCAT-1")
    const owner = registered(worktree)
    const run = newRun({
      runId: "run-2",
      workflow: { key: "w", name: "w", description: "d", provenance: "durable" },
      location: worktree,
      parentSessionID: "p",
    })
    await owner.deps.journal.begin(run, { source: "export default 1", args: null, instance: "i" })
    await owner.deps.journal.flush()
    expect(await locateServiceForRun("run-2")).toBe(owner)
  })

  it("sees every registered location (three instances, one process, like the live bug)", async () => {
    const project = await tempDir()
    registered(project)
    registered(path.join(project, ".testflow/_ro/SFATCAT-1"))
    registered(path.join(project, ".testflow/_authors/SFATCAT-1"))
    expect(engineGlobal().locations.size).toBe(3)
  })
})
