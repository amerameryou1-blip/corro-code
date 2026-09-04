import { app, safeStorage } from "electron"
import { homedir } from "node:os"
import { join } from "node:path"
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"

import { getStore } from "./store"
import { getLogger } from "./logging"
import { mergeCorroConfig, curateModelsData, parseCorroAuthLink, preferFastModels } from "./corro-config"

export { parseCorroAuthLink }

// Corro Code account backend (trial seats + model pool proxy).
// The Supabase anon key is client-safe (RLS-protected); the same values
// already ship in the public web client.
const CORRO_WEB = process.env.CORRO_WEB_URL ?? "https://corro-code-backend.vercel.app"
const SUPABASE_URL = "https://orojnlnhwnsmevkxbpte.supabase.co"
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yb2pubG5od25zbWV2a3hicHRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyOTA0MzIsImV4cCI6MjEwMzg2NjQzMn0.66jopRYujYCSPEIBQ71-BtCjaqVZaOtrSY16n_CDZxQ"

const STORE_NAME = "corro"
const REFRESH_ACCOUNT = "corro/refresh"

export type CorroTrial = {
  state: string
  position: number
  expiresAt: string | null
}

export type CorroStatus = {
  signedIn: boolean
  email: string | null
  trial: CorroTrial | null
  models: string[]
  ownKeySet: boolean
  provisioned: boolean
}

type Session = {
  access?: string
  accessExp?: number
  userId?: string
  email?: string
  trial?: CorroTrial
  consentAt?: string
  models?: string[]
  modelsAt?: number
  ownKeySet?: boolean
  provisioned?: boolean
}

function store() {
  return getStore(STORE_NAME)
}

function readSession(): Session {
  try {
    const raw = store().get("session")
    if (typeof raw !== "string" || !raw) return {}
    const parsed = JSON.parse(raw) as Session
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeSession(patch: Partial<Session>) {
  store().set("session", JSON.stringify({ ...readSession(), ...patch }))
}

function readRefresh(): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      const fallback: unknown = store().get("refresh_fallback")
      return typeof fallback === "string" ? fallback : null
    }
    const encrypted = store().get("refresh_enc") as unknown
    if (typeof encrypted !== "string" || !encrypted) return null
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"))
  } catch {
    return null
  }
}

function writeRefresh(token: string | null) {
  if (token && safeStorage.isEncryptionAvailable()) {
    store().set("refresh_enc", safeStorage.encryptString(token).toString("base64"))
    store().delete("refresh_fallback")
    return
  }
  if (token) store().set("refresh_fallback", token)
  else {
    store().delete("refresh_enc")
    store().delete("refresh_fallback")
  }
}

// Engine auth file (~/.local/share/opencode/auth.json on Windows %LOCALAPPDATA%).
// Written here so the refreshed access token stays valid for the provider
// without renderer round-trips.
function engineDataDir() {
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, "opencode")
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "opencode")
  return join(process.env.HOME ?? homedir(), ".local", "share", "opencode")
}

function engineConfigDir() {
  // Mirror the engine's own resolution (xdg-basedir on every platform):
  // XDG_CONFIG_HOME or ~/.config/opencode. Anything else provisions a file
  // the sidecar never reads.
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "opencode")
  return join(homedir(), ".config", "opencode")
}

const CORRO_CHAT_BASE_URL = `${CORRO_WEB}/api/chat`

function readJsonFile(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
  } catch {}
  return {}
}

function writeEngineAuthKey(access: string | null) {
  try {
    const dir = engineDataDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "auth.json")
    const data = readJsonFile(file)
    if (access) data["corro"] = { type: "api", key: access }
    else delete data["corro"]
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 })
  } catch (error) {
    getLogger().warn("corro engine auth write failed", error)
  }
}

// Idempotent engine provisioning: merges the Corro provider into the global
// opencode.json without touching anything else (user models, other providers
// and settings are preserved; managed keys are only added, never removed).
export async function provisionEngine(input: {
  access?: string | null
  models: string[]
  ownKey?: string | null
}): Promise<{ changed: boolean }> {
  if (input.access) writeEngineAuthKey(input.access)
  try {
    const dir = engineConfigDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "opencode.json")
    // One-time safety copy before the first reconcile touches a file the
    // user may have curated by hand.
    try {
      const backup = join(dir, "opencode.json.corro-backup")
      if (!existsSync(backup) && existsSync(file)) copyFileSync(file, backup)
    } catch (error) {
      getLogger().warn("corro engine backup failed", error)
    }
    const session = readSession()
    const { config, changed } = mergeCorroConfig({
      existing: readJsonFile(file),
      baseUrl: CORRO_CHAT_BASE_URL,
      models: input.models,
      ...(input.ownKey !== undefined ? { ownKey: input.ownKey } : {}),
      firstProvision: !session.provisioned,
    })
    if (!session.provisioned) writeSession({ provisioned: true })
    if (changed) writeFileSync(file, JSON.stringify(config, null, 2))
    return { changed }
  } catch (error) {
    getLogger().warn("corro engine provision failed", error)
  }
  return { changed: false }
}

