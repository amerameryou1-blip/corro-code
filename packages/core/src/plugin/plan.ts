export * as PlanPlugin from "./plan.js"

import { ToolFailure } from "@opencode-ai/ai"
import { Instruction } from "@opencode-ai/plugin/instructions"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Agent } from "@opencode-ai/schema/agent"
import { Global } from "@opencode-ai/util/global"
import { Effect, Schema } from "effect"
import path from "path"
import { Permission } from "../permission.js"

const plan = Agent.ID.make("plan")

const enter = (directory: string) => `<system-reminder>
You are in Plan mode. You may optionally create or update plan documents in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents. If the user asks you to implement changes, do not do so. Tell them they need to switch agents.
</system-reminder>`

const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`

export const Plugin = define({
  id: "opencode.plan",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const directory = path.join(global.home, ".opencode", "plan")
    yield* ctx.agent.transform((draft) => {
      draft.update(plan, (item) => {
        item.name = Agent.Name.make("Plan")
        item.description = "Read-only agent for exploring the codebase and planning work before implementation."
        item.mode = "primary"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
        item.permissions.push({ action: "edit", resource: "*", effect: "deny" })
        item.permissions.push({ action: "edit", resource: path.join(directory, "*"), effect: "allow" })
        item.permissions.push({ action: "external_directory", resource: path.join(directory, "*"), effect: "allow" })
      })
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.status !== "error") return Effect.void
      if (event.tool !== "edit" && event.tool !== "write" && event.tool !== "patch") return Effect.void
      if (!(event.error.error instanceof Permission.BlockedError)) return Effect.void
      event.error = new ToolFailure({
        message: `Cannot use ${event.tool} to modify files outside the Plan directory: ${directory}`,
      })
      return Effect.void
    })

    yield* ctx.experimental.instructions.transform((draft) => {
      draft.add({
        key: "opencode.plan/mode",
        codec: Schema.toCodecJson(Schema.Struct({ directory: Schema.String })),
        read: (context) => Effect.succeed(context.agent === plan ? { directory } : Instruction.removed),
        render: {
          initial: (value) => enter(value.directory),
          changed: (_previous, current) => enter(current.directory),
          removed: () => leave,
        },
      })
    })
  }),
})
