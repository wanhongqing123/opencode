import { describe, expect, it } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("Global.resolvePaths", () => {
  it("places every mutable OpenCode path below the managed account root", () => {
    const root = path.join(path.sep, "accounts", "alice", "aicli", "opencode")
    const paths = Global.resolvePaths(root)

    expect(paths.data).toBe(path.join(root, "data"))
    expect(paths.cache).toBe(path.join(root, "cache"))
    expect(paths.config).toBe(path.join(root, "config"))
    expect(paths.state).toBe(path.join(root, "state"))
    expect(paths.tmp).toBe(path.join(root, "tmp"))
    expect(paths.bin).toBe(path.join(root, "cache", "bin"))
    expect(paths.log).toBe(path.join(root, "data", "log"))
    expect(paths.repos).toBe(path.join(root, "data", "repos"))
  })
})
