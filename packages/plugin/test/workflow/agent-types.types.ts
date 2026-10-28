/**
 * Type-level proof that {@link AgentFn} carries the schema's inferred type through to its return (the
 * structured-output AC: "typed as the schema's inferred type", verified by `tsc`, not only at runtime). This
 * file is compiled by `tsc --build` (the workflow tsconfig includes `test`) but is NOT a `*.test.ts`, so
 * `bun test` skips it. It has no runtime assertions: if the conditional return type ever stopped threading
 * the schema, the GREEN lines fail to compile and `bun run typecheck` breaks.
 *
 * The `@ts-expect-error` control lines are load-bearing: they prove the checks have teeth. If the type
 * collapsed (e.g. `agent()` returned `any`), those directives would become *unused* — which `tsc` also
 * reports as an error — so the fixture fails either way.
 */
import type { AgentFn, AgentOpts, UnitToolCall } from "../../src/workflow"
import { z } from "../../src/workflow"

declare const agent: AgentFn
/** A flag whose value only settles at run time: `boolean`, never the literal `true`. */
declare const maybeReceipts: boolean

const Finding = z.object({ title: z.string(), score: z.number() })

async function proof() {
  // GREEN — no schema: resolves to `string | null`.
  const text = await agent("summarise")
  if (text !== null) text.toUpperCase()

  // GREEN — with schema: resolves to `z.infer<typeof Finding> | null`; fields are typed.
  const finding = await agent("rate it", { schema: Finding })
  if (finding !== null) {
    finding.title.toUpperCase()
    const _n: number = finding.score
    void _n
  }

  // CONTROL — the no-schema result is `string`, so a struct field access IS a type error (proves teeth).
  // @ts-expect-error — `text` is a string, it has no `.title`.
  if (text !== null) void text.title

  // CONTROL — the schema result is the inferred object, NOT a string (proves the branch actually switched).
  // @ts-expect-error — `finding` is an object, it has no string method `.toUpperCase`.
  if (finding !== null) finding.toUpperCase()

  // CONTROL — `score` is a number, not a string: assigning it to a string is a type error.
  if (finding !== null) {
    // @ts-expect-error — number is not assignable to string.
    const _s: string = finding.score
    void _s
  }

  // GREEN — `{ receipts: true }` resolves to a receipt: never null, and its `value` is typed by the schema.
  const receipt = await agent("rate it", { schema: Finding, receipts: true })
  const _unitId: string = receipt.unitId
  const _calls: Promise<UnitToolCall[]> = receipt.toolCalls
  const _receiptTitle: string | undefined = receipt.value?.title
  void _unitId
  void _calls
  void _receiptTitle

  // GREEN — a text Unit's receipt carries `string | null`.
  const textReceipt = await agent("summarise", { receipts: true })
  const _text: string | null = textReceipt.value
  void _text

  // CONTROL — the receipt is the object, not the value (proves the overload switched).
  // @ts-expect-error — a UnitReceipt is not a string.
  receipt.toUpperCase()

  // CONTROL — and WITHOUT receipts the result is still the bare value, not a receipt (the default path is unchanged).
  if (text !== null) {
    // @ts-expect-error — a string has no `unitId`.
    void text.unitId
  }

  // GREEN — `receipts: false` is the value overload, and an `AgentOpts` variable (no flag) still works.
  const explicitFalse = await agent("rate it", { schema: Finding, receipts: false })
  const _falseTitle: string | undefined = explicitFalse?.title
  void _falseTitle
  const baseOpts: AgentOpts<typeof Finding> = { schema: Finding }
  const fromBase = await agent("rate it", baseOpts)
  const _baseTitle: string | undefined = fromBase?.title
  void _baseTitle

  // GREEN — the flag may come from a spread or from an `as const` object, as long as its type is the literal `true`.
  const fromSpread = await agent("rate it", { ...baseOpts, receipts: true })
  const _spreadTitle: string | undefined = fromSpread.value?.title
  void _spreadTitle
  const literal = { receipts: true } as const
  const fromLiteral = await agent("summarise", literal)
  const _literalText: string | null = fromLiteral.value
  void _literalText

  // CONTROL — `receipts` is NOT an `AgentOpts` member: writing it into one is an excess-property error, so a value
  // typed as `AgentOpts<S>` can never carry a flag its call site cannot see.
  // @ts-expect-error — `receipts` does not exist on `AgentOpts`.
  const optsWithReceipts: AgentOpts<typeof Finding> = { schema: Finding, receipts: true }
  void optsWithReceipts

  // CONTROL — a WIDENED `boolean` selects neither overload. This is the safety the split buys: no call can be typed
  // as a value while the engine returns a receipt at run time.
  const widened = { receipts: true } // inferred as `{ receipts: boolean }`
  // @ts-expect-error — `{ receipts: boolean }` matches neither `receipts: true` nor `receipts?: false`.
  await agent("rate it", widened)

  // CONTROL — same for a boolean that only settles at run time.
  // @ts-expect-error — a non-literal flag matches neither overload.
  await agent("rate it", { schema: Finding, receipts: maybeReceipts })
}

void proof
