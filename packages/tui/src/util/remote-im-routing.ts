import { readFileSync } from "node:fs"

export type RemoteImModelRef = {
  providerID: string
  modelID: string
}

export type RemoteImProvider = {
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

function modelSupportsImages(providers: RemoteImProvider[], model: RemoteImModelRef | undefined): boolean {
  if (!model) return false
  return (
    providers.find((provider) => provider.id === model.providerID)?.models?.[model.modelID]?.capabilities?.input
      ?.image === true
  )
}

function parseModelRef(value: string): RemoteImModelRef | undefined {
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return {
    providerID: value.slice(0, separator),
    modelID: value.slice(separator + 1),
  }
}

export function selectImageCapableModel(input: {
  providers: RemoteImProvider[]
  current?: RemoteImModelRef
  routing?: ManagedRouting
}): RemoteImModelRef | undefined {
  if (modelSupportsImages(input.providers, input.current)) return input.current

  const routing = input.routing ?? loadManagedRouting()
  const configured = routing
    ? Object.entries(routing.models)
        .filter(([, route]) => route.roles?.includes("vision"))
        .sort(([leftID, left], [rightID, right]) => {
          return (right.priority ?? 0) - (left.priority ?? 0) || leftID.localeCompare(rightID)
        })
        .map(([modelID]) => parseModelRef(modelID))
        .filter((model): model is RemoteImModelRef => !!model)
    : []

  const selected = configured.find((model) => modelSupportsImages(input.providers, model))
  if (selected) return selected

  for (const provider of input.providers) {
    for (const modelID of Object.keys(provider.models ?? {}).sort()) {
      const model = { providerID: provider.id, modelID }
      if (modelSupportsImages(input.providers, model)) return model
    }
  }
  return undefined
}

export const selectRemoteImImageModel = selectImageCapableModel
