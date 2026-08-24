import net from "node:net"
import path from "node:path"

export type MultiAiCodeImAttachment = {
  type: "image"
  localPath: string
  mimeType: string
  fileName?: string
}

export type MultiAiCodeImInputOrigin = "remote-im" | "tui"

export type MultiAiCodeImUserMessageOrigin = "remote-im" | "remote-im-machine" | "local"

export type MultiAiCodeImBridge = {
  setInputOrigin?(origin: MultiAiCodeImInputOrigin, sessionID?: string): void
  isRemoteImForwardingActive?(): boolean
  remoteImForwardingSessionID?(): string | undefined
  sendTaskStarted?(input?: { replyID?: string; taskID?: string }): void
  sendTaskActivity?(input?: { taskID?: string }): void
  registerRemoteTask?(input: { replyID?: string; taskID: string }): void
  remoteTaskID?(replyID: string): string | undefined
  forgetRemoteTask?(replyID: string): void
  sendAssistantText(input: { text: string; taskID?: string; messageID?: string; partID?: string }): void
  sendAssistantFinal(input: {
    text: string
    replyID?: string
    taskID?: string
    messageID?: string
    partID?: string
  }): void
  sendTurnError(input: { text: string; replyID?: string; taskID?: string; messageID?: string }): void
  sendControlResult(input: { requestID: string; ok: boolean; text: string; error?: string }): void
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
  | {
      command: "goal"
      requestID: string
      goal?: string
    }
  | {
      command: "btw"
      requestID: string
      task: string
      replyID?: string
    }
  | {
      command: "submit_user_message"
      requestID: string
      text: string
      displayText: string
      attachments: MultiAiCodeImAttachment[]
      inputOrigin: MultiAiCodeImUserMessageOrigin
      replyID?: string
      taskID?: string
    }
  | {
      command: "interrupt"
      requestID: string
    }
  | {
      command: "compact"
      requestID: string
    }
  | {
      command: "clear"
      requestID: string
    }
  | {
      command: "theme"
      mode: "light" | "dark"
      requestID?: string
    }

type BridgeConfig = {
  host: string
  port: number
  token: string
}

type ControlPayload = {
  token?: unknown
  kind?: unknown
  command?: unknown
  mode?: unknown
  model?: unknown
  goal?: unknown
  task?: unknown
  text?: unknown
  displayText?: unknown
  attachments?: unknown
  inputOrigin?: unknown
  replyId?: unknown
  taskId?: unknown
  requestId?: unknown
}

function parseAttachments(value: unknown): MultiAiCodeImAttachment[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 4).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const attachment = item as Record<string, unknown>
    if (attachment.type !== "image") return []
    if (typeof attachment.localPath !== "string" || !path.isAbsolute(attachment.localPath)) return []
    if (typeof attachment.mimeType !== "string" || !attachment.mimeType.startsWith("image/")) return []
    return [
      {
        type: "image" as const,
        localPath: attachment.localPath,
        mimeType: attachment.mimeType,
        ...(typeof attachment.fileName === "string" && attachment.fileName.trim()
          ? { fileName: attachment.fileName.trim() }
          : {}),
      },
    ]
  })
}

