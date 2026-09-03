import { useLanguage } from "@opencode-ai/app"
import { createStore } from "solid-js/store"
import { onCleanup, onMount, Show } from "solid-js"

import type { CorroStatus, ElectronAPI } from "../preload/types"

// window.api is typed loosely where the app shell overlaps the global
// declaration; narrow once here instead of casting at every call site.
function bridge(): ElectronAPI {
  return window.api as unknown as ElectronAPI
}

const SKIPPED_KEY = "corro-skipped"

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
  const [state, setState] = createStore({
    status: null as CorroStatus | null,
    phase: "loading" as "loading" | "welcome" | "waiting" | "working" | "ready" | "hidden",
    consent: false,
    error: null as string | null,
    skipped: localStorage.getItem(SKIPPED_KEY) === "1",
    ownKey: "",
    ownKeyError: null as string | null,
    ownKeySaved: false,
    reloadNeeded: false,
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

  async function settle(status: CorroStatus) {
    setState({ status, error: null })
    if (status.trial?.state === "accepted" || status.ownKeySet) {
      // Already fully set up: stay out of the way.
      if (status.provisioned) {
        setState("phase", "hidden")
        return
      }
      setState("phase", "working")
      try {
        const result = await bridge().corroProvision()
        setState({ status: result, reloadNeeded: result.changed, phase: "ready" })
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
      await settle(await bridge().corroClaim())
    } catch (error) {
      setState({ phase: "welcome", error: error instanceof Error ? error.message : String(error) })
    }
  }

  function startCoding() {
    if (state.reloadNeeded) {
      // The engine reads its config when a location opens; reload once so the
      // Corro models appear in the picker immediately. Sessions are kept.
      location.reload()
      return
    }
    setState("phase", "hidden")
  }

  async function onDeepLink(urls: string[]) {
    for (const url of urls) {
      const tokens = parseAuthLink(url)
      if (!tokens) continue
      setState("phase", "working")
      try {
        await settle(await bridge().corroComplete(tokens, state.consent))
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
    try {
      const provisioned = await bridge().corroProvision(key)
      setState({ ownKey: "", ownKeySaved: true, reloadNeeded: provisioned.changed })
      await settle(provisioned)
    } catch (error) {
      setState("ownKeyError", error instanceof Error ? error.message : String(error))
    }
  }

  onMount(() => {
    let alive = true
    // Google sign-in is out of scope while the app itself is under test:
    // signed-out users go straight to the full product, no gate.
    void refresh().then((status) => {
      if (!alive) return
      if (!status?.signedIn) {
        setState("phase", "hidden")
        return
      }
      void settle(status)
    })
    const offDeepLink = bridge().onDeepLink((urls) => void onDeepLink(urls))
    // Cold-start links never hit IPC: the shell queues them on
    // window.__OPENCODE__.deepLinks and re-emits a DOM event instead.
    const drainQueue = () => {
      try {
        const queued = (window as unknown as { __OPENCODE__?: { deepLinks?: unknown } }).__OPENCODE__?.deepLinks
        if (Array.isArray(queued) && queued.length) {
          ;(window as unknown as { __OPENCODE__: { deepLinks: unknown[] } }).__OPENCODE__.deepLinks = []
          void onDeepLink(queued.filter((u): u is string => typeof u === "string"))
        }
      } catch {}
    }
    const onDomLinks = (event: Event) => {
      const urls = (event as CustomEvent<{ urls?: unknown }>).detail?.urls
      if (Array.isArray(urls)) void onDeepLink(urls.filter((u): u is string => typeof u === "string"))
      else drainQueue()
    }
    window.addEventListener("opencode:deep-link", onDomLinks)
    drainQueue()
    const poll = setInterval(() => void refresh(), 20000)
    onCleanup(() => {
      alive = false
      clearInterval(poll)
      offDeepLink()
      window.removeEventListener("opencode:deep-link", onDomLinks)
    })
  })

  function skip() {
    localStorage.setItem(SKIPPED_KEY, "1")
    setState("skipped", true)
  }

  const visible = () => {
    if (state.phase === "loading" || state.phase === "hidden") return false
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
            <button onClick={startCoding} style={{ padding: "10px 24px", "font-size": "14px", cursor: "pointer" }}>
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
