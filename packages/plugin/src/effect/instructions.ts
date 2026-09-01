import type { Effect } from "effect"
import type { Instruction } from "../instructions.js"
import type { Transform } from "./registration.js"

export interface Source<A> extends Instruction.Definition<A> {
  readonly read: (
    context: Instruction.Context,
  ) => Effect.Effect<NoInfer<A> | Instruction.Removed | Instruction.Unavailable, unknown>
}

export interface InstructionDraft {
  add<A>(source: Source<A>): void
}

export interface InstructionDomain {
  readonly transform: Transform<InstructionDraft>
  readonly reload: () => Effect.Effect<void>
}
