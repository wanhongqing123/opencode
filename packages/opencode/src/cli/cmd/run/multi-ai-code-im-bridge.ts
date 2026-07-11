import net from "node:net"

export type MultiAiCodeImBridge = {
  sendAssistantText(input: {
    text: string
    messageID?: string
    partID?: string
  }): void
  sendControlResult(input: {
    requestID: string
    ok: boolean
    text: string
    error?: string
  }): void
  onControlCommand(handler: (command: MultiAiCodeImControlCommand) => void): () => void
  close(): void
}

export type MultiAiCodeImControlCommand =
  | {
      command: "switch_mode"
      mode: "plan" | "build"
    }
  | {
      command: "status"
      requestID: string
    }

type BridgeConfig = {
  host: string
  port: number
  token: string
}

export function createMultiAiCodeImBridge(endpoint?: string): MultiAiCodeImBridge | undefined {
  const config = parseEndpoint(endpoint)
  if (!config) return undefined

  let socket: net.Socket | undefined
  let failed = false
  let buffer = ""
  const controlHandlers = new Set<(command: MultiAiCodeImControlCommand) => void>()

  const emitControlCommand = (command: MultiAiCodeImControlCommand) => {
    for (const handler of controlHandlers) {
      try {
        handler(command)
      } catch {
        // Keep bridge callbacks isolated from each other.
      }
    }
  }

  const connect = () => {
    if (failed) return undefined
    if (socket && !socket.destroyed) return socket
    socket = net.createConnection({ host: config.host, port: config.port })
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket?.write(JSON.stringify({ token: config.token, kind: "control_ready" }) + "\n")
    })
    socket.on("data", (chunk) => {
      buffer += String(chunk)
      for (;;) {
        const lineEnd = buffer.indexOf("\n")
        if (lineEnd < 0) break
        const raw = buffer.slice(0, lineEnd).trim()
        buffer = buffer.slice(lineEnd + 1)
        if (!raw) continue
        try {
          const payload = JSON.parse(raw) as {
            token?: unknown
            kind?: unknown
            command?: unknown
            mode?: unknown
            requestId?: unknown
          }
          if (payload.token !== config.token || payload.kind !== "control") continue
          if (payload.command === "switch_mode") {
            if (payload.mode !== "plan" && payload.mode !== "build") continue
            emitControlCommand({
              command: "switch_mode",
              mode: payload.mode,
            })
            continue
          }
          if (payload.command === "status") {
            if (typeof payload.requestId !== "string" || !payload.requestId.trim()) continue
            emitControlCommand({
              command: "status",
              requestID: payload.requestId,
            })
          }
        } catch {
          // Ignore malformed host control payloads.
        }
      }
    })
    socket.on("error", () => {
      failed = true
      socket?.destroy()
      socket = undefined
    })
    return socket
  }

  return {
    sendAssistantText(input) {
      if (!input.text) return
      const writer = connect()
      if (!writer) return
      const payload = {
        token: config.token,
        kind: "assistant_text",
        text: input.text,
        messageId: input.messageID,
        partId: input.partID,
      }
      writer.write(JSON.stringify(payload) + "\n")
    },
    sendControlResult(input) {
      const writer = connect()
      if (!writer) return
      const payload = {
        token: config.token,
        kind: "control_result",
        requestId: input.requestID,
        ok: input.ok,
        text: input.text,
        error: input.error,
      }
      writer.write(JSON.stringify(payload) + "\n")
    },
    onControlCommand(handler) {
      controlHandlers.add(handler)
      connect()
      return () => {
        controlHandlers.delete(handler)
      }
    },
    close() {
      socket?.destroy()
      socket = undefined
    },
  }
}

function parseEndpoint(endpoint?: string): BridgeConfig | undefined {
  if (!endpoint) return undefined
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "tcp:") return undefined
    const token = url.searchParams.get("token")
    const port = Number(url.port)
    if (!url.hostname || !Number.isInteger(port) || port <= 0 || !token) return undefined
    return { host: url.hostname, port, token }
  } catch {
    return undefined
  }
}
