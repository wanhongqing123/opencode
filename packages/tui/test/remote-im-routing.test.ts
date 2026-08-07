import { describe, expect, test } from "bun:test"
import {
  listImageCapableModels,
  type ManagedRouting,
  type ModelCollaborationProvider,
} from "../src/util/remote-im-routing"

const routing: ManagedRouting = {
  version: 1,
  models: {
    "zhipu/glm-4.6v": { roles: ["vision"], priority: 80 },
    "zhipu/glm-5v-turbo": { roles: ["vision"], priority: 100 },
    "deepseek/deepseek-v4-flash": { roles: ["default_text"], priority: 100 },
  },
}

const providers: ModelCollaborationProvider[] = [
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

describe("image collaborator catalog", () => {
  test("lists collaborators by managed priority without replacing the text model", () => {
    expect(
      listImageCapableModels({
        providers,
        current: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        routing,
      }),
    ).toEqual([
      { providerID: "zhipu", modelID: "glm-5v-turbo" },
      { providerID: "zhipu", modelID: "glm-4.6v" },
    ])
  })

  test("offers an image-capable current model as the first collaborator", () => {
    expect(
      listImageCapableModels({
        providers,
        current: { providerID: "zhipu", modelID: "glm-4.6v" },
        routing,
      }),
    ).toEqual([
      { providerID: "zhipu", modelID: "glm-4.6v" },
      { providerID: "zhipu", modelID: "glm-5v-turbo" },
    ])
  })

  test("omits unavailable collaborators", () => {
    expect(
      listImageCapableModels({
        providers: [providers[0]!, { id: "zhipu", models: { "glm-4.6v": providers[1]!.models?.["glm-4.6v"]! } }],
        current: { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        routing,
      }),
    ).toEqual([{ providerID: "zhipu", modelID: "glm-4.6v" }])
  })
})
