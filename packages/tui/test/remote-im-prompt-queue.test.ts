import { describe, expect, test } from "bun:test"
import { createRemoteImPromptQueue, type RemoteImPromptQueueItem } from "../src/util/remote-im-prompt-queue"

const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve))

function fakeTimers() {
  let next = 0
  const timers = new Map<number, () => void>()
  return {
    setTimer: ((callback: () => void) => {
      const id = ++next
      timers.set(id, callback)
      return id
    }) as unknown as typeof setTimeout,
    clearTimer: ((id: number) => {
      timers.delete(id)
    }) as unknown as typeof clearTimeout,
    expireAll() {
      for (const callback of [...timers.values()]) callback()
    },
    expireLatest() {
      const callback = [...timers.values()].at(-1)
      callback?.()
    },
  }
}

describe("remote IM prompt source queue", () => {
  test("waits for local idle and starts one immutable remote prompt at a time", async () => {
    const status = new Map([["session", "busy"]])
    const dispatched: string[] = []
    const terminal: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: (sessionID) => status.get(sessionID),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const item = (id: string): RemoteImPromptQueueItem => ({
      id,
      sessionID: "session",
      replyID: "reply-" + id,
      taskID: "task-" + id,
      async dispatch() {
        dispatched.push(id)
      },
      terminal(error) {
        terminal.push(id + ":" + error)
      },
    })

    expect(queue.enqueue(item("one"))).toEqual({ ok: true })
    expect(queue.enqueue(item("two"))).toEqual({ ok: true })
    await tick()
    expect(dispatched).toEqual([])

    status.set("session", "idle")
    queue.updateStatus("session", "idle")
    await tick()
    expect(dispatched).toEqual(["one"])

    expect(queue.bind({ replyID: "reply-one", taskID: "task-one" })).toBe(true)
    queue.updateStatus("session", "idle")
    await tick()
    expect(dispatched).toEqual(["one"])

    status.set("session", "busy")
    queue.updateStatus("session", "busy")
    status.set("session", "idle")
    queue.updateStatus("session", "idle")
    await tick()
    expect(dispatched).toEqual(["one", "two"])
    expect(terminal).toEqual([])
  })

  test("rejects overflow before acceptance and expires an accepted pending prompt exactly once", () => {
    const status = new Map([["session", "busy"]])
    const terminal: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: (sessionID) => status.get(sessionID),
      capacity: 1,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const entry = (id: string): RemoteImPromptQueueItem => ({
      id,
      sessionID: "session",
      taskID: id,
      async dispatch() {},
      terminal(error) {
        terminal.push(error)
      },
    })

    expect(queue.enqueue(entry("one"))).toEqual({ ok: true })
    expect(queue.enqueue(entry("two"))).toEqual({
      ok: false,
      error: "OpenCode remote prompt queue is full.",
    })
    timers.expireAll()
    queue.close()

    expect(terminal).toEqual(["OpenCode remote prompt expired before it could start."])
    expect(queue.size).toBe(0)
  })

  test("turns a dispatch rejection into one terminal and continues the FIFO", async () => {
    const terminal: string[] = []
    const dispatched: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: () => "idle",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    queue.enqueue({
      id: "bad",
      sessionID: "session",
      async dispatch() {
        throw new Error("network failed")
      },
      terminal(error) {
        terminal.push(error)
      },
    })
    queue.enqueue({
      id: "next",
      sessionID: "session",
      async dispatch() {
        dispatched.push("next")
      },
      terminal(error) {
        terminal.push(error)
      },
    })

    await tick()
    await tick()
    await tick()

    expect(terminal).toEqual(["network failed"])
    expect(dispatched).toEqual(["next"])
  })

  test("late metadata after busy-to-idle cannot resurrect a failed route", async () => {
    const status = new Map([["session", "idle"]])
    const terminal: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: (sessionID) => status.get(sessionID),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    queue.enqueue({
      id: "late",
      sessionID: "session",
      replyID: "reply-late",
      taskID: "task-late",
      async dispatch() {},
      terminal(error) {
        terminal.push(error)
      },
    })
    await tick()

    status.set("session", "busy")
    queue.updateStatus("session", "busy")
    status.set("session", "idle")
    queue.updateStatus("session", "idle")

    expect(queue.bind({ replyID: "reply-late", taskID: "task-late" })).toBe(false)
    expect(terminal).toEqual(["OpenCode turn ended before the remote prompt was accepted."])
  })

  test("a bound gate self-releases after the route lifecycle TTL without owning its terminal", async () => {
    const dispatched: string[] = []
    const terminal: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: () => "idle",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const enqueue = (id: string) =>
      queue.enqueue({
        id,
        sessionID: "session",
        taskID: id,
        async dispatch() {
          dispatched.push(id)
        },
        terminal(error) {
          terminal.push(error)
        },
      })
    enqueue("one")
    enqueue("two")
    await tick()
    expect(queue.bind({ taskID: "one" })).toBe(true)

    timers.expireLatest()
    await tick()

    expect(dispatched).toEqual(["one", "two"])
    expect(terminal).toEqual([])
  })

  test("an abort terminal releases the bound gate for the next prompt", async () => {
    const dispatched: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: () => "idle",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    for (const id of ["one", "two"]) {
      queue.enqueue({
        id,
        sessionID: "session",
        taskID: id,
        async dispatch() {
          dispatched.push(id)
        },
        terminal() {},
      })
    }
    await tick()
    expect(queue.bind({ taskID: "one" })).toBe(true)

    expect(queue.release("session")).toBe(true)
    await tick()

    expect(dispatched).toEqual(["one", "two"])
  })

  test("local submit cancels the pre-bind remote dispatch and parks the remaining FIFO", async () => {
    const status = new Map([["session", "idle"]])
    const dispatched: string[] = []
    const terminal: string[] = []
    const cancelled: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: (sessionID) => status.get(sessionID),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    let resolveCancel!: () => void
    queue.enqueue({
      id: "one",
      sessionID: "session",
      taskID: "one",
      async dispatch(signal) {
        dispatched.push("one")
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        })
      },
      async cancel() {
        cancelled.push("one")
        await new Promise<void>((resolve) => {
          resolveCancel = resolve
        })
      },
      terminal(error) {
        terminal.push(error)
      },
    })
    queue.enqueue({
      id: "two",
      sessionID: "session",
      taskID: "two",
      async dispatch() {
        dispatched.push("two")
      },
      terminal(error) {
        terminal.push(error)
      },
    })
    await tick()
    expect(dispatched).toEqual(["one"])

    const takeover = queue.takeoverForLocalSubmit("session")
    await tick()
    await tick()

    expect(cancelled).toEqual(["one"])
    expect(terminal).toEqual(["OpenCode remote prompt was cancelled by local input."])
    expect(dispatched).toEqual(["one"])

    // These belong to the cancelled remote runner and must not release the
    // local claim while its server-side abort is still settling.
    status.set("session", "busy")
    queue.updateStatus("session", "busy")
    status.set("session", "idle")
    queue.updateStatus("session", "idle")
    await tick()
    expect(dispatched).toEqual(["one"])

    resolveCancel()
    await takeover.wait
    queue.updateStatus("session", "idle")
    await tick()
    expect(dispatched).toEqual(["one"])

    status.set("session", "busy")
    queue.updateStatus("session", "busy")
    status.set("session", "idle")
    queue.updateStatus("session", "idle")
    await tick()
    expect(dispatched).toEqual(["one", "two"])
  })

  test("local submit preclaims an idle session before its delayed busy event", async () => {
    const status = new Map([["session", "idle"]])
    const dispatched: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: (sessionID) => status.get(sessionID),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })

    // The prompt component performs this synchronously immediately before the
    // local SDK submit. The status store still says idle at this point.
    queue.takeoverForLocalSubmit("session")
    expect(
      queue.enqueue({
        id: "remote",
        sessionID: "session",
        taskID: "remote",
        async dispatch() {
          dispatched.push("remote")
        },
        terminal() {},
      }),
    ).toEqual({ ok: true })
    await tick()
    expect(dispatched).toEqual([])

    status.set("session", "busy")
    queue.updateStatus("session", "busy")
    status.set("session", "idle")
    queue.updateStatus("session", "idle")
    await tick()

    expect(dispatched).toEqual(["remote"])
  })

  test("a failed local submit releases its preclaim", async () => {
    const dispatched: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: () => "idle",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const claim = queue.takeoverForLocalSubmit("session")
    queue.enqueue({
      id: "remote",
      sessionID: "session",
      async dispatch() {
        dispatched.push("remote")
      },
      terminal() {},
    })
    await tick()
    expect(dispatched).toEqual([])

    claim.release()
    await tick()
    expect(dispatched).toEqual(["remote"])
  })

  test("a stale local failure cannot release a newer local submit claim", async () => {
    const dispatched: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: () => "idle",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    const stale = queue.takeoverForLocalSubmit("session")
    const current = queue.takeoverForLocalSubmit("session")
    queue.enqueue({
      id: "remote",
      sessionID: "session",
      async dispatch() {
        dispatched.push("remote")
      },
      terminal() {},
    })

    stale.release()
    await tick()
    expect(dispatched).toEqual([])

    current.release()
    await tick()
    expect(dispatched).toEqual(["remote"])
  })

  test("close terminates dispatching and pending prompts without a late duplicate", async () => {
    let rejectDispatch: ((error: Error) => void) | undefined
    const terminal: string[] = []
    const timers = fakeTimers()
    const queue = createRemoteImPromptQueue({
      sessionStatus: () => "idle",
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    })
    queue.enqueue({
      id: "active",
      sessionID: "session",
      async dispatch() {
        await new Promise<void>((_resolve, reject) => {
          rejectDispatch = reject
        })
      },
      terminal(error) {
        terminal.push("active:" + error)
      },
    })
    queue.enqueue({
      id: "pending",
      sessionID: "session",
      async dispatch() {},
      terminal(error) {
        terminal.push("pending:" + error)
      },
    })
    await tick()

    queue.close("closed")
    rejectDispatch?.(new Error("late failure"))
    await tick()
    await tick()

    expect(terminal).toEqual(["active:closed", "pending:closed"])
  })
})
