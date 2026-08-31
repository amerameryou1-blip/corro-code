import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Model } from "@opencode-ai/core/model"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRevert } from "@opencode-ai/core/session/revert"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { initRepo, read } from "./fixture/git"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      Session.node,
      SessionExecution.node,
      LocationServiceMap.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Global.node.replace(tempGlobalLayer),
      // These tests move directories explicitly; native watchers can hold them open on Windows.
      Watcher.node.replace(Watcher.configured({ enabled: false })),
    ],
  ),
)

describe("Session.revert files", () => {
  for (const encoding of ["qualified", "legacy"] as const) {
    const stored = (id: Snapshot.ID) =>
      encoding === "legacy" ? Snapshot.ID.make(id.slice(id.lastIndexOf("/") + 1)) : id
    for (const move of [
      "repository rename",
      "another worktree",
      "another project",
      "same worktree subdirectory",
    ] as const) {
      it.live(
        `restores ${encoding} staged file changes after moving to ${move}`,
        () =>
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            const directory = path.join(tmp.path, "project")
            const destination = AbsolutePath.make(
              move === "same worktree subdirectory"
                ? path.join(directory, "nested")
                : path.join(tmp.path, "destination"),
            )
            yield* Effect.promise(async () => {
              await fs.mkdir(directory)
              await Bun.write(path.join(directory, "file.txt"), "Before assistant edit.\n")
              await Bun.write(path.join(directory, "unrelated.txt"), "Unrelated source content.\n")
              await initRepo(directory)
              await $`git add .`.cwd(directory).quiet()
              await $`git commit -qm initial`.cwd(directory).quiet()
              if (move === "another worktree")
                await $`git worktree add --detach ${destination} HEAD`.cwd(directory).quiet()
              if (move === "another project") {
                await fs.mkdir(destination)
                await Bun.write(path.join(destination, "file.txt"), "Destination content.\n")
                await $`git init -q`.cwd(destination).quiet()
                await $`git -c core.fsmonitor=false add .`.cwd(destination).quiet()
              }
              if (move === "same worktree subdirectory") await fs.mkdir(destination)
            })

            const bus = yield* Bus.Service
            const execution = yield* SessionExecution.Service
            const { session, created, prompt } = yield* recordSnapshotStep(
              directory,
              () => Bun.write(path.join(directory, "file.txt"), "After assistant edit.\n"),
              stored,
            )

            const staged = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id, files: true })
            const reverted = { ...staged, snapshot: staged.snapshot && stored(staged.snapshot) }
            if (encoding === "legacy")
              yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: created.id, revert: reverted })
            expect(reverted.snapshot).toBeDefined()
            expect(reverted.files?.map((file) => file.file)).toEqual(["file.txt"])
            expect(yield* read(path.join(directory, "file.txt"))).toBe("Before assistant edit.\n")

            if (move === "repository rename") yield* Effect.promise(() => fs.rename(directory, destination))
            const root = move === "same worktree subdirectory" ? directory : destination
            yield* Effect.promise(() => Bun.write(path.join(root, "unrelated.txt"), "Keep this destination edit.\n"))
            const indexPath = yield* Effect.promise(async () =>
              path.resolve(root, (await $`git rev-parse --git-path index`.cwd(root).quiet().text()).trim()),
            )
            const index = yield* Effect.promise(() => Bun.file(indexPath).arrayBuffer())
            yield* session.move({ sessionID: created.id, directory: destination })
            yield* execution.awaitIdle(created.id)
            const moved = yield* session.get(created.id)
            expect(moved.location.directory).toBe(destination)
            expect(moved.projectID === created.projectID).toBe(move !== "another project")
            expect(moved.revert).toEqual(reverted)

            yield* session.revert.clear(created.id)
            expect(yield* read(path.join(root, "file.txt"))).toBe("After assistant edit.\n")
            expect((yield* session.get(created.id)).revert).toBeUndefined()
            expect(yield* read(path.join(root, "unrelated.txt"))).toBe("Keep this destination edit.\n")
            if (move === "another worktree" || move === "another project")
              expect(yield* read(path.join(directory, "file.txt"))).toBe("Before assistant edit.\n")
            yield* execution.awaitIdle(created.id)
            yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id, files: true })
            expect(yield* read(path.join(root, "file.txt"))).toBe("Before assistant edit.\n")
            yield* session.revert.clear(created.id)
            expect(yield* read(path.join(root, "file.txt"))).toBe("After assistant edit.\n")
            expect(yield* Effect.promise(() => Bun.file(indexPath).arrayBuffer())).toEqual(index)
          }),
        { timeout: 15_000 },
      )
    }

    it.live(
      `rejects ${encoding} redo through a destination symlink ancestor`,
      () =>
        Effect.gen(function* () {
          const source = yield* tmpdirScoped()
          const destination = yield* tmpdirScoped()
          const file = path.join(source.path, "assets/logo.svg")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.dirname(file))
            await Bun.write(file, "Before assistant edit.\n")
            await initRepo(source.path)
            await fs.symlink(path.dirname(file), path.join(destination.path, "assets"), "dir")
            await $`git init -q`.cwd(destination.path).quiet()
          })
          const bus = yield* Bus.Service
          const execution = yield* SessionExecution.Service
          const { session, created, prompt } = yield* recordSnapshotStep(source.path, () => fs.rm(file), stored)
          const staged = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id, files: true })
          const reverted = { ...staged, snapshot: staged.snapshot && stored(staged.snapshot) }
          yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: created.id, revert: reverted })
          yield* session.move({ sessionID: created.id, directory: AbsolutePath.make(destination.path) })
          yield* execution.awaitIdle(created.id)
          expect((yield* session.get(created.id)).projectID).not.toBe(created.projectID)

          const error = yield* session.revert.clear(created.id).pipe(Effect.flip)
          expect(error).toBeInstanceOf(Snapshot.Error)
          expect(error).toMatchObject({
            operation: "restore",
            message: expect.stringContaining("Path escapes the project"),
          })
          expect(yield* read(file)).toBe("Before assistant edit.\n")
          expect((yield* session.get(created.id)).revert).toEqual(reverted)
        }),
      { timeout: 15_000 },
    )

    it.live(
      `recovers ${encoding} redo after missing snapshot data returns`,
      () =>
        Effect.gen(function* () {
          const source = yield* tmpdirScoped()
          const destination = yield* tmpdirScoped()
          yield* Effect.promise(async () => {
            await initRepo(source.path)
            await Bun.write(path.join(source.path, "file.txt"), "Before assistant edit.\n")
            await Bun.write(path.join(source.path, "unrelated.txt"), "Borrowed committed content.\n")
            await $`git add .`.cwd(source.path).quiet()
            await $`git commit -qm initial`.cwd(source.path).quiet()
            await Bun.write(path.join(destination.path, "file.txt"), "Destination content.\n")
            await $`git init -q`.cwd(destination.path).quiet()
          })
          const bus = yield* Bus.Service
          const execution = yield* SessionExecution.Service
          const { session, created, prompt } = yield* recordSnapshotStep(
            source.path,
            () => Bun.write(path.join(source.path, "file.txt"), "After assistant edit.\n"),
            stored,
          )
          const staged = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id, files: true })
          const reverted = { ...staged, snapshot: staged.snapshot && stored(staged.snapshot) }
          yield* session.move({ sessionID: created.id, directory: AbsolutePath.make(destination.path) })
          yield* execution.awaitIdle(created.id)

          const unavailable = {
            ...reverted,
            snapshot: stored(Snapshot.ID.make(`snapshot:missing/${"0".repeat(40)}/${"0".repeat(40)}`)),
          }
          yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: created.id, revert: unavailable })
          expect(yield* session.revert.clear(created.id).pipe(Effect.flip)).toBeInstanceOf(Snapshot.Error)
          expect((yield* session.get(created.id)).revert).toEqual(unavailable)
          expect(yield* read(path.join(destination.path, "file.txt"))).toBe("Destination content.\n")

          yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: created.id, revert: reverted })
          const seed = path.join(source.path, ".git")
          const missing = path.join(source.path, "unavailable-seed")
          yield* Effect.promise(() => fs.rename(seed, missing))
          expect(yield* session.revert.clear(created.id).pipe(Effect.flip)).toBeInstanceOf(Snapshot.Error)
          expect((yield* session.get(created.id)).revert).toEqual(reverted)
          expect(yield* read(path.join(destination.path, "file.txt"))).toBe("Destination content.\n")

          yield* Effect.promise(() => fs.rename(missing, seed))
          yield* session.revert.clear(created.id)
          expect(yield* read(path.join(destination.path, "file.txt"))).toBe("After assistant edit.\n")
          expect((yield* session.get(created.id)).revert).toBeUndefined()
        }),
      { timeout: 15_000 },
    )
  }

  it.live(
    "undoes and restores a file rename without losing either path",
    () =>
      Effect.gen(function* () {
        const directory = (yield* tmpdirScoped()).path
        const original = path.join(directory, "old name.txt")
        const renamed = path.join(directory, "new name.txt")
        yield* Effect.promise(async () => {
          await Bun.write(original, "Preserve this content.\n")
          await Bun.write(path.join(directory, "unrelated.txt"), "Unrelated content.\n")
          await $`git init -q`.cwd(directory).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
        })

        const { session, created, prompt } = yield* recordSnapshotStep(directory, () => fs.rename(original, renamed))
        const services = LocationServiceMap.Service.get(created.location)
        const revert = yield* SessionRevert.Service.pipe(Effect.provide(services))
        expect(yield* SessionRevert.Service.pipe(Effect.provide(services))).toBe(revert)

        yield* Effect.promise(() => Bun.write(path.join(directory, "unrelated.txt"), "Keep this later edit.\n"))
        const reverted = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id })
        expect({
          original: yield* Effect.promise(() => Bun.file(original).exists()),
          renamed: yield* Effect.promise(() => Bun.file(renamed).exists()),
        }).toEqual({ original: true, renamed: false })
        expect(yield* read(original)).toBe("Preserve this content.\n")
        expect(reverted.files?.map((file) => [file.file, file.status])).toEqual([
          ["new name.txt", "deleted"],
          ["old name.txt", "added"],
        ])
        expect(yield* read(path.join(directory, "unrelated.txt"))).toBe("Keep this later edit.\n")

        yield* session.revert.clear(created.id)
        expect(yield* Effect.promise(() => Bun.file(original).exists())).toBe(false)
        expect(yield* read(renamed)).toBe("Preserve this content.\n")
        expect(yield* read(path.join(directory, "unrelated.txt"))).toBe("Keep this later edit.\n")
        expect((yield* session.get(created.id)).revert).toBeUndefined()
      }),
    // Real Location/plugin startup and Git snapshots can exceed five seconds under CI load.
    { timeout: 15_000 },
  )
})

