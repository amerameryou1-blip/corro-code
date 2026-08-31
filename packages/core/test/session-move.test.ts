import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, rm } from "fs/promises"
import { Cause, Context, Deferred, Duration, Effect, Exit, Fiber, Layer, LayerMap } from "effect"
import { Worktree } from "@opencode-ai/schema/worktree"
import { Workspace } from "@opencode-ai/schema/workspace"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Instance } from "@opencode-ai/core/instance"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunner } from "@opencode-ai/core/session/runner/index"
import { SessionStore } from "@opencode-ai/core/session/store"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Global } from "@opencode-ai/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [Project.node.replace(globalProjectNode), SessionExecution.node.replace(SessionExecution.noopLayer)],
  ),
)
const itWithActiveExecution = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecution.node,
      Session.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(
        Layer.effect(
          LocationServiceMap.Service,
          LayerMap.make(
            (ref: Location.Ref) =>
              Layer.merge(
                LayerNode.compile(Location.boundNode(ref), {
                  replacements: [Project.node.replace(globalProjectNode)],
                }),
                Layer.succeed(SessionRunner.Service, { drain: () => Effect.never }),
              ) as unknown as Layer.Layer<LocationServices>,
          ),
        ),
      ),
    ],
  ),
)
const itWithExecution = testEffect(
  AppNodeBuilder.build(LayerNode.group([Session.node, SessionExecution.node]), [Global.node.replace(tempGlobalLayer)]),
)
const unavailableLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () => Layer.effectDiscard(Effect.fail(new Error("broken location"))) as unknown as Layer.Layer<LocationServices>,
  ),
)
const itWithUnavailableDestination = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      LocationServiceMap.node.replace(unavailableLocations),
    ],
  ),
)
const itWithSourceProbe = testEffect(Layer.empty)
const sourceProbe = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const source = AbsolutePath.make(path.join(tmp.path, "source"))
  const destination = AbsolutePath.make(tmp.path)
  yield* Effect.promise(() => mkdir(source))
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const replacements: LayerNode.Replacements = [
    Project.node.replace(globalProjectNode),
    SessionExecution.node.replace(SessionExecution.noopLayer),
    Global.node.replace(tempGlobalLayer),
  ]
  const context = yield* Layer.build(
    AppNodeBuilder.build(LayerNode.group([Session.node, Bus.node]), [
      ...replacements,
      LocationServiceMap.node.replace(
        Layer.effect(
          LocationServiceMap.Service,
          LayerMap.make(
            (ref: Location.Ref) =>
              Layer.unwrap(
                Effect.gen(function* () {
                  if (ref.directory === source) {
                    yield* Deferred.succeed(entered, undefined)
                    yield* Deferred.await(release)
                  }
                  return Instance.layer(ref, { replacements })
                }),
              ),
            { idleTimeToLive: Duration.infinity },
          ),
        ),
      ),
    ]),
  )
  return {
    source,
    destination,
    entered,
    release,
    session: Context.get(context, Session.Service),
    bus: Context.get(context, Bus.Service),
  }
})

