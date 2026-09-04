import { describe, expect, test } from "bun:test"
import { CorroPlugin, thinkingPrefix } from "./corro"

describe("thinkingPrefix", () => {
  test("maps think variants to prompt prefixes", () => {
    expect(thinkingPrefix(undefined)).toBeUndefined()
    expect(thinkingPrefix("off")).toBeUndefined()
    expect(thinkingPrefix("think")).toMatch(/^Think briefly/)
    expect(thinkingPrefix("think-deep")).toMatch(/^Think step by step/)
  })
})

describe("CorroPlugin chat.message", () => {
  test("prepends the prefix once for corro think variants", async () => {
    const hooks = await CorroPlugin({} as never)
    const hook = hooks["chat.message"]
    if (!hook) throw new Error("hook missing")
    const output: HookOutput = {
      message: { role: "user" },
      parts: [{ type: "text", text: "fix it" }],
    }
    await hook({ sessionID: "s", model: { providerID: "corro", modelID: "m" }, variant: "think-deep" } as never, output as never)
    expect(output.parts[0]?.text).toBe("Think step by step.\nfix it")
  })

  test("never stacks the prefix on retry re-admission", async () => {
    const hooks = await CorroPlugin({} as never)
    const hook = hooks["chat.message"]
    if (!hook) throw new Error("hook missing")
    const output: HookOutput = {
      message: { role: "user" },
      parts: [{ type: "text", text: "fix it" }],
    }
    const input = { sessionID: "s", model: { providerID: "corro", modelID: "m" }, variant: "think-deep" } as never
    await hook(input, output as never)
    await hook(input, output as never)
    expect(output.parts[0]?.text).toBe("Think step by step.\nfix it")
  })

  test("ignores other providers, missing variants and non-user messages", async () => {
    const hooks = await CorroPlugin({} as never)
    const hook = hooks["chat.message"]
    if (!hook) throw new Error("hook missing")
    const other: HookOutput = { message: { role: "user" }, parts: [{ type: "text", text: "hi" }] }
    await hook({ sessionID: "s", model: { providerID: "anthropic", modelID: "m" }, variant: "think-deep" } as never, other as never)
    expect(other.parts[0]?.text).toBe("hi")
    const noVariant: HookOutput = { message: { role: "user" }, parts: [{ type: "text", text: "hi" }] }
    await hook({ sessionID: "s", model: { providerID: "corro", modelID: "m" } } as never, noVariant as never)
    expect(noVariant.parts[0]?.text).toBe("hi")
  })
})

interface HookOutput {
  message: { role: string }
  parts: Array<{ type: string; text?: string }>
}
