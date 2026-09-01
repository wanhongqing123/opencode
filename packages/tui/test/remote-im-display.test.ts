import { describe, expect, test } from "bun:test"
import { remoteImPromptParts } from "../src/util/remote-im-display"

describe("remote IM display text", () => {
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

  test("keeps route-less machine input free of human reply authority", () => {
    expect(remoteImPromptParts("machine model input", "来自另一台 AICLI")[0]).toEqual(
      expect.objectContaining({
        metadata: {
          kind: "remote_im_model_prompt",
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
