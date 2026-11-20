/**
 * Isolation of a Workflow's Units from ambient skills, subagents, and MCP servers (`meta.isolation`).
 *
 * Covers: rule emission and ORDER (deny-all first, allow per id after — last match wins), the subagent allow-list
 * predicate, MCP server/tool resolution and hiding, the runner appending isolation rules LAST to a Unit session's
 * ruleset, and a Unit failing fast when it names a subagent the allow-list excludes.
 */
import { describe, expect, test } from "bun:test"

import {
  intersectIsolation,
  isHiddenMcpTool,
  isolationRules,
  mcpServersToHide,
  mcpToolServer,
  subagentAllowed,
} from "../src/isolation"
import { withIsolation } from "../src/workflow"
import { makeCtx } from "./helpers"

describe("isolationRules", () => {
  test("undefined policy emits nothing", () => {
    expect(isolationRules(undefined)).toEqual([])
  })

  test("skills and subagents: deny-all first, then allow per id", () => {
    const rules = isolationRules({ skills: ["code-markup", "design-system"], subagents: ["Reviewer"] })
    expect(rules).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "code-markup", effect: "allow" },
      { action: "skill", resource: "design-system", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "Reviewer", effect: "allow" },
    ])
  })

  test("empty list allows nothing (deny-all only)", () => {
    expect(isolationRules({ skills: [], subagents: [] })).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "deny" },
    ])
  })

  test("a field left undefined does not restrict that axis", () => {
    expect(isolationRules({ skills: ["only"] })).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "only", effect: "allow" },
    ])
  })
})

describe("subagentAllowed", () => {
  test("no isolation or no subagents field means unrestricted", () => {
    expect(subagentAllowed(undefined, "anything")).toBe(true)
    expect(subagentAllowed({}, "anything")).toBe(true)
    expect(subagentAllowed({ skills: [] }, "anything")).toBe(true)
  })

  test("explicit list is a membership check", () => {
    const iso = { subagents: ["NodeJsDeveloper"] }
    expect(subagentAllowed(iso, "NodeJsDeveloper")).toBe(true)
    expect(subagentAllowed(iso, "ForeignAgent")).toBe(false)
  })

  test("empty list allows no subagent", () => {
    expect(subagentAllowed({ subagents: [] }, "general")).toBe(false)
  })
})

describe("runner appends isolation rules LAST", () => {
  test("the created session's ruleset ends with the isolation rules", async () => {
    const { ctx, host } = makeCtx(
      {},
      {
        // Author rules that would allow everything — isolation must still come after and win.
        permissions: [{ action: "skill", resource: "*", effect: "allow" }],
        // Restrict skills only; leave subagents unrestricted so the default Unit can start.
        isolation: { skills: ["code-markup"] },
      },
    )
    await ctx.agent("hi")
    const created = host.creates[0]!
    const tail = created.permissions.slice(-4)
    expect(tail).toEqual([
      // ENGINE_UNIT_RULES tail then isolation — order is what makes it win.
      { action: "workflow", resource: "*", effect: "deny" },
      { action: "workflow_inline", resource: "*", effect: "deny" },
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "code-markup", effect: "allow" },
    ])
  })
})

describe("fail-fast on a subagent outside the allow-list", () => {
  test("a Unit naming a disallowed subagent fails without a session", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { subagents: ["NodeJsDeveloper"] } })
    const result = await ctx.agent("hi", { subagent: "ForeignAgent" })
    expect(result).toBeNull()
    expect(host.creates.length).toBe(0)
    expect(ctx.errors.at(-1)?.error).toContain("is not in the isolation allow-list")
  })

  test("a Unit naming an allowed subagent runs", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { subagents: ["NodeJsDeveloper"] } })
    await ctx.agent("hi", { subagent: "NodeJsDeveloper" })
    expect(host.creates.length).toBe(1)
  })
})

