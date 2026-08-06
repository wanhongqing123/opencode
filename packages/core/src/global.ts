import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { makeGlobalNode } from "./effect/app-node"

const app = "opencode"
const runtimeRoot = process.env.OPENCODE_RUNTIME_ROOT?.trim()

export function resolvePaths(root?: string) {
  const managed = root?.trim()
  const data = managed ? path.join(managed, "data") : path.join(xdgData!, app)
  const cache = managed ? path.join(managed, "cache") : path.join(xdgCache!, app)
  const config = managed ? path.join(managed, "config") : path.join(xdgConfig!, app)
  const state = managed ? path.join(managed, "state") : path.join(xdgState!, app)
  const tmp = managed ? path.join(managed, "tmp") : path.join(os.tmpdir(), app)
  return {
    get home() {
      return process.env.OPENCODE_TEST_HOME ?? os.homedir()
    },
    data,
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
    cache,
    config,
    state,
    tmp,
  }
}

const paths = resolvePaths(runtimeRoot)

export const Path = paths

Flock.setGlobal({ state: Path.state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
