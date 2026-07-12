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
      requestID?: string
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
  let closed = false
  let buffer = ""
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
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

  // 断线后按固定退避重连，而不是首个错误就永久失效：瞬时 TCP 抖动不能让
  // 本会话余下时间的 IM 回传与控制命令全部失联。close() 之后不再重连。
  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, 3000)
    if (typeof reconnectTimer.unref === "function") reconnectTimer.unref()
  }

  const connect = () => {
    if (closed) return undefined
    if (socket && !socket.destroyed) return socket
    buffer = ""
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
              ...(typeof payload.requestId === "string" && payload.requestId.trim()
                ? { requestID: payload.requestId }
                : {}),
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
      socket?.destroy()
      socket = undefined
      scheduleReconnect()
    })
    socket.on("close", () => {
      socket = undefined
      scheduleReconnect()
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
      closed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
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
