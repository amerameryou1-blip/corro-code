import { LLM, LLMClient } from "../../src/index.js"
import { OpenAI, Anthropic, AmazonBedrock } from "../../src/providers.js"

const openai = OpenAI.configure({
  apiKey: "test",
  providerOptions: { contextManagement: [{ type: "compaction", compactThreshold: 100000 }] },
}).responses("gpt-5.3-codex")
LLMClient.compact(LLM.request({ model: openai, prompt: "hello" }))
LLM.request({
  model: openai,
  providerOptions: {
    // @ts-expect-error A token threshold is numeric.
    contextManagement: [{ type: "compaction", compactThreshold: "100000" }],
  },
})
for (const model of [
  Anthropic.configure().model("claude-opus-4-6"),
  AmazonBedrock.configure().messages("anthropic.claude-opus-4-6-v1"),
]) {
  LLM.request({
    model,
    providerOptions: {
      contextManagement: {
        edits: [
          { type: "compact_20260112", pauseAfterCompaction: true, instructions: "Summarize without using tools" },
        ],
      },
    },
  })
  LLM.request({
    model,
    providerOptions: {
      // @ts-expect-error A pause setting is boolean.
      contextManagement: { edits: [{ type: "compact_20260112", pauseAfterCompaction: "yes" }] },
    },
  })
}
