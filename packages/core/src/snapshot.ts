export * as Snapshot from "./snapshot.js"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import path from "path"
import { Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { File } from "./file.js"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Git } from "./git.js"
import { Global } from "@opencode-ai/util/global"
import { Location } from "./location.js"
import { AbsolutePath, RelativePath } from "./schema.js"
import { ID } from "@opencode-ai/schema/snapshot"
import { Hash } from "@opencode-ai/util/hash"
import { State } from "./state.js"

export { ID }

export class Error extends Schema.TaggedError<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export type Draft = {
  configure: (enabled: boolean) => void
}

export interface Interface extends State.Transformable<Draft> {
  /**
   * Capture the current Location-scoped filesystem state as an opaque reference
   * to a content-addressed tree and its storage. Returns `undefined` when
   * snapshots are disabled, unsupported, or the best-effort capture fails.
   */
  readonly capture: () => Effect.Effect<ID | undefined>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const lifetime = yield* Scope.Scope
    const state = State.create<{ enabled: boolean }, Draft>({
      name: "snapshot",
      initial: () => ({ enabled: true }),
      draft: (draft) => ({
        configure: (enabled) => {
          draft.enabled = enabled
        },
      }),
    })
    // Cache a scope-owned fiber so caller cancellation stops waiting without poisoning shared initialization.
    const repositoryFiber = yield* Effect.cached(
      Effect.gen(function* () {
        const source = yield* git.repo.discover(location.project.directory)
        if (!source) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
        const worktree = AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
        const gitDirectory = AbsolutePath.make(
          path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)),
        )
        const snapshotRepository = (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
          ? new Git.Repository({ worktree, gitDirectory, commonDirectory: gitDirectory })
          : yield* git.repo
              .create({ worktree, gitDirectory, seed: source })
              .pipe(Effect.mapError((cause) => failure("capture", cause)))
        return {
          source,
          worktree,
          snapshotRepository,
          foreignRepository: (directory: AbsolutePath) =>
            new Git.Repository({
              worktree,
              gitDirectory: directory,
              commonDirectory: directory,
              objectDirectories: [AbsolutePath.make(path.join(source.commonDirectory, "objects"))],
            }),
        }
      }).pipe(Effect.forkIn(lifetime)),
    )
    const repository = repositoryFiber.pipe(Effect.uninterruptible, Effect.flatMap(Fiber.join))

    const scope = Effect.fnUntraced(function* (worktree: AbsolutePath) {
      const relative = path.relative(worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const enabled = () => location.vcs?.type === "git" && state.get().enabled

    const resolved = new Map<ID, { directory: AbsolutePath; tree: Git.TreeID }>()
    const resolve = Effect.fnUntraced(function* (id: ID) {
      const cached = resolved.get(id)
      if (cached) return cached
      const qualified = /^snapshot:([a-zA-Z0-9_-]+)\/([a-f0-9]{40})\/([a-f0-9]{40}|[a-f0-9]{64})$/.exec(id)
      if (qualified)
        return {
          directory: AbsolutePath.make(path.join(global.data, "snapshot", qualified[1], qualified[2])),
          tree: Git.TreeID.make(qualified[3]),
        }
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))
        return yield* new Error({ operation: "restore", message: "Invalid snapshot reference" })
      const repo = yield* repository
      const tree = Git.TreeID.make(id)
      if (yield* git.tree.exists(repo.snapshotRepository, tree))
        return { directory: repo.snapshotRepository.gitDirectory, tree }
      // Persisted hash-only IDs predate storage-qualified references. Search only on a local miss.
      const root = path.join(global.data, "snapshot")
      const projects = yield* fs.readDirectoryEntries(root).pipe(Effect.mapError((cause) => failure("restore", cause)))
      for (const project of projects.filter(
        (entry) => entry.type === "directory" && /^[a-zA-Z0-9_-]+$/.test(entry.name),
      )) {
        const stores = yield* fs
          .readDirectoryEntries(path.join(root, project.name))
          .pipe(Effect.mapError((cause) => failure("restore", cause)))
        for (const store of stores.filter((entry) => entry.type === "directory" && /^[a-f0-9]{40}$/.test(entry.name))) {
          const directory = AbsolutePath.make(path.join(root, project.name, store.name))
          const candidate = repo.foreignRepository(directory)
          if (!(yield* git.tree.exists(candidate, tree))) continue
          // Identical legacy trees can exist in several stores; skip incomplete copies.
          if (
            !(yield* git.tree.retain({ repository: candidate, trees: [tree] }).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ))
          )
            continue
          const result = { directory, tree }
          resolved.set(id, result)
          return result
        }
      }
      return yield* new Error({ operation: "restore", message: `Snapshot tree not found: ${id}` })
    })

    const read = Effect.fnUntraced(function* (ids: readonly ID[]) {
      const repo = yield* repository
      const stores = new Map<AbsolutePath, Git.TreeID[]>()
      for (const id of new Set(ids)) {
        const ref = yield* resolve(id)
        if (ref.directory === repo.snapshotRepository.gitDirectory) continue
        stores.set(ref.directory, [...(stores.get(ref.directory) ?? []), ref.tree])
      }
      for (const [directory, trees] of stores) {
        // A renamed checkout can supply the old store's borrowed objects at its new path.
        yield* git.tree.retain({ repository: repo.foreignRepository(directory), trees })
      }
      return new Git.Repository({
        ...repo.snapshotRepository,
        objectDirectories: Array.from(stores.keys(), (directory) => AbsolutePath.make(path.join(directory, "objects"))),
      })
    })

    const capture = Effect.fn("Snapshot.capture")(function* () {
      if (!enabled()) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository
        const tree = yield* git.tree.capture({
          repository: repo.snapshotRepository,
          scopes: [yield* scope(repo.worktree)],
          ignores: repo.source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        return ID.make(`snapshot:${location.project.id}/${Hash.fast(repo.worktree)}/${tree}`)
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const repo = yield* repository.pipe(Effect.mapError((cause) => failure(operation, cause)))
      const snapshots = yield* read([input.from, input.to]).pipe(Effect.mapError((cause) => failure(operation, cause)))
      const comparison = {
        repository: snapshots,
        from: treeID(input.from),
        to: treeID(input.to),
      }
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure(operation, cause)))
      const ignored = yield* git.index
        .ignored({ repository: repo.source, paths: files })
        .pipe(Effect.mapError((cause) => failure(operation, cause)))
      return {
        input: comparison,
        files,
        ignored,
      }
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      const comparison = yield* compare("files", input)
      return comparison.files.filter((file) => !comparison.ignored.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      const comparison = yield* compare("diff", input)
      return yield* git.tree
        .diff({
          ...comparison.input,
          context: input.context,
          paths: (input.paths ?? comparison.files).filter((file) => !comparison.ignored.has(file)),
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (worktree: AbsolutePath, input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(worktree, file)
        if (!FSUtil.contains(worktree, absolute))
          return yield* new Error({ operation: "restore", message: `Path escapes the project: ${file}` })
        // Check ancestors, not the leaf: removing a symlink itself must not follow its target.
        for (let parent = path.dirname(absolute); parent !== worktree; parent = path.dirname(parent)) {
          const canonical = yield* fs.realPath(parent).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
            Effect.catchReason("PlatformError", "BadResource", (reason, error) =>
              Schema.is(Schema.Struct({ code: Schema.Literal("ENOTDIR") }))(reason.cause)
                ? Effect.undefined
                : Effect.fail(error),
            ),
            Effect.mapError((cause) => failure("restore", cause)),
          )
          if (canonical === undefined) continue
          if (!FSUtil.contains(worktree, canonical))
            return yield* new Error({ operation: "restore", message: `Path escapes the project: ${file}` })
          break
        }
        files.set(file, treeID(snapshot))
      }
      return files
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!enabled()) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository.pipe(Effect.mapError((cause) => failure("restore", cause)))
      const snapshots = yield* read(Array.from(input.files.values())).pipe(
        Effect.mapError((cause) => failure("restore", cause)),
      )
      yield* git.tree
        .restore({ repository: snapshots, files: yield* plan(repo.worktree, input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    return Service.of({ transform: state.transform, reload: state.reload, capture, files, diff, restore })
  }).pipe(Effect.withSpan("Snapshot.boot")),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Git.node, Global.node, Location.node],
})

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
    capture: () => Effect.undefined,
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    restore: () => Effect.void,
  }),
)

function treeID(id: ID) {
  return Git.TreeID.make(id.slice(id.lastIndexOf("/") + 1))
}

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}
