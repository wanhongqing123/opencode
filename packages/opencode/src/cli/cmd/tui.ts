import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "../tui/worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { createOpencodeClient, type GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "@opencode-ai/tui/context/sdk"
import { writeHeapSnapshot } from "v8"
import { ServerAuth } from "@/server/auth"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"
import { createMultiAiCodeImBridge, type MultiAiCodeImBridge } from "./run/multi-ai-code-im-bridge"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>
const SOURCE_REMOTE_ROUTE_TTL_MS = 2 * 60 * 60 * 1000

type MultiAiCodeImTuiEventHandlerOptions = {
  sourceRouteTtlMs?: number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

function remoteImReplyID(text: string) {
  return /<remote-im-reply id="([A-Za-z0-9_-]{1,80})">/.exec(text)?.[1]
}

export function createMultiAiCodeImTuiEventHandler(
  bridge?: MultiAiCodeImBridge,
  options: MultiAiCodeImTuiEventHandlerOptions = {},
) {
  if (!bridge) return (_event: GlobalEvent) => {}
  if (bridge.setInputOrigin && bridge.isRemoteImForwardingActive) {
    return createSourceRoutedMultiAiCodeImTuiEventHandler(bridge, options)
  }
  return createLegacyMultiAiCodeImTuiEventHandler(bridge)
}

function createSourceRoutedMultiAiCodeImTuiEventHandler(
  bridge: MultiAiCodeImBridge,
  options: MultiAiCodeImTuiEventHandlerOptions,
) {
  type MessageState = {
    id: string
    sessionID: string
    role: "assistant" | "user"
    parentID?: string
    completed: boolean
    sequence: number
  }
  type TextPartState = {
    id: string
    messageID: string
    text: string
    completed: boolean
    sequence: number
    metadata?: Record<string, unknown>
  }
  type RemoteRouteState = {
    sessionID: string
    replyID?: string
    taskID?: string
    userMessageIDs: Set<string>
    terminalID: string
    executionStarted: boolean
    announced: boolean
    mayStartOnBusy: boolean
    key?: string
    expiryTimer: ReturnType<typeof setTimeout>
  }

  const messages = new Map<string, MessageState>()
  const textPartsByMessage = new Map<string, Map<string, TextPartState>>()
  const candidatesBySession = new Map<string, Set<string>>()
  const forwardedAssistantParts = new Set<string>()
  const forwardedAssistantPartOrder: string[] = []
  const forwardedTerminals = new Set<string>()
  const forwardedTerminalOrder: string[] = []
  const completedRemoteRoutes = new Set<string>()
  const completedRemoteRouteOrder: string[] = []
  const routesBySession = new Map<string, RemoteRouteState>()
  const statusBySession = new Map<string, string>()
  let messageSequence = 0
  let partSequence = 0
  let errorSequence = 0
  let routeSequence = 0
  const setTimer = options.setTimer ?? globalThis.setTimeout
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout
  const routeTtlMs = options.sourceRouteTtlMs ?? SOURCE_REMOTE_ROUTE_TTL_MS
  let expireRoute: (sessionID: string, terminalID: string) => void = () => {}

  const routeForSession = (sessionID: string, create = false) => {
    const current = routesBySession.get(sessionID)
    if (
      current?.replyID &&
      current.taskID &&
      bridge.remoteTaskID &&
      bridge.remoteTaskID(current.replyID) !== current.taskID
    ) {
      clearTimer(current.expiryTimer)
      routesBySession.delete(sessionID)
      candidatesBySession.delete(sessionID)
    } else if (current || !create) {
      return current
    }
    if (!create) return undefined
    const terminalID = `${sessionID}:remote-turn:${routeSequence++}`
    const route: RemoteRouteState = {
      sessionID,
      userMessageIDs: new Set(),
      terminalID,
      executionStarted: false,
      announced: false,
      mayStartOnBusy: !["busy", "retry"].includes(statusBySession.get(sessionID) ?? ""),
      expiryTimer: undefined as unknown as ReturnType<typeof setTimeout>,
    }
    route.expiryTimer = setTimer(() => expireRoute(sessionID, terminalID), routeTtlMs)
    if (typeof route.expiryTimer === "object" && route.expiryTimer && "unref" in route.expiryTimer) {
      route.expiryTimer.unref()
    }
    routesBySession.set(sessionID, route)
    return route
  }

  const routeForMessage = (message: MessageState) => {
    const route = routeForSession(message.sessionID)
    if (!route || message.role !== "assistant") return undefined
    if (route.userMessageIDs.size === 0) return undefined
    if (!message.parentID || !route.userMessageIDs.has(message.parentID)) return undefined
    route.executionStarted = true
    return route
  }

  const rememberRemotePrompt = (message: MessageState, part: { metadata?: Record<string, unknown> }) => {
    if (message.role !== "user") return
    const metadata = part.metadata
    if (!metadata || metadata.kind !== "remote_im_model_prompt") return
    const replyID = typeof metadata.remoteImReplyID === "string" ? metadata.remoteImReplyID : undefined
    const taskID =
      typeof metadata.remoteImTaskID === "string"
        ? metadata.remoteImTaskID
        : replyID
          ? bridge.remoteTaskID?.(replyID)
          : undefined
    if (!replyID && !taskID) return
    if (replyID && taskID && bridge.remoteTaskID && bridge.remoteTaskID(replyID) !== taskID) return
    const key = taskID ?? replyID!
    if (completedRemoteRoutes.has(key)) return
    const existing = routeForSession(message.sessionID)
    if (existing?.key && existing.key !== key) {
      expireRoute(message.sessionID, existing.terminalID)
    }
    const route = routeForSession(message.sessionID, true)!
    route.key = key
    route.replyID = replyID
    route.taskID = taskID
    route.userMessageIDs.add(message.id)
    if (["busy", "retry"].includes(statusBySession.get(message.sessionID) ?? "")) {
      // The source queue dispatches only from idle. If the busy event wins the
      // race with persistence of this immutable user part, it belongs to this
      // accepted prompt; no later busy edge is required to finish the route.
      route.executionStarted = true
    }
    bridge.setInputOrigin?.("remote-im", message.sessionID)
    if (!route.announced) {
      route.announced = true
      bridge.sendTaskStarted?.({
        ...(replyID ? { replyID } : {}),
        ...(taskID ? { taskID } : {}),
      })
    }
    for (const candidate of messages.values()) {
      if (candidate.role !== "assistant" || candidate.parentID !== message.id) continue
      rememberCandidate(candidate)
      forwardCompletedParts(candidate)
    }
  }

  const rememberBounded = (set: Set<string>, order: string[], value: string) => {
    if (set.has(value)) return false
    set.add(value)
    order.push(value)
    if (order.length > 512) {
      const oldest = order.shift()
      if (oldest) set.delete(oldest)
    }
    return true
  }

  const completedParts = (messageID: string) =>
    [...(textPartsByMessage.get(messageID)?.values() ?? [])]
      .filter((part) => part.completed && part.text.trim())
      .sort((left, right) => left.sequence - right.sequence)

  const resetPendingSession = (sessionID: string) => {
    candidatesBySession.delete(sessionID)
  }

  const finishRoute = (sessionID: string, route: RemoteRouteState) => {
    if (route.key) rememberBounded(completedRemoteRoutes, completedRemoteRouteOrder, route.key)
    clearTimer(route.expiryTimer)
    routesBySession.delete(sessionID)
    resetPendingSession(sessionID)
    if (route.replyID) bridge.forgetRemoteTask?.(route.replyID)
  }

  expireRoute = (sessionID, terminalID) => {
    const route = routesBySession.get(sessionID)
    if (!route || route.terminalID !== terminalID) return
    const messageID = `${terminalID}:expired`
    if (rememberBounded(forwardedTerminals, forwardedTerminalOrder, messageID)) {
      bridge.sendTurnError({
        text: "OpenCode remote turn expired before producing a final response.",
        replyID: route.replyID,
        taskID: route.taskID,
        messageID,
      })
    }
    finishRoute(sessionID, route)
  }

  const rememberCandidate = (message: MessageState) => {
    if (!routeForMessage(message)) return
    let candidates = candidatesBySession.get(message.sessionID)
    if (!candidates) {
      candidates = new Set()
      candidatesBySession.set(message.sessionID, candidates)
    }
    candidates.add(message.id)
  }

  const forwardCompletedParts = (message: MessageState) => {
    const route = routeForMessage(message)
    if (!route) return
    for (const part of completedParts(message.id)) {
      const identity = `${message.id}:${part.id}`
      if (!rememberBounded(forwardedAssistantParts, forwardedAssistantPartOrder, identity)) continue
      rememberCandidate(message)
      bridge.sendAssistantText({
        text: part.text,
        taskID: route.taskID,
        messageID: identity,
        partID: part.id,
      })
    }
  }

  const finishSession = (sessionID: string) => {
    const route = routeForSession(sessionID)
    if (!route || !route.executionStarted) return

    const candidates = [...(candidatesBySession.get(sessionID) ?? [])]
      .map((messageID) => messages.get(messageID))
      .filter((message): message is MessageState => message !== undefined)
      .sort((left, right) => left.sequence - right.sequence)
    const finalMessage = candidates.findLast((message) => completedParts(message.id).length > 0)
    if (!finalMessage) {
      const terminalID = `${route.terminalID}:empty`
      if (rememberBounded(forwardedTerminals, forwardedTerminalOrder, terminalID)) {
        bridge.sendTurnError({
          text: "OpenCode turn completed without a final assistant response.",
          replyID: route.replyID,
          taskID: route.taskID,
          messageID: terminalID,
        })
      }
      finishRoute(sessionID, route)
      return
    }

    const parts = completedParts(finalMessage.id)
    const terminalID = `${finalMessage.id}:final`
    if (rememberBounded(forwardedTerminals, forwardedTerminalOrder, terminalID)) {
      bridge.sendAssistantFinal({
        text: parts.map((part) => part.text).join("\n"),
        replyID: route.replyID,
        taskID: route.taskID,
        messageID: terminalID,
        partID: parts.at(-1)?.id,
      })
    }
    finishRoute(sessionID, route)
  }

  return (event: GlobalEvent) => {
    const payload = event.payload

    if (payload.type === "session.error") {
      const sessionID = payload.properties.sessionID
      if (!sessionID) return
      const route = routeForSession(sessionID)
      if (!route) return
      const error = payload.properties.error
      if (!error) return
      if (error.name === "MessageAbortedError") {
        const terminalID = `${route.terminalID}:aborted`
        if (rememberBounded(forwardedTerminals, forwardedTerminalOrder, terminalID)) {
          bridge.sendTurnError({
            text: "OpenCode turn was interrupted.",
            replyID: route.replyID,
            taskID: route.taskID,
            messageID: terminalID,
          })
        }
        finishRoute(sessionID, route)
        return
      }
      const data = error.data
      const text =
        data && typeof data === "object" && "message" in data && typeof data.message === "string"
          ? data.message
          : error.name
      const terminalID = `${sessionID}:error:${errorSequence++}`
      if (rememberBounded(forwardedTerminals, forwardedTerminalOrder, terminalID)) {
        bridge.sendTurnError({
          text,
          replyID: route.replyID,
          taskID: route.taskID,
          messageID: terminalID,
        })
      }
      finishRoute(sessionID, route)
      return
    }

    if (payload.type === "session.status") {
      const sessionID = payload.properties.sessionID
      const status = payload.properties.status.type
      statusBySession.set(sessionID, status)
      if (status === "busy" || status === "retry") {
        const route = routeForSession(sessionID)
        if (!route) return
        if (!route.mayStartOnBusy) return
        route.executionStarted = true
        bridge.sendTaskActivity?.({ taskID: route.taskID })
        return
      }
      if (status === "idle") {
        const route = routeForSession(sessionID)
        if (route && !route.executionStarted) {
          route.mayStartOnBusy = true
          return
        }
        finishSession(sessionID)
      }
      return
    }

    if (payload.type === "session.idle") {
      const sessionID = payload.properties.sessionID
      statusBySession.set(sessionID, "idle")
      const route = routeForSession(sessionID)
      if (route && !route.executionStarted) {
        route.mayStartOnBusy = true
        return
      }
      finishSession(sessionID)
      return
    }

    if (payload.type === "message.updated") {
      const info = payload.properties.info
      const current = messages.get(info.id)
      const message: MessageState = {
        id: info.id,
        sessionID: payload.properties.sessionID,
        role: info.role,
        parentID: info.role === "assistant" ? info.parentID : undefined,
        completed: current?.completed === true || (info.role === "assistant" && info.time?.completed !== undefined),
        sequence: current?.sequence ?? messageSequence++,
      }
      messages.set(info.id, message)
      if (message.role === "user") {
        for (const part of textPartsByMessage.get(message.id)?.values() ?? []) {
          rememberRemotePrompt(message, part)
        }
      }
      rememberCandidate(message)
      forwardCompletedParts(message)
      return
    }

    if (payload.type !== "message.part.updated") return
    const part = payload.properties.part
    if (part.type !== "text") return
    let parts = textPartsByMessage.get(part.messageID)
    if (!parts) {
      parts = new Map()
      textPartsByMessage.set(part.messageID, parts)
    }
    const current = parts.get(part.id)
    parts.set(part.id, {
      id: part.id,
      messageID: part.messageID,
      text: part.text,
      completed: current?.completed === true || part.time?.end !== undefined,
      sequence: current?.sequence ?? partSequence++,
      metadata: part.metadata ?? current?.metadata,
    })
    const message = messages.get(part.messageID)
    if (!message) return
    rememberRemotePrompt(message, part)
    rememberCandidate(message)
    forwardCompletedParts(message)
  }
}

function createLegacyMultiAiCodeImTuiEventHandler(bridge: MultiAiCodeImBridge) {
  type MessageState = {
    id: string
    sessionID: string
    role: "assistant" | "user"
    parentID?: string
    completed: boolean
    sequence: number
  }
  type TextPartState = {
    id: string
    messageID: string
    text: string
    completed: boolean
    sequence: number
  }
  type PendingSessionTermination = {
    userMessageID?: string
    replyID?: string
    error?: string
  }

  const messages = new Map<string, MessageState>()
  const textPartsByMessage = new Map<string, Map<string, TextPartState>>()
  const remoteReplyByUserMessage = new Map<string, string>()
  const idleEligibleReplyIDs = new Set<string>()
  const pendingSessionTerminations = new Map<string, PendingSessionTermination>()
  const completedReplyIDs = new Set<string>()
  const completedReplyIDOrder: string[] = []
  let messageSequence = 0
  let partSequence = 0
  let errorSequence = 0

  const taskIDForReply = (replyID: string) => bridge.remoteTaskID?.(replyID)

  const rememberCompletedReply = (replyID: string) => {
    if (completedReplyIDs.has(replyID)) return
    completedReplyIDs.add(replyID)
    completedReplyIDOrder.push(replyID)
    if (completedReplyIDOrder.length <= 256) return
    const oldest = completedReplyIDOrder.shift()
    if (oldest) completedReplyIDs.delete(oldest)
  }

  const completedParts = (message: MessageState) =>
    [...(textPartsByMessage.get(message.id)?.values() ?? [])]
      .filter((part) => (part.completed || message.completed) && part.text.trim())
      .sort((a, b) => a.sequence - b.sequence)

  const remoteAssistantMessages = (sessionID: string, userMessageID: string) =>
    [...messages.values()]
      .filter(
        (message) =>
          message.sessionID === sessionID && message.role === "assistant" && message.parentID === userMessageID,
      )
      .sort((a, b) => a.sequence - b.sequence)

  const cleanupExchange = (sessionID: string, userMessageID: string) => {
    const replyID = remoteReplyByUserMessage.get(userMessageID)
    if (replyID) {
      idleEligibleReplyIDs.delete(replyID)
      bridge.forgetRemoteTask?.(replyID)
    }
    remoteReplyByUserMessage.delete(userMessageID)
    textPartsByMessage.delete(userMessageID)
    messages.delete(userMessageID)
    for (const message of remoteAssistantMessages(sessionID, userMessageID)) {
      textPartsByMessage.delete(message.id)
      messages.delete(message.id)
    }
  }

  const activeExchanges = (sessionID: string) =>
    [...remoteReplyByUserMessage.entries()]
      .map(([userMessageID, replyID]) => {
        const user = messages.get(userMessageID)
        if (!user || user.sessionID !== sessionID || completedReplyIDs.has(replyID)) return undefined
        const assistants = remoteAssistantMessages(sessionID, userMessageID)
        return { userMessageID, replyID, assistants, userSequence: user.sequence }
      })
      .filter((exchange): exchange is NonNullable<typeof exchange> => exchange !== undefined)
      .sort((a, b) => a.userSequence - b.userSequence)

  const forwardFinalAssistantText = (sessionID: string) => {
    for (const exchange of activeExchanges(sessionID)) {
      if (!idleEligibleReplyIDs.has(exchange.replyID)) continue
      const trailingAssistant = exchange.assistants.at(-1)
      if (trailingAssistant && !trailingAssistant.completed && completedParts(trailingAssistant).length === 0) {
        continue
      }
      const messagesWithText = exchange.assistants
        .map((message) => ({ message, parts: completedParts(message) }))
        .filter((entry) => entry.parts.length > 0)
      if (!messagesWithText.length) continue

      const allText = messagesWithText.flatMap((entry) => entry.parts.map((part) => part.text)).join("\n")
      const selected = allText.includes("<remote-im-reply") ? messagesWithText : [messagesWithText.at(-1)!]
      const text = selected.flatMap((entry) => entry.parts.map((part) => part.text)).join("\n")
      const finalEntry = selected.at(-1)!
      const finalPart = finalEntry.parts.at(-1)!
      const taskID = taskIDForReply(exchange.replyID)
      bridge.sendAssistantFinal({
        text,
        replyID: exchange.replyID,
        ...(taskID ? { taskID } : {}),
        messageID: `${finalEntry.message.id}:final:${exchange.replyID}`,
        partID: finalPart.id,
      })
      rememberCompletedReply(exchange.replyID)
      cleanupExchange(sessionID, exchange.userMessageID)
    }
  }

  const cleanupSessionOrphans = (sessionID: string) => {
    const remoteUsers = new Set(
      [...remoteReplyByUserMessage.keys()].filter((messageID) => messages.get(messageID)?.sessionID === sessionID),
    )
    for (const message of [...messages.values()]) {
      if (message.sessionID !== sessionID) continue
      if (remoteUsers.has(message.id)) continue
      if (message.role === "assistant" && message.parentID && remoteUsers.has(message.parentID)) continue
      messages.delete(message.id)
      textPartsByMessage.delete(message.id)
    }
  }

  const markSessionIdle = (sessionID: string) => {
    for (const exchange of activeExchanges(sessionID)) {
      if (exchange.assistants.length > 0) idleEligibleReplyIDs.add(exchange.replyID)
    }
    const termination = pendingSessionTerminations.get(sessionID)
    if (termination) {
      pendingSessionTerminations.delete(sessionID)
      const exchange = activeExchanges(sessionID).find(
        (candidate) =>
          candidate.userMessageID === termination.userMessageID && candidate.replyID === termination.replyID,
      )
      if (exchange) {
        if (termination.error) {
          const taskID = taskIDForReply(exchange.replyID)
          bridge.sendTurnError({
            text: termination.error,
            replyID: exchange.replyID,
            ...(taskID ? { taskID } : {}),
            messageID: `${sessionID}:error:${errorSequence++}:${exchange.replyID}`,
          })
        }
        rememberCompletedReply(exchange.replyID)
        cleanupExchange(sessionID, exchange.userMessageID)
      }
    }
    forwardFinalAssistantText(sessionID)
    cleanupSessionOrphans(sessionID)
  }

  return (event: GlobalEvent) => {
    const payload = event.payload
    if (payload.type === "session.error") {
      const sessionID = payload.properties.sessionID
      if (!sessionID) return
      const error = payload.properties.error
      const exchange = activeExchanges(sessionID).at(-1)
      const message =
        error && error.name !== "MessageAbortedError"
          ? (() => {
              const data = error.data
              return data && typeof data === "object" && "message" in data && typeof data.message === "string"
                ? data.message
                : error.name
            })()
          : undefined
      pendingSessionTerminations.set(sessionID, {
        ...(exchange ? { userMessageID: exchange.userMessageID, replyID: exchange.replyID } : {}),
        ...(message ? { error: message } : {}),
      })
      return
    }

    if (payload.type === "session.status") {
      const sessionID = payload.properties.sessionID
      const status = payload.properties.status.type
      if (status === "busy" || status === "retry") {
        for (const exchange of activeExchanges(sessionID)) {
          idleEligibleReplyIDs.delete(exchange.replyID)
          const taskID = taskIDForReply(exchange.replyID)
          if (taskID) bridge.sendTaskActivity?.({ taskID })
        }
        pendingSessionTerminations.delete(sessionID)
        return
      }
      if (status !== "idle") return
      markSessionIdle(sessionID)
      return
    }

    if (payload.type === "session.idle") {
      markSessionIdle(payload.properties.sessionID)
      return
    }

    if (payload.type === "message.updated") {
      const info = payload.properties.info
      const current = messages.get(info.id)
      messages.set(info.id, {
        id: info.id,
        sessionID: payload.properties.sessionID,
        role: info.role,
        ...(info.role === "assistant" ? { parentID: info.parentID } : {}),
        completed: current?.completed === true || (info.role === "assistant" && info.time?.completed !== undefined),
        sequence: current?.sequence ?? messageSequence++,
      })
      if (info.role === "user") {
        for (const part of textPartsByMessage.get(info.id)?.values() ?? []) {
          const replyID = remoteImReplyID(part.text)
          if (replyID && !completedReplyIDs.has(replyID)) remoteReplyByUserMessage.set(info.id, replyID)
        }
      }
      forwardFinalAssistantText(payload.properties.sessionID)
      return
    }

    if (payload.type !== "message.part.updated") return
    const part = payload.properties.part
    if (part.type !== "text") return
    let parts = textPartsByMessage.get(part.messageID)
    if (!parts) {
      parts = new Map()
      textPartsByMessage.set(part.messageID, parts)
    }
    const current = parts.get(part.id)
    const completedNow = current?.completed !== true && part.time?.end !== undefined
    parts.set(part.id, {
      id: part.id,
      messageID: part.messageID,
      text: part.text,
      completed: current?.completed === true || part.time?.end !== undefined,
      sequence: current?.sequence ?? partSequence++,
    })
    const message = messages.get(part.messageID)
    if (message?.role === "user") {
      const replyID = remoteImReplyID(part.text)
      if (replyID && !completedReplyIDs.has(replyID)) remoteReplyByUserMessage.set(part.messageID, replyID)
    }
    if (completedNow && message?.role === "assistant" && message.parentID && part.text.trim()) {
      const replyID = remoteReplyByUserMessage.get(message.parentID)
      const taskID = replyID ? taskIDForReply(replyID) : undefined
      if (taskID) {
        bridge.sendAssistantText({
          text: part.text,
          taskID,
          messageID: part.messageID,
          partID: part.id,
        })
      }
    }
    forwardFinalAssistantText(payload.properties.sessionID)
  }
}

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient, onEvent?: (event: GlobalEvent) => void): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        onEvent?.(e)
        handler(e)
      })
    },
  }
}

function waitForEventSourceRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

export function createRetryingEventSource(
  open: (signal: AbortSignal) => Promise<AsyncIterable<GlobalEvent>>,
  onEvent?: (event: GlobalEvent) => void,
  retryDelay = 1000,
): EventSource {
  return {
    subscribe: async (handler) => {
      const ctrl = new AbortController()
      void (async () => {
        while (!ctrl.signal.aborted) {
          try {
            const stream = await open(ctrl.signal)
            for await (const event of stream) {
              if (ctrl.signal.aborted) break
              onEvent?.(event)
              handler(event)
            }
          } catch {
            if (ctrl.signal.aborted) break
          }
          if (!ctrl.signal.aborted) await waitForEventSourceRetry(retryDelay, ctrl.signal)
        }
      })()
      return () => ctrl.abort()
    },
  }
}

function createExternalEventSource(
  url: string,
  directory: string,
  headers: RequestInit["headers"],
  onEvent?: (event: GlobalEvent) => void,
) {
  const sdk = createOpencodeClient({
    baseUrl: url,
    directory,
    headers,
  })
  return createRetryingEventSource(async (signal) => {
    const events = await sdk.global.event({
      signal,
      sseMaxRetryAttempts: 0,
    })
    return events.stream
  }, onEvent)
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("../tui/worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("multi-ai-code-im-ipc", {
        type: "string",
        hidden: true,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }

      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
        multiAiCodeImIpc: args.multiAiCodeImIpc,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const unguard = win32InstallCtrlCGuard()
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      const file = await target()
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const worker = new Worker(file, {
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      })
      const client = Rpc.client<typeof rpc>(worker)
      const reload = () => {
        client.call("reload", undefined).catch(() => {})
      }
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown", undefined), 5000).catch(() => {})
        worker.terminate()
      }

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()
      const imBridge = createMultiAiCodeImBridge(args.multiAiCodeImIpc)
      const handleImEvent = createMultiAiCodeImTuiEventHandler(imBridge)

      const network = resolveNetworkOptionsNoConfig(args)
      const external = hasArg("--port") || hasArg("--hostname") || network.mdns === true

      const headers = external ? ServerAuth.headers() : undefined

      const externalURL = external ? (await client.call("server", network)).url : undefined
      const transport = external
        ? {
            url: externalURL!,
            fetch: undefined,
            events: createExternalEventSource(externalURL!, cwd, headers, handleImEvent),
            headers,
          }
        : {
            url: "http://opencode.internal",
            fetch: createWorkerFetch(client),
            events: createEventSource(client, handleImEvent),
          }

      try {
        await validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
          headers,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      setTimeout(() => {
        client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000).unref?.()

      try {
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        await Effect.runPromise(
          run({
            url: transport.url,
            async onSnapshot() {
              const tui = writeHeapSnapshot("tui.heapsnapshot")
              const server = await client.call("snapshot", undefined)
              return [tui, server]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,
            fetch: transport.fetch,
            headers: transport.headers,
            events: transport.events,
            multiAiCodeImControl: imBridge,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
              auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
            },
          }),
        )
      } finally {
        imBridge?.close()
        await stop()
      }
    } finally {
      try {
        unguard?.()
      } catch {}
    }
    process.exit(0)
  },
})
// scratch
