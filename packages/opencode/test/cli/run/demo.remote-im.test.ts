import { describe, expect, test } from "bun:test"
import { createRunDemo } from "@/cli/cmd/run/demo"
import type { FooterApi } from "@/cli/cmd/run/types"

function footer(): FooterApi {
  return {
    isClosed: false,
    onPrompt: () => () => {},
    onQueuedRemove: () => () => {},
    onClose: () => () => {},
    event() {},
    append() {},
    idle: () => Promise.resolve(),
    close() {},
    destroy() {},
  }
}

describe("run demo Remote IM lifecycle output", () => {
  test("returns the synthetic assistant output for terminal forwarding", async () => {
    const demo = createRunDemo({
      footer: footer(),
      sessionID: "ses_demo",
      thinking: false,
      limits: () => ({}),
    })

    const result = await demo.prompt({ text: "/fmt text hello", parts: [] })

    expect(result).toEqual({
      handled: true,
      outputs: [
        {
          text: "hello",
          messageID: "demo_msg_1",
          partID: "demo_part_1",
        },
      ],
    })
  })

  test("returns a demo error as terminal error data", async () => {
    const demo = createRunDemo({
      footer: footer(),
      sessionID: "ses_demo",
      thinking: false,
      limits: () => ({}),
    })

    expect(await demo.prompt({ text: "/fmt error failed", parts: [] })).toEqual({
      handled: true,
      outputs: [],
      error: "failed",
    })
  })
})
