import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import yargs from "yargs"
import { tmpdir } from "../../fixture/fixture"
import { TuiThreadCommand, createMultiAiCodeImTuiEventHandler, resolveThreadDirectory } from "../../../src/cli/cmd/tui"
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

  test("forwards only the final assistant text after the session becomes idle", () => {
    const sent: Array<{ text: string; replyID?: string; messageID?: string; partID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal(input) {
        sent.push(input)
      },
      sendTurnError() {},
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_user", role: "user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: {
            id: "part_user",
            messageID: "msg_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-current">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_intermediate", role: "assistant", parentID: "msg_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: {
            id: "part_intermediate",
            messageID: "msg_intermediate",
            type: "text",
            text: "intermediate commentary",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: { id: "msg_final", role: "assistant", parentID: "msg_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: {
            id: "part_final_1",
            messageID: "msg_final",
            type: "text",
            text: "final answer line 1",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: {
            id: "part_final_2",
            messageID: "msg_final",
            type: "text",
            text: "final answer line 2",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    expect(sent).toEqual([])
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      },
    } as never)

    expect(sent).toEqual([
      {
        text: "final answer line 1\nfinal answer line 2",
        replyID: "rim-current",
        messageID: "msg_final:final:rim-current",
        partID: "part_final_2",
      },
    ])
  })

  test("reports source task activity and preserves task identity through the terminal event", () => {
    const activity: string[] = []
    const progress: Array<{ text: string; taskID?: string }> = []
    const final: Array<{ text: string; replyID?: string; taskID?: string }> = []
    const forgotten: string[] = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendTaskActivity(input) {
        if (input?.taskID) activity.push(input.taskID)
      },
      remoteTaskID(replyID) {
        return replyID === "rim-lifecycle" ? "task-lifecycle" : undefined
      },
      forgetRemoteTask(replyID) {
        forgotten.push(replyID)
      },
      sendAssistantText(input) {
        progress.push({ text: input.text, taskID: input.taskID })
      },
      sendAssistantFinal(input) {
        final.push({ text: input.text, replyID: input.replyID, taskID: input.taskID })
      },
      sendTurnError() {},
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_lifecycle", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_lifecycle",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-lifecycle">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_lifecycle",
          info: { id: "remote_assistant", role: "assistant", parentID: "remote_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_lifecycle", status: { type: "busy" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_lifecycle",
          part: {
            id: "remote_final",
            messageID: "remote_assistant",
            type: "text",
            text: "source-authored result",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_lifecycle", status: { type: "idle" } },
      },
    } as never)

    expect(activity).toEqual(["task-lifecycle"])
    expect(progress).toEqual([{ text: "source-authored result", taskID: "task-lifecycle" }])
    expect(final).toEqual([{ text: "source-authored result", replyID: "rim-lifecycle", taskID: "task-lifecycle" }])
    expect(forgotten).toEqual(["rim-lifecycle"])
  })

  test("keeps forwarding across remote IM turns until a TUI prompt changes the input origin", () => {
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

    const completeTurn = (messageID: string, partID: string, text: string, sessionID = "ses_source_routed") => {
      handleEvent({
        payload: {
          type: "message.updated",
          properties: {
            sessionID,
            info: { id: messageID, role: "assistant", time: { completed: Date.now() } },
          },
        },
      } as never)
      handleEvent({
        payload: {
          type: "message.part.updated",
          properties: {
            sessionID,
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
          properties: { sessionID, status: { type: "idle" } },
        },
      } as never)
    }

    completeTurn("msg_remote_1", "part_remote_1", "first remote reply")
    completeTurn("msg_background", "part_background", "background reply", "ses_background")
    completeTurn("msg_remote_2", "part_remote_2", "second remote reply")

    expect(assistantMessages).toEqual([
      {
        text: "first remote reply",
        messageID: "msg_remote_1:part_remote_1",
        partID: "part_remote_1",
      },
      {
        text: "second remote reply",
        messageID: "msg_remote_2:part_remote_2",
        partID: "part_remote_2",
      },
    ])
    expect(final).toEqual([
      {
        text: "first remote reply",
        messageID: "msg_remote_1:final",
        partID: "part_remote_1",
      },
      {
        text: "second remote reply",
        messageID: "msg_remote_2:final",
        partID: "part_remote_2",
      },
    ])
    expect(final.every((item) => item.replyID === undefined && item.taskID === undefined)).toBe(true)

    setInputOrigin("tui")
    completeTurn("msg_tui", "part_tui", "local TUI reply")

    expect(assistantMessages.map((item) => item.text)).toEqual(["first remote reply", "second remote reply"])
    expect(final).toHaveLength(2)
  })

  test("does not forward a local turn while a remote IM reply is not active", () => {
    const sent: string[] = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal(input) {
        sent.push(input.text)
      },
      sendTurnError() {},
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_local",
          info: { id: "msg_local", role: "assistant" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_local",
          part: {
            id: "part_local",
            messageID: "msg_local",
            type: "text",
            text: "local final answer",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_local", status: { type: "idle" } },
      },
    } as never)

    expect(sent).toEqual([])
  })

  test("does not forward markerless assistant text when the session ends with an error", () => {
    const final: string[] = []
    const errors: Array<{ text: string; replyID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal(input) {
        final.push(input.text)
      },
      sendTurnError(input) {
        errors.push({ text: input.text, replyID: input.replyID })
      },
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_error",
          info: { id: "msg_error_user", role: "user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_error",
          part: {
            id: "part_error_user",
            messageID: "msg_error_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-error">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_error",
          info: { id: "msg_error", role: "assistant", parentID: "msg_error_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_error",
          part: {
            id: "part_error",
            messageID: "msg_error",
            type: "text",
            text: "I will try the next step.",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.error",
        properties: {
          sessionID: "ses_error",
          error: { name: "APIError", data: { message: "request failed" } },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_error", status: { type: "idle" } },
      },
    } as never)

    expect(final).toEqual([])
    expect(errors).toEqual([{ text: "request failed", replyID: "rim-error" }])
  })

  test("forwards only terminal session errors after the session becomes idle", () => {
    const sent: Array<{ text: string; replyID?: string; messageID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal() {},
      sendTurnError(input) {
        sent.push(input)
      },
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_failed",
          info: { id: "msg_failed_user", role: "user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_failed",
          part: {
            id: "part_failed_user",
            messageID: "msg_failed_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-failed">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_failed",
          info: { id: "msg_failed_assistant", role: "assistant", parentID: "msg_failed_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.error",
        properties: {
          sessionID: "ses_retry",
          error: { name: "ProviderError", data: { message: "temporary disconnect" } },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_retry", status: { type: "retry" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_retry", status: { type: "idle" } },
      },
    } as never)

    handleEvent({
      payload: {
        type: "session.error",
        properties: {
          sessionID: "ses_failed",
          error: { name: "ProviderError", data: { message: "request failed" } },
        },
      },
    } as never)
    expect(sent).toEqual([])
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_failed", status: { type: "idle" } },
      },
    } as never)

    expect(sent).toEqual([
      {
        text: "request failed",
        replyID: "rim-failed",
        messageID: "ses_failed:error:0:rim-failed",
      },
    ])
  })

  test("forwards a remote error even when no assistant message was created", () => {
    const sent: Array<{ text: string; replyID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal() {},
      sendTurnError(input) {
        sent.push({ text: input.text, replyID: input.replyID })
      },
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_early_error", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_early_error",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-early-error">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.error",
        properties: {
          sessionID: "ses_early_error",
          error: { name: "ProviderAuthError", data: { message: "authentication failed" } },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_early_error", status: { type: "idle" } },
      },
    } as never)

    expect(sent).toEqual([{ text: "authentication failed", replyID: "rim-early-error" }])
  })

  test("does not bind an earlier local error to a later remote request", () => {
    const final: Array<{ text: string; replyID?: string }> = []
    const errors: string[] = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal(input) {
        final.push({ text: input.text, replyID: input.replyID })
      },
      sendTurnError(input) {
        errors.push(input.text)
      },
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "session.error",
        properties: {
          sessionID: "ses_local_error",
          error: { name: "ProviderError", data: { message: "old local failure" } },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_local_error", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_local_error",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-after-local-error">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_local_error",
          info: { id: "remote_assistant", role: "assistant", parentID: "remote_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_local_error",
          part: {
            id: "remote_final",
            messageID: "remote_assistant",
            type: "text",
            text: "new remote answer",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "session.status",
        properties: { sessionID: "ses_local_error", status: { type: "idle" } },
      },
    } as never)

    expect(errors).toEqual([])
    expect(final).toEqual([{ text: "new remote answer", replyID: "rim-after-local-error" }])
  })

  test("correlates a remote reply through assistant parentID instead of session timing", () => {
    const sent: Array<{ text: string; replyID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal(input) {
        sent.push({ text: input.text, replyID: input.replyID })
      },
      sendTurnError() {},
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_race", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_race",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-race">',
          },
        },
      },
    } as never)

    // A previous local turn can finish after the remote user message is stored.
    // Its assistant message must not be attributed to the remote request.
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_race",
          info: { id: "local_assistant", role: "assistant", parentID: "local_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_race",
          part: {
            id: "local_part",
            messageID: "local_assistant",
            type: "text",
            text: "previous local answer",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: { type: "session.idle", properties: { sessionID: "ses_race" } },
    } as never)
    expect(sent).toEqual([])

    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_race",
          info: { id: "remote_assistant", role: "assistant", parentID: "remote_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_race",
          part: {
            id: "remote_part",
            messageID: "remote_assistant",
            type: "text",
            text: "actual remote answer",
            time: { end: Date.now() },
          },
        },
      },
    } as never)

    expect(sent).toEqual([])
    handleEvent({
      payload: { type: "session.idle", properties: { sessionID: "ses_race" } },
    } as never)
    expect(sent).toEqual([{ text: "actual remote answer", replyID: "rim-race" }])
  })

  test("handles reordered events and reply markers split across assistant messages", () => {
    const sent: Array<{ text: string; replyID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal(input) {
        sent.push({ text: input.text, replyID: input.replyID })
      },
      sendTurnError() {},
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_order",
          part: {
            id: "user_part",
            messageID: "user_order",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-order">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_order", info: { id: "user_order", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_order",
          info: { id: "assistant_open", role: "assistant", parentID: "user_order" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_order",
          part: {
            id: "assistant_open_part",
            messageID: "assistant_open",
            type: "text",
            text: '<remote-im-reply id="rim-order">\n第一行',
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_order",
          info: { id: "assistant_close", role: "assistant", parentID: "user_order" },
        },
      },
    } as never)
    handleEvent({
      payload: { type: "session.idle", properties: { sessionID: "ses_order" } },
    } as never)
    expect(sent).toEqual([])
    const closingEvent = {
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_order",
          part: {
            id: "assistant_close_part",
            messageID: "assistant_close",
            type: "text",
            text: '第二行\n</remote-im-reply id="rim-order">',
            time: { end: Date.now() },
          },
        },
      },
    } as never
    handleEvent(closingEvent)
    handleEvent(closingEvent)
    expect(sent).toEqual([
      {
        text: '<remote-im-reply id="rim-order">\n第一行\n第二行\n</remote-im-reply id="rim-order">',
        replyID: "rim-order",
      },
    ])
  })

  test("uses the latest assistant message with text when a trailing assistant message is empty", () => {
    const sent: Array<{ text: string; replyID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
      sendAssistantFinal(input) {
        sent.push({ text: input.text, replyID: input.replyID })
      },
      sendTurnError() {},
      onControlCommand() {
        return () => {}
      },
      sendControlResult() {},
      close() {},
    })

    handleEvent({
      payload: {
        type: "message.updated",
        properties: { sessionID: "ses_empty_tail", info: { id: "remote_user", role: "user" } },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_empty_tail",
          part: {
            id: "remote_prompt",
            messageID: "remote_user",
            type: "text",
            text: 'Opening marker: <remote-im-reply id="rim-empty-tail">',
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_empty_tail",
          info: { id: "assistant_final", role: "assistant", parentID: "remote_user" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_empty_tail",
          part: {
            id: "assistant_final_part",
            messageID: "assistant_final",
            type: "text",
            text: "final answer before empty tail",
            time: { end: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_empty_tail",
          info: {
            id: "assistant_empty",
            role: "assistant",
            parentID: "remote_user",
            time: { completed: Date.now() },
          },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.updated",
        properties: {
          sessionID: "ses_empty_tail",
          info: { id: "assistant_empty", role: "assistant", parentID: "remote_user" },
        },
      },
    } as never)
    handleEvent({
      payload: { type: "session.idle", properties: { sessionID: "ses_empty_tail" } },
    } as never)

    expect(sent).toEqual([{ text: "final answer before empty tail", replyID: "rim-empty-tail" }])
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
