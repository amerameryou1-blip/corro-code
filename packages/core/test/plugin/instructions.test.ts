import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Instruction } from "@opencode-ai/plugin/instructions"
import { Agent } from "@opencode-ai/schema/agent"
import { Session } from "@opencode-ai/schema/session"
import { Instructions } from "@opencode-ai/core/instructions/index"
import { PluginInstructions } from "@opencode-ai/core/plugin/instructions"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(PluginInstructions.layer)
const context: Instruction.Context = {
  sessionID: Session.ID.make("ses_instructions"),
  agent: Agent.ID.make("build"),
  location: host().location,
}
const key = Instructions.Key.make("example/mode")
const render = { initial: String, changed: (_previous: string, current: string) => current }

it.effect("reads the supplied session snapshot lazily and disposes future source snapshots", () =>
  Effect.gen(function* () {
    const instructions = yield* PluginInstructions.Service
    const seen: Instruction.Context[] = []
    const registration = yield* instructions.transform((draft) => {
      draft.add({
        key,
        codec: Schema.toCodecJson(Schema.String),
        read: (input) =>
          Effect.sync(() => {
            seen.push(input)
            return input.agent
          }),
        render,
      })
    })
    const snapshot = instructions.load(context)
    expect(seen).toEqual([])
    expect(yield* Instructions.read(snapshot)).toEqual([{ key, value: "build" }])
    const other = { ...context, sessionID: Session.ID.make("ses_other"), agent: Agent.ID.make("plan") }
    expect(yield* Instructions.read(instructions.load(other))).toEqual([{ key, value: "plan" }])
    expect(seen).toEqual([context, other])
    yield* registration.dispose
    yield* registration.dispose
    expect(instructions.load(context)).toEqual([])
    expect(yield* Instructions.read(snapshot)).toEqual([{ key, value: "build" }])
  }),
)

it.effect("maps explicit removals and failed reads into the existing instruction algebra", () =>
  Effect.gen(function* () {
    const instructions = yield* PluginInstructions.Service
    let value: Effect.Effect<string | Instruction.Removed | Instruction.Unavailable, unknown> = Effect.succeed("rule")
    yield* instructions.transform((draft) => {
      draft.add({ key, codec: Schema.toCodecJson(Schema.String), read: () => value, render })
    })
    const previous = { [key]: Instructions.hash("rule") }
    value = Effect.succeed(Instruction.removed)
    expect((yield* Instructions.diff(yield* Instructions.read(instructions.load(context)), previous)).delta).toEqual({
      [key]: "removed",
    })
    for (const failure of [
      Effect.succeed(Instruction.unavailable),
      Effect.fail(new Error("offline")),
      Effect.die("offline"),
    ]) {
      value = failure
      const observed = yield* Instructions.read(instructions.load(context))
      expect(observed).toEqual([{ key, value: Instructions.unavailable }])
      expect((yield* Instructions.diff(observed, previous)).delta).toEqual({})
      expect(yield* Instructions.diff(observed).pipe(Effect.flip)).toBeInstanceOf(Instructions.InitializationBlocked)
    }
  }),
)

it.effect("does not confuse sentinel-shaped JSON values with removal", () =>
  Effect.gen(function* () {
    const instructions = yield* PluginInstructions.Service
    yield* instructions.transform((draft) => {
      draft.add({
        key,
        codec: Schema.toCodecJson(Schema.Struct({ _tag: Schema.Literal("Removed") })),
        read: () => Effect.succeed({ _tag: "Removed" } as const),
        render: { initial: JSON.stringify, changed: (_previous, current) => JSON.stringify(current) },
      })
    })
    const observed = yield* Instructions.read(instructions.load(context))
    expect(observed).toEqual([{ key, value: { _tag: "Removed" } }])
    expect((yield* Instructions.diff(observed)).delta).toEqual({ [key]: Instructions.hash({ _tag: "Removed" }) })
  }),
)
