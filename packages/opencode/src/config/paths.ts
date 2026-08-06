export * as ConfigPaths from "./paths"

import path from "path"
import { Global } from "@opencode-ai/core/global"
import * as Effect from "effect/Effect"

export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  _name: string,
  _directory: string,
  _worktree?: string,
) {
  return [] as string[]
})

export const directories = Effect.fn("ConfigPaths.directories")(function* (_directory: string, _worktree?: string) {
  return [Global.Path.config]
})

export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}
