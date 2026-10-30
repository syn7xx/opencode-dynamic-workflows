/**
 * `ctx.agent` end to end over the fake host: Unit sessions, typed results through `workflow_result`, the text and
 * extract fallbacks, same-session repair, limits, stopping, and resume replay.
 */
import { describe, expect, test } from "bun:test"

import type { ReplayPlan, ReplayUnit } from "../src/context"
import type { HostMessage } from "../src/host"
import type { Unit } from "../src/protocol"
import { z } from "../src/workflow"
import { makeCtx } from "./helpers"

describe("ctx.agent — text Units", () => {
  test("creates one titled Unit session with create-time identity and engine rules, returns the final text", async () => {
    const { ctx, host } = makeCtx({ reply: { text: "hello back" } })
    const out = await ctx.agent("hello", { label: "greeter" })
    expect(out).toBe("hello back")
    expect(host.creates).toHaveLength(1)
    const create = host.creates[0]!
    expect(create.title).toBe("⟡ wf · test · greeter")
    expect(create.agent).toBe("general")
    expect(create.metadata).toMatchObject({
      workflow: { protocol: 1, runId: "run-test", ordinal: 1, parentSessionID: "ses_parent" },
    })
    expect(create.permissions.slice(-5).map((rule) => `${rule.action}:${rule.effect}`)).toEqual([
      "workflow_result:allow",
      "workflow_question:allow",
      "question:deny",
      "workflow:deny",
      "workflow_inline:deny",
    ])
    expect(host.prompts).toEqual([{ sessionID: "ses_fake_1", text: "hello", turn: 0 }])
  })

  test("model strings, effort and agentType are aliases the host understands", async () => {
    const { ctx, host } = makeCtx()
    await ctx.agent("a", { model: "anthropic/claude-x#high" })
    await ctx.agent("b", { model: { providerID: "openai", modelID: "gpt" }, effort: "low", agentType: "explore" })
    expect(host.creates[0]!.model).toEqual({ providerID: "anthropic", id: "claude-x", variant: "high" })
    expect(host.creates[1]!.model).toEqual({ providerID: "openai", id: "gpt", variant: "low" })
    expect(host.creates[1]!.agent).toBe("explore")
  })

  test('model: "inherit" runs the Unit on the launching session\'s model', async () => {
    const callerModel = { providerID: "acme", id: "caller-model" }
    const { ctx, host } = makeCtx({}, { callerModel })
    expect(ctx.model).toBe("acme/caller-model")
    await ctx.agent("x", { model: "inherit" })
    expect(host.creates[0]!.model).toEqual(callerModel)
  })

  test("a bare effort inherits the caller's model at that reasoning level (no silent no-op)", async () => {
    const { ctx, host } = makeCtx({}, { callerModel: { providerID: "acme", id: "caller-model" } })
    await ctx.agent("x", { effort: "high" })
    expect(host.creates[0]!.model).toEqual({ providerID: "acme", id: "caller-model", variant: "high" })
  })

  test("an explicit model still wins over inherited effort inheritance", async () => {
    const { ctx, host } = makeCtx({}, { callerModel: { providerID: "acme", id: "caller-model" } })
    await ctx.agent("x", { model: "openai/gpt", effort: "low" })
    expect(host.creates[0]!.model).toEqual({ providerID: "openai", id: "gpt", variant: "low" })
  })

  test("an explicit model variant wins over effort", async () => {
    const { ctx, host } = makeCtx({}, { callerModel: { providerID: "acme", id: "caller-model" } })
    await ctx.agent("x", { model: "openai/gpt#max", effort: "low" })
    expect(host.creates[0]!.model).toEqual({ providerID: "openai", id: "gpt", variant: "max" })
  })

  test("inheriting a caller model that already carries a variant: effort overrides it (no silent no-op)", async () => {
    const { ctx, host } = makeCtx({}, { callerModel: { providerID: "acme", id: "caller-model", variant: "low" } })
    expect(ctx.model).toBe("acme/caller-model#low")
    await ctx.agent("a", { model: "inherit", effort: "high" })
    await ctx.agent("b", { effort: "max" })
    expect(host.creates[0]!.model).toEqual({ providerID: "acme", id: "caller-model", variant: "high" })
    expect(host.creates[1]!.model).toEqual({ providerID: "acme", id: "caller-model", variant: "max" })
  })

  test("a headless caller (no caller model): inherit and effort are refused and logged, not silent", async () => {
    const { ctx, host, state } = makeCtx({}, { callerModel: null })
    expect(ctx.model).toBeNull()
    await ctx.agent("a", { model: "inherit" })
    await ctx.agent("b", { effort: "high" })
    // Neither Unit gets a model: the host resolves the subagent's configured one.
    expect(host.creates[0]!.model).toBeUndefined()
    expect(host.creates[1]!.model).toBeUndefined()
    expect(state.logs).toHaveLength(2)
    expect(state.logs[0]).toContain('model: "inherit"')
    expect(state.logs[1]).toContain("effort")
  })

  test('a headless caller: "inherit" + effort logs ONE line, not two', async () => {
    const { ctx, state } = makeCtx({}, { callerModel: null })
    await ctx.agent("x", { model: "inherit", effort: "high" })
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]).toContain('model: "inherit"')
  })

  test("an unusable model string is reported, not silently turned into inheritance", async () => {
    const { ctx, host, state } = makeCtx({}, { callerModel: { providerID: "acme", id: "caller-model" } })
    // No provider slash: `toHostModel` cannot parse it.
    await ctx.agent("x", { model: "just-a-model", effort: "high" })
    // Not the caller's model (which inheritance would have substituted), and not a resolved model at all.
    expect(host.creates[0]!.model).toBeUndefined()
    expect(state.logs).toHaveLength(1)
    expect(state.logs[0]).toContain("not a usable model")
  })

  test("a Unit dropped by a limit does not log a model warning", async () => {
    const { ctx, state } = makeCtx({}, { callerModel: null, limits: { maxUnits: 0 }, onLimit: () => {} })
    await ctx.agent("x", { model: "inherit" })
    expect(state.logs.filter((line) => line.includes('model: "inherit"'))).toHaveLength(0)
  })

  test("Workflow and Unit permission rules precede the engine rules", async () => {
    const { ctx, host } = makeCtx({}, { permissions: [{ action: "edit", resource: "*", effect: "allow" }] })
    await ctx.agent("x", { permissions: [{ action: "shell", resource: "*", effect: "deny" }] })
    expect(host.creates[0]!.permissions.map((rule) => rule.action)).toEqual([
      "edit",
      "shell",
      "workflow_result",
      "workflow_question",
      "question",
      "workflow",
      "workflow_inline",
    ])
  })

  test("a provider failure resolves to null and is recorded", async () => {
    const { ctx, state } = makeCtx({ reply: { error: "rate limited" } })
    expect(await ctx.agent("x", { label: "L" })).toBeNull()
    expect(state.errors).toEqual([{ unit: "L", prompt: "x", subagent: "general", error: "rate limited" }])
  })

  test("a create failure resolves to null with the reason", async () => {
    const { ctx, state } = makeCtx({ createError: "nope" })
    expect(await ctx.agent("x")).toBeNull()
    expect(state.errors[0]?.error).toContain("could not create the Unit session: nope")
  })

  test("usage is read from the Unit session and summed", async () => {
    const { ctx, state } = makeCtx({ outputTokens: 7, cost: 0.5 })
    await ctx.agent("a")
    await ctx.agent("b")
    expect(state.usage.tokens.output).toBe(14)
    expect(state.usage.cost).toBe(1)
  })

  test("emits queued → running → succeeded with the session and resolved model", async () => {
    const units: Unit[] = []
    const { ctx } = makeCtx({ model: { providerID: "p", id: "m" } }, { events: { onUnit: (unit) => units.push(unit) } })
    await ctx.agent("go")
    expect(units.map((unit) => unit.status)).toEqual(["queued", "running", "running", "succeeded"])
    const done = units.at(-1)!
    expect(done.sessionID).toBe("ses_fake_1")
    expect(done.model.resolved).toBe("p/m")
    expect(done.output).toBe("go")
    expect(done.resultPath).toBe("text")
  })
})

