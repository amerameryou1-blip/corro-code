import { useLanguage, useServerSDK, useServerSync } from "@opencode-ai/app"
import { createStore } from "solid-js/store"
import { onCleanup, onMount, Show } from "solid-js"

import type { CorroStatus, ElectronAPI } from "../preload/types"

// window.api is typed loosely where the app shell overlaps the global
// declaration; narrow once here instead of casting at every call site.
function bridge(): ElectronAPI {
  return window.api as unknown as ElectronAPI
}

const CORRO_BASE_URL = "https://corro-code-backend.vercel.app/api/chat"
const SKIPPED_KEY = "corro-skipped"
const PROVISIONED_KEY = "corro-provisioned"

const FREE_LABELS: Record<string, string> = {
  "moonshotai/kimi-k3": "Kimi K3 (free)",
  "deepseek-ai/deepseek-v4-flash-0731": "DeepSeek V4 Flash (free)",
  "minimaxai/minimax-m3": "MiniMax M3 (free)",
  "nvidia/nemotron-3-super-120b-a12b": "Nemotron 3 Super (free)",
}

function parseAuthLink(url: string) {
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

export function CorroGate() {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [state, setState] = createStore({
    status: null as CorroStatus | null,
    phase: "loading" as "loading" | "welcome" | "waiting" | "working" | "ready" | "hidden",
    consent: false,
    error: null as string | null,
    skipped: localStorage.getItem(SKIPPED_KEY) === "1",
    ownKey: "",
    ownKeyError: null as string | null,
    ownKeySaved: false,
  })

  const t = (key: string, vars?: Record<string, string | number>) => language.t(key, vars)

  async function refresh() {
    try {
      const status = await bridge().corroStatus()
      setState("status", status)
      return status
    } catch {
      return state.status
    }
  }

  function provisioned() {
    const providers = (serverSync().data.config as { providers?: Record<string, unknown> } | undefined)?.providers
    return Boolean(providers && "corro" in providers)
  }

  async function provision(status: CorroStatus, ownKey?: string) {
    const access = await bridge().corroAccessToken()
    if (!access) throw new Error(t("corro.status.failed", { error: "missing session" }))
    const ids = status.models.length ? status.models : Object.keys(FREE_LABELS)
    const models = Object.fromEntries(ids.map((id) => [id, { name: FREE_LABELS[id] ?? id }]))
    await serverSDK().client.auth.set({ providerID: "corro", auth: { type: "api", key: access } })
    const config = serverSync().data.config as {
      model?: string
      disabled_providers?: string[]
    }
    const first = localStorage.getItem(PROVISIONED_KEY) !== "1"
    const disabled = new Set(config.disabled_providers ?? [])
    if (first) {
      disabled.add("opencode")
      disabled.add("opencode-go")
    }
    await serverSync().updateConfig({
      provider: {
        corro: {
          npm: "@ai-sdk/openai-compatible",
          name: "Corro",
          options: {
            baseURL: CORRO_BASE_URL,
            ...(ownKey ? { headers: { "x-own-key": ownKey } } : {}),
          },
          models,
        },
      },
      ...(config.model ? {} : ids[0] ? { model: `corro/${ids[0]}` } : {}),
      ...(first ? { disabled_providers: [...disabled] } : {}),
    } as never)
    await serverSync().refreshProviders()
    localStorage.setItem(PROVISIONED_KEY, "1")
  }

  async function afterAuth(status: CorroStatus) {
    setState({ status, error: null })
    if (status.trial?.state === "accepted" || status.ownKeySet) {
      setState("phase", "working")
      try {
        if (!provisioned()) await provision(status)
        setState("phase", "ready")
      } catch (error) {
        setState({ phase: "welcome", error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    setState("phase", "welcome")
  }

  async function signIn() {
    if (!state.consent) return
    setState({ error: null, phase: "waiting" })
    const url = await bridge().corroLoginUrl()
    bridge().openExternal(url)
  }

  async function rejoin() {
    setState("phase", "working")
    try {
      await afterAuth(await bridge().corroClaim())
    } catch (error) {
      setState({ phase: "welcome", error: error instanceof Error ? error.message : String(error) })
    }
  }

  async function onDeepLink(urls: string[]) {
    for (const url of urls) {
      const tokens = parseAuthLink(url)
      if (!tokens) continue
      setState("phase", "working")
      try {
        await afterAuth(await bridge().corroComplete(tokens, state.consent))
      } catch (error) {
        setState({ phase: "welcome", error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
  }

  async function saveOwnKey() {
    setState({ ownKeyError: null, ownKeySaved: false })
    const key = state.ownKey.trim()
    if (!key) return
    const result = await bridge().corroValidateOwnKey(key)
    if (!result.ok) {
      setState("ownKeyError", result.error ?? t("corro.status.failed", { error: "rejected" }))
      return
    }
    const status = await refresh()
    if (status) {
      try {
        await provision(status, key)
        setState({ ownKey: "", ownKeySaved: true })
        await afterAuth(await refresh().then((s) => s ?? status))
      } catch (error) {
        setState("ownKeyError", error instanceof Error ? error.message : String(error))
      }
    }
  }

  onMount(() => {
    let alive = true
    void refresh().then((status) => {
      if (!alive) return
      if (!status?.signedIn) {
        setState("phase", "welcome")
        return
      }
      void afterAuth(status)
    })
    const offDeepLink = bridge().onDeepLink((urls) => void onDeepLink(urls))
    const poll = setInterval(() => void refresh(), 20000)
    onCleanup(() => {
      alive = false
      clearInterval(poll)
      offDeepLink()
    })
  })

  function skip() {
    localStorage.setItem(SKIPPED_KEY, "1")
    setState("skipped", true)
  }

  const visible = () => {
    if (state.phase === "loading" || state.phase === "hidden") return false
    if (state.phase === "ready") return false
    if (!state.status?.signedIn && state.skipped) return false
    return true
  }

  const trialState = () => state.status?.trial?.state ?? "none"

  return (
    <Show when={visible()}>
      <div
        style={{
          position: "fixed",
          inset: "0",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          background: "var(--background-base, #14100d)",
          "z-index": 100,
        }}
      >
        <div style={{ "max-width": "420px", width: "calc(100% - 48px)", padding: "32px", "text-align": "center" }}>
          <Show when={state.phase === "welcome" && !state.status?.signedIn}>
            <h1 style={{ "font-size": "24px", margin: "0 0 4px" }}>{t("corro.welcome.title")}</h1>
            <p style={{ opacity: 0.7, "font-size": "14px", margin: "0 0 12px" }}>{t("corro.welcome.tagline")}</p>
            <p style={{ opacity: 0.85, "font-size": "14px" }}>{t("corro.welcome.body")}</p>
            <label style={{ display: "flex", gap: "8px", "align-items": "flex-start", "font-size": "13px", margin: "16px 0", "text-align": "left" }}>
              <input type="checkbox" checked={state.consent} onChange={(e) => setState("consent", e.currentTarget.checked)} />
              <span>{t("corro.welcome.consent")}</span>
            </label>
            <button
              disabled={!state.consent}
              onClick={() => void signIn()}
              style={{ width: "100%", padding: "10px", "font-size": "14px", cursor: state.consent ? "pointer" : "default" }}
            >
              {t("corro.welcome.signin")}
            </button>
            <p style={{ opacity: 0.6, "font-size": "12px" }}>{t("corro.welcome.verifiedNote")}</p>
            <button onClick={skip} style={{ background: "none", border: "none", opacity: 0.6, cursor: "pointer", "font-size": "13px" }}>
              {t("corro.welcome.skip")}
            </button>
            <Show when={state.error}>
              <p style={{ color: "var(--text-danger, #f87171)", "font-size": "13px" }}>{state.error}</p>
            </Show>
          </Show>

          <Show when={state.phase === "waiting" || state.phase === "working"}>
            <h1 style={{ "font-size": "20px" }}>{t("corro.welcome.title")}</h1>
            <p style={{ opacity: 0.75, "font-size": "14px" }}>
              {state.phase === "waiting" ? t("corro.status.waiting") : t("corro.status.working")}
            </p>
          </Show>

          <Show when={state.status?.signedIn && trialState() === "queued"}>
            <h1 style={{ "font-size": "20px" }}>{t("corro.queue.title")}</h1>
            <p style={{ opacity: 0.8, "font-size": "14px" }}>
              {t("corro.queue.body", { position: state.status?.trial?.position ?? 1 })}
            </p>
            <OwnKeyForm />
          </Show>

          <Show when={state.status?.signedIn && (trialState() === "expired" || trialState() === "removed")}>
            <h1 style={{ "font-size": "20px" }}>{t("corro.expired.title")}</h1>
            <p style={{ opacity: 0.8, "font-size": "14px" }}>{t("corro.expired.body")}</p>
            <button onClick={() => void rejoin()} style={{ padding: "10px 24px", "font-size": "14px", cursor: "pointer" }}>
              {t("corro.expired.rejoin")}
            </button>
            <OwnKeyForm />
          </Show>

          <Show when={state.phase === "ready"}>
            <h1 style={{ "font-size": "20px" }}>{t("corro.accepted.title")}</h1>
            <p style={{ opacity: 0.8, "font-size": "14px" }}>{t("corro.accepted.body")}</p>
            <button onClick={() => setState("phase", "hidden")} style={{ padding: "10px 24px", "font-size": "14px", cursor: "pointer" }}>
              {t("corro.accepted.go")}
            </button>
          </Show>
        </div>
      </div>
    </Show>
  )

  function OwnKeyForm() {
    return (
      <div style={{ margin: "16px 0 0", "text-align": "left" }}>
        <p style={{ opacity: 0.8, "font-size": "13px" }}>{t("corro.ownkey.label")}</p>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="password"
            value={state.ownKey}
            placeholder={t("corro.ownkey.placeholder")}
            onInput={(e) => setState("ownKey", e.currentTarget.value)}
            style={{ flex: "1", padding: "8px" }}
          />
          <button onClick={() => void saveOwnKey()} style={{ padding: "8px 16px", cursor: "pointer" }}>
            {t("corro.ownkey.save")}
          </button>
        </div>
        <Show when={state.ownKeyError}>
          <p style={{ color: "var(--text-danger, #f87171)", "font-size": "13px" }}>{state.ownKeyError}</p>
        </Show>
        <Show when={state.ownKeySaved}>
          <p style={{ "font-size": "13px" }}>{t("corro.ownkey.saved")}</p>
        </Show>
      </div>
    )
  }
}
