import { afterAll, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createBroker } from "../src/broker"
import { createJournal, journalRoot, processStartedAt } from "../src/journal"
import { newRun, createRunStore } from "../src/runs"
import { DEFAULT_CONFIG } from "../src/service/config"
import { WorkflowService } from "../src/service/service"
import { createUnitIndex } from "../src/units"
import { createFakeHost } from "./fake-host"

const project = await mkdtemp(path.join(os.tmpdir(), "wf-service-"))
afterAll(() => rm(project, { recursive: true, force: true }))

function service(options: { approved?: boolean; attached?: boolean; location?: string } = {}) {
  const index = createUnitIndex()
  const location = options.location ?? project
  const store = createRunStore(location)
  const journal = createJournal(journalRoot(location), { onError: () => {} })
  return {
    journal,
    store,
    service: new WorkflowService({
      location,
      host: createFakeHost(index),
      index,
      store,
      journal,
      broker: createBroker({ store, attached: () => options.attached === true }),
      config: DEFAULT_CONFIG,
      instance: "test",
      opencodeVersion: "2.1.0",
      approvals: { get: async () => options.approved === true, set: async () => {} },
      gatewayUrl: () => null,
    }),
  }
}

// Top-level code that marks the process when the module is loaded, i.e. when its code runs.
const sideEffect = (flag: string) => `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"
;(globalThis as Record<string, unknown>)[${JSON.stringify(flag)}] = true
export default defineWorkflow({
  meta: { name: "marker", description: "marks the process", phases: [{ title: "only" }] },
  async run() {
    return "ran"
  },
})
`
const marked = (flag: string) => (globalThis as Record<string, unknown>)[flag] === true

describe("inline source runs only after approval", () => {
  it("a refused inline Run never loads its script (top-level code does not run)", async () => {
    const { service: svc } = service()
    const started = await svc.startRun({ source: sideEffect("wfRefused"), parentSessionID: "p" })
    const { error, run } = await started.done
    expect(error).toContain("no one approved")
    expect(run.status).toBe("failed")
    expect(run.workflow.name).toBe("unapproved script")
    expect(marked("wfRefused")).toBe(false)
  })

  it("resuming a refused inline Run asks again; the script still does not run", async () => {
    const { service: svc } = service()
    const started = await svc.startRun({ source: sideEffect("wfResumed"), parentSessionID: "p" })
    await started.done
    const resumed = await svc.resumeRun(started.runId)
    const { error } = await resumed.done
    expect(error).toContain("no one approved")
    expect(marked("wfResumed")).toBe(false)
  })

  it("an approved inline Run loads, then takes its name and phases from meta", async () => {
    const { service: svc } = service({ approved: true })
    const started = await svc.startRun({ source: sideEffect("wfApproved"), parentSessionID: "p" })
    const { output, run } = await started.done
    expect(marked("wfApproved")).toBe(true)
    expect(output?.result).toBe("ran")
    expect(run.workflow.name).toBe("marker")
    expect(run.phases).toEqual(["only"])
  })
})

describe("saving inline source needs the same approval as running it", () => {
  const made: string[] = []
  afterAll(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))))
  const fresh = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-save-"))
    made.push(dir)
    return dir
  }
  const saved = (location: string, name: string) =>
    existsSync(path.join(location, ".opencode", "workflows", `${name}.ts`))

  it("an unapproved save is refused, and the script neither runs nor is written", async () => {
    const location = await fresh()
    const { service: svc } = service({ location })
    await expect(svc.saveInline(sideEffect("wfSaveRefused"), "kept", "p")).rejects.toThrow("no one approved saving")
    expect(marked("wfSaveRefused")).toBe(false)
    expect(saved(location, "kept")).toBe(false)
  })

  it("a project that allows inline Workflows saves at once", async () => {
    const location = await fresh()
    const { service: svc } = service({ location, approved: true })
    const result = await svc.saveInline(sideEffect("wfSaveAllowed"), "kept", "p")
    expect(result.key).toBe("marker")
    expect(saved(location, "kept")).toBe(true)
  })

  it("save_run of a refused Run asks again instead of saving the refused script", async () => {
    const location = await fresh()
    const { service: svc } = service({ location })
    const started = await svc.startRun({ source: sideEffect("wfSaveRunRefused"), parentSessionID: "p" })
    await started.done
    await expect(svc.saveRun(started.runId, "kept")).rejects.toThrow("no one approved saving")
    expect(marked("wfSaveRunRefused")).toBe(false)
    expect(saved(location, "kept")).toBe(false)
  })

  it("save_run of a Run the person approved saves without asking again", async () => {
    const location = await fresh()
    const { service: svc, store } = service({ location, attached: true })
    const started = await svc.startRun({ source: sideEffect("wfSaveRunApproved"), parentSessionID: "p" })
    let pending = store.get(started.runId)?.interactions[0]
    for (let tries = 0; !pending && tries < 50; tries++) {
      await Bun.sleep(10)
      pending = store.get(started.runId)?.interactions[0]
    }
    expect(pending?.approval?.action).toBe("run")
    await svc.replyInteraction(started.runId, pending!.interactionId, [["Run once"]])
    await started.done
    const result = await svc.saveRun(started.runId, "kept")
    expect(result.key).toBe("marker")
    expect(saved(location, "kept")).toBe(true)
  })
})

