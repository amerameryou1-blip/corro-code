import type { Instruction } from "../instructions.js"
import type { Transform } from "./registration.js"

export interface Source<A> extends Instruction.Definition<A> {
  readonly read: (
    context: Instruction.Context,
  ) =>
    | NoInfer<A>
    | Instruction.Removed
    | Instruction.Unavailable
    | Promise<NoInfer<A> | Instruction.Removed | Instruction.Unavailable>
}

export interface InstructionDraft {
  add<A>(source: Source<A>): void
}

export interface InstructionDomain {
  readonly transform: Transform<InstructionDraft>
  readonly reload: () => Promise<void>
}
