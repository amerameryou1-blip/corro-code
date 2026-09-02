import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { PromptSubmissionError } from "@opencode-ai/client/solid"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { showToast } from "@/shell/notifications/toast"

export function PromptSubmission(props: { sessionID: string; id: string; class?: string }) {
  const data = useData()
  const language = useLanguage()
  const [state, setState] = createStore({ cancelling: false })
  const submission = () => data.session.submission.get(props.sessionID, props.id)
  const failed = (error: unknown) => {
    if (error instanceof PromptSubmissionError) return
    showToast({ title: language.t("common.requestFailed") })
  }
  const cancel = () => {
    setState("cancelling", true)
    void data.session.pending
      .cancel(props.sessionID, props.id)
      .catch(failed)
      .finally(() => setState("cancelling", false))
  }
  return (
    <Show when={submission()}>
      {(submission) => (
        <div
          data-component="prompt-submission"
          data-submission-id={props.id}
          class={`flex min-h-7 flex-wrap items-center gap-x-2 text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted ${props.class ?? ""}`}
        >
          <span role="status">{language.t(`session.submission.${submission().status}`)}</span>
          <Show when={submission().status === "failed"}>
            <Button
              type="button"
              size="small"
              variant="ghost-muted"
              disabled={state.cancelling}
              onClick={() => void data.session.submission.retry(props.sessionID, props.id).catch(failed)}
            >
              {language.t("session.submission.retry")}
            </Button>
          </Show>
          <Button type="button" size="small" variant="ghost-muted" disabled={state.cancelling} onClick={cancel}>
            {language.t("common.cancel")}
          </Button>
        </div>
      )}
    </Show>
  )
}
