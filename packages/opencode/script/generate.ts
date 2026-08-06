import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const modelsUrl = process.env.OPENCODE_MODELS_URL || "https://models.dev"
export const fetchModelsData = () => fetch(`${modelsUrl}/api.json`).then((x) => x.text())

const managedModelsPath = process.env.MODELS_DEV_API_JSON
if (!managedModelsPath) {
  throw new Error("Multi-AI Code OpenCode builds require the packaged MODELS_DEV_API_JSON catalog")
}
export const modelsData = await Bun.file(managedModelsPath).text()
console.log("Loaded models.dev snapshot")