async function supabase(path: string, init?: RequestInit) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SUPABASE_ANON, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
}

async function corroApi(path: string, access: string, init?: RequestInit) {
  return fetch(`${CORRO_WEB}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${access}`,
      ...(init?.headers ?? {}),
    },
  })
}

export function corroLoginUrl() {
  const params = new URLSearchParams({
    provider: "google",
    redirect_to: `${CORRO_WEB}/?desktop=1`,
  })
  return `${SUPABASE_URL}/auth/v1/authorize?${params.toString()}`
}

type SupabaseUser = { id: string; email?: string }

async function fetchUser(access: string): Promise<SupabaseUser | null> {
  try {
    const res = await supabase("/auth/v1/user", { headers: { Authorization: `Bearer ${access}` } })
    if (!res.ok) return null
    const user = (await res.json()) as SupabaseUser
    if (!user || typeof user.id !== "string") return null
    return user
  } catch {
    return null
  }
}

function accessExpiry(access: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64").toString("utf8")) as {
      exp?: number
    }
    return typeof payload.exp === "number" ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

async function refreshAccess(refresh: string) {
  try {
    const res = await supabase("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refresh }),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { access_token?: string; refresh_token?: string }
    if (typeof body.access_token !== "string") return null
    return {
      access: body.access_token,
      refresh: typeof body.refresh_token === "string" ? body.refresh_token : refresh,
    }
  } catch {
    return null
  }
}

function normalizeTrial(input: unknown): CorroTrial {
  const body = (input ?? {}) as { state?: unknown; position?: unknown; expiresAt?: unknown }
  return {
    state: typeof body.state === "string" ? body.state : "none",
    position: typeof body.position === "number" ? body.position : 0,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
  }
}

async function fetchTrial(access: string): Promise<CorroTrial | null> {
  try {
    const res = await corroApi("/api/trial/status", access)
    if (res.status === 401) return null
    return normalizeTrial(await res.json().catch(() => ({})))
  } catch {
    return null
  }
}

async function claimTrial(access: string) {
  const res = await corroApi("/api/trial/join", access, {
    method: "POST",
    body: JSON.stringify({ consentData: true }),
  })
  if (!res.ok) throw new Error(`trial claim failed (${res.status})`)
  return normalizeTrial(await res.json().catch(() => ({})))
}

async function fetchModels(): Promise<string[]> {
  try {
    const res = await fetch(`${CORRO_WEB}/api/health`)
    if (!res.ok) return []
    const body = (await res.json()) as { freeModels?: unknown }
    if (!Array.isArray(body.freeModels)) return []
    return body.freeModels.filter((m): m is string => typeof m === "string")
  } catch {
    return []
  }
}

export async function corroStatus(): Promise<CorroStatus> {
  const session = readSession()
  if (!session.access)
    return { signedIn: false, email: null, trial: null, models: [], ownKeySet: false, provisioned: false }
  return {
    signedIn: true,
    email: session.email ?? null,
    trial: session.trial ?? null,
    models: session.models ?? [],
    ownKeySet: session.ownKeySet ?? false,
    provisioned: session.provisioned ?? false,
  }
}

export async function corroCompleteAuth(
  tokens: { access: string; refresh: string },
  consent: boolean,
): Promise<CorroStatus> {
  const user = await fetchUser(tokens.access)
  if (!user) throw new Error("Google sign-in did not return a valid session. Please try again.")
  const trial = await fetchTrial(tokens.access)
  if (!trial) throw new Error("Signed in, but the session expired immediately. Please try again.")
  const models = await fetchModels()
  writeSession({
    access: tokens.access,
    accessExp: accessExpiry(tokens.access) ?? Date.now() + 3600_000,
    userId: user.id,
    email: user.email,
    trial,
    consentAt: consent ? new Date().toISOString() : undefined,
    models,
    modelsAt: Date.now(),
  })
  writeRefresh(tokens.refresh || null)
  writeEngineAuthKey(tokens.access)

  // Grab the free seat right away when the user consented on the welcome card.
  if (consent && trial.state === "none") {
    try {
      const claimed = await claimTrial(tokens.access)
      writeSession({ trial: claimed })
    } catch (error) {
      getLogger().warn("corro trial auto-claim failed", error)
    }
  }
  getLogger().log("corro sign-in complete", { email: user.email ?? null })
  return corroStatus()
}

export async function corroClaimTrial(): Promise<CorroStatus> {
  const session = readSession()
  if (!session.access) throw new Error("Sign in with Google first.")
  const claimed = await claimTrial(session.access)
  writeSession({ trial: claimed })
  return corroStatus()
}

export async function corroRefreshTrial(): Promise<CorroTrial | null> {
  const session = readSession()
  if (!session.access) return null
  const trial = await fetchTrial(session.access)
  if (trial) writeSession({ trial })
  return trial
}

// Silent token refresh + trial poll. Keeps long sessions alive.
export async function corroHeartbeat() {
  const session = readSession()
  if (!session.access) return
  if ((session.accessExp ?? 0) - Date.now() < 15 * 60_000) {
    const refresh = readRefresh()
    if (refresh) {
      const next = await refreshAccess(refresh)
      if (next) {
        writeSession({ access: next.access, accessExp: accessExpiry(next.access) ?? Date.now() + 3600_000 })
        writeRefresh(next.refresh)
        writeEngineAuthKey(next.access)
        getLogger().log("corro access token refreshed")
        return
      }
    }
    getLogger().warn("corro session expired, sign-in required")
    writeSession({ access: undefined, accessExp: undefined })
    writeRefresh(null)
    writeEngineAuthKey(null)
    return
  }
  await corroRefreshTrial()
}

export async function corroSignOut() {
  writeSession({ access: undefined, accessExp: undefined, trial: undefined, email: undefined })
  writeRefresh(null)
  writeEngineAuthKey(null)
  getLogger().log("corro signed out")
}

export async function corroValidateOwnKey(key: string): Promise<{ ok: boolean; error?: string }> {
  const trimmed = key.trim()
  if (!trimmed) return { ok: false, error: "Paste a key first." }
  const session = readSession()
  if (!session.access) return { ok: false, error: "Sign in with Google first." }
  const models = session.models?.length ? session.models : await fetchModels()
  const model = models[0] ?? "moonshotai/kimi-k3"
  try {
    const res = await corroApi("/api/chat/completions", session.access, {
      method: "POST",
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ok" }], max_tokens: 1, apiKey: trimmed }),
    })
    if (res.ok) {
      writeSession({ ownKeySet: true })
      return { ok: true }
    }
    return { ok: false, error: `The key was rejected (${res.status}). Check it and try again.` }
  } catch {
    return { ok: false, error: "Could not reach the service. Check your connection." }
  }
}

export async function corroProvision(ownKey?: string | null): Promise<{ changed: boolean } & CorroStatus> {
  const session = readSession()
  if (!session.access) throw new Error("Sign in with Google first.")
  if (ownKey !== undefined) writeSession({ ownKeySet: Boolean(ownKey) })
  const { changed } = await provisionEngine({
    access: session.access,
    models: preferFastModels(session.models ?? []),
    ...(ownKey !== undefined ? { ownKey } : {}),
  })
  return { changed, ...(await corroStatus()) }
}

export async function corroClearOwnKey() {
  const session = readSession()
  if (!session.access) return
  writeSession({ ownKeySet: false })
  await provisionEngine({ access: session.access, models: session.models ?? [], ownKey: "" })
}

let heartbeatTimer: NodeJS.Timeout | null = null

// Curated models.dev snapshot: the Zen provider renamed and stripped to free
// models only; every other provider passes through untouched. The sidecar
// picks it up via OPENCODE_MODELS_PATH (inherited env). Best-effort: on any
// failure the previous file (or engine defaults) stays in effect.
const MODELS_SOURCE_URL = "https://models.opencode.ai/api.json"

export async function curateModelsFile(): Promise<void> {
  const file = join(app.getPath("userData"), "corro-models.json")
  const reusePrevious = () => {
    try {
      if (existsSync(file)) process.env.OPENCODE_MODELS_PATH = file
    } catch {}
  }
  try {
    const response = await fetch(MODELS_SOURCE_URL, { signal: AbortSignal.timeout(12_000) })
    if (!response.ok) throw new Error(`models source responded ${response.status}`)
    const data: unknown = await response.json()
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("models source shape")
    writeFileSync(file, JSON.stringify(curateModelsData(data as Record<string, never>)))
    process.env.OPENCODE_MODELS_PATH = file
  } catch (error) {
    getLogger().warn("corro models curation failed, reusing previous file", error)
    reusePrevious()
  }
}

// Runs on every launch, signed in or not: reconcile the trial provider
// (limits/names/variants) and point the sidecar at the curated catalog.
export async function corroStartup(): Promise<void> {
  try {
    await provisionEngine({ models: [] })
  } catch (error) {
    getLogger().warn("corro startup provision failed", error)
  }
  await curateModelsFile()
}

export function startCorroHeartbeat() {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => void corroHeartbeat(), 5 * 60_000)
  heartbeatTimer.unref?.()
  app.once("will-quit", stopCorroHeartbeat)
}

export function stopCorroHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
}
