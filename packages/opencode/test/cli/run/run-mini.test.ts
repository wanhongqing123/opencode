import { afterEach, describe, expect, test } from "bun:test"
import { RunCommand, runMini } from "@/cli/cmd/run"

type RunCommandHandler = NonNullable<typeof RunCommand.handler>
type RunCommandArgs = Parameters<RunCommandHandler>[0]
type MutableRunCommand = {
  handler?: typeof RunCommand.handler
}

const originalHandler = RunCommand.handler

function setRunCommandHandler(handler: typeof RunCommand.handler) {
  ;(RunCommand as MutableRunCommand).handler = handler
}

afterEach(() => {
  setRunCommandHandler(originalHandler)
})

describe("run mini", () => {
  test("forwards the Multi-AI Code IM IPC option through the mini wrapper", async () => {
    let captured: RunCommandArgs | undefined
    setRunCommandHandler(async (args) => {
      captured = args
    })

    await runMini({
      directory: "/tmp/project",
      continue: true,
      multiAiCodeImIpc: "tcp://127.0.0.1:1234?token=test",
    })

    expect(captured?.["multi-ai-code-im-ipc"]).toBe("tcp://127.0.0.1:1234?token=test")
    expect(captured?.multiAiCodeImIpc).toBe("tcp://127.0.0.1:1234?token=test")
    expect(captured?.continue).toBe(true)
  })
})
