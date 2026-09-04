import { describe, expect, test } from "bun:test"
import { CORRO_MODELS, mergeCorroConfig, parseCorroAuthLink, preferFastModels } from "./corro-config"

const models = Object.keys(CORRO_MODELS)

const baseUrl = "https://corro-code-backend.vercel.app/api/chat"

describe("preferFastModels", () => {
  test("flash model leads so the default answers instantly", () => {
    expect(preferFastModels(["moonshotai/kimi-k3", "deepseek-ai/deepseek-v4-flash-0731"])[0]).toBe(
      "deepseek-ai/deepseek-v4-flash-0731",
    )
    expect(preferFastModels(["a", "b"])).toEqual(["a", "b"])
  })
})

describe("parseCorroAuthLink", () => {
  test("accepts the auth shape", () => {
    expect(parseCorroAuthLink("corro://auth?access_token=a&refresh_token=r")).toEqual({ access: "a", refresh: "r" })
  })
  test("accepts the legacy open shape", () => {
    expect(parseCorroAuthLink("corro://open?jwt=a&refresh=r")).toEqual({ access: "a", refresh: "r" })
  })
  test("rejects missing tokens and foreign schemes", () => {
    expect(parseCorroAuthLink("corro://auth?refresh_token=r")).toBeNull()
    expect(parseCorroAuthLink("https://example.com/?access_token=a")).toBeNull()
  })
})

describe("mergeCorroConfig", () => {
  test("creates the provider from an empty config", () => {
    const { config, changed } = mergeCorroConfig({ existing: {}, baseUrl, models, firstProvision: true })
    expect(changed).toBe(true)
    const provider = (config["provider"] as Record<string, any>)["corro"] as any
    expect(provider.npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(provider.models)).toEqual(models)
    expect(config["model"]).toBe(`corro/${models[0]}`)
    expect(config["disabled_providers"]).toContain("opencode")
  })

  test("preserves user data and heals managed model keys", () => {
    const existing = {
      model: "anthropic/claude",
      provider: {
        anthropic: { npm: "@ai-sdk/anthropic", models: {} },
        corro: { models: { "custom/model": { name: "Mine" }, [models[0]]: { name: "Old label", foo: 1 } } },
      },
    }
    const { config, changed } = mergeCorroConfig({ existing, baseUrl, models, firstProvision: false })
    expect((config["provider"] as any)["anthropic"].npm).toBe("@ai-sdk/anthropic")
    expect(config["model"]).toBe("anthropic/claude")
    const corroModels = (config["provider"] as any)["corro"]["models"]
    expect(corroModels["custom/model"]).toEqual({ name: "Mine" })
    const healed = corroModels[models[0]]
    expect(healed.name).toBe(CORRO_MODELS[models[0]].name)
    expect(healed.foo).toBe(1) // user customizations survive
    expect(healed.limit.context).toBeGreaterThan(0) // context budget fixed
    expect(Object.keys(healed.variants)).toEqual(["think", "think-deep"])
    expect(changed).toBe(true) // missing free models were added
  })

  test("second run without changes reports unchanged", () => {
    const first = mergeCorroConfig({ existing: {}, baseUrl, models, firstProvision: true })
    const second = mergeCorroConfig({ existing: first.config, baseUrl, models, firstProvision: false })
    expect(second.changed).toBe(false)
  })

  test("own key header is set and removed without touching siblings", () => {
    const withKey = mergeCorroConfig({
      existing: { provider: { corro: { options: { headers: { other: "1" } } } } },
      baseUrl,
      models,
      ownKey: "k",
      firstProvision: false,
    })
    expect((withKey.config["provider"] as any)["corro"]["options"]["headers"]).toEqual({
      other: "1",
      "x-own-key": "k",
    })
    const removed = mergeCorroConfig({ existing: withKey.config, baseUrl, models, ownKey: "", firstProvision: false })
    expect((removed.config["provider"] as any)["corro"]["options"]["headers"]).toEqual({ other: "1" })
  })
})
