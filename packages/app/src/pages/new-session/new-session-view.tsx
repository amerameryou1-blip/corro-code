import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Show, createMemo, createSignal, type Accessor, For } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import createPresence from "solid-presence"
import { PromptInputV2Composer } from "@/components/prompt-input-v2"
import { PromptGitStatus, PromptWorkspaceSelector } from "@/components/prompt-workspace-selector"
import {
  PromptProjectAddButton,
  PromptProjectSelector,
  type PromptProjectController,
} from "@/components/prompt-project-selector"
import { StatusPopoverV2 } from "@/components/status-popover"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useProviders } from "@/hooks/use-providers"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import { Persist, persisted } from "@/utils/persist"
import type { NewSessionDraftController } from "./new-session-draft-controller"
import type { NewSessionWorkspaceController } from "./new-session-workspace-controller"

const providerTipDismissalDuration = 30 * 24 * 60 * 60 * 1000

export function NewSessionView(props: {
  input: NewSessionDraftController["input"]
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
  onSuggest?: (text: string) => void
}) {
  const language = useLanguage()
  return (
    <div class="@container relative flex flex-col min-h-0 h-full flex-1">
      <div
        data-component="session-new-design"
        class="relative flex-1 min-h-0 overflow-hidden rounded-[10px] border-t-2 border-t-[#b0662a]/70 bg-v2-background-bg-deep"
      >
        <div class="absolute inset-x-0 top-[12%] flex justify-center px-6">
          <div class={NEW_SESSION_CONTENT_WIDTH}>
            <div class="flex items-center justify-center gap-7">
              <div data-component="corro-stage" aria-hidden="true">
                <span data-component="corro-orbit" />
                <svg viewBox="0 0 81 81" fill="none" class="relative z-[1] size-[68px]">
                  <rect width="81" height="81" rx="20" fill="#b35624" />
                  <path
                    d="M60 26H41a6 6 0 0 0-6 6v17a6 6 0 0 0 6 6h19"
                    stroke="#fff"
                    stroke-width="8"
                    stroke-linecap="round"
                  />
                </svg>
              </div>
              <div class="min-w-0">
                <span data-component="corro-hero-overline">{language.t("home.new.overline")}</span>
                <h1 data-component="corro-hero-title">corro code</h1>
                <p class="mt-2.5 text-[14px] font-[450] tracking-[0.01em] text-v2-text-text-muted">
                  {language.t("home.new.tagline")}
                </p>
              </div>
            </div>
            <div class="mt-10 flex flex-col gap-5">
              <Show when={props.project.selected()}>
                <div data-component="corro-context-bar" class="flex min-h-7 min-w-0 flex-col items-center justify-center gap-0 text-v2-text-text-faint sm:flex-row">
                  <PromptProjectSelector controller={props.project} placement="bottom" />
                  <Show
                    when={props.workspace.bar.visible()}
                    fallback={
                      <PromptGitStatus branch={props.workspace.bar.branch()} noGit={!props.workspace.project.git()} />
                    }
                  >
                    <PromptWorkspaceSelector
                      value={props.workspace.selection.value()}
                      projectRoot={props.workspace.project.root()}
                      workspaces={props.workspace.project.workspaces()}
                      branch={props.workspace.bar.branch()}
                      onChange={props.workspace.selection.set}
                      onDone={props.input.restoreFocus}
                    />
                  </Show>
                </div>
              </Show>
              <Show when={props.project.empty()}>
                <div class="flex justify-center">
                  <PromptProjectAddButton controller={props.project} />
                </div>
              </Show>
              <PromptInputV2Composer controller={props.input} />
              <Show when={props.onSuggest}>
                <SuggestChips onSuggest={props.onSuggest!} />
              </Show>
            </div>
          </div>
        </div>
        <ProviderTip />
      </div>
    </div>
  )
}

