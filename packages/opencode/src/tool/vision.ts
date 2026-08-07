import { listImageCapableModels, type ModelCollaborationRef } from "@opencode-ai/core/model-collaboration"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import type { TaskPromptOps } from "./task"
import * as Tool from "./tool"
import { Provider } from "@/provider/provider"
import { SessionRetry } from "@/session/retry"
import { Cause, Effect, Exit, Schema } from "effect"

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

type VisionModelFailure = {
  model: string
  reason: string
  permanent: boolean
}

const unavailableModels = new Map<string, string>()

export function markVisionModelUnavailable(model: ModelCollaborationRef, reason: string) {
  unavailableModels.set(modelKey(model), reason)
}

export function resetVisionModelAvailability() {
  unavailableModels.clear()
}

export function availableVisionCandidates(
  candidates: ModelCollaborationRef[],
  requested?: string,
): ModelCollaborationRef[] {
  const requestedKey = requested?.trim()
  const ordered = requestedKey
    ? [
        ...candidates.filter((candidate) => modelKey(candidate) === requestedKey),
        ...candidates.filter((candidate) => modelKey(candidate) !== requestedKey),
      ]
    : candidates
  return ordered.filter((candidate) => !unavailableModels.has(modelKey(candidate)))
}

function errorMessage(error: NonNullable<SessionV1.Assistant["error"]>) {
  if (SessionV1.APIError.isInstance(error)) return error.data.message
  if ("data" in error && error.data && typeof error.data === "object" && "message" in error.data) {
    return error.data.message
  }
  return JSON.stringify(error)
}

function permanentlyUnavailable(error: NonNullable<SessionV1.Assistant["error"]>) {
  if (SessionV1.APIError.isInstance(error)) {
    if (SessionRetry.isPermanentAPIError(error)) return true
    return [401, 403, 404].includes(error.data.statusCode ?? 0)
  }
  return SessionV1.AuthError.isInstance(error)
}

function collaborationNote(input: {
  primary?: Provider.Model
  collaborator: Provider.Model
  failures: VisionModelFailure[]
}) {
  const primaryID = input.primary ? `${input.primary.providerID}/${input.primary.id}` : "the current session model"
  const primaryName = input.primary?.name ?? primaryID
  const collaboratorID = `${input.collaborator.providerID}/${input.collaborator.id}`
  const usage = `${primaryName} (${primaryID}, primary), ${input.collaborator.name} (${collaboratorID}, vision collaborator)`
  return [
    "Model collaboration note for the primary model:",
    `- The primary session model remains ${primaryName} (${primaryID}); do not present the vision collaborator as the current model.`,
    `- Vision analysis succeeded with ${input.collaborator.name} (${collaboratorID}).`,
    ...(input.failures.length
      ? [
          `- Vision fallback skipped: ${input.failures.map((failure) => `${failure.model}: ${failure.reason}`).join("; ")}.`,
        ]
      : []),
    `- The final user-facing answer must end with a concise line: Models used: ${usage}.`,
  ].join("\n")
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

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops) return yield* Effect.fail(new Error("Vision collaboration requires prompt operations"))
          const primary = ctx.extra?.model as Provider.Model | undefined
          const all = listImageCapableModels({
            providers: Object.values(yield* providers.list()),
            current: primary ? { providerID: primary.providerID, modelID: primary.id } : undefined,
          })
          const candidates = availableVisionCandidates(all, params.model)
          if (candidates.length === 0) {
            const blocked = all
              .map((candidate) => [modelKey(candidate), unavailableModels.get(modelKey(candidate))] as const)
              .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
              .map(([model, reason]) => `${model}: ${reason}`)
            const suffix = blocked.length ? ` Unavailable until OpenCode restarts: ${blocked.join("; ")}` : ""
            return yield* Effect.fail(new Error(`No image-capable collaborator is currently available.${suffix}`))
          }

          const failures: VisionModelFailure[] = []
          const attempted: string[] = []
          for (const selected of candidates) {
            const selectedKey = modelKey(selected)
            attempted.push(selectedKey)
            const modelExit = yield* providers
              .getModel(ProviderV2.ID.make(selected.providerID), ModelV2.ID.make(selected.modelID))
              .pipe(Effect.exit)
            if (Exit.isFailure(modelExit)) {
              failures.push({ model: selectedKey, reason: String(Cause.squash(modelExit.cause)), permanent: false })
              continue
            }
            const model = modelExit.value
            if (!model.capabilities.input.image) {
              const reason = "model does not support image input"
              markVisionModelUnavailable(selected, reason)
              failures.push({ model: selectedKey, reason, permanent: true })
              continue
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
                model: selectedKey,
                primaryModel: primary ? `${primary.providerID}/${primary.id}` : undefined,
                attemptedModels: attempted,
                failedModels: failures.map((failure) => failure.model),
                images: images.length,
                sessionID: child.id,
              },
            })

            const resultExit = yield* ops
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
              .pipe(
                Effect.onInterrupt(() => ops.cancel(child.id)),
                Effect.exit,
              )
            if (Exit.isFailure(resultExit)) {
              failures.push({
                model: selectedKey,
                reason: String(Cause.squash(resultExit.cause)),
                permanent: false,
              })
              continue
            }

            const result = resultExit.value
            const assistantError = result.info.role === "assistant" ? result.info.error : undefined
            if (assistantError) {
              const reason = errorMessage(assistantError)
              const permanent = permanentlyUnavailable(assistantError)
              if (permanent) markVisionModelUnavailable(selected, reason)
              failures.push({ model: selectedKey, reason, permanent })
              continue
            }

            const output = result.parts
              .filter((part): part is SessionV1.TextPart => part.type === "text")
              .map((part) => part.text)
              .filter(Boolean)
              .join("\n")
              .trim()
            if (!output) {
              failures.push({ model: selectedKey, reason: "collaborator returned no text", permanent: false })
              continue
            }

            return {
              title: `Image analysis via ${model.name}`,
              metadata: {
                model: selectedKey,
                primaryModel: primary ? `${primary.providerID}/${primary.id}` : undefined,
                attemptedModels: attempted,
                failedModels: failures.map((failure) => failure.model),
                images: images.length,
                sessionID: child.id,
              },
              output: `${output}\n\n${collaborationNote({ primary, collaborator: model, failures })}`,
            }
          }

          return yield* Effect.fail(
            new Error(
              `All image-capable collaborators failed: ${failures
                .map((failure) => `${failure.model}: ${failure.reason}`)
                .join("; ")}`,
            ),
          )
        }).pipe(Effect.orDie),
    }
  }),
)
