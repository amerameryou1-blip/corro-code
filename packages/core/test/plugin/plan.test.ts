import { describe, expect } from "bun:test"
import { ToolFailure } from "@opencode-ai/ai"
import { Effect, Option, Types } from "effect"
import type { ToolHooks } from "@opencode-ai/plugin/effect/tool"
import { Agent } from "@opencode-ai/core/agent"
import { Environment } from "@opencode-ai/core/environment/index"
import { Instructions } from "@opencode-ai/core/instructions/index"
import { PluginInstructions } from "@opencode-ai/core/plugin/instructions"
import { PlanPlugin } from "@opencode-ai/core/plugin/plan"
import { Permission } from "@opencode-ai/core/permission"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Tool } from "@opencode-ai/schema/tool"
import { Global } from "@opencode-ai/util/global"
import path from "path"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(PluginInstructions.layer)
const sessionID = Session.ID.make("ses_plan_test")
const plan = Agent.ID.make("plan")
const build = Agent.ID.make("build")
const home = "/home/plan-test"
const planDirectory = path.join(home, ".opencode", "plan")
const location = host().location

const run = Effect.fnUntraced(function* () {
  const instructions = yield* PluginInstructions.Service
  let toolHook: ((input: ToolHooks["execute.after"]) => Effect.Effect<void>) | undefined
  const planAgent = {
    id: plan,
    name: Agent.Name.make("Plan"),
    request: { settings: {}, headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ],
  } satisfies Types.DeepMutable<Agent.Info>
  const driver = Environment.makeMemoryDriver()
  yield* PlanPlugin.Plugin.effect(
    host({
      agent: {
        get: () => Effect.die("unused agent.get"),
        list: () => Effect.die("unused agent.list"),
        reload: () => Effect.die("unused agent.reload"),
        transform: (callback) => {
          callback({
            list: () => [planAgent],
            get: (id) => (id === plan ? planAgent : undefined),
            default: () => {},
            update: (id, update) => {
              if (id === plan) update(planAgent)
            },
            remove: () => {},
          })
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      tool: {
        transform: () => Effect.die("unused tool.transform"),
        reload: () => Effect.die("unused tool.reload"),
        hook: (name, callback) => {
          if (name === "execute.after") {
            // Hook names and callbacks are correlated, but TypeScript does not narrow this generic registration API.
            // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
            toolHook = callback as unknown as (input: ToolHooks["execute.after"]) => Effect.Effect<void>
          }
          return Effect.succeed({ dispose: Effect.void })
        },
      },
      experimental: { instructions },
    }),
  ).pipe(
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })),
    Effect.provideService(
      Environment.Service,
      Environment.Service.of({ files: Environment.makeFiles(driver), spawner: driver.spawner }),
    ),
  )
  if (!toolHook) return yield* Effect.die("plan plugin did not register a tool hook")
  return {
    load: (agent: Agent.ID) => instructions.load({ sessionID, agent, location }),
    toolHook,
    files: Environment.makeFiles(driver),
    planAgent,
  }
})

type ToolErrorEvent = Extract<ToolHooks["execute.after"], { readonly status: "error" }>

const toolError = (tool: "edit" | "write" | "patch", error: Tool.Error): ToolErrorEvent => ({
  tool,
  input: {},
  sessionID,
  agent: plan,
  messageID: SessionMessage.ID.make("msg_plan_tool"),
  id: Tool.CallID.make("call_plan_tool"),
  status: "error",
  error,
})

describe("plan plugin instructions", () => {
  it.effect("provides instructions while the selected agent is Plan", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      const [source] = plugin.load(plan)
      expect(yield* source.read).toEqual({ directory: planDirectory })
      const text = source.initial({ directory: planDirectory })
      expect(text).toContain("You are in Plan mode")
      expect(text).toContain("optionally create or update plan documents")
      expect(text).toContain(planDirectory)
      expect(text).toContain("Do not modify any other files")
    }),
  )

  it.effect("removes the instruction outside Plan and supplies the leave reminder", () =>
    Effect.gen(function* () {
      const plugin = yield* run()
      const [source] = plugin.load(build)
      expect(yield* source.read).toBe(Instructions.removed)
      expect(source.removed({ directory: planDirectory })).toContain("NO LONGER in Plan mode")
    }),
  )
})

describe("plan plugin mutations", () => {
  it.effect("does not create the Plan directory during activation", () =>
    Effect.gen(function* () {
      const { files } = yield* run()
      expect(Option.isNone(yield* files.stat(planDirectory).pipe(Effect.option))).toBe(true)
    }),
  )

  it.effect("allows edits only inside the Plan directory", () =>
    Effect.gen(function* () {
      const { planAgent } = yield* run()
      expect(Permission.evaluate("edit", path.join(planDirectory, "work.md"), planAgent.permissions).effect).toBe(
        "allow",
      )
      expect(Permission.evaluate("edit", "/workspace/source.ts", planAgent.permissions).effect).toBe("deny")
      expect(Permission.evaluate("edit", "source.ts", planAgent.permissions).effect).toBe("deny")
    }),
  )

  it.effect("allows the Plan directory external boundary", () =>
    Effect.gen(function* () {
      const { planAgent } = yield* run()
      expect(
        Permission.evaluate("external_directory", path.join(planDirectory, "*"), planAgent.permissions).effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(planDirectory, "nested", "*"), planAgent.permissions)
          .effect,
      ).toBe("allow")
      expect(Permission.evaluate("external_directory", "/outside/*", planAgent.permissions).effect).toBe("ask")
    }),
  )

  it.effect("rewrites blocked mutation failures with the Plan directory", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run()
      for (const tool of ["edit", "write", "patch"] as const) {
        const event = toolError(
          tool,
          new ToolFailure({
            message: "Unable to modify file",
            error: new Permission.BlockedError({
              rules: [],
              permission: "edit",
              resources: ["source.ts"],
            }),
          }),
        )
        yield* toolHook(event)
        expect(event.error.message).toContain("outside the Plan directory")
        expect(event.error.message).toContain(planDirectory)
      }
    }),
  )

  it.effect("preserves mutation failures unrelated to permissions", () =>
    Effect.gen(function* () {
      const { toolHook } = yield* run()
      const error = new ToolFailure({ message: "oldString was not found" })
      const event = toolError("edit", error)
      yield* toolHook(event)
      expect(event.error).toBe(error)
    }),
  )
})