function SuggestChips(props: { onSuggest: (text: string) => void }) {
  const language = useLanguage()
  const chips = [
    { icon: "help", label: "home.new.suggest.explain.label", prompt: "home.new.suggest.explain.prompt" },
    { icon: "branch", label: "home.new.suggest.fix.label", prompt: "home.new.suggest.fix.prompt" },
    { icon: "edit", label: "home.new.suggest.tests.label", prompt: "home.new.suggest.tests.prompt" },
  ] as const
  return (
    <div class="flex flex-wrap items-center justify-center gap-2" data-component="corro-suggest">
      <For each={chips}>
        {(chip, index) => (
          <button
            type="button"
            data-component="corro-suggest-chip"
            class={`
              flex h-9 min-w-0 flex-1 shrink-0 cursor-default items-center gap-2 rounded-[10px] border-0 px-3
              bg-v2-background-bg-layer-01 text-[13px] font-[500] tracking-[-0.01em]
              text-v2-text-text-muted transition-all duration-150 ease-in-out
              hover:-translate-y-px hover:text-v2-text-text-base focus-visible:outline-none
            `}
            onClick={() => props.onSuggest(language.t(chip.prompt))}
          >
            <span class="corro-suggest-num">0{index() + 1}</span>
            <IconV2 name={chip.icon} size="small" class="shrink-0 text-v2-text-text-accent" />
            <span class="truncate">{language.t(chip.label)}</span>
            <i class="corro-suggest-go">→</i>
          </button>
        )}
      </For>
    </div>
  )
}

export function NewSessionStatus(props: { mount: Accessor<HTMLElement | null>; visible: Accessor<boolean> }) {
  const language = useLanguage()

  return (
    <Show when={props.mount()} keyed>
      {(mount) => (
        <Portal mount={mount}>
          <Show when={props.visible()}>
            <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
              <StatusPopoverV2 />
            </Tooltip>
          </Show>
        </Portal>
      )}
    </Show>
  )
}

function ProviderTip() {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const serverSync = useServerSync()
  const providers = useProviders(() => sdk().directory)
  const [persistedState, setPersistedState, , persistedReady] = persisted(
    Persist.global("new-session.provider-tip"),
    createStore({ dismissedAt: 0 }),
  )
  const visible = createMemo(
    () =>
      serverSync().child(sdk().directory)[0].provider_ready &&
      persistedReady() &&
      providers.paid().length === 0 &&
      Date.now() - persistedState.dismissedAt >= providerTipDismissalDuration,
  )
  const [ref, setRef] = createSignal<HTMLDivElement>()
  const presence = createPresence({
    show: visible,
    element: () => ref() ?? null,
  })
  const openProviders = () => {
    void import("@/components/dialog-connect-provider").then(({ DialogConnectProvider }) => {
      void dialog.show(() => <DialogConnectProvider directory={() => sdk().directory} />)
    })
  }

  return (
    <Show when={presence.present()}>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-10">
        <div
          ref={setRef}
          data-component="provider-tip"
          data-visible={visible()}
          class="group/provider-tip pointer-events-auto relative flex h-6 max-w-full items-center transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:transition-none"
          classList={{ "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": true }}
        >
          <button
            type="button"
            class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-none tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"
            onClick={openProviders}
          >
            <span class="truncate">{language.t("home.providerTip")}</span>
            <span class="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <IconV2 name="chevron-down" size="small" class="-rotate-90" />
            </span>
          </button>
          <TooltipV2
            class="hover-reveal absolute left-full top-0 flex h-6 w-7 items-center justify-end delay-0 duration-0 group-hover/provider-tip:delay-[250ms] group-hover/provider-tip:duration-150 group-hover/provider-tip:opacity-100 focus-within:delay-0 focus-within:duration-0 focus-within:opacity-100"
            placement="top"
            openDelay={1000}
            value={language.t("common.dismiss")}
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none"
              aria-label={language.t("common.dismiss")}
              onClick={() => setPersistedState("dismissedAt", Date.now())}
            >
              <IconV2 name="xmark-small" />
            </button>
          </TooltipV2>
        </div>
      </div>
    </Show>
  )
}
