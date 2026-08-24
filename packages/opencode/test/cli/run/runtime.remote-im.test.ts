import { describe, expect, test } from "bun:test"
import { finishRemoteImRunTurn, type RemoteImRunTurnState } from "@/cli/cmd/run/runtime"
import type { RunPrompt } from "@/cli/cmd/run/types"

function setup(state: Partial<RemoteImRunTurnState> = {}) {
  const final: unknown[] = []
  const errors: unknown[] = []
  const forgotten: string[] = []
  const bridge = {
    sendAssistantFinal(input: unknown) {
      final.push(input)
    },
    sendTurnError(input: unknown) {
      errors.push(input)
    },
    forgetRemoteTask(replyID: string) {
      forgotten.push(replyID)
    },
  }
  const prompt: RunPrompt = {
    text: "remote prompt",
    parts: [],
    messageID: "user-message",
    inputOrigin: "remote-im",
    remoteImReplyID: "reply-1",
    remoteImTaskID: "task-1",
  }
  const turn: RemoteImRunTurnState = {
    replyID: "reply-1",
    taskID: "task-1",
    outputs: [],
    terminal: false,
    suppressed: false,
    ...state,
  }
  return { bridge, prompt, turn, final, errors, forgotten }
}

describe("mini runtime Remote IM terminal lifecycle", () => {
  test("sends one immutable final even after local takeover suppressed progress", () => {
    const value = setup({
      suppressed: true,
      outputs: [
        { text: "first", messageID: "assistant-1", partID: "part-1" },
        { text: "second", messageID: "assistant-2", partID: "part-2" },
      ],
    })

    finishRemoteImRunTurn(value.bridge, value.prompt, value.turn, { status: "completed" })
    finishRemoteImRunTurn(value.bridge, value.prompt, value.turn, { status: "completed" })

    expect(value.final).toEqual([
      {
        text: "first\nsecond",
        replyID: "reply-1",
        taskID: "task-1",
        messageID: "assistant-2",
        partID: "part-2",
      },
    ])
    expect(value.errors).toEqual([])
    expect(value.forgotten).toEqual(["reply-1"])
  })

  test("turns a successful empty response into one terminal error", () => {
    const value = setup({ outputs: [{ text: "   ", messageID: "assistant", partID: "part" }] })

    finishRemoteImRunTurn(value.bridge, value.prompt, value.turn, { status: "completed" })

    expect(value.final).toEqual([])
    expect(value.errors).toEqual([
      {
        text: "OpenCode turn completed without a final assistant response.",
        replyID: "reply-1",
        taskID: "task-1",
        messageID: "user-message",
      },
    ])
  })

  test("forwards model and queue failures as one terminal error", () => {
    const model = setup({ error: "provider failed" })
    finishRemoteImRunTurn(model.bridge, model.prompt, model.turn, { status: "completed" })
    finishRemoteImRunTurn(model.bridge, model.prompt, model.turn, { status: "error", error: new Error("late") })
    expect(model.errors).toEqual([{ text: "provider failed", replyID: "reply-1", taskID: "task-1" }])

    const queue = setup()
    finishRemoteImRunTurn(queue.bridge, queue.prompt, queue.turn, {
      status: "error",
      error: new Error("queue failed"),
    })
    expect(queue.errors).toEqual([{ text: "queue failed", replyID: "reply-1", taskID: "task-1" }])
  })

  test("forwards abort and close cancellation as one terminal error", () => {
    const value = setup()

    finishRemoteImRunTurn(value.bridge, value.prompt, value.turn, {
      status: "cancelled",
      error: "OpenCode turn was interrupted.",
    })
    finishRemoteImRunTurn(value.bridge, value.prompt, value.turn, {
      status: "cancelled",
      error: "duplicate",
    })

    expect(value.final).toEqual([])
    expect(value.errors).toEqual([{ text: "OpenCode turn was interrupted.", replyID: "reply-1", taskID: "task-1" }])
    expect(value.forgotten).toEqual(["reply-1"])
  })

  test("finishes remote /new without requiring assistant output", () => {
    const value = setup()

    finishRemoteImRunTurn(value.bridge, value.prompt, value.turn, {
      status: "completed",
      command: "new-session",
    })

    expect(value.final).toEqual([{ text: "Started a new OpenCode session.", replyID: "reply-1", taskID: "task-1" }])
    expect(value.errors).toEqual([])
  })
})
