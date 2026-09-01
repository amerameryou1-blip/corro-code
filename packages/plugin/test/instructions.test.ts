import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Instruction, Plugin } from "@opencode-ai/plugin/effect"
import type { InstructionDomain, InstructionDraft, Source } from "@opencode-ai/plugin/effect/instructions"
import { fromPromise } from "@opencode-ai/plugin/promise/adapter"
import { Agent } from "@opencode-ai/schema/agent"
import { Location } from "@opencode-ai/schema/location"
import { Project } from "@opencode-ai/schema/project"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Exit, Schema, Scope } from "effect"

const context: Instruction.Context = Object.freeze({
  sessionID: Session.ID.make("ses_instructions"),
  agent: Agent.ID.make("build"),
  location: new Location.Info({
    directory: AbsolutePath.make("/workspace/packages/plugin"),
    project: {
      id: Project.ID.make("project"),
      directory: AbsolutePath.make("/workspace"),
      canonical: AbsolutePath.make("/workspace"),
    },
  }),
})

test("instruction sentinels survive a separately evaluated plugin-package copy", async () => {
  const source = await Bun.file(new URL("../src/instructions.ts", import.meta.url)).text()
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
    source.replace('export * as Instruction from "./instructions.js"', ""),
  )
  const directory = await mkdtemp(path.join(tmpdir(), "plugin-instructions-"))
  try {
    const file = path.join(directory, "instructions.mjs")
    await Bun.write(file, code)
    const other: typeof Instruction = await import(file)
    expect(other.removed).toBe(Instruction.removed)
    expect(other.unavailable).toBe(Instruction.unavailable)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Promise instruction reads preserve decoded values, context, renderers, and sentinel identity", async () => {
  const sources: Array<Pick<Source<unknown>, "key" | "read"> & { codec: Schema.Top; render: unknown }> = []
  const render = { initial: String, changed: (previous: number, current: number) => `${previous} -> ${current}` }
  const observed: Instruction.Context[] = []
  const lookalike = { _tag: "Removed" }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* fromPromise({
          id: "instructions",
          setup: async (ctx) => {
            await ctx.experimental.instructions.transform((draft) => {
              draft.add({
                key: "count",
                codec: Schema.FiniteFromString,
                read: async (input) => {
                  observed.push(input)
                  await Promise.resolve()
                  return 42
                },
                render,
              })
              for (const [key, result] of [
                ["Removed", Instruction.removed],
                ["Unavailable", Instruction.unavailable],
              ] as const) {
                draft.add({ key, codec: Schema.Number, read: () => result, render })
              }
              draft.add({
                key: "lookalike",
                codec: Schema.Struct({ _tag: Schema.String }),
                read: () => lookalike,
                render: { initial: (current) => current._tag, changed: (previous) => previous._tag },
              })
            })
          },
        }).effect(
          host({
            transform: (callback) =>
              Effect.sync(() => {
                callback({ add: (source) => sources.push(source) })
                return { dispose: Effect.void }
              }),
            reload: () => Effect.void,
          }),
        )
        expect(observed).toEqual([])
        expect(sources.map((source) => source.key)).toEqual(["count", "Removed", "Unavailable", "lookalike"])
        expect(sources[0].codec).toBe(Schema.FiniteFromString)
        expect(sources[0].render).toBe(render)
        const values = yield* Effect.forEach(sources, (source) => source.read(context))
        expect(values[0]).toBe(42)
        expect(values[1]).toBe(Instruction.removed)
        expect(values[2]).toBe(Instruction.unavailable)
        expect(values[3]).toBe(lookalike)
        expect(values[3]).not.toBe(Instruction.removed)
        expect(observed).toEqual([context])
        expect(observed[0]).toBe(context)
      }),
    ),
  )
})

test.each(["throw", "reject"])("Promise instruction read %s remains a typed failure", async (kind) => {
  const error = new Error(kind)
  const sources: Array<Pick<Source<unknown>, "read">> = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* fromPromise({
          id: "failed-instructions",
          setup: async (ctx) => {
            await ctx.experimental.instructions.transform((draft) =>
              draft.add({
                key: "failed",
                codec: Schema.String,
                read: () => {
                  if (kind === "reject") return Promise.reject(error)
                  throw error
                },
                render: { initial: (current) => current, changed: (previous) => previous },
              }),
            )
          },
        }).effect(
          host({
            transform: (callback) =>
              Effect.sync(() => {
                callback({ add: (source) => sources.push(source) })
                return { dispose: Effect.void }
              }),
            reload: () => Effect.void,
          }),
        )
        const result = yield* Effect.flip(sources[0].read(context))
        expect(result).toBe(error)
      }),
    ),
  )
})

test("Promise instruction registrations use the plugin scope and forward reload and disposal", async () => {
  const active = new Set<(draft: InstructionDraft) => void>()
  const seen: string[] = []
  const instructions: InstructionDomain = {
    transform: (callback) =>
      Effect.gen(function* () {
        active.add(callback)
        const dispose = Effect.sync(() => {
          active.delete(callback)
        })
        yield* Effect.addFinalizer(() => dispose)
        return { dispose }
      }),
    reload: () =>
      Effect.sync(() => {
        for (const callback of active) callback({ add: (source) => seen.push(source.key) })
      }),
  }
  const scope = Effect.runSync(Scope.make())
  await Effect.runPromise(
    fromPromise({
      id: "scoped-instructions",
      setup: async (ctx) => {
        const first = await ctx.experimental.instructions.transform((draft) =>
          draft.add({
            key: "first",
            codec: Schema.Number,
            read: () => 1,
            render: { initial: String, changed: String },
          }),
        )
        await ctx.experimental.instructions.reload()
        await first.dispose()
        await first.dispose()
        await ctx.experimental.instructions.reload()
        expect(active.size).toBe(0)
        await ctx.experimental.instructions.transform((draft) =>
          draft.add({
            key: "second",
            codec: Schema.Number,
            read: () => 2,
            render: { initial: String, changed: String },
          }),
        )
        await ctx.experimental.instructions.reload()
        await ctx.experimental.instructions.reload()
      },
    })
      .effect(host(instructions))
      .pipe(Effect.provideService(Scope.Scope, scope)),
  )
  expect(seen).toEqual(["first", "second", "second"])
  expect(active.size).toBe(1)
  await Effect.runPromise(Scope.close(scope, Exit.void))
  expect(active.size).toBe(0)
})

function host(instructions: InstructionDomain): Plugin.Context {
  // SAFETY: Only instruction methods are invoked; other domains provide the adapter's lookup structure.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return {
    app: { name: "test", version: "test", channel: "test" },
    location: context.location,
    options: {},
    agent: {},
    aisdk: {},
    catalog: { provider: {}, model: {} },
    command: {},
    event: {},
    experimental: { instructions, terminal: {} },
    generate: {},
    integration: { connect: {}, oauth: {}, command: {}, connection: {} },
    mcp: {},
    permission: {},
    plugin: {},
    reference: {},
    rpc: {},
    session: {},
    shell: {},
    skill: {},
    storage: {},
    tool: {},
    vcs: {},
    websearch: {},
  } as Plugin.Context
}
