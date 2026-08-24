import { readFileSync } from "node:fs"

export type ModelCollaborationRef = {
  providerID: string
  modelID: string
}

export type ModelCollaborationProvider = {
  id: string
  models?: Record<
    string,
    {
      capabilities?: {
        input?: {
          image?: boolean
        }
      }
    }
  >
}

export type ManagedRouting = {
  version: number
  models: Record<
    string,
    {
      roles?: string[]
      priority?: number
    }
  >
}

let cachedPath = ""
let cachedRouting: ManagedRouting | undefined

function loadManagedRouting(): ManagedRouting | undefined {
  const routingPath = process.env.OPENCODE_MANAGED_ROUTING_PATH?.trim() ?? ""
  if (!routingPath) return undefined
  if (routingPath === cachedPath) return cachedRouting

  cachedPath = routingPath
  try {
    const value = JSON.parse(readFileSync(routingPath, "utf8")) as Partial<ManagedRouting>
    cachedRouting =
      value.version === 1 && value.models && typeof value.models === "object" ? (value as ManagedRouting) : undefined
  } catch {
    cachedRouting = undefined
  }
  return cachedRouting
}

export function modelSupportsImages(
  providers: ModelCollaborationProvider[],
  model: ModelCollaborationRef | undefined,
): boolean {
  if (!model) return false
  return (
    providers.find((provider) => provider.id === model.providerID)?.models?.[model.modelID]?.capabilities?.input
      ?.image === true
  )
}

function parseModelRef(value: string): ModelCollaborationRef | undefined {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

function key(model: ModelCollaborationRef) {
  return `${model.providerID}/${model.modelID}`
}

export function listImageCapableModels(input: {
  providers: ModelCollaborationProvider[]
  current?: ModelCollaborationRef
  routing?: ManagedRouting
}): ModelCollaborationRef[] {
  const result: ModelCollaborationRef[] = []
  const seen = new Set<string>()
  const append = (model: ModelCollaborationRef | undefined) => {
    if (!model || !modelSupportsImages(input.providers, model)) return
    const id = key(model)
    if (seen.has(id)) return
    seen.add(id)
    result.push(model)
  }

  append(input.current)

  const routing = input.routing ?? loadManagedRouting()
  if (routing) {
    Object.entries(routing.models)
      .filter(([, route]) => route.roles?.includes("vision"))
      .sort(([leftID, left], [rightID, right]) => {
        return (right.priority ?? 0) - (left.priority ?? 0) || leftID.localeCompare(rightID)
      })
      .forEach(([modelID]) => append(parseModelRef(modelID)))
  }

  for (const provider of input.providers) {
    for (const modelID of Object.keys(provider.models ?? {}).sort()) {
      append({ providerID: provider.id, modelID })
    }
  }
  return result
}
