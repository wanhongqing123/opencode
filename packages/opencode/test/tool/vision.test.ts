import { afterEach, describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import {
  availableVisionCandidates,
  latestImageParts,
  markVisionModelUnavailable,
  resetVisionModelAvailability,
} from "../../src/tool/vision"

const sessionID = SessionID.make("session")

function userMessage(id: string, parts: SessionV1.Part[]): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created: 0 },
      agent: "build",
      model: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
    } as SessionV1.User,
    parts,
  }
}

function image(messageID: string, name: string): SessionV1.FilePart {
  return {
    id: PartID.ascending(),
    messageID: MessageID.make(messageID),
    sessionID,
    type: "file",
    mime: "image/png",
    filename: name,
    url: `file:///tmp/${name}`,
  }
}

describe("vision collaboration attachments", () => {
  afterEach(() => resetVisionModelAvailability())

  test("uses images from the latest image-bearing user message", () => {
    const older = image("msg_older", "older.png")
    const latest = image("msg_latest", "latest.png")
    const messages = [
      userMessage("msg_older", [older]),
      userMessage("msg_latest", [latest]),
      userMessage("msg_followup", [
        {
          id: PartID.ascending(),
          messageID: MessageID.make("msg_followup"),
          sessionID,
          type: "text",
          text: "Please inspect the previous image",
        },
      ]),
    ]

    expect(latestImageParts(messages)).toEqual([latest])
  })

  test("tries a requested collaborator first and preserves the remaining fallback order", () => {
    const candidates = [
      { providerID: "zhipu", modelID: "glm-5v-turbo" },
      { providerID: "zhipu", modelID: "glm-4.6v" },
      { providerID: "other", modelID: "vision" },
    ]

    expect(availableVisionCandidates(candidates, "zhipu/glm-4.6v")).toEqual([
      { providerID: "zhipu", modelID: "glm-4.6v" },
      { providerID: "zhipu", modelID: "glm-5v-turbo" },
      { providerID: "other", modelID: "vision" },
    ])
  })

  test("preserves managed priority order when no collaborator is requested", () => {
    const candidates = [
      { providerID: "zhipu", modelID: "glm-5v-turbo" },
      { providerID: "zhipu", modelID: "glm-4.6v" },
    ]

    expect(availableVisionCandidates(candidates)).toEqual(candidates)
  })

  test("skips a permanently unavailable collaborator for later image requests", () => {
    const unavailable = { providerID: "zhipu", modelID: "glm-5v-turbo" }
    const fallback = { providerID: "zhipu", modelID: "glm-4.6v" }
    markVisionModelUnavailable(unavailable, "subscription does not include this model")

    expect(availableVisionCandidates([unavailable, fallback], "zhipu/glm-5v-turbo")).toEqual([fallback])
  })
})
