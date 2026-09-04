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
    name: "Kimi K3 (Trial)",
    limit: { context: 262144, output: 32768 },
    variants: { think: {}, "think-deep": {} },
  },
  "deepseek-ai/deepseek-v4-flash-0731": {
    name: "DeepSeek V4 Flash (Trial)",
    limit: { context: 131072, output: 32768 },
    variants: { think: {}, "think-deep": {} },
  },
  "minimaxai/minimax-m3": {
    name: "MiniMax M3 (Trial)",
    limit: { context: 196608, output: 32768 },
    variants: { think: {}, "think-deep": {} },
  },
  "nvidia/nemotron-3-super-120b-a12b": {
    name: "Nemotron 3 Super (Trial)",
    limit: { context: 262144, output: 16384 },
    variants: { think: {}, "think-deep": {} },
  },
}

// Fallback budgets for trial models the registry does not know (yet): enough
// for correct tooltips/context accounting without touching anything else.
const UNKNOWN_MODEL_LIMIT = { context: 131072, output: 32768 }

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
  if (!def) {
    // Unknown trial model already in the file: keep its name, but ensure it
    // has working budgets instead of leaving Context 0 in the UI.
    return {
      tool_call: true,
      modalities: { input: ["text"], output: ["text"] },
      limit: { ...UNKNOWN_MODEL_LIMIT },
    }
  }
  return {
    name: def.name,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { ...def.limit },
    variants: Object.fromEntries(Object.keys(def.variants).map((v) => [v, {}])),
  }
}

export function mergeCorroConfig(input: MergeInput): { config: Record<string, unknown>; changed: boolean } {
  let changed = false
  const data: Record<string, unknown> = { ...input.existing }
  const providers = { ...(isRecord(data["provider"]) ? (data["provider"] as Record<string, unknown>) : {}) }
  // Migrate the legacy trial provider id to the canonical "corro" id
  // (thinking-level hooks and defaults key on it). The working connection
  // settings travel with it untouched.
  if (isRecord(providers["ultracode"]) && !isRecord(providers["corro"])) {
    providers["corro"] = providers["ultracode"]
    changed = true
  }
  if (isRecord(providers["ultracode"]) || "ultracode" in providers) {
    delete providers["ultracode"]
    changed = true
  }
  // Drop our own long-dead experiment residue, nothing else.
  if (isRecord(providers["ff"]) || "ff" in providers) {
    delete providers["ff"]
    changed = true
  }
  const corro = { ...(isRecord(providers["corro"]) ? (providers["corro"] as Record<string, unknown>) : {}) }
  const options = { ...(isRecord(corro["options"]) ? (corro["options"] as Record<string, unknown>) : {}) }
  const models = { ...(isRecord(corro["models"]) ? (corro["models"] as Record<string, unknown>) : {}) }

  const ids = input.models.length ? input.models : Object.keys(CORRO_MODELS)
  // Heal every trial model already in the file (registry or not) so none is
  // left with missing limits (the "Context 0" tooltip bug).
  for (const id of new Set([...Object.keys(models), ...ids])) {
    const current = isRecord(models[id]) ? (models[id] as Record<string, unknown>) : undefined
    const fresh = modelEntry(id)
    if (!current) {
      models[id] = fresh
      changed = true
      continue
    }
    // Heal managed keys without touching anything the user customized.
    // Unknown ids keep their own name (fresh has none).
    const healed = { ...current }
    for (const key of ["name", "tool_call", "modalities", "limit", "variants"] as const) {
      if (fresh[key] === undefined) continue
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
    name: "Corro Code Trial",
    // Preserve a working connection (NVIDIA-direct while the trial backend is
    // down). Only fresh provisions point at the trial backend URL.
    options: {
      ...options,
      baseURL: typeof options["baseURL"] === "string" && options["baseURL"] ? options["baseURL"] : input.baseUrl,
    },
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

  return { config: data, changed }
}

// A Zen model is free when its base price is zero — same rule the model
// picker badge uses (provider "opencode", cost.input === 0).
export function isFreeModelCost(cost: { input?: number; output?: number } | undefined): boolean {
  if (!cost) return true
  return (cost.input ?? 0) === 0
}

// Curate a models.dev snapshot for the Corro catalog: the third-party free
// pool is surfaced as Corro Code Trial and stripped to free models only; the
// paid Go provider is dropped entirely. Every other provider passes through
// untouched so connected keys keep working.
export function curateModelsData(
  data: Record<string, { name?: string; models?: Record<string, { cost?: { input?: number; output?: number } }> }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, item] of Object.entries(data)) {
    if (!item || typeof item !== "object") continue
    if (id === "opencode-go") continue
    if (id !== "opencode") {
      out[id] = item
      continue
    }
    const models: Record<string, unknown> = {}
    for (const [modelID, model] of Object.entries(item.models ?? {})) {
      if (!model || typeof model !== "object") continue
      if (isFreeModelCost(model.cost)) models[modelID] = model
    }
    out[id] = { ...item, name: "Corro Code Trial", models }
  }
  return out
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
