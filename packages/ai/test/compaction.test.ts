import { expect, test } from "bun:test"
import { Schema } from "effect"
import { CompactionPart, LLMEvent, LLMResponse, Message, ProviderID } from "../src/schema/index.js"

test("compaction survives event assembly and message serialization without becoming text", () => {
  const part = CompactionPart.make({
    provider: ProviderID.make("openai"),
    id: "cmp_1",
    encrypted: "opaque",
  })
  const response = LLMResponse.fromEvents([
    LLMEvent.textStart({ id: "before" }),
    LLMEvent.textDelta({ id: "before", text: "Before" }),
    LLMEvent.textEnd({ id: "before" }),
    part,
    LLMEvent.textStart({ id: "after" }),
    LLMEvent.textDelta({ id: "after", text: "After" }),
    LLMEvent.textEnd({ id: "after" }),
    LLMEvent.finish({ reason: { normalized: "stop" } }),
  ])!
  expect(response.message.content.map((part) => part.type)).toEqual(["text", "compaction", "text"])
  expect(response.text).toBe("BeforeAfter")
  expect(response.reasoning).toBe("")
  expect(response.events.filter(LLMEvent.is.compaction)).toEqual([part])
  const codec = Schema.fromJsonString(Message)
  expect(Schema.decodeSync(codec)(Schema.encodeSync(codec)(response.message))).toEqual(response.message)
})

test("compaction requires exactly one typed representation", () => {
  const provider = ProviderID.make("anthropic")
  expect(CompactionPart.make({ provider, text: null })).toEqual({ type: "compaction", provider, text: null })
  expect(() => CompactionPart.make({ provider })).toThrow()
  expect(() => CompactionPart.make({ provider, text: "summary", encrypted: "opaque" })).toThrow()
})
