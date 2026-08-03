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

  test("forwards completed assistant text parts from default TUI events", () => {
    const sent: Array<{ text: string; messageID?: string; partID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText(input) {
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
          info: { id: "msg_1", role: "assistant" },
        },
      },
    } as never)
    handleEvent({
      payload: {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: {
            id: "part_1",
            messageID: "msg_1",
            type: "text",
            text: "hello",
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
            id: "part_1",
            messageID: "msg_1",
            type: "text",
            text: "hello",
            time: { end: Date.now() },
          },
        },
      },
    } as never)

    expect(sent).toEqual([{ text: "hello", messageID: "msg_1", partID: "part_1" }])
  })

  test("forwards only terminal session errors after the session becomes idle", () => {
    const sent: Array<{ text: string; messageID?: string }> = []
    const handleEvent = createMultiAiCodeImTuiEventHandler({
      sendAssistantText() {},
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

    expect(sent).toEqual([{ text: "request failed", messageID: "ses_failed:error:0" }])
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
