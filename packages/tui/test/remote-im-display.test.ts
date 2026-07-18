import { describe, expect, test } from "bun:test"
import { remoteImPromptParts, visibleRemoteImReplyText } from "../src/util/remote-im-display"

describe("remote IM display text", () => {
  test("hides reply protocol markers", () => {
    expect(
      visibleRemoteImReplyText('<remote-im-reply id="rim-1">\n## 状态\n\n任务完成。\n</remote-im-reply id="rim-1">'),
    ).toBe("## 状态\n\n任务完成。\n")
  })

  test("holds a partial opening marker", () => {
    expect(visibleRemoteImReplyText("<remote-im-re")).toBe("")
  })

  test("hides inline and malformed generated reply markers", () => {
    expect(
      visibleRemoteImReplyText(
        '<remote-im-reply id="rim-0123456789abcdef">你好</remote-im-reply id="rim-0123456789abcdef">',
      ),
    ).toBe("你好")
    expect(
      visibleRemoteImReplyText(
        '<remote-im-reply id="rim-0123456789abcdef你好\n</remote-im-reply id="rim-0123456789abcdef',
      ),
    ).toBe("你好\n")
  })

  test("separates model input from TUI display text", () => {
    expect(remoteImPromptParts("wrapped model prompt", "来自 IM 的消息")).toEqual([
      expect.objectContaining({ text: "wrapped model prompt", synthetic: true }),
      expect.objectContaining({ text: "来自 IM 的消息", ignored: true }),
    ])
  })
})
