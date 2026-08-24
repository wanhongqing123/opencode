import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import { runInteractiveMode } from "@/cli/cmd/run/runtime"
import type { MultiAiCodeImBridge, MultiAiCodeImControlCommand } from "@/cli/cmd/run/multi-ai-code-im-bridge"
import type { FooterApi, RunProvider } from "@/cli/cmd/run/types"

type SessionMessage = NonNullable<Awaited<ReturnType<OpencodeClient["session"]["messages"]>>["data"]>[number]

const provider: RunProvider = {
  id: "openai",
  name: "OpenAI",
  source: "api",
  env: [],
  options: {},
  models: {
    "gpt-5": {
      id: "gpt-5",
      providerID: "openai",
      api: {
        id: "openai",
        url: "https://openai.test",
        npm: "@ai-sdk/openai",
      },
      name: "Little Frank",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      cost: {
        input: 0,
        output: 0,
        cache: {
          read: 0,
          write: 0,
        },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-01-01",
    },
  },
}

const transportProviders: RunProvider[][] = []

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ok<T>(data: T) {
  return Promise.resolve({
    data,
    error: undefined,
    request: new Request("https://opencode.test"),
    response: new Response(),
  })
}

function footer(): FooterApi {
  let closed = false
  const closes = new Set<() => void>()

  const notify = () => {
    for (const fn of closes) fn()
  }

  return {
    get isClosed() {
      return closed
    },
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose(fn) {
      if (closed) {
        fn()
        return () => {}
      }

      closes.add(fn)
      return () => {
        closes.delete(fn)
      }
    },
    event() {},
    append() {},
    idle() {
      return Promise.resolve()
    },
    close() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
    destroy() {
      if (closed) {
        return
      }

      closed = true
      notify()
    },
  }
}

afterEach(() => {
  mock.restore()
  transportProviders.length = 0
})

describe("run interactive runtime", () => {
  test("waits for provider metadata before eager replay transport bootstrap", async () => {
    const providersStarted = defer<void>()
    const providers = defer<void>()

    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(async () => {
      providersStarted.resolve()
      await providers.promise
      return ok({ providers: [provider], default: {} })
    })
    spyOn(sdk.session, "messages").mockImplementation(() =>
      ok([
        {
          info: {
            id: "msg-user-1",
            sessionID: "ses-1",
            role: "user",
            time: {
              created: 1,
            },
            agent: "build",
            model: {
              providerID: "openai",
              modelID: "gpt-5",
              variant: undefined,
            },
          },
          parts: [
            {
              id: "part-user-1",
              sessionID: "ses-1",
              messageID: "msg-user-1",
              type: "text",
              text: "hello",
            },
          ],
        } satisfies SessionMessage,
      ]),
    )
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        resume: true,
        replay: true,
        replayLimit: 100,
        agent: "build",
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        createRuntimeLifecycle: async () => ({
          footer: footer(),
          onResize: () => () => {},
          refreshTheme: () => {},
          resetForReplay: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
        streamTransport: Promise.resolve({
          createSessionTransport: async (input: { providers?: () => RunProvider[]; footer: FooterApi }) => {
            transportProviders.push(input.providers?.() ?? [])
            setTimeout(() => {
              input.footer.close()
            }, 0)
            return {
              runPromptTurn: async () => {},
              selectSubagent: () => {},
              replayOnResize: async () => false,
              close: async () => {},
            }
          },
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await providersStarted.promise

    expect(transportProviders).toEqual([])

    providers.resolve()

    await task

    expect(transportProviders).toEqual([[provider]])
  })

  test("keeps a machine steer silent, then attaches the first remote human to an active local turn", async () => {
    const sdk = new OpencodeClient()
    spyOn(sdk.config, "providers").mockImplementation(() => ok({ providers: [provider], default: {} }))
    spyOn(sdk.session, "messages").mockImplementation(() => ok([]))
    spyOn(sdk.session, "get").mockRejectedValue(new Error("not needed"))
    spyOn(sdk.session, "promptAsync").mockImplementation(() => ok(undefined) as never)
    spyOn(sdk.app, "agents").mockImplementation(() => ok([]))
    spyOn(sdk.experimental.resource, "list").mockImplementation(() => ok({}))
    spyOn(sdk.command, "list").mockImplementation(() => ok([]))

    const localTurnStarted = defer<void>()
    const releaseLocalTurn = defer<void>()
    const machineControlCompleted = defer<void>()
    const controlCompleted = defer<void>()
    const lifecycle: Array<{
      kind: string
      replyID?: string
      taskID?: string
      text?: string
      messageID?: string
      partID?: string
    }> = []
    let controlHandler: ((command: MultiAiCodeImControlCommand) => void) | undefined
    let runtimeFooter: FooterApi | undefined
    const bridge: MultiAiCodeImBridge = {
      setInputOrigin() {},
      sendTaskStarted(input) {
        lifecycle.push({ kind: "started", ...input })
      },
      sendTaskActivity(input) {
        lifecycle.push({ kind: "activity", ...input })
      },
      registerRemoteTask() {},
      forgetRemoteTask() {},
      sendAssistantText(input) {
        lifecycle.push({ kind: "text", ...input })
      },
      sendAssistantFinal(input) {
        lifecycle.push({ kind: "final", ...input })
      },
      sendTurnError(input) {
        lifecycle.push({ kind: "error", ...input })
      },
      sendControlResult(input) {
        if (input.requestID === "request-machine") machineControlCompleted.resolve()
        if (input.requestID === "request-1") controlCompleted.resolve()
      },
      onControlCommand(handler) {
        controlHandler = handler
        return () => {
          controlHandler = undefined
        }
      },
      close() {},
    }

    const task = runInteractiveMode(
      {
        sdk,
        directory: "/tmp",
        sessionID: "ses-1",
        sessionTitle: "Session",
        initialInput: "local active",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: undefined,
        files: [],
        thinking: true,
        backgroundSubagents: false,
      },
      {
        imBridge: bridge,
        createRuntimeLifecycle: async () => {
          runtimeFooter = footer()
          return {
            footer: runtimeFooter,
            onResize: () => () => {},
            refreshTheme: () => {},
            resetForReplay: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }
        },
        streamTransport: Promise.resolve({
          createSessionTransport: async () => ({
            runPromptTurn: async (input) => {
              localTurnStarted.resolve()
              await releaseLocalTurn.promise
              input.onTaskActivity?.()
              input.onAssistantProgress?.({ text: "working", messageID: "msg-1", partID: "part-1" })
              input.onAssistantOutput?.({ text: "done", messageID: "msg-2", partID: "part-2" })
            },
            selectSubagent: () => {},
            replayOnResize: async () => false,
            close: async () => {},
          }),
          formatUnknownError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
        }),
      },
    )

    await localTurnStarted.promise
    controlHandler?.({
      command: "submit_user_message",
      requestID: "request-machine",
      text: "machine steer",
      displayText: "machine steer",
      attachments: [],
      inputOrigin: "remote-im-machine",
    })
    await machineControlCompleted.promise
    expect(lifecycle).toEqual([])

    controlHandler?.({
      command: "submit_user_message",
      requestID: "request-1",
      text: "remote steer",
      displayText: "remote steer",
      attachments: [],
      inputOrigin: "remote-im",
      replyID: "reply-1",
      taskID: "task-1",
    })
    await controlCompleted.promise
    releaseLocalTurn.resolve()

    while (!lifecycle.some((event) => event.kind === "final")) await Bun.sleep(1)
    runtimeFooter?.close()
    await task

    expect(lifecycle).toEqual([
      { kind: "started", replyID: "reply-1", taskID: "task-1" },
      { kind: "activity", taskID: "task-1" },
      { kind: "text", taskID: "task-1", text: "working", messageID: "msg-1", partID: "part-1" },
      { kind: "final", replyID: "reply-1", taskID: "task-1", text: "done", messageID: "msg-2", partID: "part-2" },
    ])
  })
})
