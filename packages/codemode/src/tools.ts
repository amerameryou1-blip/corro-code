import type { Namespace } from "./namespace.js"
import type { Tool } from "./tool.js"

export type Tools<R = never> = ReadonlyArray<Tool<R> | Namespace<R>>