describe("isolation survives a continuation", () => {
  test("a continuation of an isolated Run reuses the session's ruleset (no re-decision, no bypass)", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { subagents: ["NodeJsDeveloper"] } })
    const handle = await ctx.agent("first", { subagent: "NodeJsDeveloper", keepSession: true })
    expect(handle.sessionID).not.toBeNull()
    // A follow-up turn runs in the SAME session; it does not create a new one, so its ruleset is the one set at
    // create time — the isolation the first turn decided still holds.
    const before = host.creates.length
    await handle.ask("second")
    expect(host.creates.length).toBe(before)
  })
})

describe("MCP isolation — server resolution and hiding", () => {
  const configured = ["playwright", "github", "sentry"]

  test("mcpToolServer resolves the server by longest known prefix (names may contain _)", () => {
    expect(mcpToolServer("github_create_issue", configured)).toBe("github")
    expect(mcpToolServer("playwright_click", configured)).toBe("playwright")
    // An unknown prefix resolves to none (not hidden by accident).
    expect(mcpToolServer("other_tool", configured)).toBeUndefined()
  })

  test("mcpServersToHide: undefined mcp leaves MCP unrestricted", () => {
    expect(mcpServersToHide(undefined, configured)).toBeUndefined()
    expect(mcpServersToHide({}, configured)).toBeUndefined()
    expect(mcpServersToHide({ skills: [] }, configured)).toBeUndefined()
  })

  test("mcpServersToHide returns every configured server not in the allow-list", () => {
    expect(mcpServersToHide({ mcp: ["playwright"] }, configured)).toEqual(["github", "sentry"])
    expect(mcpServersToHide({ mcp: [] }, configured)).toEqual(["playwright", "github", "sentry"])
    expect(mcpServersToHide({ mcp: [...configured] }, configured)).toEqual([])
  })

  test("isHiddenMcpTool matches only tools of hidden servers", () => {
    const hidden = ["github", "sentry"]
    expect(isHiddenMcpTool("github_create_issue", hidden, configured)).toBe(true)
    expect(isHiddenMcpTool("sentry_list_issues", hidden, configured)).toBe(true)
    expect(isHiddenMcpTool("playwright_click", hidden, configured)).toBe(false)
    expect(isHiddenMcpTool("write", hidden, configured)).toBe(false)
    expect(isHiddenMcpTool("github_create_issue", [], configured)).toBe(false)
  })
})

describe("MCP isolation reaches the Unit binding", () => {
  // The binding is live only while the Unit runs; a hanging prompt keeps it bound so it can be inspected.
  test("hiddenMcpServers is stored on the Unit binding from meta.isolation.mcp", async () => {
    const { ctx, host, index } = makeCtx(
      { promptHang: true },
      { isolation: { mcp: ["playwright"] }, mcpServers: ["playwright", "github", "sentry"] },
    )
    void ctx.agent("hi")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const sessionID = host.prompts[0]?.sessionID ?? host.sessions.keys().next().value
    const binding = index.get(sessionID!)
    expect(binding?.hiddenMcpServers).toEqual(["github", "sentry"])
    expect(binding?.knownMcpServers).toEqual(["playwright", "github", "sentry"])
  })

  test("no mcp field ⇒ no hidden servers on the binding", async () => {
    const { ctx, host, index } = makeCtx({ promptHang: true }, { isolation: { skills: [] }, mcpServers: ["github"] })
    void ctx.agent("hi")
    await new Promise((resolve) => setTimeout(resolve, 20))
    const sessionID = host.prompts[0]?.sessionID ?? host.sessions.keys().next().value
    expect(index.get(sessionID!)?.hiddenMcpServers).toBeUndefined()
  })
})

