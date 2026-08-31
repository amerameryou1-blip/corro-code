import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
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
      [Bus.node, Bus.configured({ persist: true })],
      [Global.node, tempGlobalLayer],
    ],
  ),
)

describe("Session.revert files", () => {
  for (const encoding of ["qualified", "legacy"] as const) {
    for (const move of [
      "repository rename",
      "another worktree",
      "another project",
      "symlink ancestor",
      "same worktree subdirectory",
    ] as const) {
      it.live(
        move === "symlink ancestor"
          ? `rejects ${encoding} redo through a destination symlink ancestor`
          : `restores ${encoding} staged file changes after moving to ${move}`,
        () =>
          Effect.gen(function* () {
            const tmp = yield* tmpdirScoped()
            const directory = path.join(tmp.path, "project")
            const file = move === "symlink ancestor" ? "assets/logo.svg" : "file.txt"
            const destination = AbsolutePath.make(
              move === "same worktree subdirectory"
                ? path.join(directory, "nested")
                : path.join(tmp.path, "destination"),
            )
            yield* Effect.promise(async () => {
              await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true })
              await Bun.write(path.join(directory, file), "Before assistant edit.\n")
              await Bun.write(path.join(directory, "unrelated.txt"), "Unrelated source content.\n")
              await $`git init -q`.cwd(directory).quiet()
              await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
              await $`git -c user.name=Test -c user.email=test@example.com -c commit.gpgsign=false commit -qm initial`
                .cwd(directory)
                .quiet()
              if (move === "another worktree")
                await $`git worktree add --detach ${destination} HEAD`.cwd(directory).quiet()
              if (move === "another project" || move === "symlink ancestor") {
                await fs.mkdir(destination)
                if (move === "another project") await Bun.write(path.join(destination, file), "Destination content.\n")
                if (move === "symlink ancestor")
                  await fs.symlink(path.join(directory, "assets"), path.join(destination, "assets"), "dir")
                await $`git init -q`.cwd(destination).quiet()
                await $`git -c core.fsmonitor=false add .`.cwd(destination).quiet()
              }
              if (move === "same worktree subdirectory") await fs.mkdir(destination)
            })

            const session = yield* Session.Service
            const database = yield* Database.Service
            const bus = yield* Bus.Service
            const execution = yield* SessionExecution.Service
            const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
            const prompt = yield* session.prompt({ sessionID: created.id, text: "Edit the file", resume: false })
            yield* SessionInbox.promote(database.db, bus, created.id, "steer")
            const stored = (id: Snapshot.ID) =>
              encoding === "legacy" ? Snapshot.ID.make(id.slice(id.lastIndexOf("/") + 1)) : id
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
              yield* Effect.promise(async () => {
                if (move === "symlink ancestor") return fs.rm(path.join(directory, file))
                await Bun.write(path.join(directory, file), "After assistant edit.\n")
              })
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

            const staged = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id, files: true })
            const reverted = { ...staged, snapshot: staged.snapshot && stored(staged.snapshot) }
            if (encoding === "legacy")
              yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: created.id, revert: reverted })
            expect(reverted.snapshot).toBeDefined()
            expect(reverted.files?.map((file) => file.file)).toEqual([file])
            expect(yield* Effect.promise(() => Bun.file(path.join(directory, file)).text())).toBe(
              "Before assistant edit.\n",
            )

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
            if (move === "another project" || move === "symlink ancestor")
              expect(moved.projectID).not.toBe(created.projectID)
            if (move !== "another project" && move !== "symlink ancestor")
              expect(moved.projectID).toBe(created.projectID)
            expect(moved.revert).toEqual(reverted)

            if (move === "symlink ancestor") {
              const error = yield* session.revert
                .clear(created.id)
                .pipe(Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }))
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, file)).exists())).toBe(true)
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, file)).text())).toBe(
                "Before assistant edit.\n",
              )
              expect(error).toBeInstanceOf(Snapshot.Error)
              expect(error).toMatchObject({
                operation: "restore",
                message: expect.stringContaining("Path escapes the project"),
              })
              expect((yield* session.get(created.id)).revert).toEqual(reverted)
              return
            }

            if (move === "another project") {
              const unavailable = {
                ...reverted,
                snapshot: Snapshot.ID.make(
                  encoding === "legacy" ? "0".repeat(40) : `snapshot:missing/${"0".repeat(40)}/${"0".repeat(40)}`,
                ),
              }
              yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: created.id, revert: unavailable })
              expect(yield* session.revert.clear(created.id).pipe(Effect.flip)).toBeInstanceOf(Snapshot.Error)
              expect((yield* session.get(created.id)).revert).toEqual(unavailable)
              expect(yield* Effect.promise(() => Bun.file(path.join(root, "file.txt")).text())).toBe(
                "Destination content.\n",
              )
              yield* bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: created.id, revert: reverted })
              yield* Effect.promise(() =>
                fs.rename(path.join(directory, ".git"), path.join(tmp.path, "unavailable-seed")),
              )
              expect(yield* session.revert.clear(created.id).pipe(Effect.flip)).toBeInstanceOf(Snapshot.Error)
              expect((yield* session.get(created.id)).revert).toEqual(reverted)
              expect(yield* Effect.promise(() => Bun.file(path.join(root, "file.txt")).text())).toBe(
                "Destination content.\n",
              )
              yield* Effect.promise(() =>
                fs.rename(path.join(tmp.path, "unavailable-seed"), path.join(directory, ".git")),
              )
            }

            yield* session.revert.clear(created.id)
            expect(yield* Effect.promise(() => Bun.file(path.join(root, "file.txt")).text())).toBe(
              "After assistant edit.\n",
            )
            expect((yield* session.get(created.id)).revert).toBeUndefined()
            expect(yield* Effect.promise(() => Bun.file(path.join(root, "unrelated.txt")).text())).toBe(
              "Keep this destination edit.\n",
            )
            if (move === "another worktree" || move === "another project")
              expect(yield* Effect.promise(() => Bun.file(path.join(directory, "file.txt")).text())).toBe(
                "Before assistant edit.\n",
              )
            yield* execution.awaitIdle(created.id)
            yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id, files: true })
            expect(yield* Effect.promise(() => Bun.file(path.join(root, "file.txt")).text())).toBe(
              "Before assistant edit.\n",
            )
            yield* session.revert.clear(created.id)
            expect(yield* Effect.promise(() => Bun.file(path.join(root, "file.txt")).text())).toBe(
              "After assistant edit.\n",
            )
            expect(yield* Effect.promise(() => Bun.file(indexPath).arrayBuffer())).toEqual(index)
          }),
        { timeout: 15_000 },
      )
    }
  }

  it.live(
    "undoes and restores a file rename without losing either path",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        const original = path.join(directory, "old name.txt")
        const renamed = path.join(directory, "new name.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(directory)
          await Bun.write(original, "Preserve this content.\n")
          await Bun.write(path.join(directory, "unrelated.txt"), "Unrelated content.\n")
          await $`git init -q`.cwd(directory).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
        })

        const session = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const prompt = yield* session.prompt({ sessionID: created.id, text: "Rename the file", resume: false })
        yield* SessionInbox.promote(database.db, bus, created.id, "steer")
        const services = LocationServiceMap.Service.get(created.location)
        const revert = yield* SessionRevert.Service.pipe(Effect.provide(services))
        expect(yield* SessionRevert.Service.pipe(Effect.provide(services))).toBe(revert)

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
            snapshot: before,
          })
          yield* Effect.promise(() => fs.rename(original, renamed))
          const after = yield* snapshot.capture()
          if (!after) throw new Error("Renamed snapshot missing")
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: created.id,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            snapshot: after,
            files: yield* snapshot.files({ from: before, to: after }),
          })

          yield* Effect.promise(() => Bun.write(path.join(directory, "unrelated.txt"), "Keep this later edit.\n"))
          const reverted = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id })
          expect({
            original: yield* Effect.promise(() => Bun.file(original).exists()),
            renamed: yield* Effect.promise(() => Bun.file(renamed).exists()),
          }).toEqual({ original: true, renamed: false })
          expect(yield* Effect.promise(() => Bun.file(original).text())).toBe("Preserve this content.\n")
          expect(reverted.files?.map((file) => [file.file, file.status])).toEqual([
            ["new name.txt", "deleted"],
            ["old name.txt", "added"],
          ])
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "unrelated.txt")).text())).toBe(
            "Keep this later edit.\n",
          )

          yield* session.revert.clear(created.id)
          expect(yield* Effect.promise(() => Bun.file(original).exists())).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(renamed).text())).toBe("Preserve this content.\n")
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "unrelated.txt")).text())).toBe(
            "Keep this later edit.\n",
          )
          expect((yield* session.get(created.id)).revert).toBeUndefined()
        }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))
      }),
    // Real Location/plugin startup and Git snapshots can exceed five seconds under CI load.
    { timeout: 15_000 },
  )
})
