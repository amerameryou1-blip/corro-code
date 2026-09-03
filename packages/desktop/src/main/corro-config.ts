// Pure Corro engine-config helpers (no Electron imports, unit-tested).
// The desktop merges a "corro" provider into the global opencode.json while
// preserving everything the user already has.

export const CORRO_CHAT_PATH = "/api/chat"

export const FAST_MODEL_FIRST = "deepseek-ai/deepseek-v4-flash-0731"

// Fast models first so the default provisioned model answers instantly;
// slow giants tend to stall past the serverless time budget.
export function preferFastModels(models: string[]): string[] {
  const rest = models.filter((m) => m !== FAST_MODEL_FIRST)
  return models.includes(FAST_MODEL_FIRST) ? [FAST_MODEL_FIRST, ...rest] : models
}

export const FREE_LABELS: Record<string, string> = {  "moonshotai/kimi-k3": "Kimi K3 (free)",
  "deepseek-ai/deepseek-v4-flash-0731": "DeepSeek V4 Flash (free)",
  "minimaxai/minimax-m3": "MiniMax M3 (free)",
  "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super (free)",
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

export function mergeCorroConfig(input: MergeInput): { config: Record<string, unknown>; changed: boolean } {
  let changed = false
  const data: Record<string, unknown> = { ...input.existing }
  const providers = { ...(isRecord(data["provider"]) ? (data["provider"] as Record<string, unknown>) : {}) }
  const corro = { ...(isRecord(providers["corro"]) ? (providers["corro"] as Record<string, unknown>) : {}) }
  const options = { ...(isRecord(corro["options"]) ? (corro["options"] as Record<string, unknown>) : {}) }
  const models = { ...(isRecord(corro["models"]) ? (corro["models"] as Record<string, unknown>) : {}) }

  const ids = input.models.length ? input.models : Object.keys(FREE_LABELS)
  for (const id of ids) {
    if (!isRecord(models[id])) {
      models[id] = { name: FREE_LABELS[id] ?? id }
      changed = true
    }
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
