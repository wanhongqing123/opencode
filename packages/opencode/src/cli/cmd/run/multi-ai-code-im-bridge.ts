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
  | {
      command: "model"
      requestID: string
      model?: string
    }

type BridgeConfig = {
  host: string
  port: number
  token: string
}

// 数据连接：assistant_text 发出后若在此窗口内没等到宿主回 ack，就判定这条连接
// 半死（比如宿主侧已关但本地 write() 仍"成功"写进黑洞），重连并补发。这正是修
// 复"回传出现后一直丢、必须重启 AICLI 才恢复"的粘滞故障的关键。
const ACK_TIMEOUT_MS = 1500
const WATCHDOG_TICK_MS = 500
const MAX_RESEND = 8
const MAX_PENDING = 256

export function createMultiAiCodeImBridge(endpoint?: string): MultiAiCodeImBridge | undefined {
  const config = parseEndpoint(endpoint)
  if (!config) return undefined

  let closed = false
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

  // ---------------------------------------------------------------------------
  // 控制连接：electron -> codex/opencode 命令（switch_mode/status/model）。断线固定
  // 退避重连，与 codex 侧对齐。宿主靠 control_ready 把这条连接识别为控制通道。
  // ---------------------------------------------------------------------------
  let controlSocket: net.Socket | undefined
  let controlBuffer = ""
  let controlReconnectTimer: ReturnType<typeof setTimeout> | undefined

  const scheduleControlReconnect = () => {
    if (closed || controlReconnectTimer) return
    controlReconnectTimer = setTimeout(() => {
      controlReconnectTimer = undefined
      connectControl()
    }, 3000)
    if (typeof controlReconnectTimer.unref === "function") controlReconnectTimer.unref()
  }

  const connectControl = () => {
    if (closed) return
    if (controlSocket && !controlSocket.destroyed) return
    controlBuffer = ""
    const socket = net.createConnection({ host: config.host, port: config.port })
    socket.setEncoding("utf8")
    socket.on("connect", () => {
      socket.write(JSON.stringify({ token: config.token, kind: "control_ready" }) + "\n")
    })
    socket.on("data", (chunk) => {
      controlBuffer += String(chunk)
      for (;;) {
        const lineEnd = controlBuffer.indexOf("\n")
        if (lineEnd < 0) break
        const raw = controlBuffer.slice(0, lineEnd).trim()
        controlBuffer = controlBuffer.slice(lineEnd + 1)
        if (!raw) continue
        try {
          const payload = JSON.parse(raw) as {
            token?: unknown
            kind?: unknown
            command?: unknown
            mode?: unknown
            model?: unknown
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
            continue
          }
          if (payload.command === "model") {
            if (typeof payload.requestId !== "string" || !payload.requestId.trim()) continue
            emitControlCommand({
              command: "model",
              requestID: payload.requestId,
              ...(typeof payload.model === "string" && payload.model.trim()
                ? { model: payload.model.trim() }
                : {}),
            })
          }
        } catch {
          // Ignore malformed host control payloads.
        }
      }
    })
    socket.on("error", () => {
      socket.destroy()
      if (controlSocket === socket) controlSocket = undefined
      scheduleControlReconnect()
    })
    socket.on("close", () => {
      if (controlSocket === socket) controlSocket = undefined
      scheduleControlReconnect()
    })
    controlSocket = socket
  }

  // ---------------------------------------------------------------------------
  // 数据连接：codex/opencode -> electron 输出（assistant_text + control_result），
  // 并读回 electron 的 ack。断线/半死均自愈：error/close 重连；assistant_text 超时
  // 无 ack 则强制重连并补发未 ack 的消息。
  // ---------------------------------------------------------------------------
  let dataSocket: net.Socket | undefined
  let dataBuffer = ""
  let dataReconnectTimer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  const pending = new Map<string, { line: string; sentAt: number }>()

  const scheduleDataReconnect = () => {
    if (closed || dataReconnectTimer) return
    dataReconnectTimer = setTimeout(() => {
      dataReconnectTimer = undefined
      connectData()
    }, 3000)
    if (typeof dataReconnectTimer.unref === "function") dataReconnectTimer.unref()
  }

  const connectData = (): net.Socket | undefined => {
    if (closed) return undefined
    if (dataSocket && !dataSocket.destroyed) return dataSocket
    dataBuffer = ""
    const socket = net.createConnection({ host: config.host, port: config.port })
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      dataBuffer += String(chunk)
      for (;;) {
        const lineEnd = dataBuffer.indexOf("\n")
        if (lineEnd < 0) break
        const raw = dataBuffer.slice(0, lineEnd).trim()
        dataBuffer = dataBuffer.slice(lineEnd + 1)
        if (!raw) continue
        try {
          const payload = JSON.parse(raw) as { token?: unknown; kind?: unknown; messageId?: unknown }
          if (payload.token !== config.token) continue
          if (payload.kind === "ack" && typeof payload.messageId === "string") {
            pending.delete(payload.messageId)
          }
        } catch {
          // Ignore malformed host ack payloads.
        }
      }
    })
    socket.on("error", () => {
      socket.destroy()
      if (dataSocket === socket) dataSocket = undefined
      scheduleDataReconnect()
    })
    socket.on("close", () => {
      if (dataSocket === socket) dataSocket = undefined
      scheduleDataReconnect()
    })
    dataSocket = socket
    return socket
  }

  const writeData = (line: string) => {
    const writer = connectData()
    if (!writer) return
    writer.write(line)
  }

  const watchdog = setInterval(() => {
    if (closed || pending.size === 0) return
    const oldest = pending.values().next().value
    if (!oldest) return
    const now = Date.now()
    if (now - oldest.sentAt < ACK_TIMEOUT_MS) return
    // Stale: the data socket is not delivering. Force a reconnect and resend the
    // oldest un-acked messages (bounded, to avoid a resend storm).
    if (dataSocket) {
      dataSocket.destroy()
      dataSocket = undefined
    }
    let resent = 0
    for (const entry of pending.values()) {
      if (resent >= MAX_RESEND) break
      writeData(entry.line)
      entry.sentAt = now
      resent += 1
    }
  }, WATCHDOG_TICK_MS)
  if (typeof watchdog.unref === "function") watchdog.unref()

  return {
    sendAssistantText(input) {
      if (!input.text) return
      const messageID =
        input.messageID && input.messageID.trim() ? input.messageID : `opencode-im-${seq++}`
      const payload = {
        token: config.token,
        kind: "assistant_text",
        text: input.text,
        messageId: messageID,
        partId: input.partID,
      }
      const line = JSON.stringify(payload) + "\n"
      if (pending.size >= MAX_PENDING) {
        const firstKey = pending.keys().next().value
        if (firstKey !== undefined) pending.delete(firstKey)
      }
      pending.set(messageID, { line, sentAt: Date.now() })
      writeData(line)
    },
    sendControlResult(input) {
      const payload = {
        token: config.token,
        kind: "control_result",
        requestId: input.requestID,
        ok: input.ok,
        text: input.text,
        error: input.error,
      }
      // control_result 是命令 RPC 的响应，由宿主的请求超时兜底，不需要逐条 ack，
      // 只是搭同一条自愈的数据连接发出。
      writeData(JSON.stringify(payload) + "\n")
    },
    onControlCommand(handler) {
      controlHandlers.add(handler)
      connectControl()
      return () => {
        controlHandlers.delete(handler)
      }
    },
    close() {
      closed = true
      clearInterval(watchdog)
      if (controlReconnectTimer) {
        clearTimeout(controlReconnectTimer)
        controlReconnectTimer = undefined
      }
      if (dataReconnectTimer) {
        clearTimeout(dataReconnectTimer)
        dataReconnectTimer = undefined
      }
      controlSocket?.destroy()
      controlSocket = undefined
      dataSocket?.destroy()
      dataSocket = undefined
      pending.clear()
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