export function parseMultiAiCodeImControlPayload(
  payload: ControlPayload,
  token: string,
): MultiAiCodeImControlCommand | undefined {
  if (payload.token !== token || payload.kind !== "control") return undefined
  if (payload.command === "switch_mode") {
    if (payload.mode !== "plan" && payload.mode !== "build") return undefined
    return {
      command: "switch_mode",
      mode: payload.mode,
      ...(typeof payload.requestId === "string" && payload.requestId.trim() ? { requestID: payload.requestId } : {}),
    }
  }

  if (
    payload.command === "status" ||
    payload.command === "interrupt" ||
    payload.command === "compact" ||
    payload.command === "clear"
  ) {
    if (typeof payload.requestId !== "string" || !payload.requestId.trim()) return undefined
    return {
      command: payload.command,
      requestID: payload.requestId,
    }
  }

  if (payload.command === "model") {
    if (typeof payload.requestId !== "string" || !payload.requestId.trim()) return undefined
    return {
      command: "model",
      requestID: payload.requestId,
      ...(typeof payload.model === "string" && payload.model.trim() ? { model: payload.model.trim() } : {}),
    }
  }

  if (payload.command === "goal") {
    if (typeof payload.requestId !== "string" || !payload.requestId.trim()) return undefined
    return {
      command: "goal",
      requestID: payload.requestId,
      ...(typeof payload.goal === "string" && payload.goal.trim() ? { goal: payload.goal.trim() } : {}),
    }
  }

  if (payload.command === "btw") {
    if (typeof payload.requestId !== "string" || !payload.requestId.trim()) return undefined
    return {
      command: "btw",
      requestID: payload.requestId,
      task: typeof payload.task === "string" ? payload.task.trim() : "",
      ...(typeof payload.replyId === "string" && payload.replyId.trim() ? { replyID: payload.replyId.trim() } : {}),
    }
  }

  if (payload.command === "submit_user_message") {
    if (typeof payload.requestId !== "string" || !payload.requestId.trim()) return undefined
    if (typeof payload.text !== "string" || !payload.text.trim()) return undefined
    const inputOrigin =
      payload.inputOrigin === "remote-im" ||
      payload.inputOrigin === "remote-im-machine" ||
      payload.inputOrigin === "local"
        ? payload.inputOrigin
        : typeof payload.replyId === "string" || typeof payload.taskId === "string"
          ? "remote-im"
          : "local"
    return {
      command: "submit_user_message",
      requestID: payload.requestId,
      text: payload.text,
      displayText:
        typeof payload.displayText === "string" && payload.displayText.trim() ? payload.displayText : payload.text,
      attachments: parseAttachments(payload.attachments),
      inputOrigin,
      // Machine collaboration is deliberately route-less. Even malformed or
      // stale host input cannot claim the active human reply/approval identity.
      ...(inputOrigin !== "remote-im-machine" && typeof payload.replyId === "string" && payload.replyId.trim()
        ? { replyID: payload.replyId.trim() }
        : {}),
      ...(inputOrigin !== "remote-im-machine" && typeof payload.taskId === "string" && payload.taskId.trim()
        ? { taskID: payload.taskId.trim() }
        : {}),
    }
  }

  // 运行时明暗切换：宿主 app 切主题时下发，绝对值（非 toggle），无需重启会话。
  if (payload.command === "theme") {
    if (payload.mode !== "light" && payload.mode !== "dark") return undefined
    return {
      command: "theme",
      mode: payload.mode,
      ...(typeof payload.requestId === "string" && payload.requestId.trim() ? { requestID: payload.requestId } : {}),
    }
  }

  return undefined
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
  let remoteImForwardingActive = false
  let remoteImForwardingSessionID: string | undefined
  const controlHandlers = new Set<(command: MultiAiCodeImControlCommand) => void>()
  const remoteTaskIDs = new Map<string, string>()

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
          const payload = JSON.parse(raw) as ControlPayload
          const command = parseMultiAiCodeImControlPayload(payload, config.token)
          if (command) emitControlCommand(command)
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
  // 数据连接：codex/opencode -> electron 输出（assistant_text + turn_error + control_result），
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

  const sendReliableText = (input: {
    kind: "input_origin" | "task_started" | "task_activity" | "assistant_text" | "assistant_final" | "turn_error"
    text: string
    messageID?: string
    partID?: string
    replyID?: string
    taskID?: string
  }) => {
    if (!input.text) return
    const messageID = input.messageID && input.messageID.trim() ? input.messageID : `opencode-im-${seq++}`
    const payload = {
      token: config.token,
      kind: input.kind,
      text: input.text,
      messageId: messageID,
      partId: input.partID,
      replyId: input.replyID,
      taskId: input.taskID,
    }
    const line = JSON.stringify(payload) + "\n"
    if (pending.size >= MAX_PENDING) {
      const firstKey = pending.keys().next().value
      if (firstKey !== undefined) pending.delete(firstKey)
    }
    pending.set(messageID, { line, sentAt: Date.now() })
    writeData(line)
  }

  return {
    setInputOrigin(origin, sessionID) {
      const active = origin === "remote-im"
      const nextSessionID = active && sessionID ? sessionID : undefined
      const stateChanged = remoteImForwardingActive !== active
      remoteImForwardingSessionID = nextSessionID
      if (!stateChanged) return
      remoteImForwardingActive = active
      sendReliableText({ kind: "input_origin", text: origin })
    },
    isRemoteImForwardingActive() {
      return remoteImForwardingActive
    },
    remoteImForwardingSessionID() {
      return remoteImForwardingSessionID
    },
    registerRemoteTask(input) {
      if (!input.replyID) return
      remoteTaskIDs.delete(input.replyID)
      remoteTaskIDs.set(input.replyID, input.taskID)
      if (remoteTaskIDs.size <= 256) return
      const oldest = remoteTaskIDs.keys().next().value
      if (oldest !== undefined) remoteTaskIDs.delete(oldest)
    },
    remoteTaskID(replyID) {
      return remoteTaskIDs.get(replyID)
    },
    forgetRemoteTask(replyID) {
      remoteTaskIDs.delete(replyID)
    },
    sendTaskStarted(input = {}) {
      sendReliableText({ kind: "task_started", text: "running", ...input })
    },
    sendTaskActivity(input = {}) {
      sendReliableText({ kind: "task_activity", text: "active", ...input })
    },
    sendAssistantText(input) {
      sendReliableText({ kind: "assistant_text", ...input })
    },
    sendAssistantFinal(input) {
      sendReliableText({ kind: "assistant_final", ...input })
    },
    sendTurnError(input) {
      sendReliableText({ kind: "turn_error", ...input })
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
      remoteTaskIDs.clear()
      remoteImForwardingSessionID = undefined
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