const recordSnapshotStep = Effect.fnUntraced(function* (
  directory: string,
  mutate: () => Promise<unknown>,
  stored = (id: Snapshot.ID) => id,
) {
  const session = yield* Session.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
  const prompt = yield* session.prompt({ sessionID: created.id, text: "Edit the files", resume: false })
  yield* SessionInbox.promote(database.db, bus, created.id, "steer")
  yield* Effect.gen(function* () {
    const plugins = yield* PluginSupervisor.Service
    yield* plugins.flush
    const snapshot = yield* Snapshot.Service
    const before = yield* snapshot.capture()
    if (!before) throw new Error("Initial snapshot missing")
    const assistantMessageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.Step.Started, {
      sessionID: created.id,
      assistantMessageID,
      agent: Agent.defaultID,
      model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
      snapshot: stored(before),
    })
    yield* Effect.promise(mutate)
    const after = yield* snapshot.capture()
    if (!after) throw new Error("Edited snapshot missing")
    yield* bus.publish(SessionEvent.Step.Ended, {
      sessionID: created.id,
      assistantMessageID,
      finish: "stop",
      cost: Money.USD.zero,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      snapshot: stored(after),
      files: yield* snapshot.files({ from: before, to: after }),
    })
  }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))
  return { session, created, prompt }
})