describe("intersectIsolation — narrow-only across levels", () => {
  test("no policy constrains anything ⇒ undefined", () => {
    expect(intersectIsolation(undefined, undefined)).toBeUndefined()
    expect(intersectIsolation()).toBeUndefined()
    expect(intersectIsolation({}, {})).toBeUndefined()
  })

  test("undefined on one side yields the other unchanged", () => {
    expect(intersectIsolation({ skills: ["a", "b"] }, undefined)).toEqual({ skills: ["a", "b"] })
    expect(intersectIsolation(undefined, { skills: ["a"] })).toEqual({ skills: ["a"] })
  })

  test("two allow-lists intersect; [] collapses to empty", () => {
    expect(intersectIsolation({ skills: ["a", "b", "c"] }, { skills: ["b", "c", "d"] })).toEqual({ skills: ["b", "c"] })
    expect(intersectIsolation({ skills: ["a"] }, { skills: [] })).toEqual({ skills: [] })
  })

  test("axes are independent", () => {
    expect(
      intersectIsolation({ skills: ["a"], subagents: ["x", "y"], mcp: ["p", "q"] }, { subagents: ["y"], mcp: ["p"] }),
    ).toEqual({ skills: ["a"], subagents: ["y"], mcp: ["p"] })
  })
})

describe("per-Unit isolation — a Unit can tighten but never widen", () => {
  test("isolation narrows the effective subagent allow-list (fail-fast on the intersection)", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { subagents: ["A", "B"] } })
    // "B" is allowed by the Workflow but excluded by this Unit's isolation ⇒ rejected before any session.
    const result = await ctx.agent("hi", { subagent: "B", isolation: { subagents: ["A"] } })
    expect(result).toBeNull()
    expect(host.creates.length).toBe(0)
    expect(ctx.errors.at(-1)?.error).toContain("is not in the isolation allow-list")
  })

  test("isolation cannot widen: a subagent outside the Workflow policy stays rejected", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { subagents: ["A"] } })
    const result = await ctx.agent("hi", { subagent: "Z", isolation: { subagents: ["Z"] } })
    expect(result).toBeNull()
    expect(host.creates.length).toBe(0)
  })

  test("a Unit's narrower ruleset ends with the Intersected rules", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { skills: ["a", "b"] } })
    await ctx.agent("hi", { isolation: { skills: ["b"] } })
    const tail = host.creates[0]!.permissions.slice(-2)
    expect(tail).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "b", effect: "allow" },
    ])
  })

  test("isolation is refused on a continuation (the session's ruleset is fixed)", async () => {
    const { ctx } = makeCtx({})
    const handle = await ctx.agent("first", { keepSession: true })
    // The continuation resolves to a handle whose value is null and records the refusal in ctx.errors.
    const next = await handle.ask("second", { isolation: { skills: [] } } as never)
    expect(next.value).toBeNull()
    expect(ctx.errors.at(-1)?.error).toContain("keeps its session's")
  })
})

describe("withIsolation — sugar over Unit isolation (not a security boundary)", () => {
  test("Units on the narrowed view carry the intersected restriction", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { skills: ["a", "b"] } })
    const view = withIsolation(ctx, { skills: ["b"] })
    await view.agent("hi")
    const tail = host.creates[0]!.permissions.slice(-2)
    expect(tail).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "b", effect: "allow" },
    ])
  })

  test("nested withIsolation stays narrow-only (intersection, not replacement)", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { skills: ["a", "b", "c"] } })
    const outer = withIsolation(ctx, { skills: ["a", "b"] })
    const inner = withIsolation(outer, { skills: ["b", "c"] })
    await inner.agent("hi")
    const tail = host.creates[0]!.permissions.slice(-2)
    expect(tail).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "b", effect: "allow" },
    ])
  })

  test("the original ctx is unaffected by a narrowed view (documents the non-boundary)", async () => {
    const { ctx, host } = makeCtx({}, { isolation: { skills: ["a", "b"] } })
    withIsolation(ctx, { skills: ["a"] })
    await ctx.agent("via original")
    // Original ctx still allows both — a view never mutates the ctx it wraps.
    const tail = host.creates[0]!.permissions.slice(-3)
    expect(tail).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "a", effect: "allow" },
      { action: "skill", resource: "b", effect: "allow" },
    ])
  })
})
