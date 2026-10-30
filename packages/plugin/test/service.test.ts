import { afterAll, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createBroker } from "../src/broker"
import { createJournal, journalRoot, processStartedAt, type Journal, type JournalRecord } from "../src/journal"
import { emptyUsage, type Run, type Unit } from "../src/protocol"
import { newRun, createRunStore } from "../src/runs"
import { DEFAULT_CONFIG } from "../src/service/config"
import { originalSessions, WorkflowService } from "../src/service/service"
import { createUnitIndex } from "../src/units"
import { createFakeHost, type FakeHostOptions } from "./fake-host"

const project = await mkdtemp(path.join(os.tmpdir(), "wf-service-"))
afterAll(() => rm(project, { recursive: true, force: true }))

function service(options: { approved?: boolean; attached?: boolean; location?: string; host?: FakeHostOptions } = {}) {
  const index = createUnitIndex()
  const location = options.location ?? project
  const store = createRunStore(location)
  const journal = createJournal(journalRoot(location), { onError: () => {} })
  const host = createFakeHost(index, options.host)
  return {
    journal,
    store,
    host,
    service: new WorkflowService({
      location,
      host,
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

  it("records the caller's model and keeps it across a resume, even when the launching session is gone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-inherit-"))
    made.push(dir)
    await Bun.write(
      path.join(dir, ".opencode", "workflows", "inherit.ts"),
      `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\n` +
        `export default defineWorkflow({ meta: { name: "inherit", description: "d" }, async run({ agent }) {\n` +
        `  await agent("a", { label: "a", model: "inherit" })\n` +
        `  await agent("b", { label: "b", model: "inherit" })\n` +
        `  return "done"\n` +
        `} })\n`,
    )
    const caller = { providerID: "acme", id: "caller-model" }
    // The Run fails at Unit "b" so a resume re-runs it LIVE — the case that must still inherit the caller's model.
    const first = service({
      location: dir,
      host: {
        model: caller,
        seedSessions: [{ id: "p" }],
        reply: (call) => (call.text.includes("b") ? { error: "boom" } : { text: "ok" }),
      },
    })
    const started = await first.service.startRun({ name: "inherit", args: {}, parentSessionID: "p" })
    await started.done
    // Both Units ran on the caller's model; the model is journaled with the Run.
    expect(first.host.creates.map((create) => create.model)).toEqual([caller, caller])
    expect((await first.journal.read(started.runId))?.callerModel).toBe("acme/caller-model")

    // Resume in a fresh process: the launching session is unknown, and the resuming host would resolve a DIFFERENT
    // model for "p". The journaled caller model must win, so Unit "b" still inherits acme/caller-model.
    const second = service({
      location: dir,
      host: { model: { providerID: "other", id: "some-parent" }, reply: { text: "ok" } },
    })
    const resumed = await second.service.resumeRun(started.runId)
    expect((await resumed.done).run.status).toBe("succeeded")
    // "a" replayed (no new session); only "b" ran live — on the journaled caller model, not the resuming host's.
    expect(second.host.creates.map((create) => create.model)).toEqual([caller])
  })

  it("keeps a headless caller's null across a resume (never resolves a live model into it)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-headless-resume-"))
    made.push(dir)
    await Bun.write(
      path.join(dir, ".opencode", "workflows", "headless.ts"),
      `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\n` +
        `export default defineWorkflow({ meta: { name: "headless", description: "d" }, async run({ agent }) {\n` +
        `  return agent("only", { label: "only", model: "inherit" })\n` +
        `} })\n`,
    )
    // A synthetic starter: no session to read, so the caller model is null. Its Unit cannot inherit, and fails
    // so a resume re-runs it live (the case where a wrong live resolution would show up).
    const first = service({ location: dir, host: { reply: { error: "boom" } } })
    const started = await first.service.startRun({ name: "headless", args: {}, parentSessionID: "p" })
    await started.done
    expect(first.host.creates[0]!.model).toBeUndefined()
    expect((await first.journal.read(started.runId))?.callerModel).toBeNull()

    // The resuming host WOULD resolve a model for "p"; the journaled null must win, so the re-run Unit still
    // inherits nothing — the headless decision is reproduced, not silently upgraded.
    const second = service({
      location: dir,
      host: {
        model: { providerID: "other", id: "some-parent" },
        // Seed "p" so a live resolution would yield other/some-parent: without the sentinel, this test's
        // `model === undefined` assertion would fail — making the null-preservation load-bearing.
        seedSessions: [{ id: "p" }],
        reply: { text: "ok" },
      },
    })
    const resumed = await second.service.resumeRun(started.runId)
    await resumed.done
    expect(second.host.creates).toHaveLength(1)
    expect(second.host.creates[0]!.model).toBeUndefined()
  })
})

