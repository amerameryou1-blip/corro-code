import type { Tools } from "./tools.js"

/** A named group of tools or nested namespaces exposed through CodeMode's `tools` object. */
export type Namespace<R = never> = {
  readonly _tag: "CodeModeNamespace"
  readonly name: string
  readonly description?: string
  readonly tools: Tools<R>
}

/** Options for declaring one CodeMode namespace. */
export type Options<R = never> = {
  readonly name: string
  readonly description?: string
  readonly tools: Tools<R>
}

export const isNamespace = <R = never>(value: unknown): value is Namespace<R> =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  Object.hasOwn(value, "_tag") &&
  value._tag === "CodeModeNamespace"

/**
 * Declares one optionally described group of tools available through `tools.<name>.*`.
 *
 * Names belong to the namespace. The host registers the value in a `tools` array; the
 * runtime does not take the name from object keys.
 */
export const make = <R = never>(options: Options<R>): Namespace<R> => ({
  _tag: "CodeModeNamespace",
  name: options.name,
  ...(options.description === undefined ? {} : { description: options.description }),
  tools: options.tools,
})
