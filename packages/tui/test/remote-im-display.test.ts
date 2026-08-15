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

  test("binds an immutable Remote IM route to the synthetic model part", () => {
    expect(
      remoteImPromptParts("wrapped model prompt", "来自 IM 的消息", [], {
        route: { replyID: "rim-route", taskID: "task-route" },
      })[0],
    ).toEqual(
      expect.objectContaining({
        metadata: {
          kind: "remote_im_model_prompt",
          remoteImReplyID: "rim-route",
          remoteImTaskID: "task-route",
        },
      }),
    )
  })

  test("submits remote images as native file parts", () => {
    expect(
      remoteImPromptParts("wrapped model prompt", "来自 IM 的图片", [
        {
          type: "image",
          localPath: "/tmp/remote-im/photo.png",
          mimeType: "image/png",
          fileName: "photo.png",
        },
      ]),
    ).toEqual([
      expect.objectContaining({ text: "wrapped model prompt", synthetic: true }),
      {
        type: "file",
        mime: "image/png",
        filename: "photo.png",
        url: "file:///tmp/remote-im/photo.png",
      },
      expect.objectContaining({ text: "来自 IM 的图片", ignored: true }),
    ])
  })
})
