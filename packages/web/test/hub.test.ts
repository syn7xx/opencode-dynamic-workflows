import { describe, expect, test } from "bun:test"

import { EventHub } from "../src/hub"
import type { SseOptions } from "../src/sse"

function setup() {
  const connections: SseOptions[] = []
  const hub = new EventHub({ eventsUrl: () => "/v1/events", authHeaders: () => ({}) }, (options) => {
    connections.push(options)
    return { close() {}, lastEventId: "" }
  })
  const events: number[] = []
  const resyncs: string[] = []
  hub.listen({
    event: (event) => events.push(event.seq),
    resync: (location, reason) => resyncs.push(`${location}:${reason}`),
  })
  hub.ensure("/p")
  hub.ensure("/p")
  const send = (seq: number, type = "unit.updated", data: unknown = {}, location = "/p") =>
    connections[0]!.onMessage({
      id: String(seq),
      event: type,
      data: JSON.stringify({ protocol: 1, seq, time: 0, location, runId: "r", type, revision: seq, data }),
    })
  return { hub, connections, events, resyncs, send }
}

describe("EventHub", () => {
  test("one multiplexed stream for every location", () => {
    const { connections, hub } = setup()
    hub.ensure("/q")
    expect(connections).toHaveLength(1)
    expect(connections[0]!.url).toBe("/v1/events")
  })

  test("routes each event to its own location's seq watch", () => {
    const { hub, resyncs, send } = setup()
    hub.ensure("/q")
    send(1, "unit.updated", {}, "/p")
    send(1, "unit.updated", {}, "/q")
    send(2, "unit.updated", {}, "/p")
    expect(resyncs).toEqual([])
    expect(hub.trackerFor("/p")!.last).toBe(2)
    expect(hub.trackerFor("/q")!.last).toBe(1)
  })

  test("delivers contiguous events and asks for a resync on a gap", () => {
    const { events, resyncs, send } = setup()
    send(1)
    send(2)
    send(5)
    expect(events).toEqual([1, 2, 5])
    expect(resyncs).toEqual(["/p:missed events"])
  })

  test("a seq going backwards (service restart) triggers a resync", () => {
    const { resyncs, send } = setup()
    send(10)
    send(1)
    expect(resyncs).toEqual(["/p:the service restarted"])
  })

  test("resync.required is not delivered as an event, and resets the cursor", () => {
    const { events, resyncs, send } = setup()
    send(1)
    send(30, "resync.required", { reason: "events were missed" })
    send(31)
    expect(events).toEqual([1, 31])
    expect(resyncs).toEqual(["/p:events were missed"])
  })

  test("a reconnect after the first open asks for a resync", () => {
    const { connections, resyncs } = setup()
    connections[0]!.onStatus!("open")
    expect(resyncs).toEqual([])
    connections[0]!.onStatus!("retrying")
    connections[0]!.onStatus!("open")
    expect(resyncs).toEqual(["/p:reconnected"])
  })

  test("retain drops locations the Gateway no longer serves", () => {
    const { hub, connections } = setup()
    hub.ensure("/q")
    hub.retain(["/q"])
    expect(hub.trackerFor("/p")).toBeUndefined()
    expect(hub.trackerFor("/q")).toBeDefined()
    expect(connections).toHaveLength(1)
  })

  test("retain also drops a tracker created by an event for an un-ensured location", () => {
    const { hub, send } = setup()
    send(1, "run.updated", {}, "/ghost")
    expect(hub.trackerFor("/ghost")).toBeDefined()
    hub.retain(["/p"])
    expect(hub.trackerFor("/ghost")).toBeUndefined()
    expect(hub.trackerFor("/p")).toBeDefined()
  })
})
