import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import os from "node:os"
import path from "node:path"

import { startGateway, type GatewayHandle } from "../src/gateway/server"
import { DEFAULT_CONFIG, type GatewayConfig } from "../src/service/config"
import type { WorkflowService } from "../src/service/service"

const gatewayConfig: GatewayConfig = { ...DEFAULT_CONFIG.gateway, enabled: true, port: 0, web: false, auth: "none" }

/** The smallest thing `events()` touches: `location`, `deps.store`, `eventsSince`. */
function fakeService(location: string, tail?: { events: unknown[]; complete: boolean; latest: number; epoch: string }) {
  const subscribers = new Set<(event: unknown) => void>()
  let seq = 0
  const store = {
    subscribe(subscriber: (event: unknown) => void) {
      subscribers.add(subscriber)
      return () => subscribers.delete(subscriber)
    },
  }
  const emit = () => {
    const event = {
      protocol: 1,
      seq: ++seq,
      epoch: "e",
      time: 0,
      location,
      runId: "r",
      // `run.updated` passes `elideEvent` untouched; `unit.updated` would expect a full Unit in `data`.
      type: "run.updated",
      revision: seq,
      data: {},
    }
    for (const subscriber of subscribers) subscriber(event)
  }
  const service = {
    location,
    deps: { store },
    eventsSince: () => tail ?? { events: [], complete: true, latest: 0, epoch: "e" },
  } as unknown as WorkflowService
  return { service, emit }
}

/** Read until `until(text)` holds (or 2 s pass), running `enter` after the first read is armed. */
async function collect(
  reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
  enter: () => void,
  until: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 2_000
  enter()
  while (!until(text) && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
  }
  return text
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

let handle: GatewayHandle
beforeAll(async () => {
  handle = await startGateway(gatewayConfig, {
    tokenFile: path.join(os.tmpdir(), `wf-gw-events-${process.pid}.json`),
  })
})
afterAll(async () => {
  await handle.stop()
})

describe("gateway /v1/events multiplex", () => {
  it("one locationless stream carries every location's events, and attached counts each", async () => {
    const a = fakeService("/a")
    const b = fakeService("/b")
    const offA = handle.register("/a", a.service)
    const offB = handle.register("/b", b.service)

    const controller = new AbortController()
    const response = await fetch(`${handle.url}/v1/events`, { signal: controller.signal })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()

    await collect(
      reader,
      () => {},
      (text) => text.includes("protocol 1"),
    )
    expect(handle.attached("/a")).toBe(true)
    expect(handle.attached("/b")).toBe(true)

    const events = await collect(
      reader,
      () => {
        a.emit()
        b.emit()
      },
      (text) => text.includes('"location":"/a"') && text.includes('"location":"/b"'),
    )
    expect(events).toContain('"location":"/a"')
    expect(events).toContain('"location":"/b"')

    controller.abort()
    await settle()
    expect(handle.attached("/a")).toBe(false)
    expect(handle.attached("/b")).toBe(false)
    offA()
    offB()
  })

  it("follows a location registered after the stream opened, and drops one that leaves", async () => {
    const a = fakeService("/a")
    const offA = handle.register("/a", a.service)
    const controller = new AbortController()
    const response = await fetch(`${handle.url}/v1/events`, { signal: controller.signal })
    const reader = response.body!.getReader()
    await collect(
      reader,
      () => {},
      (text) => text.includes("protocol 1"),
    )
    expect(handle.attached("/c")).toBe(false)

    const c = fakeService("/c")
    const offC = handle.register("/c", c.service)
    expect(handle.attached("/c")).toBe(true)
    const arrived = await collect(
      reader,
      () => c.emit(),
      (text) => text.includes('"location":"/c"'),
    )
    expect(arrived).toContain('"location":"/c"')

    offC()
    expect(handle.attached("/c")).toBe(false)

    controller.abort()
    await settle()
    offA()
  })

  it("a location's stale cleanup does not unhook the live registration or its stream", async () => {
    const a = fakeService("/a")
    const offOld = handle.register("/a", a.service)
    const offNew = handle.register("/a", a.service) // a reload: same service object, a new registration
    const controller = new AbortController()
    const response = await fetch(`${handle.url}/v1/events`, { signal: controller.signal })
    const reader = response.body!.getReader()
    await collect(
      reader,
      () => {},
      (text) => text.includes("protocol 1"),
    )

    offOld() // the leaked older instance cleans up late: it must not remove the live registration
    expect(handle.attached("/a")).toBe(true)
    const arrived = await collect(
      reader,
      () => a.emit(),
      (text) => text.includes('"location":"/a"'),
    )
    expect(arrived).toContain('"location":"/a"')

    controller.abort()
    await settle()
    offNew()
  })

  it("a locationless stream with no locations is a valid, open stream", async () => {
    const controller = new AbortController()
    const response = await fetch(`${handle.url}/v1/events`, { signal: controller.signal })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const text = await collect(
      reader,
      () => {},
      (t) => t.includes("protocol 1"),
    )
    expect(text).toContain("protocol 1")
    controller.abort()
    await settle()
  })

  it("?location keeps its single-target Last-Event-ID replay", async () => {
    const a = fakeService("/a", { events: [], complete: false, latest: 7, epoch: "e" })
    const offA = handle.register("/a", a.service)
    const controller = new AbortController()
    const response = await fetch(`${handle.url}/v1/events?location=%2Fa`, {
      signal: controller.signal,
      headers: { "last-event-id": "e.3" },
    })
    const reader = response.body!.getReader()
    const text = await collect(
      reader,
      () => {},
      (t) => t.includes("resync.required"),
    )
    expect(text).toContain("event: resync.required")
    expect(text).toContain('"reason":"events were missed"')
    controller.abort()
    await settle()
    offA()
  })
})
