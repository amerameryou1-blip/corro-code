import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Git } from "@opencode-ai/core/git"
import { Global } from "@opencode-ai/util/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/util/hash"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  for (const transition of ["symlink", "file"] as const) {
    testEffect(Layer.empty).live(`restores directory/${transition} transitions without touching external files`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const assets = path.join(project, "assets")
            const external = path.join(tmp.path, "external")
            const leaf = transition === "symlink" ? "assets/logo.svg" : "assets/nested/logo.svg"
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await fs.mkdir(external)
              await Bun.write(path.join(external, "logo.svg"), "External content must survive.\n")
              if (transition === "symlink") await fs.symlink(external, assets, "dir")
              if (transition === "file") {
                await fs.mkdir(path.dirname(path.join(project, leaf)), { recursive: true })
                await Bun.write(path.join(project, leaf), "Directory content.\n")
              }
              await initGit(project)
            })
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              const before = yield* snapshot.capture()
              if (!before) throw new Error("Initial snapshot missing")
              yield* Effect.promise(async () => {
                await fs.rm(assets, { recursive: true })
                if (transition === "file") await Bun.write(assets, "File content.\n")
                if (transition === "symlink") {
                  await fs.mkdir(assets)
                  await Bun.write(path.join(project, leaf), "Directory content.\n")
                }
              })
              const after = yield* snapshot.capture()
              if (!after) throw new Error("Changed snapshot missing")
              const files = yield* snapshot.files({ from: before, to: after })
              expect(files).toEqual([RelativePath.make("assets"), RelativePath.make(leaf)])
              const restored = yield* snapshot
                .restore({ files: new Map(files.map((file) => [file, before])) })
                .pipe(Effect.exit)
              expect(yield* Effect.promise(() => Bun.file(path.join(external, "logo.svg")).exists())).toBe(true)
              expect(yield* read(path.join(external, "logo.svg"))).toBe("External content must survive.\n")
              yield* restored
              if (transition === "symlink") {
                expect(yield* Effect.promise(() => fs.readlink(assets))).toBe(external)
                yield* Effect.promise(async () => {
                  await fs.rm(assets)
                  await fs.mkdir(assets)
                })
                yield* snapshot.restore({
                  files: new Map([
                    [RelativePath.make("assets"), before],
                    [RelativePath.make(leaf), after],
                  ]),
                })
                expect(yield* read(path.join(external, "logo.svg"))).toBe("External content must survive.\n")
                expect(yield* Effect.promise(async () => (await fs.lstat(assets)).isDirectory())).toBe(true)
                expect(yield* read(path.join(project, leaf))).toBe("Directory content.\n")
                return
              }
              expect(yield* read(path.join(project, leaf))).toBe("Directory content.\n")
              yield* snapshot.restore({ files: new Map(files.toReversed().map((file) => [file, after])) })
              expect(yield* read(assets)).toBe("File content.\n")
            }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  testEffect(Layer.empty).live("keeps lazy repository discovery after the first caller is interrupted", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })

          const git = yield* Git.Service.pipe(Effect.provide(AppNodeBuilder.build(Git.node)))
          const location = yield* Location.Service.pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          const started = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          let discoveries = 0
          let creations = 0
          const instrumented = Git.Service.of({
            ...git,
            repo: {
              ...git.repo,
              discover: (input) => {
                discoveries++
                return git.repo.discover(input)
              },
              create: (input) =>
                Effect.gen(function* () {
                  creations++
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                  return yield* git.repo.create(input)
                }),
            },
          })
          const layer = AppNodeBuilder.build(Snapshot.node, [
            [Location.node, Layer.succeed(Location.Service, location)],
            [Global.node, Global.layerWith({ data: tmp.path, config: path.join(tmp.path, "config") })],
            [Git.node, Layer.succeed(Git.Service, instrumented)],
          ])

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            expect(discoveries).toBe(0)

            const interrupted = yield* snapshot.capture().pipe(Effect.forkChild)
            yield* Deferred.await(started)
            expect(discoveries).toBe(1)
            expect(creations).toBe(1)
            yield* Fiber.interrupt(interrupted)

            const capture = yield* snapshot.capture().pipe(Effect.forkChild)
            expect(discoveries).toBe(1)
            expect(creations).toBe(1)
            yield* Deferred.succeed(release, undefined)
            expect(yield* Fiber.join(capture)).toBeDefined()
            expect(discoveries).toBe(1)
            expect(creations).toBe(1)
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await initGit(project)
          })

          const layer = snapshotLayer(tmp.path, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            yield* Effect.promise(() => fs.symlink("loop", path.join(location, "loop")))
            expect(
              yield* snapshot
                .restore({ files: new Map([[RelativePath.make("scope/loop/file.txt"), before]]) })
                .pipe(Effect.flip),
            ).toMatchObject({
              operation: "restore",
              cause: { reason: { cause: { code: "ELOOP" } } },
            })
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
            const error = yield* snapshot
              .restore({
                files: new Map([[RelativePath.make("../escape.txt"), before]]),
              })
              .pipe(Effect.flip)
            expect(error.message).toContain("Path escapes the project")
            expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "escape.txt")).exists())).toBe(false)
            expect(
              yield* snapshot
                .restore({
                  files: new Map([
                    [
                      RelativePath.make("scope/tracked.txt"),
                      Snapshot.ID.make(`snapshot:../${"0".repeat(40)}/${"0".repeat(40)}`),
                    ],
                  ]),
                })
                .pipe(Effect.flip),
            ).toMatchObject({ operation: "restore", message: "Invalid snapshot reference" })
            yield* Effect.promise(async () => {
              await Bun.write(path.join(tmp.path, "target.txt"), "Keep the external target.\n")
              await fs.symlink(path.join(tmp.path, "target.txt"), path.join(location, "link.txt"))
            })
            yield* snapshot.restore({ files: new Map([[RelativePath.make("scope/link.txt"), before]]) })
            expect(yield* Effect.promise(() => Bun.file(path.join(location, "link.txt")).exists())).toBe(false)
            expect(yield* read(path.join(tmp.path, "target.txt"))).toBe("Keep the external target.\n")
            yield* Effect.promise(() => fs.rm(location, { recursive: true }))
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats fatal ignore checks as unavailable captures", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await Bun.write(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            expect(yield* snapshot.capture()).toBeDefined()
            yield* Effect.promise(async () => {
              await Bun.write(path.join(project, "tracked.txt"), "two\n")
              await Bun.write(path.join(project, ".git", "config"), "[broken\n")
            })
            expect(yield* snapshot.capture()).toBeUndefined()
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("applies availability transforms", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await initGit(project)
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const registration = yield* snapshot.transform((draft) => draft.configure(false))
            expect(yield* snapshot.capture()).toBeUndefined()

            yield* registration.dispose
            expect(yield* snapshot.capture()).toBeDefined()
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live(
    "isolates snapshot indexes by canonical Git worktree",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const linked = path.join(tmp.path, "linked")
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
              await initGit(project, true)
              await $`git -c core.fsmonitor=false worktree add --detach ${linked} HEAD`.cwd(project).quiet()
            })

            const capture = (directory: string) =>
              Effect.gen(function* () {
                const snapshot = yield* Snapshot.Service
                return yield* snapshot.capture()
              }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
            yield* Effect.promise(() => Bun.write(path.join(project, "tracked.txt"), "Uncommitted source content.\n"))
            const captured = yield* capture(project)
            if (!captured) throw new Error("Snapshot missing")
            expect(yield* capture(linked)).toBeDefined()
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              expect(
                yield* snapshot.diff({
                  from: captured,
                  to: Snapshot.ID.make(captured.slice(captured.lastIndexOf("/") + 1)),
                }),
              ).toEqual([])
              expect(yield* read(path.join(linked, "tracked.txt"))).toBe("main\n")
            }).pipe(Effect.provide(snapshotLayer(tmp.path, linked)))

            const projectID = yield* Effect.gen(function* () {
              return (yield* Location.Service).project.id
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
              ),
            )
            expect(
              yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(project)))),
            ).toBeDefined()
            expect(
              yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(linked)))),
            ).toBeDefined()
          }),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    { timeout: 15_000 },
  )
})

function snapshotLayer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
  ])
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}

async function initGit(directory: string, commit = false) {
  await $`git init`.cwd(directory).quiet()
  await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
  if (!commit) return
  await $`git -c user.email=test@opencode.test -c user.name=Test commit --no-gpg-sign -m initial`.cwd(directory).quiet()
}
