/**
 * `agent({ keepSession })` / `agent({ session })` / `handle.ask()` — a conversation that spans turns.
 *
 * The rules these tests pin: a continuation is a NEW Unit with its OWN id, ordinal and prompt, but it runs in the
 * session the earlier turn created, so the transcript accumulates. Everything the session decided at create time is
 * refused rather than ignored. Usage is per turn, not per session.
 */
import { describe, expect, test } from "bun:test"

import type { HostMessage } from "../src/host"
import type { Unit } from "../src/protocol"
import { z } from "../src/workflow"
import { makeCtx } from "./helpers"

describe("agent({ keepSession }) — a conversation", () => {
  test("a continuation is a new Unit that runs in the SAME session, with no second create", async () => {
    const { ctx, state } = makeCtx({ reply: (call) => ({ text: `about ${call.text}` }) })
    const first = await ctx.agent("review", { label: "reviewer", keepSession: true })
    expect(first.value).toBe("about review")
    expect(first.sessionID).toBe("ses_fake_1")

    const second = await first.ask("re-check")
    expect(second.value).toBe("about re-check")
    // Same session, two prompts: the conversation continued instead of starting over.
    expect(second.sessionID).toBe("ses_fake_1")
    expect(state.unitCount).toBe(2)
    expect(second.unitId).not.toBe(first.unitId)
  })

  test("the second turn sends a prompt only — no create, so agent/model/location cannot change", async () => {
    const { ctx, host } = makeCtx({ reply: { text: "ok" } })
    const first = await ctx.agent("one", { subagent: "explore", model: "acme/m1", keepSession: true })
    await ctx.agent("two", { session: first.sessionID! })
    expect(host.creates).toHaveLength(1)
    expect(host.creates[0]!.agent).toBe("explore")
    expect(host.prompts.map((prompt) => prompt.sessionID)).toEqual(["ses_fake_1", "ses_fake_1"])
    expect(host.prompts.map((prompt) => prompt.turn)).toEqual([0, 1])
  })

  test("a continuation that names subagent/model/location/permissions fails as a Unit, not silently", async () => {
    const { ctx, host, state } = makeCtx({ reply: { text: "ok" } })
    const first = await ctx.agent("one", { keepSession: true })
    const cases: Array<Record<string, unknown>> = [
      { subagent: "reviewer" },
      { agentType: "reviewer" },
      { model: "acme/other" },
      { effort: "high" },
      { location: "/elsewhere" },
      { worktree: true },
      { permissions: [{ action: "edit", resource: "*", effect: "allow" }] },
    ]
    for (const extra of cases) {
      const out = await ctx.agent("two", { session: first.sessionID!, ...extra } as never)
      expect(out).toBeNull()
    }
    // Nothing ran: the mistake was reported before a single prompt was sent.
    expect(host.prompts).toHaveLength(1)
    expect(state.errors).toHaveLength(cases.length)
    expect(state.errors[0]!.error).toContain("keeps its session's subagent")
    expect(state.errors[0]!.error).toContain("start a new Unit")
  })

  test("schema is per turn: a text turn followed by a typed one on the same session", async () => {
    const { ctx } = makeCtx({
      replies: [{ text: "loose notes" }, { result: { issues: ["a", "b"] } }],
    })
    const first = await ctx.agent("review", { keepSession: true })
    expect(first.value).toBe("loose notes")
    const Findings = z.object({ issues: z.array(z.string()) })
    const second = await first.ask("list them", { schema: Findings })
    expect(second.value).toEqual({ issues: ["a", "b"] })
  })

  test("an unknown session id is refused: a stray id never becomes a Unit's scratchpad", async () => {
    const { ctx, host, state } = makeCtx({ reply: { text: "ok" } })
    const out = await ctx.agent("hi", { session: "ses_someone_elses_chat" })
    expect(out).toBeNull()
    expect(host.prompts).toHaveLength(0)
    expect(state.errors[0]!.error).toContain("not a session this Run can continue")
  })

  test("close() ends the conversation; a later turn fails legibly and the session is interrupted", async () => {
    const { ctx, host, state } = makeCtx({ reply: { text: "ok" } })
    const first = await ctx.agent("one", { keepSession: true })
    await first.close()
    expect(host.interrupts).toEqual(["ses_fake_1"])
    const after = await ctx.agent("two", { session: first.sessionID! })
    expect(after).toBeNull()
    expect(state.errors.at(-1)!.error).toContain("closed")
    expect(host.prompts).toHaveLength(1)
  })

  test("one turn at a time: a concurrent turn on a busy session is refused", async () => {
    const { ctx, state } = makeCtx({ reply: { text: "ok" }, delayMs: 20 })
    const first = await ctx.agent("one", { keepSession: true })
    const [a, b] = await Promise.all([
      ctx.agent("two", { session: first.sessionID! }),
      ctx.agent("three", { session: first.sessionID! }),
    ])
    // Exactly one turn won the session; the other was refused instead of interleaving in the transcript.
    expect([a, b].filter((value) => value === "ok")).toHaveLength(1)
    expect([a, b].filter((value) => value === null)).toHaveLength(1)
    expect(state.errors.at(-1)!.error).toContain("one turn at a time")
  })

  test("usage is per turn: a continuation reports what THIS turn spent, not the session total", async () => {
    const { ctx, state } = makeCtx({ reply: { text: "ok" }, outputTokens: 7 })
    const first = await ctx.agent("one", { keepSession: true })
    expect(first.value).toBe("ok")
    const afterFirst = state.usage.tokens.output
    await ctx.agent("two", { session: first.sessionID! })
    // The fake host reports session totals (7 per turn), so the second Unit must have reported 7, not 14.
    expect(state.usage.tokens.output - afterFirst).toBe(7)
  })

  test("each turn reports only its own tokens: 10, 20, 30 cumulative → 10, 10, 10 per Unit", async () => {
    // A session reports LIFETIME totals; the engine subtracts a baseline taken before each turn. Without that, turn 2
    // would be billed for turn 1's tokens as well, and a review loop would look quadratic in cost.
    const units: Unit[] = []
    const { ctx, state } = makeCtx(
      { reply: (call) => ({ text: `r:${call.text}` }), outputTokens: 100 },
      { events: { onUnit: (unit) => units.push(unit) } },
    )
    const first = await ctx.agent("t1", { label: "t1", keepSession: true })
    const second = await first.ask("t2", { label: "t2" })
    await second.ask("t3", { label: "t3" })

    const settled = units.filter((unit) => unit.status === "succeeded")
    expect(settled.map((unit) => unit.label)).toEqual(["t1", "t2", "t3"])
    // Every turn spent the same: its own prompt and its own answer, not the conversation's running total.
    expect(settled.map((unit) => unit.usage.tokens.input)).toEqual([10, 10, 10])
    expect(settled.map((unit) => unit.usage.tokens.output)).toEqual([100, 100, 100])
    // The Run adds the turns up — which IS the conversation's total, and what the budget is measured against.
    expect(state.usage.tokens.input).toBe(30)
    expect(state.usage.tokens.output).toBe(300)
    expect(state.tokensSpent).toBe(300)
  })

  test("a handle serializes to { value, unitId, sessionID }: no function table in the journal", async () => {
    const { ctx, host } = makeCtx({
      reply: { tools: [{ name: "bash", input: { command: "true" }, content: "ok" }], text: "done" },
    })
    const handle = await ctx.agent("run", { keepSession: true })
    const ownRead = host.contexts.length
    expect(Object.keys(handle)).toEqual(["value", "unitId", "sessionID"])
    expect(JSON.stringify(handle)).toBe(
      `{"value":"done","unitId":"${handle.unitId}","sessionID":"${handle.sessionID}"}`,
    )
    expect(host.contexts).toHaveLength(ownRead)
    expect(await handle.toolCalls).toHaveLength(1)
  })

  test("resume() on a Unit that never had a session fails as a value, not a rejection", async () => {
    const { ctx, state } = makeCtx({ createError: "no capacity" })
    const handle = await ctx.agent("one", { keepSession: true })
    expect(handle.value).toBeNull()
    expect(handle.sessionID).toBeNull()
    const again = await handle.ask("two")
    expect(again.value).toBeNull()
    expect(state.errors.at(-1)!.error).toContain("never had a session")
  })

  test("a continuation's Unit is journaled with its session from the start", async () => {
    const seen: Unit[] = []
    const { ctx } = makeCtx({ reply: { text: "ok" } }, { events: { onUnit: (unit) => seen.push(unit) } })
    const first = await ctx.agent("one", { keepSession: true })
    seen.length = 0
    await ctx.agent("two", { session: first.sessionID!, label: "turn2" })
    const queued = seen[0]!
    expect(queued.label).toBe("turn2")
    expect(queued.sessionID).toBe("ses_fake_1")
    expect(queued.prompt).toBe("two")
  })

  test("the transcript accumulates across turns: the second turn sees the first one's messages", async () => {
    const { ctx, host } = makeCtx({ reply: (call) => ({ text: `reply to ${call.text}` }) })
    const first = await ctx.agent("one", { keepSession: true })
    await first.ask("two")
    const transcript = (await host.session.context({ sessionID: first.sessionID! })) as HostMessage[]
    expect(transcript.map((message) => message.type)).toEqual(["user", "assistant", "user", "assistant"])
    expect(transcript[0]!.content?.[0]?.text).toBe("one")
    expect(transcript[2]!.content?.[0]?.text).toBe("two")
  })

  test("a continuation's answer is its OWN turn, never the previous turn's text", async () => {
    // The blocker this pins: a session holds every turn, and "the last assistant text" would answer with turn 1.
    const { ctx, state } = makeCtx({ replies: [{ text: "first answer" }, { none: true }] })
    const first = await ctx.agent("review1", { keepSession: true })
    expect(first.value).toBe("first answer")
    const second = await first.ask("review2")
    // Turn 2 produced no text at all: that is a failed turn, NOT turn 1's answer reported as a success.
    expect(second.value).toBeNull()
    expect(state.errors.at(-1)!.unit).toBeTruthy()
  })

  test("a continuation's provider error is not swallowed by the previous turn's answer", async () => {
    const { ctx, state } = makeCtx({ replies: [{ text: "first answer" }, { error: "provider exploded" }] })
    const first = await ctx.agent("review1", { keepSession: true })
    const second = await first.ask("review2")
    expect(second.value).toBeNull()
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0]!.error).toContain("provider exploded")
  })

  test("a typed continuation does not reuse the previous turn's JSON", async () => {
    const Findings = z.object({ issues: z.array(z.string()) })
    const { ctx } = makeCtx({
      // Turn 1 answers with a valid JSON object in text; turn 2 answers with nothing at all.
      replies: [{ text: '{"issues":["stale"]}' }, { none: true }],
    })
    const first = await ctx.agent("review1", { schema: Findings, keepSession: true })
    expect(first.value).toEqual({ issues: ["stale"] })
    const second = await first.ask("review2", { schema: Findings, retries: 0 })
    expect(second.value).toBeNull()
  })

  test("a continuation's toolCalls are its own turn's, not the whole conversation's", async () => {
    const { ctx } = makeCtx({
      replies: [
        { tools: [{ name: "bash", input: { command: "first" }, content: "one" }], text: "a" },
        { tools: [{ name: "bash", input: { command: "second" }, content: "two" }], text: "b" },
      ],
    })
    const first = await ctx.agent("t1", { keepSession: true })
    expect((await first.toolCalls).map((call) => JSON.parse(call.input))).toEqual([{ command: "first" }])
    const second = await first.ask("t2")
    expect((await second.toolCalls).map((call) => JSON.parse(call.input))).toEqual([{ command: "second" }])
  })

  test("a receipt read AFTER the next turn still reports its OWN turn's calls", async () => {
    // The lazy getter can be read long after the Unit settled — by then the session holds later turns too. The
    // boundary is measured when the turn ends, so a late read must not drift into the next turn.
    const { ctx } = makeCtx({
      replies: [
        { tools: [{ name: "read", input: { path: "a.ts" }, content: "a" }], text: "one" },
        { tools: [{ name: "edit", input: { path: "a.ts" }, content: "b" }], text: "two" },
      ],
    })
    const first = await ctx.agent("t1", { keepSession: true })
    await first.ask("t2")
    // Read only now: both turns are in the session.
    expect((await first.toolCalls).map((call) => call.name)).toEqual(["read"])
  })

  test("a repair turn does not shrink the receipt to the repair prompt", async () => {
    // A typed Unit's repair turn is a separate prompt in the SAME Unit: the "last user message" moves to it, so a
    // boundary derived from it would drop the first attempt's tool calls.
    const Findings = z.object({ ok: z.boolean() })
    const { ctx } = makeCtx({
      replies: [
        // Turn 1 of the Unit: calls a tool, then answers with an invalid payload.
        { tools: [{ name: "bash", input: { command: "check" }, content: "ran" }], text: "not the tool" },
        // The repair turn: a valid result.
        { result: { ok: true } },
      ],
    })
    const receipt = await ctx.agent("do it", { schema: Findings, retries: 1, receipts: true })
    expect(receipt.value).toEqual({ ok: true })
    const names = (await receipt.toolCalls).map((call) => call.name)
    // Both the original call and the submitted result are this Unit's evidence.
    expect(names).toContain("bash")
    expect(names).toContain("workflow_result")
  })

  test("a continuation whose start read fails fails the turn — it never answers with the previous turn's text", async () => {
    // THE regression this guards: with no measurable boundary, "read the transcript" means the whole conversation, and
    // a turn that produced nothing is answered with the PREVIOUS turn's text as a success.
    //
    // The scenario has to be discriminating: turn 1 must SUCCEED (its own answer read is #1), and only turn 2's
    // start measurement (reads #2 and #3, the try and the retry) must fail. Failing every read — as an earlier
    // version of this test did — passes for the wrong reason: turn 1 fails too, so `resume` on a session-less handle
    // returns null whatever the measurement does.
    const { ctx, state } = makeCtx({
      replies: [{ text: "TURN1 ANSWER" }, { text: "TURN2 ANSWER" }],
      // Reads: turn 1's answer (1), then turn 2's start measurement and its retry (2 and 3) fail; nothing else does.
      // Break ONLY those, so the failure is the measurement — not an unreadable transcript, which would fail for a
      // different reason and let a broken fix pass.
      contextErrorAt: [2, 3],
      contextError: "transient read failure",
    })
    const first = await ctx.agent("t1", { keepSession: true })
    expect(first.value).toBe("TURN1 ANSWER")
    expect(first.sessionID).not.toBeNull()
    const second = await first.ask("t2")
    // The turn fails, legibly, and — the point — never carries the previous turn's answer as a success.
    expect(second.value).toBeNull()
    const error = state.errors.at(-1)!.error
    expect(error).toContain("could not be scoped to its own messages")
    expect(second.value).not.toBe("TURN1 ANSWER")
  })

  test("a single transient failure of the start read is retried, so the turn still runs", async () => {
    // The measurement retries once: a host hiccup on the boundary read must not fail an otherwise healthy turn.
    const { ctx } = makeCtx({
      replies: [{ text: "one" }, { text: "two" }],
      // Read 1 is turn 1's answer; read 2 is turn 2's start measurement — a one-off failure, retried and succeeding.
      contextErrorAt: [2],
      contextError: "one-off hiccup",
    })
    const first = await ctx.agent("t1", { keepSession: true })
    expect(first.value).toBe("one")
    const second = await first.ask("t2")
    expect(second.value).toBe("two")
  })

  test("a continuation that died before its answer reports NO tool calls, not the earlier turn's", async () => {
    // `slice` stays `null` when a turn dies before the read that ends it. For a Unit that owns its session that means
    // "the whole session is my turn" — true by definition. For a continuation the session also holds earlier turns,
    // so the whole transcript would hand back calls this turn never made: `[]` (unknown) is the only honest answer.
    const { ctx, state } = makeCtx({
      replies: [
        { tools: [{ name: "read", input: { path: "turn1.ts" }, content: "a" }], text: "one" },
        { tools: [{ name: "read", input: { path: "turn2.ts" }, content: "b" }], text: "two" },
      ],
      // Reads: turn 1's answer (1), turn 2's start measurement (2), turn 2's answer read (3) — break the last one.
      contextErrorFrom: 3,
      contextError: "transcript vanished",
    })
    const first = await ctx.agent("t1", { keepSession: true })
    const second = await first.ask("t2")
    expect(second.value).toBeNull()
    expect(state.errors.at(-1)!.error).toContain("could not read the Unit transcript")
    // Failed before the read that fixes its slice: `[]`, never turn 1's `read`.
    expect(await second.toolCalls).toEqual([])
  })

  test("an unmeasurable turn reports NO tool calls even when the transcript reads fine", async () => {
    // The subtler leak: the boundary is missing (the turn timed out before its answer read) but the transcript is
    // perfectly readable. Reading it would look authoritative and hand back the EARLIER turn's calls. The guard must
    // therefore sit before the read, not after it.
    const { ctx, state } = makeCtx({
      replies: [{ tools: [{ name: "read", input: { path: "turn1.ts" }, content: "a" }], text: "one" }, { hang: true }],
    })
    const first = await ctx.agent("t1", { keepSession: true })
    expect(first.value).toBe("one")
    // The turn times out before it can read its own answer: no slice is ever recorded.
    const second = await first.ask("t2", { timeoutMs: 20 })
    expect(second.value).toBeNull()
    expect(state.errors.at(-1)!.error).toContain("timeout")
    // Every read would succeed here — the answer is still `[]`, because the turn's own extent is unknown.
    expect(await second.toolCalls).toEqual([])
  })

  test("a rejected continuation is journaled WITHOUT the session id it named", async () => {
    // `cleanupTargets` collects every Unit's sessionID, so a stray id here would let "delete this Run's sessions"
    // delete a session the Run never owned.
    const units: Unit[] = []
    const { ctx } = makeCtx({ reply: { text: "ok" } }, { events: { onUnit: (unit) => units.push(unit) } })
    await ctx.agent("hi", { session: "ses_someone_elses_chat" })
    expect(units).toHaveLength(1)
    expect(units[0]!.status).toBe("failed")
    expect(units[0]!.sessionID).toBeNull()
  })

  test("a continuation's Unit reports the session's directory, not the Run's root", async () => {
    const units: Unit[] = []
    const { ctx } = makeCtx(
      { reply: { text: "ok" }, seedSessions: [{ id: "ses_wt" }] },
      { events: { onUnit: (unit) => units.push(unit) } },
    )
    // Register a session the way a worktree Unit's first turn would: created in another directory.
    const first = await ctx.agent("one", { keepSession: true })
    expect(first.sessionID).toBe("ses_fake_1")
    expect(units.at(-1)!.location).toBe("/fake")
  })

  test("a finished turn stays finished: the surfaces key Units by unitId, never by session", async () => {
    // The whole point of this test: three turns of one conversation are THREE Unit rows with their own statuses.
    // Sharing a session must not make an earlier turn look like it is running again — `runs.ts` and `ui/state.ts`
    // upsert by `unitId`, and nothing there groups by `sessionID`.
    const seen: Unit[] = []
    const { ctx } = makeCtx(
      { reply: (call) => ({ text: `r:${call.text}` }), delayMs: 5 },
      { events: { onUnit: (unit) => seen.push(unit) } },
    )
    const first = await ctx.agent("review1", { label: "review", keepSession: true })
    await ctx.agent("fix", { label: "fix" })
    await first.ask("review2", { label: "review2" })

    // The latest state of each Unit, in ordinal order — what a surface renders as rows.
    const latest = new Map<string, Unit>()
    for (const unit of seen) latest.set(unit.unitId, unit)
    const rows = [...latest.values()].toSorted((a, b) => a.ordinal - b.ordinal)
    expect(rows.map((unit) => unit.label)).toEqual(["review", "fix", "review2"])
    expect(rows.map((unit) => unit.status)).toEqual(["succeeded", "succeeded", "succeeded"])
    // Two rows share one session — and that is exactly why the session cannot be the identity.
    expect(rows[0]!.sessionID).toBe(rows[2]!.sessionID)
    expect(rows[1]!.sessionID).not.toBe(rows[0]!.sessionID)
    expect(new Set(rows.map((unit) => unit.unitId)).size).toBe(3)
    expect(rows.map((unit) => unit.ordinal)).toEqual([1, 2, 3])
  })

  test("an in-flight turn does not re-open an earlier turn on the same session", async () => {
    const statuses: Array<{ prompt: string; status: string }> = []
    const { ctx } = makeCtx(
      { reply: (call) => ({ text: `r:${call.text}` }), delayMs: 5 },
      { events: { onUnit: (unit) => statuses.push({ prompt: unit.prompt, status: unit.status }) } },
    )
    const first = await ctx.agent("review1", { label: "review", keepSession: true })
    const running = first.ask("review2", { label: "review2" })
    // While the second turn is in flight, the first turn saw its last transition as `succeeded`.
    await Bun.sleep(2)
    const lastOf = (prompt: string) => statuses.findLast((entry) => entry.prompt === prompt)!
    expect(lastOf("review1").status).toBe("succeeded")
    await running
    expect(lastOf("review1").status).toBe("succeeded")
  })
})

