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

  test("parses source-level user messages with separate display text", () => {
    const result = parseMultiAiCodeImControlPayload(
      {
        token: "token",
        kind: "control",
        command: "submit_user_message",
        requestId: "req-1",
        text: "wrapped model prompt",
        displayText: "来自 IM 的消息",
        inputOrigin: "remote-im",
        replyId: "rim-fixed",
        taskId: "task-fixed",
        attachments: [
          {
            type: "image",
            localPath: "/tmp/remote-im/photo.png",
            mimeType: "image/png",
            fileName: "photo.png",
          },
        ],
      },
      "token",
    )

    expect(result).toEqual({
      command: "submit_user_message",
      requestID: "req-1",
      text: "wrapped model prompt",
      displayText: "来自 IM 的消息",
      inputOrigin: "remote-im",
      replyID: "rim-fixed",
      taskID: "task-fixed",
      attachments: [
        {
          type: "image",
          localPath: "/tmp/remote-im/photo.png",
          mimeType: "image/png",
          fileName: "photo.png",
        },
      ],
    })
  })

  test("rejects unsafe or non-image source attachments", () => {
    const result = parseMultiAiCodeImControlPayload(
      {
        token: "token",
        kind: "control",
        command: "submit_user_message",
        requestId: "req-1",
        text: "wrapped model prompt",
        inputOrigin: "local",
        attachments: [
          { type: "image", localPath: "relative.png", mimeType: "image/png" },
          { type: "image", localPath: "/tmp/note.txt", mimeType: "text/plain" },
        ],
      },
      "token",
    )

    expect(result).toEqual({
      command: "submit_user_message",
      requestID: "req-1",
      text: "wrapped model prompt",
      displayText: "wrapped model prompt",
      attachments: [],
      inputOrigin: "local",
    })
  })
})
