import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import {
  TuiThreadCommand,
  createMultiAiCodeImTuiEventHandler,
  createRetryingEventSource,
  resolveThreadDirectory,
} from "../../../src/cli/cmd/tui"
import { cliIt } from "../../lib/cli-process"

describe("tui thread", () => {
  test("loads the TUI integration lazily", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toContain('await import("../tui/layer")')
    expect(source).toMatch(/await import\(["']@\/plugin\/tui\/runtime["']\)/)
    expect(source).not.toContain('import("./app")')
  })

  test("forwards the CLI environment to the TUI worker", async () => {
    const source = await Bun.file(new URL("../../../src/cli/cmd/tui.ts", import.meta.url)).text()

    expect(source).toMatch(/new Worker\(file, \{\s*env: Object\.fromEntries\(\s*Object\.entries\(process\.env\)/)
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves a relative mini project from PWD when cwd differs", async () => {
    await using pwd = await tmpdir({ git: true })
    await using cwd = await tmpdir({ git: true })

    expect(resolveThreadDirectory(".", pwd.path, cwd.path)).toBe(pwd.path)
    expect(resolveThreadDirectory(undefined, pwd.path, cwd.path)).toBe(cwd.path)
  })

  test("parses supported --no-replay forms", async () => {
    for (const option of ["--no-replay", "--no-replay=true", "--noReplay"]) {
      const args = await yargs([])
        .command({ ...TuiThreadCommand, handler: () => {} })
        .exitProcess(false)
        .parse(["--mini", option, "--replay-limit", "10"])

      expect(args.replay === false || args.noReplay === true).toBe(true)
      expect(args.replayLimit).toBe(10)
    }
  })

  test("preserves boolean negation for existing options", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--mdns", "--no-mdns"])

    expect(args.mdns).toBe(false)
  })

  test("accepts the hidden Multi-AI Code IM IPC option in default TUI mode", async () => {
    const args = await yargs([])
      .command({ ...TuiThreadCommand, handler: () => {} })
      .exitProcess(false)
      .parse(["--multi-ai-code-im-ipc", "tcp://127.0.0.1:1?token=test", "."])

    expect(args.multiAiCodeImIpc).toBe("tcp://127.0.0.1:1?token=test")
  })

  test("taps external-network SDK events into the Remote IM lifecycle handler", async () => {
    const event = {
      directory: "/tmp/project",
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_external", status: { type: "idle" } },
      },
    } as never
    const tapped: unknown[] = []
    const delivered: unknown[] = []
    let resolveDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve
    })
    const source = createRetryingEventSource(
      async (signal) =>
        (async function* () {
          yield event
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        })(),
      (next) => tapped.push(next),
      1,
    )
    const unsubscribe = await source.subscribe((next) => {
      delivered.push(next)
      resolveDelivery()
    })

    await delivery
    unsubscribe()

    expect(tapped).toEqual([event])
    expect(delivered).toEqual([event])
  })

  test("reconnects the external-network event stream without bypassing the lifecycle tap", async () => {
    const tapped: number[] = []
    const delivered: number[] = []
    let opens = 0
    let resolveDelivery!: () => void
    const delivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve
    })
    const source = createRetryingEventSource(
      async (signal) => {
        const index = ++opens
        return (async function* () {
          yield { directory: "/tmp/project", payload: { type: "test", properties: { index } } } as never
          if (index > 1) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
          }
        })()
      },
      (event) => tapped.push((event.payload as unknown as { properties: { index: number } }).properties.index),
      0,
    )
    const unsubscribe = await source.subscribe((event) => {
      delivered.push((event.payload as unknown as { properties: { index: number } }).properties.index)
      if (delivered.length === 2) resolveDelivery()
    })

    await delivery
    unsubscribe()

    expect(opens).toBe(2)
    expect(tapped).toEqual([1, 2])
    expect(delivered).toEqual([1, 2])
  })

  test("forwards only assistant messages parented by an immutable remote route", () => {
    let active = true
    let activeSessionID: string | undefined = "ses_source_routed"
    const setInputOrigin = (origin: "remote-im" | "tui", sessionID?: string) => {
      active = origin === "remote-im"
      activeSessionID = active ? sessionID : undefined
    }
    const assistantMessages: Array<{
      text: string
      replyID?: string
      taskID?: string
      messageID?: string
      partID?: string
    }> = []
    const final: Array<{
      text: string
      replyID?: string
      taskID?: string
      messageID?: string
      partID?: string
    }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      setInputOrigin,
      isRemoteImForwardingActive() {
        return active
      },
      remoteImForwardingSessionID() {
        return activeSessionID
      },
      sendTaskActivity() {},
      sendAssistantText(input) {
        assistantMessages.push(input)
      },
      sendAssistantFinal(input) {
        final.push(input)
      },
      sendTurnError() {},
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    const completeRemoteTurn = (index: number, messageID: string, partID: string, text: string) => {
      const userID = `remote_user_${index}`
      const replyID = `rim-source-${index}`
      const taskID = `task-source-${index}`
      handleEvent({
        payload: {
          type: "message.updated",
          properties: { sessionID: "ses_source_routed", info: { id: userID, role: "user" } },
        },
      } as never)
      handleEvent({
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID: "ses_source_routed",
            part: {
              id: `remote_prompt_${index}`,
              messageID: userID,
              type: "text",
              text: `remote prompt ${index}`,
              metadata: {
                kind: "remote_im_model_prompt",
                remoteImReplyID: replyID,
                remoteImTaskID: taskID,
              },
            },
          },
        },
      } as never)
      handleEvent({
        payload: {
          type: "message.updated",
          properties: {
            sessionID: "ses_source_routed",
            info: { id: messageID, role: "assistant", parentID: userID, time: { completed: Date.now() } },
          },
        },
      } as never)
      handleEvent({
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID: "ses_source_routed",
            part: {
              id: partID,
              messageID,
              type: "text",
              text,
              time: { end: Date.now() },
            },
          },
        },
      } as never)
      handleEvent({
        payload: {
          type: "session.status",
          properties: { sessionID: "ses_source_routed", status: { type: "idle" } },
        },
      } as never)
    }

    completeRemoteTurn(1, "msg_remote_1", "part_remote_1", "first remote reply")
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_background", info: { id: "msg_background", role: "assistant" } },
      },
    } as never)
    completeRemoteTurn(2, "msg_remote_2", "part_remote_2", "second remote reply")

    expect(assistantMessages).toEqual([
      {
        text: "first remote reply",
        taskID: "task-source-1",
        messageID: "msg_remote_1:part_remote_1",
        partID: "part_remote_1",
      },
      {
        text: "second remote reply",
        taskID: "task-source-2",
        messageID: "msg_remote_2:part_remote_2",
        partID: "part_remote_2",
      },
    ])
    expect(final).toEqual([
      {
        text: "first remote reply",
        replyID: "rim-source-1",
        taskID: "task-source-1",
        messageID: "msg_remote_1:final",
        partID: "part_remote_1",
      },
      {
        text: "second remote reply",
        replyID: "rim-source-2",
        taskID: "task-source-2",
        messageID: "msg_remote_2:final",
        partID: "part_remote_2",
      },
    ])
    setInputOrigin("tui")
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_source_routed", info: { id: "msg_tui", role: "assistant" } },
      },
    } as never)

    expect(assistantMessages.map((item) => item.text)).toEqual(["first remote reply", "second remote reply"])
    expect(final).toHaveLength(2)
  })

  test.each(["no assistant message", "an empty assistant message"])(
    "terminates a source-routed remote turn with %s exactly once",
    (scenario) => {
      const errors: Array<{ text: string; replyID?: string; taskID?: string }> = []
      const forgotten: string[] = []
      const handleEvent = createMultiAiCodeImTuiEventHandler({
        setInputOrigin() {},
        isRemoteImForwardingActive: () => true,
        remoteImForwardingSessionID: () => "ses_empty",
        remoteTaskID: (replyID) => (replyID === "rim-empty" ? "task-empty" : undefined),
        forgetRemoteTask(replyID) {
          forgotten.push(replyID)
        },
        sendTaskActivity() {},
        sendAssistantText() {},
        sendAssistantFinal() {},
        sendTurnError(input) {
          errors.push({ text: input.text, replyID: input.replyID, taskID: input.taskID })
        },
        onControlCommand: () => () => {},
        sendControlResult() {},
        close() {},
      })

      handleEvent({
        payload: {
          type: "message.updated",
          properties: { sessionID: "ses_empty", info: { id: "remote_user", role: "user" } },
        },
      } as never)
      handleEvent({
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID: "ses_empty",
            part: {
              id: "remote_prompt",
              messageID: "remote_user",
              type: "text",
              text: "remote prompt",
              metadata: {
                kind: "remote_im_model_prompt",
                remoteImReplyID: "rim-empty",
                remoteImTaskID: "task-empty",
              },
            },
          },
        },
      } as never)
      handleEvent({
        payload: {
          type: "session.status",
          properties: { sessionID: "ses_empty", status: { type: "busy" } },
        },
      } as never)

      if (scenario === "an empty assistant message") {
        handleEvent({
          payload: {
            type: "message.updated",
            properties: {
              sessionID: "ses_empty",
              info: { id: "empty_assistant", role: "assistant", parentID: "remote_user" },
            },
          },
        } as never)
        handleEvent({
          payload: {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_empty",
              part: {
                id: "empty_part",
                messageID: "empty_assistant",
                type: "text",
                text: "   ",
                time: { end: Date.now() },
              },
            },
          },
        } as never)
      }

      const idle = {
        payload: {
          type: "session.status",
          properties: { sessionID: "ses_empty", status: { type: "idle" } },
        },
      } as never
      handleEvent(idle)
      handleEvent(idle)

      expect(errors).toEqual([
        {
          text: "OpenCode turn completed without a final assistant response.",
          replyID: "rim-empty",
          taskID: "task-empty",
        },
      ])
      expect(forgotten).toEqual(["rim-empty"])
    },
  )

  test("terminates an empty source route when busy arrives before its immutable prompt metadata", () => {
    const errors: Array<{ text: string; replyID?: string; taskID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      setInputOrigin() {},
      isRemoteImForwardingActive: () => true,
      remoteTaskID: () => "task-busy-before-bind",
      forgetRemoteTask() {},
      sendTaskActivity() {},
      sendAssistantText() {},
      sendAssistantFinal() {},
      sendTurnError(input) {
        errors.push({ text: input.text, replyID: input.replyID, taskID: input.taskID })
      },
      onControlCommand: () => () => {},
      sendControlResult() {},
      close() {},
    })
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_busy_before_bind", status: { type: "busy" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_busy_before_bind", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_busy_before_bind",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: "remote prompt",
            metadata: {
              kind: "remote_im_model_prompt",
              remoteImReplyID: "rim-busy-before-bind",
              remoteImTaskID: "task-busy-before-bind",
            },
          },
        },
      },
    } as never)
    const idle = {
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_busy_before_bind", status: { type: "idle" } },
      },
    } as never
    handleEvent(idle)
    handleEvent(idle)

    expect(errors).toEqual([
      {
        text: "OpenCode turn completed without a final assistant response.",
        replyID: "rim-busy-before-bind",
        taskID: "task-busy-before-bind",
      },
    ])
  })

  test("terminates an aborted source-routed remote turn before its first busy event exactly once", () => {
    const errors: string[] = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      setInputOrigin() {},
      isRemoteImForwardingActive: () => true,
      remoteImForwardingSessionID: () => "ses_abort",
      remoteTaskID: () => "task-abort",
      forgetRemoteTask() {},
      sendTaskActivity() {},
      sendAssistantText() {},
      sendAssistantFinal() {},
      sendTurnError(input) {
        errors.push(input.text)
      },
      onControlCommand: () => () => {},
      sendControlResult() {},
      close() {},
    })
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_abort", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_abort",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: "remote prompt",
            metadata: {
              kind: "remote_im_model_prompt",
              remoteImReplyID: "rim-abort",
              remoteImTaskID: "task-abort",
            },
          },
        },
      },
    } as never)
    const aborted = {
      payload: {
        type: "session.error",
        properties: { sessionID: "ses_abort", error: { name: "MessageAbortedError" } },
      },
    } as never
    handleEvent(aborted)
    handleEvent(aborted)

    expect(errors).toEqual(["OpenCode turn was interrupted."])
  })

  test("terminates a failed source-routed remote turn before its first busy event exactly once", () => {
    const errors: Array<{ text: string; replyID?: string; taskID?: string }> = []
    const forgotten: string[] = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      setInputOrigin() {},
      isRemoteImForwardingActive: () => true,
      remoteTaskID: () => "task-start-failure",
      forgetRemoteTask(replyID) {
        forgotten.push(replyID)
      },
      sendTaskActivity() {},
      sendAssistantText() {},
      sendAssistantFinal() {},
      sendTurnError(input) {
        errors.push({ text: input.text, replyID: input.replyID, taskID: input.taskID })
      },
      onControlCommand: () => () => {},
      sendControlResult() {},
      close() {},
    })
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_start_failure", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_start_failure",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: "remote prompt",
            metadata: {
              kind: "remote_im_model_prompt",
              remoteImReplyID: "rim-start-failure",
              remoteImTaskID: "task-start-failure",
            },
          },
        },
      },
    } as never)
    const failed = {
      payload: {
        type: "session.error",
        properties: {
          sessionID: "ses_start_failure",
          error: { name: "ProviderError", data: { message: "runner failed to start" } },
        },
      },
    } as never
    handleEvent(failed)
    handleEvent(failed)

    expect(errors).toEqual([
      {
        text: "runner failed to start",
        replyID: "rim-start-failure",
        taskID: "task-start-failure",
      },
    ])
    expect(forgotten).toEqual(["rim-start-failure"])
  })

  test("expires a bound source route with one terminal error", () => {
    let expire: (() => void) | undefined
    const errors: string[] = []
    const forgotten: string[] = []
    const handleEvent = createMultiAiCodeImTuiEventHandler(
      {
        setInputOrigin() {},
        isRemoteImForwardingActive: () => true,
        remoteTaskID: () => "task-expiry",
        forgetRemoteTask(replyID) {
          forgotten.push(replyID)
        },
        sendTaskActivity() {},
        sendAssistantText() {},
        sendAssistantFinal() {},
        sendTurnError(input) {
          errors.push(input.text)
        },
        onControlCommand: () => () => {},
        sendControlResult() {},
        close() {},
      },
      {
        sourceRouteTtlMs: 1,
        setTimer: ((callback: () => void) => {
          expire = callback
          return 1
        }) as unknown as typeof setTimeout,
        clearTimer() {},
      },
    )
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_expiry", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_expiry",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: "remote prompt",
            metadata: {
              kind: "remote_im_model_prompt",
              remoteImReplyID: "rim-expiry",
              remoteImTaskID: "task-expiry",
            },
          },
        },
      },
    } as never)

    expire?.()
    expire?.()

    expect(errors).toEqual(["OpenCode remote turn expired before producing a final response."])
    expect(forgotten).toEqual(["rim-expiry"])
  })

  test("does not bind source metadata after its host route was cancelled", () => {
    const started: Array<{ replyID?: string; taskID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      setInputOrigin() {},
      isRemoteImForwardingActive: () => true,
      remoteTaskID: () => undefined,
      sendTaskStarted(input) {
        started.push({ replyID: input?.replyID, taskID: input?.taskID })
      },
      sendTaskActivity() {},
      sendAssistantText() {},
      sendAssistantFinal() {},
      sendTurnError() {},
      onControlCommand: () => () => {},
      sendControlResult() {},
      close() {},
    })
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_cancelled", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_cancelled",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: "late remote prompt",
            metadata: {
              kind: "remote_im_model_prompt",
              remoteImReplyID: "rim-cancelled",
              remoteImTaskID: "task-cancelled",
            },
          },
        },
      },
    } as never)

    expect(started).toEqual([])
  })

  test("keeps an accepted remote route terminal-safe after local takeover", () => {
    let active = true
    const final: Array<{ text: string; replyID?: string; taskID?: string }> = []
    const progress: string[] = []
    const errors: string[] = []
    const started: Array<{ replyID?: string; taskID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      setInputOrigin(origin) {
        active = origin === "remote-im"
      },
      isRemoteImForwardingActive: () => active,
      remoteImForwardingSessionID: () => (active ? "ses_takeover" : undefined),
      remoteTaskID: () => "task-takeover",
      forgetRemoteTask() {},
      sendTaskStarted(input) {
        started.push({ replyID: input?.replyID, taskID: input?.taskID })
      },
      sendTaskActivity() {},
      sendAssistantText(input) {
        progress.push(input.text)
      },
      sendAssistantFinal(input) {
        final.push({ text: input.text, replyID: input.replyID, taskID: input.taskID })
      },
      sendTurnError(input) {
        errors.push(input.text)
      },
      onControlCommand: () => () => {},
      sendControlResult() {},
      close() {},
    })
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_takeover", status: { type: "busy" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_takeover",
          info: { id: "local_assistant", role: "assistant", parentID: "local_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_takeover",
          part: {
            id: "local_answer",
            messageID: "local_assistant",
            type: "text",
            text: "local result",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_takeover", status: { type: "idle" } },
      },
    } as never)
    expect(started).toEqual([])
    expect(progress).toEqual([])
    expect(final).toEqual([])
    expect(errors).toEqual([])

    // The source queue can now dispatch the remote prompt from idle.
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_takeover", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_takeover",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: "remote prompt",
            metadata: {
              kind: "remote_im_model_prompt",
              remoteImReplyID: "rim-takeover",
              remoteImTaskID: "task-takeover",
            },
          },
        },
      },
    } as never)
    expect(started).toEqual([{ replyID: "rim-takeover", taskID: "task-takeover" }])
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_takeover", status: { type: "busy" } },
      },
    } as never)

    active = false
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_takeover",
          info: { id: "remote_assistant", role: "assistant", parentID: "remote_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_takeover",
          part: {
            id: "remote_answer",
            messageID: "remote_assistant",
            type: "text",
            text: "remote result",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_takeover", status: { type: "idle" } },
      },
    } as never)

    expect(progress).toEqual(["remote result"])
    expect(final).toEqual([{ text: "remote result", replyID: "rim-takeover", taskID: "task-takeover" }])
    expect(errors).toEqual([])
  })

  test("keeps a route-less machine steer attached to the active human reply", () => {
    const started: Array<{ replyID?: string; taskID?: string }> = []
    const final: Array<{ text: string; replyID?: string; taskID?: string }> = []
    const errors: string[] = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      setInputOrigin() {},
      isRemoteImForwardingActive: () => true,
      remoteImForwardingSessionID: () => "ses-machine-steer",
      remoteTaskID: () => "task-human",
      forgetRemoteTask() {},
      sendTaskStarted(input) {
        started.push({ replyID: input?.replyID, taskID: input?.taskID })
      },
      sendTaskActivity() {},
      sendAssistantText() {},
      sendAssistantFinal(input) {
        final.push({ text: input.text, replyID: input.replyID, taskID: input.taskID })
      },
      sendTurnError(input) {
        errors.push(input.text)
      },
      onControlCommand: () => () => {},
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses-machine-steer",
          info: { id: "human-user", role: "user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses-machine-steer",
          part: {
            id: "human-prompt",
            messageID: "human-user",
            type: "text",
            text: "human prompt",
            metadata: {
              kind: "remote_im_model_prompt",
              remoteImReplyID: "reply-human",
              remoteImTaskID: "task-human",
            },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses-machine-steer",
          info: { id: "machine-user", role: "user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses-machine-steer",
          part: {
            id: "machine-prompt",
            messageID: "machine-user",
            type: "text",
            text: "machine steer",
            metadata: { kind: "remote_im_model_prompt" },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses-machine-steer", status: { type: "busy" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses-machine-steer",
          info: { id: "assistant-after-machine", role: "assistant", parentID: "machine-user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses-machine-steer",
          part: {
            id: "machine-steered-answer",
            messageID: "assistant-after-machine",
            type: "text",
            text: "answer after machine steer",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses-machine-steer", status: { type: "idle" } },
      },
    } as never)

    expect(started).toEqual([{ replyID: "reply-human", taskID: "task-human" }])
    expect(final).toEqual([
      {
        text: "answer after machine steer",
        replyID: "reply-human",
        taskID: "task-human",
      },
    ])
    expect(errors).toEqual([])
  })


  cliIt.live("rejects mini-only options without --mini", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--replay-limit", "10"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--replay-limit requires --mini")
    }),
  )

  cliIt.live("routes attached sessions to mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["attach", "http://127.0.0.1:1", "--mini"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--mini requires a TTY stdout")
    }),
  )

  cliIt.live("rejects network options in mini mode", ({ opencode }) =>
    Effect.gen(function* () {
      const result = yield* opencode.spawn(["--mini", "--port", "4096"])

      opencode.expectExit(result, 1)
      expect(result.stderr).toContain("--port cannot be used with --mini")
    }),
  )
})
