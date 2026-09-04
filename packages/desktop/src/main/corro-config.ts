// Pure Corro engine-config helpers (no Electron imports, unit-tested).
// The desktop merges a "corro" provider into the global opencode.json while
// preserving everything the user already has.

export const CORRO_CHAT_PATH = "/api/chat"

export type CorroModelDef = {
  name: string
  limit: { context: number; output: number }
  variants: Record<string, Record<string, unknown>>
}

// Context/output budgets are deliberately conservative (at or under the
// pool's hosted limits) so long sessions compact instead of overflowing.
export const CORRO_MODELS: Record<string, CorroModelDef> = {
  "moonshotai/kimi-k3": {
    name: "Kimi K3 (free)",
    limit: { context: 262144, output: 32768 },
    variants: { think: {}, "think-deep": {} },
  },
  "deepseek-ai/deepseek-v4-flash-0731": {
    name: "DeepSeek V4 Flash (free)",
    limit: { context: 131072, output: 32768 },
    variants: { think: {}, "think-deep": {} },
  },
  "minimaxai/minimax-m3": {
    name: "MiniMax M3 (free)",
    limit: { context: 196608, output: 32768 },
    variants: { think: {}, "think-deep": {} },
  },
  "nvidia/nemotron-3-super-120b-a12b": {
    name: "Nemotron 3 Super (free)",
    limit: { context: 262144, output: 16384 },
    variants: { think: {}, "think-deep": {} },
  },
}

export const FREE_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(CORRO_MODELS).map(([id, def]) => [id, def.name]),
)

// Fast models first so the default provisioned model answers instantly;
// slow giants tend to stall past the serverless time budget.
const FAST_MODEL_FIRST = "deepseek-ai/deepseek-v4-flash-0731"

export function preferFastModels(models: string[]): string[] {
  const rest = models.filter((m) => m !== FAST_MODEL_FIRST)
  return models.includes(FAST_MODEL_FIRST) ? [FAST_MODEL_FIRST, ...rest] : models
}

export type MergeInput = {
  existing: Record<string, unknown>
  baseUrl: string
  models: string[]
  // undefined = leave headers untouched; "" = remove the own key.
  ownKey?: string | null
  firstProvision: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function modelEntry(id: string): Record<string, unknown> {
  const def = CORRO_MODELS[id]
  return {
    name: def?.name ?? id,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    ...(def ? { limit: { ...def.limit } } : {}),
    ...(def ? { variants: Object.fromEntries(Object.keys(def.variants).map((v) => [v, {}])) } : {}),
  }
}

export function mergeCorroConfig(input: MergeInput): { config: Record<string, unknown>; changed: boolean } {
  let changed = false
  const data: Record<string, unknown> = { ...input.existing }
  const providers = { ...(isRecord(data["provider"]) ? (data["provider"] as Record<string, unknown>) : {}) }
  const corro = { ...(isRecord(providers["corro"]) ? (providers["corro"] as Record<string, unknown>) : {}) }
  const options = { ...(isRecord(corro["options"]) ? (corro["options"] as Record<string, unknown>) : {}) }
  const models = { ...(isRecord(corro["models"]) ? (corro["models"] as Record<string, unknown>) : {}) }

  const ids = input.models.length ? input.models : Object.keys(CORRO_MODELS)
  for (const id of ids) {
    const current = isRecord(models[id]) ? (models[id] as Record<string, unknown>) : undefined
    const fresh = modelEntry(id)
    if (!current) {
      models[id] = fresh
      changed = true
      continue
    }
    // Heal managed keys (name/limit/capabilities/variants) without touching
    // anything the user customized.
    const healed = { ...current }
    for (const key of ["name", "tool_call", "modalities", "limit", "variants"] as const) {
      if (JSON.stringify(healed[key]) !== JSON.stringify(fresh[key])) {
        healed[key] = fresh[key]
        changed = true
      }
    }
    models[id] = healed
  }

  if (input.ownKey !== undefined) {
    const headers = { ...(isRecord(options["headers"]) ? (options["headers"] as Record<string, unknown>) : {}) }
    if (input.ownKey) {
      if (headers["x-own-key"] !== input.ownKey) {
        headers["x-own-key"] = input.ownKey
        changed = true
      }
    } else if ("x-own-key" in headers) {
      delete headers["x-own-key"]
      changed = true
    }
    options["headers"] = headers
  }

  const nextCorro = {
    ...corro,
    npm: "@ai-sdk/openai-compatible",
    name: "Corro",
    options: { ...options, baseURL: input.baseUrl },
    models,
  }
  if (JSON.stringify(providers["corro"] ?? null) !== JSON.stringify(nextCorro)) {
    providers["corro"] = nextCorro
    changed = true
  }
  data["provider"] = providers

  if (typeof data["model"] !== "string" && ids[0]) {
    data["model"] = `corro/${ids[0]}`
    changed = true
  }

  if (input.firstProvision) {
    const disabled = new Set(
      Array.isArray(data["disabled_providers"])
        ? (data["disabled_providers"] as unknown[]).filter((d): d is string => typeof d === "string")
        : [],
    )
    disabled.add("opencode")
    disabled.add("opencode-go")
    data["disabled_providers"] = [...disabled]
    changed = true
  }

  return { config: data, changed }
}

// Accepts corro://auth?access_token=..&refresh_token=.. (and the legacy
// corro://open?jwt=..&refresh=.. shape). Carries tokens only, no workspace.
export function parseCorroAuthLink(url: string): { access: string; refresh: string } | null {
  if (!url.startsWith("corro://")) return null
  try {
    const query = new URL(url).searchParams
    const access = query.get("access_token") ?? query.get("jwt") ?? ""
    const refresh = query.get("refresh_token") ?? query.get("refresh") ?? ""
    if (!access) return null
    return { access, refresh }
  } catch {
    return null
  }
}
