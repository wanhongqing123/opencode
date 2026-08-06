import { describe, expect, test } from "bun:test"
import { selectRemoteImImageModel, type ManagedRouting, type RemoteImProvider } from "../src/util/remote-im-routing"

const routing: ManagedRouting = {
  version: 1,
  models: {
    "zhipu/glm-4.6v": { roles: ["vision"], priority: 80 },
    "zhipu/glm-5v-turbo": { roles: ["vision"], priority: 100 },
    "deepseek/deepseek-v4-flash": { roles: ["default_text"], priority: 100 },
  },
}

const providers: RemoteImProvider[] = [
  {
    id: "deepseek",
    models: {
      "deepseek-v4-flash": { capabilities: { input: { image: false } } },
    },
  },
  {
    id: "zhipu",
    models: {
      "glm-5v-turbo": { capabilities: { input: { image: true } } },
      "glm-4.6v": { capabilities: { input: { image: true } } },
    },
  },
]

describe("remote IM image model routing", () => {
  test("routes a text model image turn to the highest-priority vision model", () => {
    expect(
      selectRemoteImImageModel({
        providers,
        current: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        routing,
      }),
    ).toEqual({ providerID: "zhipu", modelID: "glm-5v-turbo" })
  })

  test("keeps an already image-capable current model", () => {
    expect(
      selectRemoteImImageModel({
        providers,
        current: { providerID: "zhipu", modelID: "glm-4.6v" },
        routing,
      }),
    ).toEqual({ providerID: "zhipu", modelID: "glm-4.6v" })
  })

  test("falls back to the next configured vision model when the first is unavailable", () => {
    expect(
      selectRemoteImImageModel({
        providers: [providers[0]!, { id: "zhipu", models: { "glm-4.6v": providers[1]!.models?.["glm-4.6v"]! } }],
        current: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        routing,
      }),
    ).toEqual({ providerID: "zhipu", modelID: "glm-4.6v" })
  })
})
