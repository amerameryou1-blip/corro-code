import type { AnthropicMessages } from "../anthropic-messages.js"

export const resolve = (
  body: Pick<AnthropicMessages.AnthropicMessagesBody, "messages" | "context_management">,
  header: string | undefined,
) => {
  const betas = new Set(
    (header ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )
  if (
    body.context_management?.edits.length ||
    body.messages.some((message) => message.content.some((block) => block.type === "compaction"))
  )
    betas.add("compact-2026-01-12")
  return [...betas]
}

export * as AnthropicBetas from "./anthropic-betas.js"