describe("a cancelled request never runs or saves inline code, even when the project allows it", () => {
  it("startRun with an aborted signal does not load the script", async () => {
    const { service: svc } = service({ approved: true })
    const controller = new AbortController()
    controller.abort()
    const started = await svc.startRun(
      { source: sideEffect("wfAbortedRun"), parentSessionID: "p" },
      { signal: controller.signal },
    )
    const { run } = await started.done
    expect(run.status).toBe("stopped")
    expect(marked("wfAbortedRun")).toBe(false)
  })

  it("saveInline with an aborted signal writes nothing and does not load the script", async () => {
    const location = await mkdtemp(path.join(os.tmpdir(), "wf-save-abort-"))
    const { service: svc } = service({ approved: true, location })
    const controller = new AbortController()
    controller.abort()
    await expect(svc.saveInline(sideEffect("wfAbortedSave"), "kept", "p", controller.signal)).rejects.toThrow(
      "cancelled",
    )
    expect(marked("wfAbortedSave")).toBe(false)
    expect(existsSync(path.join(location, ".opencode", "workflows", "kept.ts"))).toBe(false)
    await rm(location, { recursive: true, force: true })
  })
})

describe("durable resume — a decomposed Workflow resumes from its own journal", () => {
  const made: string[] = []
  afterAll(() => Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true }))))

  /** A project with a decomposed durable Workflow (entry + lib/helper) and a service over it. */
  async function decomposed() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-durable-"))
    made.push(dir)
    const root = path.join(dir, ".opencode", "workflows")
    await Bun.write(path.join(root, "lib", "demo", "util.ts"), `export const greeting = () => "hi-from-lib"\n`)
    await Bun.write(
      path.join(root, "demo.ts"),
      `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\n` +
        `import { greeting } from "./lib/demo/util.ts"\n` +
        `export default defineWorkflow({ meta: { name: "demo", description: "d" }, async run({ agent, log }) { log(greeting()); return agent("Say hi.", { label: "hi" }) } })\n`,
    )
    return { dir, ...service({ location: dir }) }
  }

  it("journals execution.ts, and resumes even after the durable file and its lib/ are deleted", async () => {
    const { dir, service: svc } = await decomposed()
    const started = await svc.startRun({ name: "demo", args: {}, parentSessionID: "p" })
    expect((await started.done).run.status).toBe("succeeded")
    expect(existsSync(path.join(journalRoot(dir), started.runId, "execution.ts"))).toBe(true)

    // The whole durable tree is gone; the Run must still resume from the journal alone.
    await rm(path.join(dir, ".opencode", "workflows", "demo.ts"), { force: true })
    await rm(path.join(dir, ".opencode", "workflows", "lib"), { recursive: true, force: true })

    const resumed = await svc.resumeRun(started.runId)
    const { error, run } = await resumed.done
    expect(error).toBeUndefined()
    expect(run.status).toBe("succeeded")
    // The replayed Unit returns its recorded result without prompting anyone.
    expect(run.units[0]?.resultPath).toBe("replay")
  })

  it("fails with a clear error for a decomposed Run journaled before execution.ts existed", async () => {
    const { dir, journal, service: svc } = await decomposed()
    const run = newRun({
      runId: "legacy",
      workflow: { key: "gone", name: "gone", description: "d", provenance: "durable" },
      location: dir,
      parentSessionID: "p",
    })
    // A legacy record: a script with relative imports, no execution.ts, and no registered durable file.
    await journal.begin(run, {
      source: `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\nimport { x } from "./lib/gone/util.ts"\nexport default defineWorkflow({ meta: { name: "gone", description: "d" }, async run() { return x } })\n`,
      args: null,
      instance: "i",
    })
    await expect(svc.resumeRun("legacy")).rejects.toThrow(/cannot be resumed/i)
  })

  it("legacy fallback bundles the journaled source, even when the durable file was edited", async () => {
    const { dir, journal, service: svc } = await decomposed()
    // A registered durable file ("demo") whose on-disk body differs from what the Run journaled.
    const run = newRun({
      runId: "legacy-edited",
      workflow: { key: "demo", name: "demo", description: "d", provenance: "durable" },
      location: dir,
      parentSessionID: "p",
    })
    await journal.begin(run, {
      source:
        `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\n` +
        `import { greeting } from "./lib/demo/util.ts"\n` +
        `export default defineWorkflow({ meta: { name: "demo", description: "d" }, async run() { return "JOURNALED_" + greeting() } })\n`,
      args: null,
      instance: "i",
    })
    const { output, error } = await (await svc.resumeRun("legacy-edited")).done
    expect(error).toBeUndefined()
    // The name comes from the journaled script; the on-disk demo.ts has no such return value.
    expect(output?.result).toBe("JOURNALED_hi-from-lib")
  })

  it("still resumes a single-file durable Run (unchanged behaviour)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-single-"))
    made.push(dir)
    await Bun.write(
      path.join(dir, ".opencode", "workflows", "single.ts"),
      `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\nexport default defineWorkflow({ meta: { name: "single", description: "d" }, async run() { return "ok" } })\n`,
    )
    const { service: svc } = service({ location: dir })
    const started = await svc.startRun({ name: "single", args: {}, parentSessionID: "p" })
    expect((await started.done).run.status).toBe("succeeded")
    // No bundling ⇒ no snapshot written; resume takes the same inline path as before.
    expect(existsSync(path.join(journalRoot(dir), started.runId, "execution.ts"))).toBe(false)
    const resumed = await svc.resumeRun(started.runId)
    expect((await resumed.done).run.status).toBe("succeeded")
  })
})

