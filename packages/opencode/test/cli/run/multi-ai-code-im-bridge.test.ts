import { describe, expect, test } from "bun:test"
import { parseMultiAiCodeImControlPayload } from "../../../src/cli/cmd/run/multi-ai-code-im-bridge"

describe("parseMultiAiCodeImControlPayload", () => {
  test.each(["interrupt", "compact", "clear"] as const)("parses %s lifecycle command", (command) => {
    const result = parseMultiAiCodeImControlPayload(
      {
        token: "token",
        kind: "control",
        command,
        requestId: "req-1",
      },
      "token",
    )

    expect(result).toEqual({
      command,
      requestID: "req-1",
    })
  })

  test("parses /btw control command with reply id", () => {
    const result = parseMultiAiCodeImControlPayload(
      {
        token: "token",
        kind: "control",
        command: "btw",
        requestId: "req-1",
        task: "检查日志",
        replyId: "reply-btw-fixed",
      },
      "token",
    )

    expect(result).toEqual({
      command: "btw",
      requestID: "req-1",
      task: "检查日志",
      replyID: "reply-btw-fixed",
    })
  })
})