describe("Session.move", () => {
  itWithExecution.live(
    "recovers an idle session whose source configuration cannot load",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const source = AbsolutePath.make(path.join(tmp.path, "source"))
        const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
        yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
        yield* Effect.promise(() =>
          Bun.write(path.join(source, "opencode.json"), JSON.stringify({ instructions: ["{file:./missing.txt}"] })),
        )
        const session = yield* Session.Service
        const execution = yield* SessionExecution.Service
        const created = yield* session.create({ location: Location.Ref.make({ directory: source }) })

        yield* session.move({ sessionID: created.id, directory: destination })
        yield* execution.awaitIdle(created.id)

        expect((yield* session.get(created.id)).location.directory).toBe(destination)
        expect(yield* session.inbox(created.id)).toEqual([])
      }),
    { timeout: 15_000 },
  )

  itWithSourceProbe.live("does not recover or enqueue a move when source initialization is interrupted", () =>
    Effect.gen(function* () {
      const fixture = yield* sourceProbe
      const created = yield* fixture.session.create({ location: Location.Ref.make({ directory: fixture.source }) })
      const pending = yield* fixture.session.synthetic({ sessionID: created.id, text: "Keep pending", resume: false })
      const moving = yield* fixture.session
        .move({ sessionID: created.id, directory: fixture.destination })
        .pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(fixture.entered)

      yield* Deferred.interrupt(fixture.release)
      const exit = yield* Fiber.join(moving)

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect((yield* fixture.session.get(created.id)).location.directory).toBe(fixture.source)
      expect(yield* fixture.session.inbox(created.id)).toEqual([pending])
    }).pipe(Effect.timeout("5 seconds")),
  )

  for (const changed of ["directory", "workspace"] as const) {
    itWithSourceProbe.live(
      `allows inbox cancellation during a source probe and rejects stale ${changed} recovery`,
      () =>
        Effect.gen(function* () {
          const fixture = yield* sourceProbe
          const created = yield* fixture.session.create({ location: Location.Ref.make({ directory: fixture.source }) })
          const pending = yield* fixture.session.synthetic({
            sessionID: created.id,
            text: "Cancel pending",
            resume: false,
          })
          const moving = yield* fixture.session
            .move({ sessionID: created.id, directory: fixture.destination })
            .pipe(Effect.exit, Effect.forkScoped)
          yield* Deferred.await(fixture.entered)

          yield* fixture.session.cancelInbox({ sessionID: created.id, inboxID: pending.id }).pipe(
            Effect.timeout("2 seconds"),
            Effect.onError(() => Deferred.interrupt(fixture.release)),
          )
          expect(yield* fixture.session.inbox(created.id)).toEqual([])
          expect(moving.pollUnsafe()).toBeUndefined()

          const location = Location.Ref.make({
            directory: changed === "directory" ? fixture.destination : fixture.source,
            workspaceID: changed === "workspace" ? Workspace.ID.create() : undefined,
          })
          // Apply a concurrent placement change while the original source probe is suspended.
          yield* fixture.bus.publish(SessionEvent.Moved, {
            sessionID: created.id,
            location,
            projectID: Project.ID.global,
          })
          yield* Deferred.die(fixture.release, new Error("source unavailable"))
          expect(Exit.isSuccess(yield* Fiber.join(moving))).toBe(true)

          expect((yield* fixture.session.get(created.id)).location).toEqual(location)
          expect(yield* fixture.session.inbox(created.id)).toMatchObject([
            { type: "move", payload: { location: { directory: fixture.destination } } },
          ])
        }).pipe(Effect.timeout("5 seconds")),
    )
  }

  itWithUnavailableDestination.effect("rejects an unavailable destination before admitting the move", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const source = AbsolutePath.make(path.join(tmp.path, "source"))
          const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
          yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
          const created = yield* session.create({ location: Location.Ref.make({ directory: source }) })

          const error = yield* session.move({ sessionID: created.id, directory: destination }).pipe(Effect.flip)

          expect(error).toEqual(new Session.DestinationUnavailableError({ directory: destination }))
          expect((yield* session.get(created.id)).location.directory).toBe(source)
          expect(yield* session.inbox(created.id)).toEqual([])
        }),
      ),
    ),
  )

  it.effect("applies a move immediately when the source directory no longer exists", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const destination = AbsolutePath.make(tmp.path)
          const source = path.join(tmp.path, "source")
          yield* Effect.promise(() => mkdir(source))
          const created = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(source) }),
          })

          yield* session.move({ sessionID: created.id, directory: destination })
          expect((yield* session.get(created.id)).location.directory).toBe(AbsolutePath.make(source))
          expect(yield* session.inbox(created.id)).toHaveLength(1)

          yield* Effect.promise(() => rm(source, { recursive: true }))
          yield* session.move({ sessionID: created.id, directory: destination })

          expect((yield* session.get(created.id)).location.directory).toBe(destination)
          expect(yield* session.inbox(created.id)).toEqual([])

          yield* session.move({ sessionID: created.id, directory: destination })
          expect(yield* session.inbox(created.id)).toHaveLength(1)

          yield* Effect.promise(() => mkdir(path.join(tmp.path, "other")))
          const steered = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "other")) }),
          })
          yield* session.move({ sessionID: steered.id, directory: destination, delivery: "queue" })
          expect(yield* session.inbox(steered.id)).toMatchObject([{ type: "move", delivery: "queue" }])
        }),
      ),
    ),
  )

  itWithActiveExecution.live("defers an active move when the source directory no longer exists", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const execution = yield* SessionExecution.Service
          const source = AbsolutePath.make(path.join(tmp.path, "source"))
          const destination = AbsolutePath.make(tmp.path)
          yield* Effect.promise(() => mkdir(source))
          const created = yield* session.create({ location: Location.Ref.make({ directory: source }) })

          // Hold real execution open so the move cannot be consumed before admission is checked.
          yield* execution.wake(created.id)
          expect(yield* execution.isActive(created.id)).toBe(true)
          yield* Effect.promise(() => rm(source, { recursive: true }))

          yield* session.move({ sessionID: created.id, directory: destination })

          expect((yield* session.get(created.id)).location.directory).toBe(source)
          expect(yield* session.inbox(created.id)).toMatchObject([
            {
              type: "move",
              delivery: "steer",
              payload: { location: { directory: destination } },
            },
          ])
          expect(yield* execution.isActive(created.id)).toBe(true)

          yield* execution.interrupt(created.id)
          yield* execution.awaitIdle(created.id)
        }),
      ),
    ),
  )

  it.effect("keeps a moved session out of its former directory's new identity", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const bus = yield* Bus.Service
          const previous = AbsolutePath.make(path.join(tmp.path, "previous"))
          const destination = AbsolutePath.make(tmp.path)
          const created = yield* session.create({ location: Location.Ref.make({ directory: previous }) })

          // Moves are admitted through the inbox and applied by the drain;
          // publish the applied move directly since execution is a no-op here.
          yield* bus.publish(SessionEvent.Moved, {
            sessionID: created.id,
            location: Location.Ref.make({ directory: destination }),
            projectID: Project.ID.global,
          })
          // The former directory becomes a project after the session left it.
          yield* bus.publish(Worktree.Event.Resolved, {
            projectID: Project.ID.make("adopting"),
            directory: previous,
            previous: Project.ID.global,
          })

          expect(yield* session.get(created.id)).toMatchObject({
            projectID: Project.ID.global,
            location: { directory: destination },
            subpath: undefined,
          })
        }),
      ),
    ),
  )
})
