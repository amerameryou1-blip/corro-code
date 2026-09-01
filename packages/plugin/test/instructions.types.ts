import { Instruction, Plugin } from "@opencode-ai/plugin/effect"
import type { Source } from "@opencode-ai/plugin/effect/instructions"
import type { Registration } from "@opencode-ai/plugin/effect/registration"
import type { Context } from "@opencode-ai/plugin/promise/plugin"
import { Agent } from "@opencode-ai/schema/agent"
import type { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import type { Assert, Equal } from "./rpc.fixture.js"

declare const effect: Plugin.Context
declare const promise: Context

const registration = effect.experimental.instructions.transform((draft) => {
  draft.add({
    key: "count",
    codec: Schema.Struct({ count: Schema.Number }),
    read: (context) => {
      context.sessionID satisfies Session.ID
      context.agent satisfies Agent.ID
      context.location satisfies Location.Info
      // @ts-expect-error The read context is a readonly snapshot.
      context.agent = Agent.ID.make("other")
      // @ts-expect-error Nested location information is readonly too.
      context.location.project.directory = context.location.directory
      return Effect.succeed({ count: 1 })
    },
    render: {
      initial: (current) => String(current.count satisfies number),
      changed: (previous, current) => {
        // @ts-expect-error Schema-inferred snapshot fields stay readonly.
        current.count = previous.count
        return String((current.count satisfies number) - (previous.count satisfies number))
      },
      removed: (previous) => String(previous.count satisfies number),
    },
  })
  for (const result of [Instruction.removed, Instruction.unavailable] as const) {
    draft.add({
      key: "optional",
      codec: Schema.String,
      read: () => Effect.succeed(result),
      render: { initial: (current) => current satisfies string, changed: (previous) => previous satisfies string },
    })
  }
  draft.add({
    key: "failed",
    codec: Schema.Number,
    read: () => Effect.fail(new Error("unavailable")),
    render: { initial: String, changed: String },
  })
  draft.add({
    key: "invalid",
    codec: Schema.Number,
    // @ts-expect-error Read values must match the codec's decoded representation.
    read: () => Effect.succeed("wrong"),
    render: { initial: String, changed: String },
  })
})

const promiseRegistration = promise.experimental.instructions.transform((draft) => {
  draft.add({
    key: "decoded",
    codec: Schema.FiniteFromString,
    read: async (context) => {
      context satisfies Instruction.Context
      // @ts-expect-error Promise read contexts retain the same readonly snapshot.
      context.sessionID = Session.ID.make("ses_other")
      return 42
    },
    render: {
      initial: (current) => String(current satisfies number),
      changed: (previous, current) => String((current satisfies number) - (previous satisfies number)),
    },
  })
  for (const result of [Instruction.removed, Instruction.unavailable, "present"] as const) {
    draft.add({
      key: "sync",
      codec: Schema.String,
      read: () => result,
      render: { initial: (current) => current satisfies string, changed: (previous) => previous satisfies string },
    })
  }
  draft.add({
    key: "invalid",
    codec: Schema.Number,
    // @ts-expect-error Promise reads cannot return a value outside the codec.
    read: async () => "wrong",
    render: { initial: String, changed: String },
  })
})

export type Checks = [
  Assert<Equal<Effect.Success<typeof registration>, Registration>>,
  Assert<Equal<Effect.Error<typeof registration>, never>>,
  Assert<Equal<Effect.Services<typeof registration>, Scope.Scope>>,
  Assert<Equal<Effect.Error<ReturnType<Source<number>["read"]>>, unknown>>,
  Assert<Equal<Effect.Services<ReturnType<Source<number>["read"]>>, never>>,
  Assert<
    Equal<Effect.Success<ReturnType<Source<number>["read"]>>, number | Instruction.Removed | Instruction.Unavailable>
  >,
  Assert<Equal<Awaited<typeof promiseRegistration>["dispose"], () => Promise<void>>>,
  Assert<Equal<ReturnType<typeof effect.experimental.instructions.reload>, Effect.Effect<void>>>,
  Assert<Equal<ReturnType<typeof promise.experimental.instructions.reload>, Promise<void>>>,
]