describe("ctx.agent — typed Units", () => {
  const Rating = z.object({ score: z.number().int().min(0).max(10), reason: z.string() })

  test("a valid workflow_result call resolves to the parsed value", async () => {
    const units: Unit[] = []
    const { ctx } = makeCtx(
      { reply: { result: { score: 7, reason: "ok" } } },
      { events: { onUnit: (u) => units.push(u) } },
    )
    const out = await ctx.agent("rate", { schema: Rating })
    expect(out).toEqual({ score: 7, reason: "ok" })
    expect(units.at(-1)?.resultPath).toBe("tool")
    expect(units.at(-1)?.schema).toBe(true)
  })

  test("an invalid call followed by a valid one in the same turn succeeds without a repair turn", async () => {
    const { ctx, host } = makeCtx({
      reply: {
        results: [
          { score: 99, reason: "x" },
          { score: 9, reason: "fixed" },
        ],
      },
    })
    expect(await ctx.agent("rate", { schema: Rating })).toEqual({ score: 9, reason: "fixed" })
    expect(host.prompts).toHaveLength(1)
  })

  test("no tool call → a repair turn in the SAME session", async () => {
    const units: Unit[] = []
    const { ctx, host } = makeCtx(
      { replies: [{ text: "I think it is a 7." }, { result: { score: 7, reason: "late" } }] },
      { events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("rate", { schema: Rating })).toEqual({ score: 7, reason: "late" })
    expect(host.creates).toHaveLength(1)
    expect(host.prompts.map((p) => p.sessionID)).toEqual(["ses_fake_1", "ses_fake_1"])
    expect(host.prompts[1]!.text).toContain("workflow_result")
    expect(units.map((u) => u.status)).toContain("repairing")
    expect(units.at(-1)?.attempts.map((a) => `${a.path}:${a.ok}`)).toEqual(["tool:false", "tool:true"])
  })

  test("JSON in the reply text is accepted when it validates (text-json path)", async () => {
    const units: Unit[] = []
    const { ctx } = makeCtx(
      { reply: { text: 'Here:\n```json\n{"score": 4, "reason": "meh"}\n```' } },
      { events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("rate", { schema: Rating })).toEqual({ score: 4, reason: "meh" })
    expect(units.at(-1)?.resultPath).toBe("text-json")
  })

  test("after the repairs, extraction is the last resort", async () => {
    const units: Unit[] = []
    const { ctx, host } = makeCtx(
      { reply: { text: "score four, because meh" }, generate: () => '{"score": 4, "reason": "meh"}' },
      { events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("rate", { schema: Rating, retries: 1 })).toEqual({ score: 4, reason: "meh" })
    expect(host.prompts).toHaveLength(2)
    expect(host.generates[0]).toContain("score four")
    expect(units.at(-1)?.resultPath).toBe("extract")
  })

  test("every path failing resolves to null with a legible error", async () => {
    const { ctx, state } = makeCtx({ reply: { text: "no idea" } })
    expect(await ctx.agent("rate", { schema: Rating, retries: 1 })).toBeNull()
    expect(state.errors[0]?.error).toContain("structured output failed after 1 repair turn(s)")
  })

  test("a plain JSON Schema works as `schema` (D7 alias)", async () => {
    const { ctx, index } = makeCtx({ reply: { results: [{ n: "x" }, { n: 3 }] } })
    const out = await ctx.agent("count", {
      schema: {
        type: "object",
        properties: { n: { type: "integer", minimum: 0 } },
        required: ["n"],
        additionalProperties: false,
      },
    })
    expect(out).toEqual({ n: 3 })
    expect(index.size()).toBe(0) // bindings are released when the Unit settles
  })

  test("a schema that is neither zod nor JSON Schema fails the Unit, not the Run", async () => {
    const { ctx, state } = makeCtx()
    expect(await ctx.agent("x", { schema: "nope" as never })).toBeNull()
    expect(state.errors[0]?.error).toContain("not a zod schema or a JSON Schema")
  })
})

describe("ctx.agent — stopping and limits", () => {
  test("a Unit timeout interrupts the session and fails the Unit", async () => {
    const { ctx, host, state } = makeCtx({ reply: { hang: true } })
    expect(await ctx.agent("slow", { timeoutMs: 20 })).toBeNull()
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(state.errors[0]?.error).toContain("20ms timeout")
  })

  test("the per-Unit stop handle stops only that Unit", async () => {
    const units: Unit[] = []
    const stops = new Map<string, () => void>()
    const { ctx } = makeCtx(
      { reply: (call) => (call.text === "hang" ? { hang: true } : { text: "fine" }) },
      { events: { onUnit: (u) => units.push(u), onUnitSession: (unitId, _sid, stop) => stops.set(unitId, stop) } },
    )
    const hanging = ctx.agent("hang", { label: "H" })
    const fine = ctx.agent("ok")
    await new Promise((r) => setTimeout(r, 5))
    const hangId = units.find((u) => u.label === "H")!.unitId
    stops.get(hangId)!()
    expect(await hanging).toBeNull()
    expect(await fine).toBe("fine")
    expect(units.findLast((u) => u.unitId === hangId)?.status).toBe("stopped")
  })

  test("the step guard stops a runaway Unit", async () => {
    const { ctx, state } = makeCtx({ stepsPerPrompt: 5, reply: { hang: true } }, { limits: { maxUnitSteps: 3 } })
    expect(await ctx.agent("loop")).toBeNull()
    expect(state.errors[0]?.error).toContain("step limit (3 model requests)")
  })

  test("limits.maxUnits reports the limit so the orchestrator can stop the Run", async () => {
    const limits: string[] = []
    const { ctx } = makeCtx({}, { limits: { maxUnits: 2 }, onLimit: (m) => limits.push(m) })
    await ctx.agent("1")
    await ctx.agent("2")
    await ctx.agent("3")
    expect(limits).toEqual(["limit reached: this Run tried to start more than 2 Units (limits.maxUnits)"])
  })
})

describe("ctx.agent — resume replay", () => {
  const plan = (overrides: Partial<ReplayPlan> = {}): ReplayPlan => ({
    units: new Map([
      [1, { prompt: "first", status: "succeeded", output: "one", schema: false, subagent: "general" }],
      [2, { prompt: "second", status: "succeeded", output: '{"n": 2}', schema: true, subagent: "general" }],
      [3, { prompt: "third", status: "failed", schema: false, subagent: "general" }],
    ]),
    answers: [],
    rerunFailed: true,
    diverged: false,
    ...overrides,
  })

  test("finished Units come back from the record without a session; failed ones re-run", async () => {
    const units: Unit[] = []
    const { ctx, host } = makeCtx(
      { reply: { text: "live" } },
      { replay: plan(), events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("first")).toBe("one")
    expect(await ctx.agent("second", { schema: z.object({ n: z.number() }) })).toEqual({ n: 2 })
    expect(await ctx.agent("third")).toBe("live")
    expect(host.prompts.map((p) => p.text)).toEqual(["third"])
    expect(units.filter((u) => u.status === "replayed")).toHaveLength(2)
  })

  test("a replayed Unit never re-logs a model-inheritance warning", async () => {
    const logs: string[] = []
    // Only ordinal 1 replays; the second call is a fresh Unit that runs live. With no caller model, the live Unit
    // warns and the replayed one must not.
    const replayOnlyFirst: ReplayPlan = {
      units: new Map([
        [1, { prompt: "first", status: "succeeded", output: "one", schema: false, subagent: "general" }],
      ]),
      answers: [],
      rerunFailed: true,
      diverged: false,
    }
    const { ctx } = makeCtx(
      { reply: { text: "live" } },
      { callerModel: null, replay: replayOnlyFirst, events: { onLog: (m) => logs.push(m) } },
    )
    expect(await ctx.agent("first", { model: "inherit" })).toBe("one")
    expect(logs.filter((line) => line.includes('model: "inherit"'))).toHaveLength(0)
    // A LIVE Unit under the same conditions does warn — proving the suppression is the replay, not the call.
    await ctx.agent("fresh", { model: "inherit" })
    expect(logs.filter((line) => line.includes('model: "inherit"'))).toHaveLength(1)
  })

  test("a different prompt at a recorded ordinal diverges and everything after runs live", async () => {
    const diverged: string[] = []
    const { ctx, host } = makeCtx({ reply: { text: "live" } }, { replay: plan({ onDiverge: (m) => diverged.push(m) }) })
    expect(await ctx.agent("CHANGED")).toBe("live")
    expect(await ctx.agent("second")).toBe("live")
    expect(diverged[0]).toContain("resume diverged at Unit 1")
    expect(host.prompts.map((p) => p.text)).toEqual(["CHANGED", "second"])
  })

  test("recorded ctx.ask answers replay in order", async () => {
    const { ctx } = makeCtx({}, { replay: plan({ answers: [[["Thorough"]]] }) })
    const answer = await ctx.ask(
      {
        header: "Depth",
        prompt: "How deep?",
        options: [
          { label: "Fast", description: "" },
          { label: "Thorough", description: "" },
        ],
      },
      { fallback: [["Fast"]] },
    )
    expect(answer).toEqual([["Thorough"]])
  })

  test("a recorded hand-back (null) replays the fallback", async () => {
    const { ctx } = makeCtx({}, { replay: plan({ answers: [null] }) })
    const answer = await ctx.ask(
      {
        header: "Depth",
        prompt: "How deep?",
        options: [
          { label: "Fast", description: "" },
          { label: "Thorough", description: "" },
        ],
      },
      { fallback: [["Fast"]] },
    )
    expect(answer).toEqual([["Fast"]])
  })
})

describe("ctx.ask and Unit questions", () => {
  const form = {
    header: "Region",
    prompt: "Where?",
    options: [
      { label: "EU", description: "" },
      { label: "US", description: "" },
    ],
  }

  test("with no broker the fallback answers at once (headless contract)", async () => {
    const { ctx } = makeCtx()
    expect(await ctx.ask(form, { fallback: [["us"]] })).toEqual([["US"]])
  })

  test("a fallback outside the offered labels is an authoring error", async () => {
    const { ctx } = makeCtx()
    await expect(ctx.ask(form, { fallback: [["Mars"]] })).rejects.toThrow("fallback")
  })

  test("a Unit's own question tool call is routed to askAgent", async () => {
    const asked: string[] = []
    const { ctx } = makeCtx(
      { reply: { question: { header: "Color", prompt: "red or blue?", options: ["red", "blue"] } } },
      {
        askAgent: (unitId, sessionID) => async (questions) => {
          asked.push(`${unitId.length > 0}:${sessionID}:${questions[0]?.prompt}`)
          return { answers: [["blue"]], by: "human" }
        },
      },
    )
    expect(await ctx.agent("ask something")).toBe("ANSWER: blue")
    expect(asked).toEqual(["true:ses_fake_1:red or blue?"])
  })
})

describe("audit regressions — a Unit never outlives its stop, and never throws", () => {
  test("stopped while the session was being created: the new session is interrupted", async () => {
    const controller = new AbortController()
    const { ctx, host } = makeCtx({ createDelayMs: 30 }, { signal: controller.signal })
    const pending = ctx.agent("x")
    setTimeout(() => controller.abort(), 5)
    expect(await pending).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 40)) // the session appears later; it is stopped then
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(host.prompts).toHaveLength(0)
  })

  test("a hung prompt admission still honours the Unit timeout, and the session is interrupted", async () => {
    const { ctx, host, state } = makeCtx({ promptHang: true })
    expect(await ctx.agent("x", { timeoutMs: 20 })).toBeNull()
    expect(state.errors[0]?.error).toContain("20ms timeout")
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a rejected prompt interrupts the session it may have started", async () => {
    const { ctx, host, state } = makeCtx({ promptError: "boom" })
    expect(await ctx.agent("x")).toBeNull()
    expect(state.errors[0]?.error).toBe("could not prompt the Unit session: boom")
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a rejected wait is a failed Unit (recorded, interrupted), not a thrown error", async () => {
    const units: Unit[] = []
    const { ctx, host, state } = makeCtx({ waitError: "socket closed" }, { events: { onUnit: (u) => units.push(u) } })
    expect(await ctx.agent("x")).toBeNull()
    expect(state.errors[0]?.error).toBe("waiting for the Unit session failed: socket closed")
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(units.at(-1)?.status).toBe("failed")
  })
})

describe("audit regressions — hard budget covers repairs and extraction", () => {
  const Rating = z.object({ score: z.number() })

  test("no repair turn once a hard budget is spent", async () => {
    const { ctx, host, state } = makeCtx(
      { reply: { text: "no json here" }, outputTokens: 80 },
      { budget: 50, hardBudget: true },
    )
    expect(await ctx.agent("rate", { schema: Rating })).toBeNull()
    expect(host.prompts).toHaveLength(1)
    expect(state.errors[0]?.error).toContain("budget exhausted before repair turn 1")
  })

  test("no extraction once a hard budget is spent", async () => {
    const { ctx, host, state } = makeCtx(
      { reply: { text: "score four" }, outputTokens: 30, generate: () => '{"score": 4}' },
      { budget: 50, hardBudget: true },
    )
    expect(await ctx.agent("rate", { schema: Rating, retries: 1 })).toBeNull()
    expect(host.generates).toHaveLength(0)
    expect(state.errors[0]?.error).toContain("budget exhausted before extraction")
  })

  test("extraction's (estimated) tokens are counted in the Unit's usage and the budget", async () => {
    const units: Unit[] = []
    const { ctx, state } = makeCtx(
      { reply: { text: "score four" }, outputTokens: 0, generate: () => '{"score": 4}' },
      { events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("rate", { schema: Rating, retries: 0 })).toEqual({ score: 4 })
    const done = units.at(-1)!
    expect(done.resultPath).toBe("extract")
    expect(done.usage.tokens.output).toBeGreaterThan(0)
    expect(done.attempts.at(-1)?.note).toContain("estimated")
    expect(state.tokensSpent).toBe(done.usage.tokens.output)
  })
})

describe("audit round 2 — runner setup and restarts", () => {
  test("a throw after the Unit is bound still unbinds it, stops its session and reports it", async () => {
    const { ctx, host, index, state } = makeCtx(
      {},
      {
        events: {
          onUnitSession: () => {
            throw new Error("surface bug")
          },
        },
      },
    )
    expect(await ctx.agent("x")).toBeNull()
    expect(index.size()).toBe(0)
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(state.errors[0]?.error).toContain("the Unit failed unexpectedly: surface bug")
  })

  test("an interrupt beyond the restart limit fails the Unit instead of reading the cut-off turn as done", async () => {
    const { ctx, host, index, state } = makeCtx({ reply: { hang: true } })
    const pending = ctx.agent("x")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const binding = index.get("ses_fake_1")!
    binding.restarts = 5
    binding.restart = true
    await host.session.interrupt({ sessionID: "ses_fake_1" })
    expect(await pending).toBeNull()
    expect(state.errors[0]?.error).toContain("restarted more than 5 times")
  })
})

describe("audit round 3 — deadlines cover every step", () => {
  test("the Unit timeout covers a slow session create", async () => {
    const { ctx, host, state } = makeCtx({ createDelayMs: 80 })
    expect(await ctx.agent("x", { timeoutMs: 20 })).toBeNull()
    expect(state.errors[0]?.error).toContain("timeout while its session was being created")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a hung extraction honours the Unit timeout", async () => {
    const { ctx, state } = makeCtx({ reply: { text: "no json" }, generate: () => new Promise<string>(() => {}) })
    expect(await ctx.agent("x", { schema: z.object({ n: z.number() }), retries: 0, timeoutMs: 30 })).toBeNull()
    expect(state.errors[0]?.error).toContain("30ms timeout")
  })

  test("a turn is active only between admission and settling", async () => {
    const { ctx, index } = makeCtx({ reply: { hang: true } })
    const pending = ctx.agent("x", { timeoutMs: 40 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(index.get("ses_fake_1")?.turnActive).toBe(true)
    await pending
  })
})

describe("audit round 4 — a hung interrupt cannot hold the Unit", () => {
  test("stop with a host whose interrupt never returns still ends the Unit", async () => {
    const { ctx, state } = makeCtx({ reply: { hang: true }, interruptHang: true })
    const started = Date.now()
    expect(await ctx.agent("x", { timeoutMs: 20 })).toBeNull()
    expect(state.errors[0]?.error).toContain("20ms timeout")
    expect(Date.now() - started).toBeLessThan(12_000)
  }, 15_000)
})

describe("worktree isolation", () => {
  test("an unchanged worktree is removed; the Unit ran there", async () => {
    const { ctx, host } = makeCtx({ worktree: { changed: false } })
    expect(await ctx.agent("edit", { isolation: "worktree", label: "w" })).toBe("edit")
    expect(host.creates[0]!.location).toEqual({ directory: "/wt/wf-run-test-1" })
    expect(host.worktreeLog).toEqual(["create wf-run-test-1", "changed /wt/wf-run-test-1", "remove /wt/wf-run-test-1"])
    expect(ctx.worktrees()).toEqual([])
  })

  test("a changed worktree is kept and listed for merging", async () => {
    const { ctx, host } = makeCtx({ worktree: { changed: true } })
    await ctx.agent("edit", { isolation: "worktree", label: "w" })
    expect(host.worktreeLog.some((line) => line.startsWith("remove"))).toBe(false)
    expect(ctx.worktrees()).toEqual([{ unit: "w", directory: "/wt/wf-run-test-1", branch: "wt-wf-run-test-1" }])
  })

  test("a location without the plugin fails the Unit early, legibly", async () => {
    const { ctx, host, state } = makeCtx({ worktree: { active: false } })
    expect(await ctx.agent("edit", { isolation: "worktree" })).toBeNull()
    expect(state.errors[0]?.error).toContain("the workflow plugin is not active in /wt/wf-run-test-1")
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a host without worktrees fails the Unit, not the Run", async () => {
    const { ctx, state } = makeCtx()
    expect(await ctx.agent("edit", { isolation: "worktree" })).toBeNull()
    expect(state.errors[0]?.error).toContain("not available on this host")
  })
})

describe("agent receipts — what a Unit's session actually did", () => {
  /** A replay plan with ONE Unit at ordinal 1 — the shape `resumeRun` hands the engine. */
  const oneReplayed = (unit: Partial<ReplayUnit> = {}, plan: Partial<ReplayPlan> = {}): ReplayPlan => ({
    units: new Map([
      [1, { prompt: "first", status: "succeeded", output: "one", schema: false, subagent: "general", ...unit }],
    ]),
    answers: [],
    rerunFailed: true,
    diverged: false,
    ...plan,
  })

  /** The transcript a previous Run's session left behind: one completed `bash` call. */
  const recordedCall = (id: string): { id: string; messages: HostMessage[] } => ({
    id,
    messages: [
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            name: "bash",
            state: { status: "completed", input: { command: "bun run migrate" }, content: "migrated 3 sites" },
          },
        ],
      },
    ],
  })

  test("resolves to { value, unitId, toolCalls } and reports each call the session recorded", async () => {
    const units: Unit[] = []
    const { ctx, host } = makeCtx(
      {
        reply: {
          tools: [
            { name: "bash", input: { command: "bun run migrate" }, content: "migrated 3 sites" },
            { name: "read", input: { path: "src/a.ts" }, content: [{ type: "text", text: "export const a = 1\n" }] },
          ],
          text: "migration done",
        },
      },
      { events: { onUnit: (u) => units.push(u) } },
    )
    const receipt = await ctx.agent("migrate", { label: "migration", receipts: true })
    expect(receipt.value).toBe("migration done")
    expect(receipt.unitId).toBe(units.at(-1)!.unitId)
    const calls = await receipt.toolCalls
    expect(calls.map((call) => call.name)).toEqual(["bash", "read"])
    expect(JSON.parse(calls[0]!.input)).toEqual({ command: "bun run migrate" })
    expect(calls[0]!.output).toBe("migrated 3 sites")
    expect(calls[1]!.output).toBe("export const a = 1\n")
    expect(calls.map((call) => call.successful)).toEqual([true, true])
    // `receipts` is engine-level only: the Unit is created exactly as it would be without it.
    expect(host.creates[0]!.title).toBe("⟡ wf · test · migration")
    expect(host.creates[0]).not.toHaveProperty("receipts")
  })

  test("without receipts agent() still resolves to the bare value, and to null on failure", async () => {
    const { ctx, host } = makeCtx({
      replies: [
        { text: "hello back" },
        { error: "rate limited" },
        { tools: [{ name: "bash", input: { command: "true" }, content: "ok" }], text: "with tools" },
      ],
    })
    expect(await ctx.agent("a")).toBe("hello back")
    expect(await ctx.agent("b")).toBeNull()
    // A Unit that ran tools is still just its text: no receipt on the default path.
    expect(await ctx.agent("c")).toBe("with tools")
    // Exactly one transcript read per Unit — the runner's own. The default path reads nothing extra, even for a Unit
    // that ran tools, which is what "a Workflow that never asks pays nothing" means.
    expect(host.contexts).toHaveLength(3)
  })

  test("a failed Unit reports value: null and STILL reports what it did", async () => {
    const { ctx, state } = makeCtx({
      reply: { tools: [{ name: "bash", input: { command: "bun test" }, content: "1 failing" }], text: "no json here" },
    })
    const receipt = await ctx.agent("do it", { schema: z.object({ ok: z.boolean() }), retries: 0, receipts: true })
    expect(receipt.value).toBeNull()
    expect(state.errors.at(-1)?.error).toContain("structured output failed after 0 repair turn(s)")
    // The raw evidence of what the Unit did outlives its failure.
    const calls = await receipt.toolCalls
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("bash")
    expect(calls[0]!.output).toBe("1 failing")
  })

  test("a call that errored or never completed is not successful", async () => {
    const { ctx } = makeCtx({
      reply: {
        tools: [
          { name: "bash", input: { command: "false" }, content: "exit 1", status: "error", error: "command failed" },
          { name: "bash", input: { command: "sleep 60" }, status: "running" },
        ],
        text: "tried",
      },
    })
    const receipt = await ctx.agent("run it", { label: "runner", receipts: true })
    const calls = await receipt.toolCalls
    expect(calls.map((call) => call.successful)).toEqual([false, false])
    expect(calls[0]!.output).toBe("exit 1")
    expect(calls[1]!.output).toBe("")
  })

  test("a failed call with no output reports its error message, not an empty string", async () => {
    const { ctx } = makeCtx({
      reply: {
        tools: [{ name: "shell", input: { command: "bun run migrate" }, status: "error", error: "command not found" }],
        text: "tried",
      },
    })
    const receipt = await ctx.agent("run it", { label: "runner", receipts: true })
    const [call] = await receipt.toolCalls
    // A fallback receipt-only by design (`toTranscript` shows the host's raw text instead): a reason for the drop is
    // evidence, an empty string is not.
    expect(call!.output).toBe("command not found")
    expect(call!.successful).toBe(false)
  })

  test("a host-reported exit code is not appended: output stays the host's evidence, unmodified", async () => {
    const { ctx } = makeCtx({
      reply: {
        tools: [
          {
            name: "shell",
            input: { command: "bun run migrate" },
            content: '{"ok":true,"n":2}',
            metadata: { exit: 1 },
          },
          { name: "shell", input: { command: "git status" }, content: "clean", metadata: { exitCode: 0 } },
        ],
        text: "ran the migration",
      },
    })
    const receipt = await ctx.agent("migrate", { label: "migration", receipts: true })
    const calls = await receipt.toolCalls
    // `metadata` is an arbitrary passthrough that even a successful call can carry, so a marker would corrupt the
    // evidence — and a JSON result would stop being parseable.
    expect(calls[0]!.output).toBe('{"ok":true,"n":2}')
    expect(JSON.parse(calls[0]!.output)).toEqual({ ok: true, n: 2 })
    expect(calls[1]!.output).toBe("clean")
    // `successful` only says the call FINISHED; the evidence decides whether the command worked.
    expect(calls.map((call) => call.successful)).toEqual([true, true])
  })

  test("a replayed Unit reads the tool calls the ORIGINAL Run's session recorded", async () => {
    const { ctx, host } = makeCtx(
      { seedSessions: [recordedCall("ses_fake_old")] },
      { replay: oneReplayed({ sessionID: "ses_fake_old" }) },
    )
    const receipt = await ctx.agent("first", { label: "from the journal", receipts: true })
    expect(receipt.value).toBe("one")
    // The Unit itself did NOT run here, so the Run creates no session for it.
    expect(host.prompts).toHaveLength(0)
    expect(host.creates).toHaveLength(0)
    // …but its receipt reads the earlier session's evidence.
    const calls = await receipt.toolCalls
    expect(host.contexts).toEqual(["ses_fake_old"])
    expect(calls.map((call) => call.name)).toEqual(["bash"])
    expect(calls[0]!.output).toBe("migrated 3 sites")
    expect(calls[0]!.successful).toBe(true)
  })

  test("a replayed FAILED Unit still reports the evidence its session recorded", async () => {
    // `resumeRun(runId, /* rerunFailed */ false)` replays a failure instead of re-running it. That Unit did not run
    // here either, so a receipt must read the original session exactly like a replayed success — with `value: null`,
    // because the failure is the recorded truth.
    const { ctx, host } = makeCtx(
      { seedSessions: [recordedCall("ses_fake_failed")] },
      {
        replay: oneReplayed(
          { prompt: "third", status: "failed", output: undefined, sessionID: "ses_fake_failed" },
          { rerunFailed: false },
        ),
      },
    )
    const receipt = await ctx.agent("third", { label: "from the journal", receipts: true })
    expect(receipt.value).toBeNull()
    expect(host.prompts).toHaveLength(0)
    const calls = await receipt.toolCalls
    expect(calls.map((call) => call.name)).toEqual(["bash"])
  })

  test("a replayed Unit's receipt does not run the Unit: no prompt, and the Unit stays sessionID: null", async () => {
    const units: Unit[] = []
    const logs: string[] = []
    const { ctx, host } = makeCtx(
      {},
      {
        replay: oneReplayed(),
        events: { onUnit: (u) => units.push(u), onLog: (message) => logs.push(message) },
      },
    )
    const receipt = await ctx.agent("first", { label: "from the journal", receipts: true })
    expect(receipt.value).toBe("one")
    expect(host.prompts).toHaveLength(0)
    expect(units.at(-1)!.status).toBe("replayed")
    expect(units.at(-1)!.sessionID).toBeNull()
    // No recorded session: nothing to read, and [] without a host call — but still reported as unknown, not "none".
    expect(await receipt.toolCalls).toEqual([])
    expect(host.contexts).toEqual([])
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("no session is recorded for it")
  })

  test("the unknown notice is replay-only: a LIVE Unit with no evidence logs nothing", async () => {
    // A live setup failure has no session either, and its `[]` means "it never ran" — already visible through `value`
    // and `errors`. Only a replay needs the notice, because only there does `[]` hide a real earlier Run.
    const logs: string[] = []
    const live = makeCtx({ createError: "no session for you" }, { events: { onLog: (message) => logs.push(message) } })
    const receipt = await live.ctx.agent("nope", { label: "broken", receipts: true })
    expect(receipt.value).toBeNull()
    await expect(receipt.toolCalls).resolves.toEqual([])
    expect(logs).toEqual([])
    // …and a live READ failure still throws rather than logging an unknown.
    const failed: string[] = []
    const read = makeCtx({ reply: { text: "done" } }, { events: { onLog: (message) => failed.push(message) } })
    const second = await read.ctx.agent("talk", { receipts: true })
    read.host.session.context = async () => {
      throw new Error("socket closed")
    }
    await expect(second.toolCalls).rejects.toThrow("agent({ receipts }): reading the session")
    expect(failed).toEqual([])
  })

  test("a throwing host logger cannot turn a replayed receipt's [] into a rejection", async () => {
    // The notice is the only external call on the "never rejects" path, so it must not be able to break that promise.
    const { ctx } = makeCtx(
      {},
      {
        replay: oneReplayed({ sessionID: "ses_deleted" }),
        events: {
          onLog: () => {
            throw new Error("the TUI blew up")
          },
        },
      },
    )
    const receipt = await ctx.agent("first", { receipts: true })
    await expect(receipt.toolCalls).resolves.toEqual([])
  })

  test("a replayed Unit left without receipts never touches the host -- no read for a value nobody asserts on", async () => {
    const { ctx, host } = makeCtx(
      { seedSessions: [recordedCall("ses_fake_old")] },
      { replay: oneReplayed({ sessionID: "ses_fake_old" }) },
    )
    expect(await ctx.agent("first")).toBe("one")
    expect(host.contexts).toEqual([])
  })

  test("a replayed receipt is lazy and memoized: one read, only once toolCalls is awaited", async () => {
    const { ctx, host } = makeCtx(
      { seedSessions: [recordedCall("ses_fake_old")] },
      { replay: oneReplayed({ sessionID: "ses_fake_old" }) },
    )
    const receipt = await ctx.agent("first", { receipts: true })
    expect(host.contexts).toEqual([]) // resolving the receipt read nothing
    const [first, second] = await Promise.all([receipt.toolCalls, receipt.toolCalls])
    expect(first).toBe(second) // the same promise, not two reads
    expect(host.contexts).toEqual(["ses_fake_old"])
  })

  test("a replayed Unit's unreadable session reports [] (unknown) -- gone and broken alike, never a failure", async () => {
    // Backward compatibility: before receipts could read a replayed Unit's session at all, `toolCalls` was `[]` and
    // never rejected. Any failure — the session is gone (unknown id) or the host is broken (a transport error) — must
    // keep that promise, so a resumed Workflow that passed before cannot start failing now.
    for (const hostOptions of [{}, { contextError: "socket closed" }]) {
      const logs: string[] = []
      const { ctx, host, state } = makeCtx(hostOptions, {
        replay: oneReplayed({ sessionID: "ses_deleted" }),
        events: { onLog: (message) => logs.push(message) },
      })
      const receipt = await ctx.agent("first", { label: "from the journal", receipts: true })
      await expect(receipt.toolCalls).resolves.toEqual([])
      // Exactly one host call: the read. No existence check, no retry — the replayed path is best-effort.
      expect(host.contexts).toEqual(["ses_deleted"])
      // A read failure on the replayed path is not a Run failure either …
      expect(state.errors).toEqual([])
      // … but it is never silent: an unknown ≠ "called no tools", and the Run log says so.
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain("replayed Unit from the journal")
      expect(logs[0]).toContain("tool calls are unknown")
    }
  })

  test("a replayed Unit whose transcript comes back malformed reports [] instead of rejecting", async () => {
    const logs: string[] = []
    const { ctx, host } = makeCtx(
      {},
      {
        replay: oneReplayed({ sessionID: "ses_fake_old" }),
        events: { onLog: (message) => logs.push(message) },
      },
    )
    // A host that resolves a transcript of the wrong shape: the type forbids it, a misbehaving server can still do it.
    host.session.context = async () => null as never
    const receipt = await ctx.agent("first", { label: "from the journal", receipts: true })
    await expect(receipt.toolCalls).resolves.toEqual([])
    expect(logs[0]).toContain("transcript the engine cannot read")
  })

  test("a replayed Unit with a READABLE session logs nothing", async () => {
    const logs: string[] = []
    const { ctx } = makeCtx(
      { seedSessions: [recordedCall("ses_fake_old")] },
      { replay: oneReplayed({ sessionID: "ses_fake_old" }), events: { onLog: (message) => logs.push(message) } },
    )
    const receipt = await ctx.agent("first", { receipts: true })
    expect(await receipt.toolCalls).toEqual([expect.objectContaining({ name: "bash" })])
    expect(logs).toEqual([])
  })

  test("a LIVE Unit whose transcript comes back malformed still throws", async () => {
    // The live path keeps its pre-existing behaviour: a session that exists must be readable, and a host violating
    // its own contract is a real error, not silently "no calls".
    const { ctx, host } = makeCtx({ reply: { text: "done" } })
    const receipt = await ctx.agent("talk", { receipts: true })
    host.session.context = async () => null as never
    await expect(receipt.toolCalls).rejects.toBeInstanceOf(TypeError)
  })

  test("a Unit that ran no tools reports []", async () => {
    const { ctx } = makeCtx({ reply: { text: "just talking" } })
    const receipt = await ctx.agent("talk", { label: "talker", receipts: true })
    expect(receipt.value).toBe("just talking")
    expect(await receipt.toolCalls).toEqual([])
  })

  test("a Unit stopped before its session existed reports no calls and reads nothing", async () => {
    const controller = new AbortController()
    const { ctx, host, state } = makeCtx({}, { signal: controller.signal })
    controller.abort()
    const receipt = await ctx.agent("x", { label: "gone", receipts: true })
    expect(receipt.value).toBeNull()
    expect(receipt.unitId).toEqual(expect.any(String))
    expect(await receipt.toolCalls).toEqual([])
    expect(host.creates).toHaveLength(0)
    expect(host.contexts).toEqual([])
    expect(state.errors).toHaveLength(1)
  })

  test("a very large payload is clipped, and what is kept is still useful", async () => {
    const body = "migrated site 42\n".repeat(5_000)
    const { ctx } = makeCtx({
      reply: {
        tools: [{ name: "read", input: { command: "cat huge.log", padding: "p".repeat(20_000) }, content: body }],
        text: "read it",
      },
    })
    const receipt = await ctx.agent("read the log", { label: "reader", receipts: true })
    const [call] = await receipt.toolCalls
    // MAX_TOOL_CALL_TEXT in context.ts — the clip keeps thousands of characters, not the 160 of an audit line.
    expect(call!.output.length).toBe(4_000)
    expect(call!.output.startsWith("migrated site 42\nmigrated site 42\n")).toBe(true)
    expect(call!.output.endsWith("…")).toBe(true)
    expect(call!.input.length).toBe(4_000)
    expect(call!.input).toContain("cat huge.log")
    expect(call!.input.endsWith("…")).toBe(true)
  })

  test("toolCalls is lazy (no read until asked) and memoized (one read for two asks)", async () => {
    const { ctx, host } = makeCtx({
      reply: { tools: [{ name: "bash", input: { command: "true" }, content: "ok" }], text: "done" },
    })
    const receipt = await ctx.agent("run", { label: "runner", receipts: true })
    const ownRead = host.contexts.length // the runner's own read of the Unit transcript
    await Bun.sleep(1)
    expect(host.contexts).toHaveLength(ownRead) // never accessed ⇒ never read
    const first = await receipt.toolCalls
    const second = await receipt.toolCalls
    expect(first).toHaveLength(1)
    expect(second).toBe(first) // the same memoized promise
    expect(host.contexts).toHaveLength(ownRead + 1)
  })

  test("a session that cannot be read rejects from toolCalls, and does not fail the Unit", async () => {
    const { ctx, host } = makeCtx({ reply: { text: "done" }, contextError: "socket closed", contextErrorFrom: 2 })
    const receipt = await ctx.agent("x", { label: "reader", receipts: true })
    expect(receipt.value).toBe("done") // the Unit itself settled normally
    await expect(receipt.toolCalls).rejects.toThrow(
      "agent({ receipts }): reading the session of Unit reader failed: socket closed",
    )
    // Memoized rejection: asking again does not read again.
    await expect(receipt.toolCalls).rejects.toThrow("socket closed")
    expect(host.contexts).toHaveLength(2)
  })

  test("the tracked in-flight promise IS the promise agent() returned, on both paths", async () => {
    const { ctx, state } = makeCtx({ reply: { hang: true } })
    const receiptTask = ctx.agent("a", { timeoutMs: 20, receipts: true })
    const valueTask = ctx.agent("b", { timeoutMs: 20 })
    expect(state.inflight.size).toBe(2)
    // Identity, not the count: a fire-and-forget author holds the promise the Run actually drains.
    expect(state.inflight.has(receiptTask)).toBe(true)
    expect(state.inflight.has(valueTask)).toBe(true)
    const [receipt, value] = await Promise.all([receiptTask, valueTask])
    expect(receipt.value).toBeNull()
    expect(value).toBeNull()
    // Nothing leaks: both Units unregistered themselves as they settled.
    expect(state.inflight.size).toBe(0)
  })

  test("a fire-and-forget agent() whose Unit rejects leaves no unhandled rejection, on both paths", async () => {
    // A genuine host surprise: the event sink throws while announcing the settled Unit.
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      for (const receipts of [false, true]) {
        const { ctx, state } = makeCtx(
          { reply: { text: "done" } },
          {
            events: {
              onUnit: (unit) => {
                if (unit.status === "succeeded") throw new Error("onUnit blew up")
              },
            },
          },
        )
        const returned = receipts ? ctx.agent("a", { receipts: true }) : ctx.agent("a")
        expect(state.inflight.has(returned)).toBe(true)
        await Bun.sleep(20)
        expect(state.inflight.has(returned)).toBe(false)
      }
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("a receipt serializes to { value, unitId }: no read, no lie in the journal", async () => {
    const { ctx, host } = makeCtx({
      reply: { tools: [{ name: "bash", input: { command: "true" }, content: "ok" }], text: "done" },
    })
    const receipt = await ctx.agent("run", { label: "runner", receipts: true })
    const ownRead = host.contexts.length
    expect(Object.keys(receipt)).toEqual(["value", "unitId"])
    expect(JSON.stringify(receipt)).toBe(`{"value":"done","unitId":"${receipt.unitId}"}`)
    // Structured-cloneable too (a promise is not): what a store or a journal does to a result must not throw.
    const clone = structuredClone(receipt) as unknown as Record<string, unknown>
    expect(clone).toEqual({ value: "done", unitId: receipt.unitId })
    expect(host.contexts).toHaveLength(ownRead) // serializing read nothing
    expect(await receipt.toolCalls).toHaveLength(1) // and the evidence is still there when asked for
  })

  test("a clip never ends in the middle of a surrogate pair", async () => {
    const body = `${"a".repeat(3_998)}😀${"b".repeat(100)}`
    const { ctx } = makeCtx({
      reply: { tools: [{ name: "bash", input: { command: "echo" }, content: body }], text: "done" },
    })
    const receipt = await ctx.agent("run", { label: "runner", receipts: true })
    const [call] = await receipt.toolCalls
    // The pair straddles the cut, so both halves are dropped rather than one lone half being kept.
    expect(call!.output).toBe(`${"a".repeat(3_998)}…`)
  })

  test("collect() keeps a failed Unit's receipt: a receipt is never a null slot", async () => {
    const { ctx, state } = makeCtx({ replies: [{ text: "fine" }, { error: "rate limited" }] })
    const kept = ctx.collect(
      await ctx.parallel([() => ctx.agent("one", { receipts: true }), () => ctx.agent("two", { receipts: true })]),
    )
    // Without receipts the second slot would be `null` and `collect` would drop it; an opted-in fan-out keeps both,
    // so the shape of an opted-in `parallel` + `collect` differs on purpose (`value` is what carries the failure).
    expect(kept).toHaveLength(2)
    expect(kept.map((receipt) => receipt.value)).toEqual(["fine", null])
    expect(kept[1]!.unitId).toEqual(expect.any(String))
    expect(state.errors).toHaveLength(1)
    expect(await kept[1]!.toolCalls).toEqual([])
  })

  test("receipts flow through pipeline, parallel and collect as the receipt object", async () => {
    const { ctx } = makeCtx({
      reply: (call) => ({
        tools: [{ name: "bash", input: { command: call.text }, content: "ok" }],
        text: `did ${call.text}`,
      }),
    })
    const reviewed = await ctx.pipeline(
      ["a.ts", "b.ts"],
      (file) => ctx.agent(`review ${file}`, { label: file, receipts: true }),
      async (receipt) => ({ value: receipt.value, calls: (await receipt.toolCalls).length }),
    )
    expect(reviewed).toEqual([
      { value: "did review a.ts", calls: 1 },
      { value: "did review b.ts", calls: 1 },
    ])
    const fanout = ctx.collect(
      await ctx.parallel([() => ctx.agent("one", { receipts: true }), () => ctx.agent("two", { receipts: true })]),
    )
    expect(fanout.map((receipt) => receipt.value)).toEqual(["did one", "did two"])
    expect(await Promise.all(fanout.map((receipt) => receipt.toolCalls))).toHaveLength(2)
  })
})
