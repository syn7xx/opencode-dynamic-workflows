/**
 * Isolation rules for a Workflow's Units — the deny-by-default subset of `meta.isolation`.
 *
 * Why a separate module: the rules must be appended LAST to a Unit session's ruleset (after author rules, unit
 * rules, and the engine's own rules), and OpenCode's "last match wins" makes that ordering the whole guarantee.
 * Keeping the ordering rule and the emission logic in one place means a caller cannot get it subtly wrong.
 *
 * Skills and subagents map cleanly to one permission action each. MCP does not: a server contributes many tools
 * (`<server>_<tool>`), so isolation there is enforced by HIDING the disallowed servers' tools from the Unit's
 * toolset (`context` hook) and by DENYING them by name (`permission evaluate` hook). Both helpers live here so the
 * two hooks agree on exactly which servers are hidden.
 */
import type { HostPermissionRule } from "./host"
import type { IsolationPolicy } from "./workflow"

/**
 * Is the named subagent allowed by an isolation policy? Used to fail a Unit fast at authoring/launch time with a
 * clear message, rather than letting it start and be denied by a permission rule mid-turn.
 *
 * `undefined` → allowed (axis unrestricted). An explicit list → membership.
 */
export function subagentAllowed(isolation: IsolationPolicy | undefined, subagent: string): boolean {
  if (!isolation || isolation.subagents === undefined) return true
  return isolation.subagents.includes(subagent)
}

/**
 * Rules for one axis: `deny *` then `allow` per id. Order is load-bearing — `deny` first so the specific
 * `allow`s win under last-match-wins.
 */
function axisRules(action: string, allowed: string[] | undefined): HostPermissionRule[] {
  if (allowed === undefined) return []
  const rules: HostPermissionRule[] = [{ action, resource: "*", effect: "deny" }]
  for (const id of allowed) rules.push({ action, resource: id, effect: "allow" })
  return rules
}

/**
 * The isolation ruleset for `meta.isolation`, to be appended AFTER every other rule (the engine puts them last in
 * the Unit session's `permissions`). Returns `[]` when there is no isolation, so callers can spread unconditionally.
 *
 * MCP is deliberately absent: it has no single-action form (see {@link mcpToolServersToHide}).
 */
export function isolationRules(isolation: IsolationPolicy | undefined): HostPermissionRule[] {
  if (!isolation) return []
  return [...axisRules("skill", isolation.skills), ...axisRules("subagent", isolation.subagents)]
}

/** The server part of an MCP tool name: `<server>_<tool>` → `<server>`. Falls back to the whole name. */
export function mcpToolServer(toolName: string, knownServers: readonly string[]): string | undefined {
  // Prefer a known server exactly: names may contain `_`, so a bare split is ambiguous. Longest match wins.
  const match = [...knownServers]
    .filter((server) => toolName.startsWith(`${server}_`))
    .toSorted((a, b) => b.length - a.length)[0]
  return match
}

/**
 * Which configured MCP servers a Unit must not see, or `undefined` when MCP is unrestricted (isolation absent or
 * `mcp` left `undefined`). A Unit may use only the servers named in `meta.isolation.mcp`; every other configured
 * server is hidden. `[]` hides them all.
 *
 * `configured` is every MCP server name the process currently knows (`ctx.mcp.list()`), so the result is exact even
 * though the allowlist is small. Order is stable (the caller's `configured` order) for legible logs.
 */
export function mcpServersToHide(
  isolation: IsolationPolicy | undefined,
  configured: readonly string[],
): string[] | undefined {
  if (!isolation || isolation.mcp === undefined) return undefined
  const allowed = new Set(isolation.mcp)
  return configured.filter((server) => !allowed.has(server))
}

/**
 * Does a tool name belong to one of the hidden MCP servers? Used by the `context` hook (hide the tool) and the
 * `permission evaluate` hook (deny it if the model still names it).
 */
export function isHiddenMcpTool(
  toolName: string,
  hiddenServers: readonly string[],
  knownServers: readonly string[],
): boolean {
  if (hiddenServers.length === 0) return false
  const server = mcpToolServer(toolName, knownServers)
  return server !== undefined && hiddenServers.includes(server)
}

/**
 * Intersect two allow-lists: the ids both permit. Narrow-only by construction — a later level can never widen an
 * earlier one. `undefined` means "this level imposes nothing", so it yields the other side unchanged; an empty
 * array means "nothing allowed" and collapses the axis to empty.
 */
function intersectAxis(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const allowed = new Set(b)
  return a.filter((id) => allowed.has(id))
}

/**
 * The effective isolation of a Unit: the intersection of every level that declared something (manifest, `meta`,
 * per-Unit `restrict`, caller override). Narrow-only: no level can widen another. Returns `undefined` when no level
 * constrained any axis, so a Unit with no isolation behaves exactly as before.
 *
 * A Unit's `restrict` can only make a Workflow's policy stricter — never looser — which is why this is an
 * intersection and not a precedence chain.
 */
export function intersectIsolation(...policies: Array<IsolationPolicy | undefined>): IsolationPolicy | undefined {
  const defined = policies.filter((policy): policy is IsolationPolicy => policy !== undefined)
  if (defined.length === 0) return undefined
  const axis = (key: keyof IsolationPolicy): string[] | undefined =>
    defined
      .map((policy) => policy[key])
      .reduce<string[] | undefined>((acc, next) => intersectAxis(acc, next), undefined)
  const skills = axis("skills")
  const subagents = axis("subagents")
  const mcp = axis("mcp")
  // No axis constrained at all (every policy was `{}`): no isolation, not an empty object.
  if (skills === undefined && subagents === undefined && mcp === undefined) return undefined
  return {
    ...(skills !== undefined ? { skills } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
  }
}