describe("audit round 4 — resume never duplicates a Run another process is running", () => {
  it("refuses while the journaled owner (another live process) still runs it", async () => {
    const { journal, service: svc } = service()
    const run = newRun({
      runId: "busy",
      workflow: { key: null, name: "w", description: "", provenance: "inline" },
      location: project,
      parentSessionID: "p",
    })
    await journal.begin(run, { source: "export default 1", args: null, instance: "other" })
    const ppid = process.ppid
    await journal.update({ ...run, status: "running" })
    await journal.flush()
    // Rewrite the owner as the parent process: alive, and not us.
    const file = path.join(journalRoot(project), "busy", "run.json")
    const doc = JSON.parse(await Bun.file(file).text())
    doc.owner = { pid: ppid, instance: "other", startedAt: processStartedAt(ppid) ?? undefined }
    await Bun.write(file, JSON.stringify(doc))
    await expect(svc.resumeRun("busy")).rejects.toThrow("still running in another OpenCode process")
  })
})

describe("transcripts", () => {
  it("maps text, reasoning and tool parts, and clips large outputs", async () => {
    const { toTranscript } = await import("../src/service/service")
    const out = toTranscript("ses_x", [
      { type: "user", content: [{ type: "text", text: "hi" }] },
      {
        type: "assistant",
        model: { providerID: "p", id: "m" },
        content: [
          { type: "reasoning", text: "thinking" },
          {
            type: "tool",
            name: "read",
            state: {
              status: "completed",
              input: { path: "a.ts" },
              content: [{ type: "text", text: "x".repeat(25_000) }],
            },
          },
          { type: "text", text: "done" },
        ],
      },
    ])
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    const tool = out.messages[1]!.parts[1]!.tool!
    expect(tool.name).toBe("read")
    expect(tool.input).toContain('"path": "a.ts"')
    expect(tool.output!.length).toBeLessThan(21_000)
    expect(out.clipped).toBe(true)
    expect(out.messages[1]!.model).toBe("p/m")
  })
})
