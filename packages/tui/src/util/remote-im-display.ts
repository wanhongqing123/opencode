const OPEN_PREFIX = "<remote-im-reply"
const CLOSE_PREFIX = "</remote-im-reply"

function openMarkerBodyStart(marker: string) {
  const suffix = marker.slice(OPEN_PREFIX.length)
  if (suffix.startsWith(">")) return OPEN_PREFIX.length + 1

  const idPrefix = ' id="'
  if (!suffix.startsWith(idPrefix)) return undefined
  const withID = suffix.slice(idPrefix.length)
  const exactEnd = withID.indexOf('\">')
  if (exactEnd >= 0) return OPEN_PREFIX.length + idPrefix.length + exactEnd + 2

  const generated = /^rim-[0-9a-fA-F]{16}/.exec(withID)?.[0]
  if (!generated) return undefined
  let bodyStart = OPEN_PREFIX.length + idPrefix.length + generated.length
  if (marker.slice(bodyStart).startsWith('"')) bodyStart++
  if (marker.slice(bodyStart).startsWith(">")) bodyStart++
  return bodyStart
}

function replyBodyEnd(body: string) {
  const close = body.indexOf(CLOSE_PREFIX)
  if (close >= 0) return close
  for (let length = Math.min(body.length, CLOSE_PREFIX.length); length > 0; length--) {
    if (body.endsWith(CLOSE_PREFIX.slice(0, length))) return body.length - length
  }
  return body.length
}

export function visibleRemoteImReplyText(text: string): string {
  const open = text.indexOf(OPEN_PREFIX)
  if (open >= 0) {
    const marker = text.slice(open)
    const bodyStart = openMarkerBodyStart(marker)
    if (bodyStart === undefined) return ""
    const body = marker.slice(bodyStart).replace(/^\r?\n/, "")
    return body.slice(0, replyBodyEnd(body))
  }

  const candidate = text.trimStart()
  if (!candidate.includes("\n") && OPEN_PREFIX.startsWith(candidate)) return ""
  return text
}

export function remoteImPromptParts(text: string, displayText: string) {
  return [
    {
      type: "text" as const,
      text,
      synthetic: true,
      metadata: { kind: "remote_im_model_prompt" },
    },
    {
      type: "text" as const,
      text: displayText,
      ignored: true,
      metadata: { kind: "remote_im_display_text" },
    },
  ]
}
