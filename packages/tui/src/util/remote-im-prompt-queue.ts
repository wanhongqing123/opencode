export const REMOTE_IM_PROMPT_QUEUE_CAPACITY = 32
export const REMOTE_IM_PROMPT_QUEUE_TTL_MS = 30 * 60 * 1000
export const REMOTE_IM_ROUTE_TTL_MS = 2 * 60 * 60 * 1000
export const REMOTE_IM_PROMPT_GATE_TTL_MS = REMOTE_IM_ROUTE_TTL_MS + 1000

export type RemoteImPromptRoute = {
  replyID?: string
  taskID?: string
}

export type RemoteImPromptQueueItem = RemoteImPromptRoute & {
  id: string
  sessionID: string
  dispatch(signal: AbortSignal): Promise<void>
  cancel?(): Promise<void>
  terminal(error: string): void
}

export type RemoteImLocalSubmitClaim = {
  wait?: Promise<void>
  release(): void
}

type QueueEntry = {
  item: RemoteImPromptQueueItem
  state: "pending" | "dispatching"
  busySeen: boolean
  ctrl: AbortController
  timer: ReturnType<typeof setTimeout>
}

type SessionGate = {
  busySeen: boolean
  timer: ReturnType<typeof setTimeout>
}

type LocalSubmitGate = SessionGate & {
  armed: boolean
}

