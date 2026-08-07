import { listImageCapableModels, type ModelCollaborationRef } from "@opencode-ai/core/model-collaboration"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import type { TaskPromptOps } from "./task"
import * as Tool from "./tool"
import { Provider } from "@/provider/provider"
import { Effect, Schema } from "effect"

const Parameters = Schema.Struct({
  question: Schema.String.annotate({
    description: "The focused visual question that the image-capable collaborator should answer",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional provider/model collaborator from the available list in this tool description",
  }),
})

function modelKey(model: ModelCollaborationRef) {
  return `${model.providerID}/${model.modelID}`
}

export function latestImageParts(messages: SessionV1.WithParts[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.info.role !== "user") continue
    const images = message.parts.filter(
      (part): part is SessionV1.FilePart => part.type === "file" && part.mime.startsWith("image/"),
    )
    if (images.length > 0) return images
  }
  return []
}

function chooseModel(candidates: ModelCollaborationRef[], requested: string | undefined) {
  const value = requested?.trim()
  if (!value) return candidates[0]
  return candidates.find((candidate) => modelKey(candidate) === value)
}

export const VisionTool = Tool.define(
  "vision",
  Effect.gen(function* () {
    const providers = yield* Provider.Service
    const sessions = yield* Session.Service

    return {
      description: [
        "Ask an image-capable model to inspect the image attachments from the latest relevant user message.",
        "Use this when visual details are needed and you cannot inspect the image yourself.",
        "This is collaboration only: it does not change the current session model, and you remain responsible for the final answer.",
      ].join(" "),
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx) =>
        Effect.gen(function* () {
          const images = latestImageParts(ctx.messages)
          if (images.length === 0) {
            return yield* Effect.fail(new Error("No image attachment is available in the current conversation"))
          }

          const available = listImageCapableModels({ providers: Object.values(yield* providers.list()) })
          const selected = chooseModel(available, params.model)
          if (!selected) {
            const suffix = available.length ? ` Available models: ${available.map(modelKey).join(", ")}` : ""
            return yield* Effect.fail(new Error(`No matching image-capable collaborator is available.${suffix}`))
          }

          const model = yield* providers.getModel(
            ProviderV2.ID.make(selected.providerID),
            ModelV2.ID.make(selected.modelID),
          )
          if (!model.capabilities.input.image) {
            return yield* Effect.fail(
              new Error(`Selected collaborator does not support image input: ${modelKey(selected)}`),
            )
          }

          const child = yield* sessions.create({
            parentID: ctx.sessionID,
            title: `Image analysis (${model.name})`,
            agent: "vision",
            permission: [{ permission: "*", pattern: "*", action: "deny" }],
          })
          yield* ctx.metadata({
            title: `Analyze ${images.length} image${images.length === 1 ? "" : "s"}`,
            metadata: {
              model: modelKey(selected),
              images: images.length,
              sessionID: child.id,
            },
          })

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("Vision collaboration requires prompt operations"))

          const result = yield* ops
            .prompt({
              messageID: MessageID.ascending(),
              sessionID: child.id,
              model: {
                providerID: model.providerID,
                modelID: model.id,
              },
              agent: "vision",
              parts: [
                {
                  type: "text",
                  text: `Question from the primary model:\n${params.question}`,
                  synthetic: true,
                },
                ...images.map((image) => ({
                  type: "file" as const,
                  mime: image.mime,
                  filename: image.filename,
                  url: image.url,
                  source: image.source,
                })),
              ],
            })
            .pipe(Effect.onInterrupt(() => ops.cancel(child.id)))

          const output = result.parts
            .filter((part): part is SessionV1.TextPart => part.type === "text")
            .map((part) => part.text)
            .filter(Boolean)
            .join("\n")
            .trim()
          if (!output) return yield* Effect.fail(new Error("Image collaborator returned no text"))

          return {
            title: `Image analysis via ${model.name}`,
            metadata: {
              model: modelKey(selected),
              images: images.length,
              sessionID: child.id,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
