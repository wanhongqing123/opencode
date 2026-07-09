import net from "node:net"

export type MultiAiCodeImBridge = {
  sendAssistantText(input: {
    text: string
    messageID?: string
    partID?: string
  }): void
  close(): void
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

  const connect = () => {
    if (failed) return undefined
    if (socket && !socket.destroyed) return socket
    socket = net.createConnection({ host: config.host, port: config.port })
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