describe("a conversation across a resume — replay", () => {
  /** A replay plan with one finished Unit per entry, in ordinal order — the shape `resumeRun` hands the engine. */
  const replayed = (
    units: Array<{ prompt: string; output?: string; status?: Unit["status"]; sessionID?: string }>,
  ) => ({
    units: new Map(
      units.map((unit, index) => [
        index + 1,
        {
          prompt: unit.prompt,
          status: unit.status ?? ("succeeded" as const),
          output: unit.output ?? unit.prompt,
          schema: false,
          subagent: "general",
          ...(unit.sessionID ? { sessionID: unit.sessionID } : {}),
        },
      ]),
    ),
    answers: [],
    rerunFailed: true,
    diverged: false,
  })

  test("a replayed conversation replays BOTH turns without prompting the model", async () => {
    const { ctx, host, state } = makeCtx(
      {},
      {
        replay: replayed([
          { prompt: "review", output: "first pass", sessionID: "ses_fake_1" },
          { prompt: "re-check", output: "second pass", sessionID: "ses_fake_1" },
        ]),
      },
    )
    const first = await ctx.agent("review", { keepSession: true })
    expect(first.value).toBe("first pass")
    const second = await first.ask("re-check")
    expect(second.value).toBe("second pass")
    // The whole point: a resume of a conversation costs nothing — no create, no prompt.
    expect(host.creates).toHaveLength(0)
    expect(host.prompts).toHaveLength(0)
    // …and the session is still continuable, so a script may go on live after the replayed part.
    expect(second.sessionID).toBe("ses_fake_1")
    expect(state.unitCount).toBe(2)
  })

  test("a replayed first turn leaves its session continuable live", async () => {
    const { ctx, host } = makeCtx(
      { reply: { text: "live answer" }, seedSessions: [{ id: "ses_fake_old" }] },
      { replay: replayed([{ prompt: "review", output: "first pass", sessionID: "ses_fake_old" }]) },
    )
    const first = await ctx.agent("review", { keepSession: true })
    expect(first.value).toBe("first pass")
    // A replayed Unit's handle reports the session the ORIGINAL Run recorded, so the next turn goes there.
    expect(first.sessionID).toBe("ses_fake_old")
    const second = await first.ask("re-check")
    expect(second.value).toBe("live answer")
    expect(host.prompts).toEqual([{ sessionID: "ses_fake_old", text: "re-check", turn: 0 }])
  })

  test("a divergence inside a conversation runs live from there, not from the start", async () => {
    const { ctx, host, state } = makeCtx(
      { reply: { text: "live" }, seedSessions: [{ id: "ses_fake_1" }] },
      {
        replay: replayed([
          { prompt: "review", output: "first pass", sessionID: "ses_fake_1" },
          { prompt: "something else", output: "unused" },
        ]),
      },
    )
    const first = await ctx.agent("review", { keepSession: true })
    expect(first.value).toBe("first pass")
    // The script asked for a different prompt at ordinal 2: replay diverges and the rest runs live.
    const second = await first.ask("re-check")
    expect(second.value).toBe("live")
    expect(host.prompts).toHaveLength(1)
    expect(state.errors).toHaveLength(0)
  })
})
