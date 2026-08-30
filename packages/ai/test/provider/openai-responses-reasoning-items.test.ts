import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent, Message } from "../../src/index.js"
import { OpenAIResponses } from "../../src/protocols/openai-responses.js"
import { configure } from "../../src/providers/openai-compatible-responses.js"
import { Auth, LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "reasoning-model" })
const request = LLM.request({ model, prompt: "Think it through." })
const completed = { type: "response.completed", response: { id: "resp_1" } }
const generate = (...events: OpenAIResponses.Event[]) =>
  LLMClient.generate(request).pipe(Effect.provide(fixedResponse(sseEvents(...events))))

describe("OpenAI Responses reasoning items", () => {
  it.effect("streams one block and replays the completed item by route", () =>
    Effect.gen(function* () {
      const item = {
        type: "reasoning",
        id: "rs_1",
        summary: [
          { type: "summary_text", text: "Corrected summary." },
          { type: "summary_text", text: "Second summary." },
        ],
        content: [{ type: "reasoning_text", text: "Completed raw." }],
        status: "completed",
        future_field: { retained: true },
      } as const
      const response = yield* generate(
        {
          type: "response.output_item.added",
          output_index: 2,
          item: { type: "reasoning", id: "rs_1", encrypted_content: "added-state" },
        },
        {
          type: "response.reasoning_text.delta",
          output_index: 2,
          item_id: "wrong",
          content_index: 0,
          delta: "Raw delta. ",
        },
        {
          type: "response.reasoning_summary_text.delta",
          output_index: 2,
          item_id: "wrong",
          summary_index: 0,
          delta: "Summary delta.",
        },
        { type: "response.reasoning_summary_part.added", item_id: "rs_1", summary_index: 1 },
        {
          type: "response.reasoning_summary_text.done",
          item_id: "rs_1",
          summary_index: 1,
          text: "Second summary.",
        },
        { type: "response.reasoning.delta", item_id: "rs_1", content_index: 1, delta: " Raw tail." },
        { type: "response.output_item.done", item },
        completed,
      )
      const stored = { ...item, encrypted_content: "added-state" }

      expect(response.events.filter(LLMEvent.is.reasoningStart)).toEqual([
        { type: "reasoning-start", id: "rs_1", providerMetadata: undefined },
      ])
      expect(response.events.filter(LLMEvent.is.reasoningDelta).map((event) => event.text)).toEqual([
        "Raw delta. ",
        "Summary delta.",
        "\n\nSecond summary.",
        " Raw tail.",
      ])
      expect(response.events.filter(LLMEvent.is.reasoningEnd)).toEqual([
        {
          type: "reasoning-end",
          id: "rs_1",
          text: "Corrected summary.\n\nSecond summary.",
          providerMetadata: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "added-state",
              reasoningItem: stored,
            },
          },
        },
      ])
      expect(response.message.content).toEqual([
        {
          type: "reasoning",
          text: "Corrected summary.\n\nSecond summary.",
          providerMetadata: {
            openai: {
              itemId: "rs_1",
              reasoningEncryptedContent: "added-state",
              reasoningItem: stored,
            },
          },
        },
      ])

      const native = yield* compileRequest(LLM.request({ model, messages: [response.message] }))
      expect(native.body.input).toEqual([stored])

      const reasoning = response.message.content[0]
      if (reasoning?.type !== "reasoning") return
      const sharedModel = configure({ apiKey: "test", baseURL: "https://responses.test/v1" }).model("shared-model")
      const shared = yield* compileRequest(
        LLM.request({
          model: sharedModel,
          messages: [
            Message.assistant({
              ...reasoning,
              providerMetadata: { "openai-compatible": reasoning.providerMetadata?.openai ?? {} },
            }),
          ],
        }),
      )
      expect(shared.body.input).toEqual([
        {
          type: "reasoning",
          id: "rs_1",
          summary: item.summary,
          encrypted_content: "added-state",
        },
      ])
    }),
  )

  it.effect("uses completed raw content and then streamed fallback", () =>
    Effect.gen(function* () {
      const raw = yield* generate(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_raw" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_raw", delta: "Provisional" },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_raw",
            summary: [{ type: "summary_text", text: "" }],
            content: [{ type: "reasoning_text", text: "Raw final" }],
          },
        },
        completed,
      )
      const fallback = yield* generate(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_fallback" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_fallback", delta: "Streamed text" },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_fallback", summary: [], content: [] },
        },
        completed,
      )

      expect(raw.reasoning).toBe("Raw final")
      expect(fallback.reasoning).toBe("Streamed text")
      expect(raw.events.filter(LLMEvent.is.reasoningEnd).map((event) => event.text)).toEqual(["Raw final"])
      expect(fallback.events.filter(LLMEvent.is.reasoningEnd).map((event) => event.text)).toEqual(["Streamed text"])
    }),
  )

  it.effect("tracks raw and summary indexes independently with an empty item ID", () =>
    Effect.gen(function* () {
      const response = yield* generate(
        { type: "response.output_item.added", item: { type: "reasoning", id: "" } },
        { type: "response.reasoning_text.delta", item_id: "", content_index: 0, delta: "Raw" },
        { type: "response.reasoning_text.done", item_id: "", content_index: 0, text: "Raw duplicate" },
        { type: "response.reasoning_summary_text.done", item_id: "", summary_index: 0, text: "Summary" },
        { type: "response.reasoning.delta", item_id: "", content_index: 1, delta: " raw tail" },
        { type: "response.reasoning.done", item_id: "", content_index: 1, text: "raw duplicate" },
        { type: "response.reasoning_summary_text.delta", item_id: "", summary_index: 1, delta: "Second" },
        { type: "response.reasoning_summary_text.done", item_id: "", summary_index: 1, text: "duplicate" },
        { type: "response.output_item.done", item: { type: "reasoning", id: "", summary: [], content: [] } },
        completed,
      )

      expect(response.events.filter(LLMEvent.is.reasoningDelta).map((event) => event.text)).toEqual([
        "Raw",
        "Summary",
        " raw tail",
        "\n\nSecond",
      ])
      expect(response.events.filter(LLMEvent.is.reasoningStart).map((event) => event.id)).toEqual([""])
      expect(response.events.filter(LLMEvent.is.reasoningEnd).map((event) => event.id)).toEqual([""])
    }),
  )

  it.effect("does not replay reasoning without output item completion", () =>
    Effect.gen(function* () {
      const response = yield* generate(
        {
          type: "response.output_item.added",
          item: { type: "reasoning", id: "rs_partial", encrypted_content: "partial-state" },
        },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_partial", delta: "Partial" },
        {
          type: "response.completed",
          response: {
            id: "resp_1",
            output: [
              {
                type: "reasoning",
                id: "rs_partial",
                summary: [{ type: "summary_text", text: "Terminal" }],
                encrypted_content: "terminal-state",
              },
            ],
          },
        },
      )

      expect(response.reasoning).toBe("Partial")
      expect(response.message.content).toEqual([{ type: "reasoning", text: "Partial" }])
      expect(response.events.filter(LLMEvent.is.reasoningEnd)).toEqual([{ type: "reasoning-end", id: "rs_partial" }])
      const replay = yield* compileRequest(LLM.request({ model, messages: [response.message] }))
      expect(replay.body.input).toEqual([])
    }),
  )

  it.effect("keeps sequential reasoning items separate", () =>
    Effect.gen(function* () {
      const response = yield* generate(
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "First" }] },
        },
        {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_2", summary: [{ type: "summary_text", text: "Second" }] },
        },
        completed,
      )

      expect(response.message.content.map((part) => (part.type === "reasoning" ? part.text : undefined))).toEqual([
        "First",
        "Second",
      ])
      expect(response.events.filter(LLMEvent.is.reasoningStart).map((event) => event.id)).toEqual(["rs_1", "rs_2"])
      expect(response.events.filter(LLMEvent.is.reasoningEnd).map((event) => event.id)).toEqual(["rs_1", "rs_2"])
    }),
  )
})
