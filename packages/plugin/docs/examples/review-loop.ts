/**
 * Review → fix → re-review in ONE conversation per file.
 *
 * Each file gets a reviewer Unit that keeps its session (`keepSession`), so every later round runs in the same
 * conversation: the reviewer already has the file in its transcript and its tool results, and re-checks exactly
 * what it found instead of reading everything again. The rounds are bounded — a review loop that never converges
 * must end, not spin.
 *
 *   workflow({ name: "review-loop", args: { files: ["src/a.ts"] } })
 */
import { defineWorkflow, z } from "@syn7xx/opencode-dynamic-workflows/workflow"

const Finding = z.object({
  issues: z.array(
    z.object({
      line: z.number().int().nullable(),
      severity: z.enum(["low", "medium", "high"]),
      summary: z.string(),
    }),
  ),
})

export default defineWorkflow({
  meta: {
    name: "review-loop",
    description: "Review a file, fix what was found, and re-review in the same conversation",
    whenToUse: "Iterating on a fix until a reviewer reports nothing left, per file",
    phases: [{ title: "review" }, { title: "fix" }, { title: "re-review" }],
    args: z.object({
      files: z.array(z.string()).min(1),
      /** How many fix rounds at most. A loop that never converges must stop. */
      rounds: z.number().int().min(1).max(5).default(2),
    }),
  },
  async run({ agent, pipeline, collect, phase, args, log, errors }) {
    phase("review")
    const results = await pipeline(args.files, async (file) => {
      // `keepSession` gives back a handle; every `resume` is a NEW Unit in the SAME session.
      let review = await agent(
        `Review ${file} for bugs. Read it first. Report concrete issues with line numbers only.`,
        { label: `${file}#review`, schema: Finding, keepSession: true },
      )

      for (let round = 0; round < args.rounds && (review.value?.issues.length ?? 0) > 0; round++) {
        phase("fix")
        const fixed = await agent(
          `Fix exactly these issues in ${file}:\n${JSON.stringify(review.value!.issues, null, 2)}\n` +
            `Do not change anything else. Report what you changed.`,
          { label: `${file}#fix-${round}` },
        )
        if (fixed === null) {
          log(`${file}: the fix turn failed, stopping the loop`)
          break
        }
        phase("re-review")
        review = await review.ask(
          "Re-check your previous findings against the fixes just made. " +
            "Report only the issues that are still present after the fixes.",
          { schema: Finding },
        )
        log(`${file}: round ${round + 1} → ${review.value?.issues.length ?? "?"} issue(s) left`)
      }

      // Optional: end the conversation explicitly. Idle kept sessions are cleaned up with the Run anyway.
      await review.close()
      return review.value ? { file, issues: review.value.issues } : null
    })

    const reports = collect(results)
    return {
      files: reports.length,
      // Only a file that finished its rounds should report zero issues; a dropped file is in `errors`.
      remaining: reports.filter((report) => report.issues.length > 0).map((report) => report.file),
      failed: errors.map((error) => error.unit),
    }
  },
})
