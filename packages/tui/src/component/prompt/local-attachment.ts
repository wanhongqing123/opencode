import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export type LocalFiles = Readonly<{
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  mime(path: string): Promise<string>
}>

export type LocalAttachment =
  | Readonly<{ type: "text"; mime: "image/svg+xml"; content: string }>
  | Readonly<{ type: "binary"; mime: string; content: Uint8Array }>

export function readLocalAttachment(file: string) {
  return readLocalAttachmentWith(
    {
      readText: (value) => readFile(value, "utf8"),
      readBytes: (value) => readFile(value),
      mime: async (value) => mimeTypes[path.extname(value).toLowerCase()] ?? "application/octet-stream",
    },
    file,
  )
}

const mimeTypes: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
}

const attachmentExtension = "(?:avif|gif|jpe?g|pdf|png|svg|webp)"

export type LeadingLocalAttachmentPath = Readonly<{
  path: string
  start: number
  end: number
  rest: string
}>

function normalizeLocalPath(value: string, platform: string) {
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value)
    } catch {
      return value
    }
  }
  if (platform === "win32") return value
  return value.replace(/\\(.)/g, "$1")
}

function isAbsoluteLocalPath(value: string, platform: string) {
  if (value.startsWith("file://")) return true
  if (platform === "win32") return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)
  return value.startsWith("/")
}

/**
 * Detect the absolute image/PDF path that Multi-AI Code writes into the TUI
 * when a clipboard image cannot be delivered as a terminal paste event.
 */
export function extractLeadingLocalAttachmentPath(
  input: string,
  platform: string,
): LeadingLocalAttachmentPath | undefined {
  const start = input.search(/\S/)
  if (start < 0) return
  const value = input.slice(start)

  let rawPath: string | undefined
  let consumed = 0
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const closing = value.indexOf(quote, 1)
    if (closing > 1) {
      rawPath = value.slice(1, closing)
      consumed = closing + 1
    }
  } else {
    const match = value.match(new RegExp(`^(.+?\\.${attachmentExtension})(?=\\s|$)`, "i"))
    rawPath = match?.[1]
    consumed = rawPath?.length ?? 0
  }

  if (!rawPath || !new RegExp(`\\.${attachmentExtension}$`, "i").test(rawPath)) return
  const normalized = normalizeLocalPath(rawPath, platform)
  if (!isAbsoluteLocalPath(normalized, platform)) return

  return {
    path: normalized,
    start,
    end: start + consumed,
    rest: input.slice(start + consumed).trimStart(),
  }
}

export async function readLocalAttachmentWith(files: LocalFiles, path: string): Promise<LocalAttachment | undefined> {
  const mime = await files.mime(path).catch(() => undefined)
  if (!mime) return
  if (mime === "image/svg+xml") {
    const content = await files.readText(path).catch(() => undefined)
    if (!content) return
    return { type: "text", mime, content }
  }
  if (!mime.startsWith("image/") && mime !== "application/pdf") return
  const content = await files.readBytes(path).catch(() => undefined)
  if (!content) return
  return { type: "binary", mime, content }
}