describe("resume — a replayed Unit's receipt reads the original Run's session", () => {
  it("threads the recorded sessionID through the ReplayPlan to the receipt's toolCalls, across repeated resumes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wf-receipt-resume-"))
    try {
      await Bun.write(
        path.join(dir, ".opencode", "workflows", "receipts.ts"),
        `import { defineWorkflow } from "@syn7xx/opencode-dynamic-workflows/workflow"\n` +
          `export default defineWorkflow({ meta: { name: "receipts", description: "d" }, async run({ agent }) {\n` +
          `  const receipt = await agent("do the work", { label: "worker", receipts: true })\n` +
          `  const calls = await receipt.toolCalls\n` +
          `  return calls.map((call) => call.name).join(",")\n` +
          `} })\n`,
      )
      const chat = {
        reply: {
          tools: [{ name: "write", input: { path: "a.txt" }, content: "ok" }],
          text: "done",
        },
      }
      const { service: first, host } = service({ location: dir, host: chat })
      const started = await first.startRun({ name: "receipts", args: {}, parentSessionID: "p" })
      expect((await started.done).output?.result).toBe("write")
      // The session the first Run created, and the calls it recorded — the evidence a later resume must find.
      const sessionID = host.creates.length === 1 ? host.sessions.keys().next().value : undefined
      expect(sessionID).toBeString()
      const recorded = [...host.sessions.get(sessionID!)!.messages]

      // Each resume is a NEW run in a NEW service (a plugin reload): only the journal and the host session carry over.
      const resumeWith = async (runId: string) => {
        const { service: resumed } = service({
          location: dir,
          host: { ...chat, seedSessions: [{ id: sessionID!, messages: recorded }] },
        })
        const done = await (await resumed.resumeRun(runId)).done
        expect(done.error).toBeUndefined()
        expect(done.run.units[0]?.status).toBe("replayed")
        return done
      }

      // Hop 1: the journaled sessionID reaches the receipt.
      const hop1 = await resumeWith(started.runId)
      // Without the threading the receipt reports [] and the script returns "".
      expect(hop1.output?.result).toBe("write")

      // Hop 2: a replayed Unit is journaled with `sessionID: null`, so this only works because resume follows
      // `resumeOf` back to the Run that actually ran the Unit.
      const hop2 = await resumeWith(hop1.run.runId)
      expect(hop2.output?.result).toBe("write")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("resume — matching a replayed Unit to the session it was recorded with", () => {
  /** A journaled Unit at `ordinal`, with the session its Run recorded (or none). */
  const recorded = (runId: string, ordinal: number, prompt: string, sessionID: string | null): Unit => ({
    unitId: `${runId}-u${ordinal}`,
    runId,
    ordinal,
    label: null,
    subagent: "general",
    phase: null,
    status: sessionID ? "succeeded" : "replayed",
    sessionID,
    location: null,
    prompt,
    model: { requested: null, resolved: null },
    schema: false,
    resultPath: null,
    attempts: [],
    usage: emptyUsage(),
    startedAt: null,
    endedAt: null,
  })

  /** A Run as the journal would hand it back, with `resumeOf` pointing at the Run it resumed. */
  const runRecord = (runId: string, resumeOf: string | null, units: Unit[]): Run => ({
    ...newRun({
      runId,
      workflow: { key: null, name: "w", description: "", provenance: "durable" },
      location: "/p",
      parentSessionID: "p",
    }),
    resumeOf,
    units,
  })

  /** A journal over fixed records: anything else is simply absent, like a cleaned-up Run. */
  const journalOf = (records: Run[]): Journal => {
    const byId = new Map(records.map((run) => [run.runId, run] as const))
    return {
      read: async (runId: string): Promise<JournalRecord | null> => {
        const run = byId.get(runId)
        return run ? { run, source: "", args: undefined, callerModel: null, transitions: [], owner: null } : null
      },
    } as unknown as Journal
  }

  it("adopts the nearest ancestor's session for a Unit that only replayed, and keeps a live one", async () => {
    const original = runRecord("a", null, [recorded("a", 1, "first", "ses_1"), recorded("a", 2, "second", "ses_2")])
    // Hop b replayed Unit 1 but RAN Unit 2 live (a divergence): its own session must win.
    const middle = runRecord("b", "a", [recorded("b", 1, "first", null), recorded("b", 2, "second", "ses_b2")])
    const sessions = await originalSessions(journalOf([original, middle]), middle)
    expect(sessions.get(1)).toBe("ses_1")
    expect(sessions.get(2)).toBe("ses_b2")
  })

  it("never adopts a session recorded for a DIFFERENT prompt at the same ordinal", async () => {
    const original = runRecord("a", null, [recorded("a", 1, "the old prompt", "ses_old")])
    const current = runRecord("b", "a", [recorded("b", 1, "a rewritten prompt", null)])
    expect(await originalSessions(journalOf([original, current]), current)).toEqual(new Map())
  })

  it("never adopts a session for an ordinal the current Run does not have", async () => {
    const original = runRecord("a", null, [recorded("a", 1, "first", "ses_1"), recorded("a", 2, "second", "ses_2")])
    const current = runRecord("b", "a", [recorded("b", 1, "first", null)])
    const sessions = await originalSessions(journalOf([original, current]), current)
    expect([...sessions.keys()]).toEqual([1])
  })

  it("stops quietly at a missing, cleaned-up ancestor instead of throwing", async () => {
    const current = runRecord("b", "gone", [recorded("b", 1, "first", null)])
    expect(await originalSessions(journalOf([]), current)).toEqual(new Map())
  })

  it("terminates on a resumeOf cycle that recorded no sessions", async () => {
    // The realistic cycle: resume-of-resume journals carry `sessionID: null`, so nothing is ever adopted and only the
    // visited set stops the walk — without it this loops forever.
    const first = runRecord("a", "b", [recorded("a", 1, "first", null)])
    const second = runRecord("b", "a", [recorded("b", 1, "first", null)])
    const journal = journalOf([first, second])
    const reads: string[] = []
    const counted = {
      read: async (runId: string) => {
        reads.push(runId)
        // A walk that is not stopped by the visited set spins forever on resolved promises (so a per-test timeout could
        // not even fire). Fail it from here — the walk treats a rejected read as "no journal" and gives up.
        if (reads.length > 5) throw new Error("runaway resume walk: the cycle was not stopped")
        return journal.read(runId)
      },
    } as unknown as Journal
    expect(await originalSessions(counted, second)).toEqual(new Map())
    // b → a, then stop: "a" points back at "b", which was already visited.
    expect(reads).toEqual(["a"])
  })

  it("terminates on a cyclic chain that DOES have sessions", async () => {
    const first = runRecord("a", "b", [recorded("a", 1, "first", "ses_1")])
    const second = runRecord("b", "a", [recorded("b", 1, "first", null)])
    const journal = journalOf([first, second])
    expect((await originalSessions(journal, second)).get(1)).toBe("ses_1")
    expect((await originalSessions(journal, first)).get(1)).toBe("ses_1")
  })

  it("walks further back when the nearest hop recorded nothing for that Unit", async () => {
    const original = runRecord("a", null, [recorded("a", 1, "first", "ses_deep")])
    const middle = runRecord("b", "a", [recorded("b", 1, "first", null)])
    const current = runRecord("c", "b", [recorded("c", 1, "first", null)])
    expect((await originalSessions(journalOf([original, middle, current]), current)).get(1)).toBe("ses_deep")
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