type Input = {
  sessionStatus(sessionID: string): string | undefined
  capacity?: number
  ttlMs?: number
  gateTtlMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

export function createRemoteImPromptQueue(input: Input) {
  const capacity = input.capacity ?? REMOTE_IM_PROMPT_QUEUE_CAPACITY
  const ttlMs = input.ttlMs ?? REMOTE_IM_PROMPT_QUEUE_TTL_MS
  const gateTtlMs = input.gateTtlMs ?? REMOTE_IM_PROMPT_GATE_TTL_MS
  const setTimer = input.setTimer ?? globalThis.setTimeout
  const clearTimer = input.clearTimer ?? globalThis.clearTimeout
  const entries = new Map<string, QueueEntry>()
  const gates = new Map<string, SessionGate>()
  const localTakeovers = new Map<string, LocalSubmitGate>()
  let closed = false

  const isIdle = (sessionID: string) => {
    const status = input.sessionStatus(sessionID)
    return !status || status === "idle"
  }

  const remove = (entry: QueueEntry) => {
    if (entries.get(entry.item.id) !== entry) return false
    entries.delete(entry.item.id)
    clearTimer(entry.timer)
    return true
  }

  const activeForSession = (sessionID: string) =>
    [...entries.values()].find((entry) => entry.item.sessionID === sessionID && entry.state === "dispatching")

  const nextForSession = (sessionID: string) =>
    [...entries.values()].find((entry) => entry.item.sessionID === sessionID && entry.state === "pending")

  const routeMatches = (entry: QueueEntry, route: RemoteImPromptRoute) => {
    if (route.taskID && entry.item.taskID) return route.taskID === entry.item.taskID
    if (route.replyID && entry.item.replyID) return route.replyID === entry.item.replyID
    return false
  }

  const drain = (sessionID: string) => {
    if (
      closed ||
      !isIdle(sessionID) ||
      gates.has(sessionID) ||
      localTakeovers.has(sessionID) ||
      activeForSession(sessionID)
    )
      return
    const entry = nextForSession(sessionID)
    if (!entry) return
    entry.state = "dispatching"
    void Promise.resolve()
      .then(() => {
        if (closed || entries.get(entry.item.id) !== entry) return
        return entry.item.dispatch(entry.ctrl.signal)
      })
      .catch((error) => {
        fail(entry, error instanceof Error ? error.message : String(error))
      })
  }

  const fail = (entry: QueueEntry, error: string, drainNext = true) => {
    entry.ctrl.abort()
    if (!remove(entry)) return
    entry.item.terminal(error || "OpenCode remote prompt failed.")
    if (drainNext) drain(entry.item.sessionID)
  }

  const enqueue = (item: RemoteImPromptQueueItem): { ok: true } | { ok: false; error: string } => {
    if (closed) return { ok: false, error: "OpenCode remote prompt queue is closed." }
    if (entries.has(item.id)) return { ok: false, error: "Duplicate OpenCode remote prompt." }
    if (entries.size >= capacity) return { ok: false, error: "OpenCode remote prompt queue is full." }

    const entry = {
      item,
      state: "pending",
      busySeen: false,
      ctrl: new AbortController(),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    } satisfies QueueEntry
    entry.timer = setTimer(() => {
      fail(entry, "OpenCode remote prompt expired before it could start.")
    }, ttlMs)
    if (typeof entry.timer === "object" && entry.timer && "unref" in entry.timer) entry.timer.unref()
    entries.set(item.id, entry)
    drain(item.sessionID)
    return { ok: true }
  }

  const updateStatus = (sessionID: string, status: string) => {
    const active = activeForSession(sessionID)
    const gate = gates.get(sessionID)
    const localTakeover = localTakeovers.get(sessionID)
    if (status === "busy" || status === "retry") {
      if (active) active.busySeen = true
      if (gate) gate.busySeen = true
      if (localTakeover?.armed) localTakeover.busySeen = true
      return
    }
    if (status !== "idle") return

    if (localTakeover?.armed) {
      if (!localTakeover.busySeen) return
      clearTimer(localTakeover.timer)
      localTakeovers.delete(sessionID)
    }

    if (active) {
      if (active.busySeen) {
        fail(active, "OpenCode turn ended before the remote prompt was accepted.")
      }
      return
    }
    if (gate) {
      if (!gate.busySeen) return
      clearTimer(gate.timer)
      gates.delete(sessionID)
    }
    drain(sessionID)
  }

  const bind = (route: RemoteImPromptRoute) => {
    const entry = [...entries.values()].find(
      (candidate) => candidate.state === "dispatching" && routeMatches(candidate, route),
    )
    if (!entry || !remove(entry)) return false
    const existing = gates.get(entry.item.sessionID)
    if (existing) clearTimer(existing.timer)
    const gate = {
      busySeen: entry.busySeen || ["busy", "retry"].includes(input.sessionStatus(entry.item.sessionID) ?? ""),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    } satisfies SessionGate
    gate.timer = setTimer(() => {
      if (gates.get(entry.item.sessionID) !== gate) return
      gates.delete(entry.item.sessionID)
      drain(entry.item.sessionID)
    }, gateTtlMs)
    if (typeof gate.timer === "object" && gate.timer && "unref" in gate.timer) gate.timer.unref()
    gates.set(entry.item.sessionID, gate)
    return true
  }

  const release = (sessionID: string) => {
    const gate = gates.get(sessionID)
    const localTakeover = localTakeovers.get(sessionID)
    let released = false
    if (gate) {
      clearTimer(gate.timer)
      gates.delete(sessionID)
      released = true
    }
    if (localTakeover?.armed && localTakeover.busySeen) {
      clearTimer(localTakeover.timer)
      localTakeovers.delete(sessionID)
      released = true
    }
    if (released) drain(sessionID)
    return released
  }

  // Claim the session synchronously for every local submit, including when the
  // SDK's busy event has not reached the UI yet. If a remote dispatch is in the
  // pre-bind window, abort it and keep the claim disarmed until that abort has
  // settled so its busy/idle events cannot release the local claim.
  const takeoverForLocalSubmit = (sessionID: string) => {
    const entry = activeForSession(sessionID)
    const previous = localTakeovers.get(sessionID)
    if (previous) clearTimer(previous.timer)
    const localTakeover = {
      armed: !entry,
      busySeen: !entry && ["busy", "retry"].includes(input.sessionStatus(sessionID) ?? ""),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    } satisfies LocalSubmitGate
    localTakeover.timer = setTimer(() => {
      if (localTakeovers.get(sessionID) !== localTakeover) return
      localTakeovers.delete(sessionID)
      drain(sessionID)
    }, ttlMs)
    if (typeof localTakeover.timer === "object" && localTakeover.timer && "unref" in localTakeover.timer) {
      localTakeover.timer.unref()
    }
    localTakeovers.set(sessionID, localTakeover)
    const release = () => {
      if (localTakeovers.get(sessionID) !== localTakeover) return
      clearTimer(localTakeover.timer)
      localTakeovers.delete(sessionID)
      drain(sessionID)
    }
    if (!entry) return { release } satisfies RemoteImLocalSubmitClaim
    fail(entry, "OpenCode remote prompt was cancelled by local input.", false)
    const wait = Promise.resolve(entry.item.cancel?.())
      .catch(() => {})
      .finally(() => {
        if (localTakeovers.get(sessionID) === localTakeover) localTakeover.armed = true
      })
    return { wait, release } satisfies RemoteImLocalSubmitClaim
  }

  const close = (error = "OpenCode TUI closed before the remote prompt could start.") => {
    if (closed) return
    closed = true
    for (const entry of [...entries.values()]) {
      entry.ctrl.abort()
      if (!remove(entry)) continue
      entry.item.terminal(error)
    }
    for (const gate of gates.values()) clearTimer(gate.timer)
    gates.clear()
    for (const takeover of localTakeovers.values()) clearTimer(takeover.timer)
    localTakeovers.clear()
  }

  return {
    enqueue,
    updateStatus,
    bind,
    release,
    takeoverForLocalSubmit,
    close,
    get size() {
      return entries.size
    },
  }
}
