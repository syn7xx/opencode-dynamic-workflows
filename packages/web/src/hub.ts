/**
 * One event stream for every location, shared by every view. It turns the raw stream into two signals for
 * listeners: protocol events, and "re-read your snapshots" (a seq gap, a seq going backwards after a service
 * restart, a `resync.required`, or a reconnect — the replay after a reconnect is usually complete, but a restarted
 * Gateway cannot be told apart from a quiet one, so a cheap re-read is the safe default).
 *
 * The stream is multiplexed: the Gateway serves every location's events over one connection (`GET /v1/events`
 * without `?location`). A connection per location would exhaust the browser's small per-origin pool once a few
 * projects are open, and then every ordinary request queues forever; one stream cannot. Each event carries its
 * `location`, so a per-location `seq`/`epoch` watch is kept here, keyed by that field.
 *
 * Keeping the stream open also tells the engine a surface is attached, so questions and permission asks are
 * published to people instead of taking their headless defaults.
 */
import type { ProtocolEvent } from "@syn7xx/opencode-dynamic-workflows/protocol"

import { connectSse, type SseConnection, type SseMessage, type SseOptions, type SseStatus } from "./sse"
import { SeqTracker } from "./state"

export interface HubListener {
  event?(event: ProtocolEvent): void
  resync?(location: string, reason: string): void
}

export interface HubSource {
  /** The multiplexed stream covering every location the Gateway serves (no `?location`). */
  eventsUrl(): string
  authHeaders(): Record<string, string>
  onUnauthorized?(): void
}

export type LocationStatus = SseStatus

export class EventHub {
  private readonly listeners = new Set<HubListener>()
  private readonly trackers = new Map<string, SeqTracker>()
  private readonly statusListeners = new Set<(statuses: ReadonlyMap<string, LocationStatus>) => void>()
  /** Locations the app cares about; the single stream covers all of them, so this drives the status map. */
  private readonly known = new Set<string>()
  private connection: SseConnection | undefined
  private status: LocationStatus = "connecting"
  private opened = false

  constructor(
    private readonly source: HubSource,
    private readonly connect: (options: SseOptions) => SseConnection = connectSse,
  ) {}

  /** Cover a location's events (idempotent) and make sure the one stream is open. */
  ensure(location: string): void {
    if (!this.known.has(location)) {
      this.known.add(location)
      if (!this.trackers.has(location)) this.trackers.set(location, new SeqTracker())
      this.publishStatus()
    }
    this.open()
  }

  private open(): void {
    if (this.connection) return
    this.connection = this.connect({
      url: this.source.eventsUrl(),
      headers: () => this.source.authHeaders(),
      onUnauthorized: () => this.source.onUnauthorized?.(),
      onMessage: (message) => this.receive(message),
      onStatus: (status) => {
        if (status === "open") {
          if (this.opened) for (const location of this.known) this.resync(location, "reconnected")
          this.opened = true
        }
        this.status = status
        this.publishStatus()
      },
    })
  }

  listen(listener: HubListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: (statuses: ReadonlyMap<string, LocationStatus>) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.statusMap())
    return () => this.statusListeners.delete(listener)
  }

  close(): void {
    this.connection?.close()
    this.connection = undefined
  }

  /** Exposed for tests: feed one raw SSE message as if it came from its event's `location`. */
  receive(message: SseMessage): void {
    let event: ProtocolEvent
    try {
      event = JSON.parse(message.data) as ProtocolEvent
    } catch {
      return
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") return
    const location = typeof event.location === "string" ? event.location : ""
    let tracker = this.trackers.get(location)
    if (!tracker) {
      tracker = new SeqTracker()
      this.trackers.set(location, tracker)
    }
    if (event.type === "resync.required") {
      if (typeof event.seq === "number") tracker.resyncTo(event.seq, event.epoch)
      const reason = (event.data as { reason?: string } | undefined)?.reason ?? "resync required"
      this.resync(location, reason)
      return
    }
    const verdict = tracker.observe(event.seq, event.epoch)
    if (verdict !== "ok") this.resync(location, verdict === "gap" ? "missed events" : "the service restarted")
    for (const listener of Array.from(this.listeners)) listener.event?.(event)
  }

  trackerFor(location: string): SeqTracker | undefined {
    return this.trackers.get(location)
  }

  /** Forget locations the Gateway no longer serves, so a removed project does not linger in the status map. */
  retain(locations: string[]): void {
    const keep = new Set(locations)
    let changed = false
    // Iterate the trackers too: an event for a location never `ensure`d still creates one, and it must not leak.
    for (const location of new Set([...this.known, ...this.trackers.keys()])) {
      if (keep.has(location)) continue
      this.known.delete(location)
      this.trackers.delete(location)
      changed = true
    }
    if (changed) this.publishStatus()
  }

  private resync(location: string, reason: string): void {
    for (const listener of Array.from(this.listeners)) listener.resync?.(location, reason)
  }

  private statusMap(): ReadonlyMap<string, LocationStatus> {
    const map = new Map<string, LocationStatus>()
    for (const location of this.known) map.set(location, this.status)
    return map
  }

  private publishStatus(): void {
    const map = this.statusMap()
    for (const listener of Array.from(this.statusListeners)) listener(map)
  }
}
