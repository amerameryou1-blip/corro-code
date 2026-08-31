import { Effect, Schema, Stream } from "effect"
import {
  AIError,
  InvalidProviderOutputError,
  CompactionPart,
  CompactionResponse,
  HttpOptions,
  LLMRequest,
  Message,
  type ContentPart,
  mergeJsonRecords,
} from "../../schema/index.js"
import type { CompactOperation } from "../../route/client.js"
import { Endpoint } from "../../route/endpoint.js"
import { RequestExecutor } from "../../route/executor.js"
import { HttpTransport } from "../../route/transport/index.js"
import { OpenResponses } from "../open-responses.js"
import { JsonObject, ProviderShared } from "../shared.js"

const Body = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(Schema.Unknown),
  instructions: Schema.optional(Schema.String),
  previous_response_id: Schema.optional(Schema.String),
})
const Response = Schema.Struct({
  object: Schema.Literal("response.compaction"),
  output: Schema.Array(
    Schema.Union([
      OpenResponses.CompactionItem,
      OpenResponses.OpenResponsesReasoningItem,
      Schema.Struct({
        type: Schema.Literal("message"),
        id: Schema.optional(Schema.String),
        role: Schema.Literals(["user", "assistant"]),
        status: Schema.optional(Schema.String),
        phase: Schema.optional(OpenResponses.MessagePhase),
        content: Schema.Array(
          Schema.Union([OpenResponses.OpenResponsesInputContent, OpenResponses.OpenResponsesOutputText]),
        ).check(Schema.isMinLength(1)),
      }),
    ]),
  ),
  usage: Schema.optional(Schema.StructWithRest(OpenResponses.OpenResponsesUsage, [JsonObject])),
})

export const execute: CompactOperation = Effect.fn("ResponsesCompaction.execute")(
  function* (request, executor, options) {
    const route = request.model.route
    const native = yield* route.body.from(request)
    const body = yield* ProviderShared.validateWith(Schema.decodeUnknownEffect(Body))(
      mergeJsonRecords(native, request.http?.body),
    )
    const url = Endpoint.render(route.endpoint, { request, body: native })
    url.pathname = `${url.pathname.replace(/\/$/, "")}/compact`
    const parts = yield* HttpTransport.jsonRequestParts({
      request: LLMRequest.update(request, {
        http: request.http === undefined ? undefined : new HttpOptions({ ...request.http, body: undefined }),
      }),
      body,
      endpoint: Endpoint.path(url.toString()),
      auth: route.auth,
      encodeBody: Schema.encodeSync(Schema.fromJsonString(Body)),
    })
    const response = yield* executor.execute(
      ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
      options?.http,
    )
    const text = yield* RequestExecutor.responseStream(response).pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (text, chunk) => text + chunk,
      ),
    )
    const invalid = (message: string, cause?: unknown) =>
      new AIError({
        reason: new InvalidProviderOutputError({
          route: route.id,
          message,
          body: text,
          cause,
          http: RequestExecutor.responseHttp(response),
        }),
      })
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Response))(text).pipe(
      Effect.mapError((cause) => invalid("Invalid compaction response", cause)),
    )
    if (!result.output.some((item) => item.type === "compaction"))
      return yield* invalid("Compaction response did not contain a checkpoint")
    const key = route.providerMetadataKey ?? String(request.model.provider)
    const messages = yield* Effect.forEach(result.output, (item) =>
      Effect.gen(function* () {
        if (item.type === "compaction")
          return Message.assistant(
            CompactionPart.make({
              provider: request.model.provider,
              id: item.id ?? undefined,
              encrypted: item.encrypted_content,
            }),
          )
        if (item.type === "reasoning") {
          const summary = item.summary.length ? item.summary : [{ text: "" }]
          return Message.assistant(
            summary.map((part) => ({
              type: "reasoning" as const,
              text: part.text,
              providerMetadata: { [key]: { itemId: item.id, reasoningEncryptedContent: item.encrypted_content } },
            })),
          )
        }
        const content: ContentPart[] = []
        for (const part of item.content) {
          if (part.type === "input_text" || part.type === "output_text") {
            content.push({ type: "text", text: part.text })
            continue
          }
          if (item.role !== "user") return yield* invalid("Compacted assistant messages must contain text")
          if (part.type === "input_image") {
            content.push({
              type: "media",
              mediaType: /^data:([^;,]+)/.exec(part.image_url)?.[1] ?? "image/*",
              data: part.image_url,
            })
            continue
          }
          const data = part.file_url ?? part.file_data
          if (data === undefined) return yield* invalid("Compacted file is missing its data or URL")
          content.push({
            type: "media",
            mediaType: /^data:([^;,]+)/.exec(data)?.[1] ?? "application/octet-stream",
            data,
            filename: part.filename,
          })
        }
        return Message.make({
          role: item.role,
          content,
          providerMetadata: { [key]: { itemId: item.id, type: item.type, status: item.status, phase: item.phase } },
        })
      }),
    )
    return new CompactionResponse({
      messages,
      usage: OpenResponses.mapUsage(result.usage, key),
    })
  },
)

export * as ResponsesCompaction from "./responses-compaction.js"
