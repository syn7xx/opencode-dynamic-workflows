/**
 * Small GUI-only helpers over the shared pure formatters (`src/ui/format.ts`): a status `Tone` → a CSS class the
 * panel style understands, and the phase line both the Run header and the TUI print.
 */
import type { Run } from "../protocol"
import { isTerminal } from "../runs"
import type { Tone } from "../ui/format"

/** The CSS class for a status tone; colour is only ever a bonus beside the glyph and the word. */
export function toneClass(tone: Tone): string {
  return `wf-tone-${tone}`
}

/** `✓ build ── ● test ── ○ ship` — one entry per declared (or observed) phase, coloured by position. */
export function phaseLine(run: Pick<Run, "phases" | "phasesDeclared" | "currentPhase" | "status">): Array<{
  text: string
  tone: Tone
}> {
  if (run.phases.length === 0) return []
  const index = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1
  const finished = isTerminal(run.status)
  return run.phases.map((phase, position) => {
    if (position < index || (finished && position === index && run.status === "succeeded"))
      return { text: `✓ ${phase}`, tone: "success" as Tone }
    if (position === index) return { text: `● ${phase}`, tone: finished ? ("warning" as Tone) : ("info" as Tone) }
    return { text: `○ ${phase}`, tone: "muted" as Tone }
  })
}

/** A Unit is terminal when the engine will not run it again. */
export function isUnitTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped" || status === "replayed"
}

/** Pretty-print a JSON string for display; a value that is not JSON (or is empty) is returned as-is. */
export function prettyJson(text: string | null | undefined): string | null | undefined {
  if (!text) return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** `812 B`, `4.3 KB` — a byte count for a source size. */
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
