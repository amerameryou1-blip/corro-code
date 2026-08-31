import { expect, test } from "bun:test"
import { AnthropicBetas } from "../../src/protocols/utils/anthropic-betas.js"

test("preserves existing betas without enabling compaction", () => {
  expect(AnthropicBetas.resolve({ messages: [] }, undefined)).toEqual([])
  expect(AnthropicBetas.resolve({ messages: [], context_management: { edits: [] } }, " , ")).toEqual([])
  expect(AnthropicBetas.resolve({ messages: [] }, " existing-beta,existing-beta,other-beta , ")).toEqual([
    "existing-beta",
    "other-beta",
  ])
})

test("adds the compaction beta for configuration or replay and deduplicates existing values", () => {
  for (const body of [
    { messages: [], context_management: { edits: [{ type: "compact_20260112" }] } },
    { messages: [{ role: "assistant", content: [{ type: "compaction", content: "Summary" }] }] },
    { messages: [{ role: "assistant", content: [{ type: "compaction", content: null }] }] },
  ] as const) {
    expect(AnthropicBetas.resolve(body, undefined)).toEqual(["compact-2026-01-12"])
    expect(AnthropicBetas.resolve(body, "existing-beta")).toEqual(["existing-beta", "compact-2026-01-12"])
    expect(AnthropicBetas.resolve(body, "existing-beta, compact-2026-01-12, existing-beta")).toEqual([
      "existing-beta",
      "compact-2026-01-12",
    ])
  }
})
