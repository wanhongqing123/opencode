function isOpenMarker(line: string) {
  const value = line.trim()
  return value === "<remote-im-reply>" || /^<remote-im-reply id="[A-Za-z0-9_-]+">$/.test(value)
}

function isCloseMarker(line: string) {
  const value = line.trim()
  return value === "</remote-im-reply>" || /^<\/remote-im-reply id="[A-Za-z0-9_-]+">$/.test(value)
}

export function visibleRemoteImReplyText(text: string): string {
  let foundOpen = false
  let inside = false
  let visible = ""

  for (const segment of text.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!segment) continue
    const line = segment.endsWith("\n") ? segment.slice(0, -1) : segment
    if (isOpenMarker(line)) {
      foundOpen = true
      inside = true
      continue
    }
    if (inside && isCloseMarker(line)) break
    if (inside) visible += segment
  }

  if (foundOpen) return visible

  const candidate = text.trimStart()
  if (!candidate.includes("\n") && "<remote-im-reply".startsWith(candidate)) return ""
  return text
}
