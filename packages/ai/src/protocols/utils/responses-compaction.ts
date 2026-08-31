import { Effect, Schema, Stream } from "effect"
import {
  AIError,
  InvalidProviderOutputError,
  CompactionPart,
  CompactionResponse,
  HttpOptions,
  LLMRequest,
  Message,
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
  output: Schema.Array(Schema.Json),
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
    if (!result.output.some(Schema.is(OpenResponses.CompactionItem)))
      return yield* invalid("Compaction response did not contain a checkpoint")
    return new CompactionResponse({
      message: Message.assistant(
        CompactionPart.make({ provider: request.model.provider, format: "responses", value: result.output }),
      ),
      usage: OpenResponses.mapUsage(result.usage, route.providerMetadataKey ?? String(request.model.provider)),
    })
  },
)

export * as ResponsesCompaction from "./responses-compaction.js"
