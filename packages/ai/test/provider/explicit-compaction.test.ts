import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { LLM, LLMRequest, Message } from "../../src/index.js"
import { LLMClient } from "../../src/route/client.js"
import { OpenAI, Azure, XAI, Anthropic, AmazonBedrockMantle } from "../../src/providers/index.js"
import { testEffect } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const checkpoint = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" }
const retained = {
  type: "message",
  role: "user",
  id: "msg_1",
  status: "completed",
  content: [{ type: "input_text", text: "retained", future_field: "preserve" }],
}
const output = [retained, checkpoint]

testEffect(fixedResponse("must not execute")).effect("xAI rejects automatic compaction options", () =>
  Effect.gen(function* () {
    const request = LLMRequest.update(
      LLM.request({ model: XAI.configure({ apiKey: "test" }).responses("grok-4.6"), prompt: "hello" }),
      { providerOptions: { contextManagement: [{ type: "compaction" }] } },
    )
    const error = yield* LLMClient.generate(request).pipe(Effect.flip)
    expect(error.reason._tag).toBe("InvalidRequest")
    expect(error.message).toContain("LLMClient.compact")
  }),
)

for (const model of [
  OpenAI.configure({ apiKey: "test" }).responses("gpt-5.3-codex"),
  Azure.configure({ apiKey: "test", resourceName: "test" }).responses("deployment"),
  XAI.configure({ apiKey: "test" }).responses("grok-4.6"),
]) {
  testEffect(
    dynamicResponse(({ request, text, respond }) =>
      Effect.sync(() => {
        const body = JSON.parse(text)
        expect(request.method).toBe("POST")
        expect(request.headers[model.provider === "azure" ? "api-key" : "authorization"]).toBe(
          model.provider === "azure" ? "test" : "Bearer test",
        )
        if (new URL(request.url).pathname.endsWith("/responses/compact")) {
          expect(body).toEqual({
            model: model.id,
            input: [{ role: "user", content: [{ type: "input_text", text: "original" }] }],
            instructions: "system",
          })
          return respond(
            JSON.stringify({
              object: "response.compaction",
              output,
              usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
            }),
            { headers: { "content-type": "application/json" } },
          )
        }
        expect(new URL(request.url).pathname.endsWith("/responses")).toBe(true)
        expect(body.input).toEqual([...output, { role: "user", content: [{ type: "input_text", text: "continue" }] }])
        return respond(sseEvents({ type: "response.completed", response: { id: "resp_1", output: [] } }), {
          headers: { "content-type": "text/event-stream" },
        })
      }),
    ),
  ).effect(`${model.provider} explicitly compacts and replays the entire canonical window`, () =>
    Effect.gen(function* () {
      const request = LLM.request({ model, prompt: "original", system: "system", http: { body: { store: false } } })
      const compacted = yield* LLMClient.compact(request)
      expect(compacted.usage?.totalTokens).toBe(1010)
      const codec = Schema.fromJsonString(Message)
      const message = Schema.decodeSync(codec)(Schema.encodeSync(codec)(compacted.message))
      yield* LLMClient.generate(LLMRequest.update(request, { messages: [message, Message.user("continue")] }))
    }),
  )
}

for (const model of [
  Anthropic.configure({ apiKey: "test" }).model("claude-opus-4-6"),
  AmazonBedrockMantle.configure({ apiKey: "test" }).responses("model"),
]) {
  testEffect(fixedResponse("must not execute")).effect(
    `${model.route.id} does not inherit an unsupported compact endpoint`,
    () =>
      Effect.gen(function* () {
        const error = yield* LLMClient.compact(LLM.request({ model, prompt: "hello" })).pipe(Effect.flip)
        expect(error.reason._tag).toBe("InvalidRequest")
      }),
  )
}

testEffect(
  fixedResponse(JSON.stringify({ object: "response.compaction", output: [retained], debug: "original payload" })),
).effect("invalid explicit compaction preserves the original response and HTTP context", () =>
  Effect.gen(function* () {
    const error = yield* LLMClient.compact(
      LLM.request({ model: OpenAI.configure({ apiKey: "test" }).responses("gpt-5.3-codex"), prompt: "hello" }),
    ).pipe(Effect.flip)
    expect(error.reason._tag).toBe("InvalidProviderOutput")
    expect(error.reason.body).toContain("original payload")
    expect(error.reason.http?.status).toBe(200)
  }),
)
