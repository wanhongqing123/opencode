import { describe, expect, test } from "bun:test"
import { extractLeadingLocalAttachmentPath, readLocalAttachmentWith } from "../../src/component/prompt/local-attachment"
import type { LocalFiles } from "../../src/component/prompt/local-attachment"

function files(input: { mime: string; text?: string; bytes?: Uint8Array }): LocalFiles {
  return {
    mime: async () => input.mime,
    readText: async () => input.text ?? "",
    readBytes: async () => input.bytes ?? new Uint8Array(),
  }
}

describe("prompt local attachments", () => {
  test("extracts a Windows image path followed by a caption", () => {
    const file = String.raw`C:\Users\tester\AppData\Local\Temp\multi-ai-code\pasted\paste-123.png`
    expect(extractLeadingLocalAttachmentPath(`${file} 看下这个图片的内容`, "win32")).toEqual({
      path: file,
      start: 0,
      end: file.length,
      rest: "看下这个图片的内容",
    })
  })

  test("extracts quoted paths with spaces", () => {
    expect(extractLeadingLocalAttachmentPath(`  "/tmp/My Image.webp" describe it`, "darwin")).toEqual({
      path: "/tmp/My Image.webp",
      start: 2,
      end: 22,
      rest: "describe it",
    })
  })

  test("does not treat relative paths and web URLs as local attachments", () => {
    expect(extractLeadingLocalAttachmentPath("screenshots/image.png inspect", "darwin")).toBeUndefined()
    expect(extractLeadingLocalAttachmentPath("https://example.com/image.png inspect", "darwin")).toBeUndefined()
  })

  test("reads SVG attachments as text", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "image/svg+xml", text: "<svg />" }), "/tmp/image.svg")).toEqual({
      type: "text",
      mime: "image/svg+xml",
      content: "<svg />",
    })
  })

  test("reads image and PDF attachments as bytes", async () => {
    const content = new Uint8Array([1, 2, 3])
    expect(await readLocalAttachmentWith(files({ mime: "application/pdf", bytes: content }), "/tmp/file.pdf")).toEqual({
      type: "binary",
      mime: "application/pdf",
      content,
    })
  })

  test("ignores unsupported and unreadable local files", async () => {
    expect(await readLocalAttachmentWith(files({ mime: "text/plain" }), "/tmp/file.txt")).toBeUndefined()
    expect(
      await readLocalAttachmentWith(
        {
          ...files({ mime: "image/png" }),
          readBytes: async () => Promise.reject(new Error("missing")),
        },
        "/tmp/missing.png",
      ),
    ).toBeUndefined()
  })
})
