import { EventStreamCodec } from "@smithy/eventstream-codec"
import { fromUtf8, toUtf8 } from "@smithy/util-utf8"
import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMRequest, Message } from "../../src/index.js"
import { LLMClient } from "../../src/route/client.js"
import { AmazonBedrock } from "../../src/providers/index.js"
import { testEffect } from "../lib/effect.js"
import { dynamicResponse, fixedResponse } from "../lib/http.js"

const codec = new EventStreamCodec(toUtf8, fromUtf8)
const frame = (event: object) =>
  codec.encode({
    headers: { ":message-type": { type: "string", value: "event" }, ":event-type": { type: "string", value: "chunk" } },
    body: new TextEncoder().encode(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString("base64") })),
  })
const response = Buffer.concat(
  [
    { type: "message_start", message: { usage: { input_tokens: 60000 } } },
    { type: "content_block_start", index: 0, content_block: { type: "compaction", content: null } },
    { type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "Summary" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ].map(frame),
)

for (const auth of [
  { apiKey: "test" },
  { credentials: { accessKeyId: "test", secretAccessKey: "test", region: "us-west-2" } },
]) {
  testEffect(
    dynamicResponse(({ request, text, respond }) =>
      Effect.sync(() => {
        expect(request.url).toBe(
          "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-opus-4-6-v1%3A0/invoke-with-response-stream",
        )
        expect(request.headers.authorization).toStartWith(auth.apiKey ? "Bearer test" : "AWS4-HMAC-SHA256")
        const body = JSON.parse(text)
        expect(body.model).toBeUndefined()
        expect(body.stream).toBeUndefined()
        expect(body.anthropic_version).toBe("bedrock-2023-05-31")
        expect(body.anthropic_beta).toEqual(["existing-beta", "compact-2026-01-12"])
        expect(body.context_management.edits).toEqual([{ type: "compact_20260112" }])
        if (body.messages.length > 1)
          expect(body.messages[1].content[0]).toEqual({ type: "compaction", content: "Summary" })
        return respond(response, { headers: { "content-type": "application/vnd.amazon.eventstream" } })
      }),
    ),
  ).effect(`Bedrock Messages compaction round trip with ${auth.apiKey ? "bearer" : "SigV4"} authentication`, () =>
    Effect.gen(function* () {
      const model = AmazonBedrock.configure({ ...auth, region: "us-west-2" }).messages("anthropic.claude-opus-4-6-v1:0")
      const request = LLM.request({
        model,
        prompt: "hello",
        http: { headers: { "anthropic-beta": "existing-beta, existing-beta, compact-2026-01-12" } },
        providerOptions: { contextManagement: { edits: [{ type: "compact_20260112" }] } },
      })
      const first = yield* LLMClient.generate(request)
      expect(first.text).toBe("Hello")
      expect(first.message.content.map((part) => part.type)).toEqual(["compaction", "text"])
      yield* LLMClient.generate(
        LLMRequest.update(request, { messages: [...request.messages, first.message, Message.user("continue")] }),
      )
    }),
  )
}

testEffect(
  fixedResponse(
    codec.encode({
      headers: {
        ":message-type": { type: "string", value: "exception" },
        ":exception-type": { type: "string", value: "throttlingException" },
      },
      body: new TextEncoder().encode(JSON.stringify({ message: "Too many requests", trace: "keep-original" })),
    }),
  ),
).effect("Bedrock Messages retains the original exception frame", () =>
  Effect.gen(function* () {
    const error = yield* LLMClient.generate(
      LLM.request({ model: AmazonBedrock.configure({ apiKey: "test" }).messages("claude"), prompt: "hello" }),
    ).pipe(Effect.flip)
    expect(error.reason.body).toContain("keep-original")
    expect(error.reason.http?.status).toBe(200)
  }),
)
