import { Effect, Encoding, Schema } from "effect"
import { Headers } from "effect/unstable/http"
import { Route } from "../route/client.js"
import { Auth } from "../route/auth.js"
import { Endpoint } from "../route/endpoint.js"
import { Protocol } from "../route/protocol.js"
import { HttpTransport } from "../route/transport/index.js"
import { LLMRequest, type JsonSchema, type ToolDefinition } from "../schema/index.js"
import { OpenResponses } from "./open-responses.js"
import { JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared.js"
import { OpenAIImage } from "./utils/openai-image.js"
import { ResponsesHostedTools } from "./utils/responses-hosted-tools.js"
import { ToolSchemaProjection } from "./utils/tool-schema.js"
import { OpenResponsesChannel } from "./open-responses-channel.js"

const ADAPTER = "openai-responses"
const NAME = "OpenAI Responses"
const WEBSOCKET_PROTOCOL_HEADER = "responses_websockets=2026-02-06"
const WEBSOCKET_ROTATE_AFTER_MS = 55 * 60 * 1000
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = OpenResponses.PATH

const OpenAIResponsesImageGenerationTool = Schema.Struct({
  type: Schema.tag("image_generation"),
  action: Schema.optional(Schema.Literals(["auto", "generate", "edit"])),
  background: Schema.optional(Schema.Literals(["auto", "opaque", "transparent"])),
  input_fidelity: Schema.optional(Schema.Literals(["low", "high"])),
  output_compression: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))),
  output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
  partial_images: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  quality: Schema.optional(Schema.Literals(["auto", "low", "medium", "high"])),
  size: Schema.optional(OpenAIImage.Size),
})

const OpenAIResponsesCustomTool = Schema.Struct({
  type: Schema.tag("custom"),
  name: Schema.String,
  description: Schema.String,
  format: Schema.optional(
    Schema.Struct({
      type: Schema.tag("grammar"),
      syntax: Schema.Literals(["lark", "regex"]),
      definition: Schema.String,
    }),
  ),
})

const OpenAIResponsesCustomToolItem = Schema.Union([
  Schema.Struct({
    type: Schema.tag("custom_tool_call"),
    id: Schema.optional(Schema.String),
    call_id: Schema.String,
    name: Schema.String,
    input: Schema.String,
  }),
  Schema.Struct({
    type: Schema.tag("custom_tool_call_output"),
    call_id: Schema.String,
    output: OpenResponses.FunctionCallOutput,
  }),
])

const OpenAIResponsesHostedToolItem = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.tag("computer_call"),
      id: Schema.String,
      status: Schema.optional(Schema.String),
      call_id: Schema.optional(Schema.String),
      action: optionalNull(JsonObject),
      pending_safety_checks: Schema.optional(Schema.Array(JsonObject)),
    }),
    [JsonObject],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.tag("web_search_preview_call"),
      id: Schema.String,
      status: Schema.optional(Schema.String),
      action: optionalNull(JsonObject),
    }),
    [JsonObject],
  ),
  Schema.StructWithRest(
    Schema.Struct({
      type: Schema.tag("image_generation_call"),
      id: Schema.String,
      status: Schema.optional(Schema.String),
      result: optionalNull(Schema.String),
      output_format: Schema.optional(Schema.Literals(["png", "jpeg", "webp"])),
      revised_prompt: optionalNull(Schema.String),
    }),
    [JsonObject],
  ),
])

const OpenAIResponsesTools = Schema.Union([
  OpenResponses.Tool,
  OpenAIResponsesCustomTool,
  OpenAIResponsesImageGenerationTool,
])

const OpenAIResponsesToolChoice = Schema.Union([
  Schema.Struct({
    type: Schema.tag("allowed_tools"),
    mode: Schema.Literals(["auto", "none", "required"]),
    tools: Schema.Array(
      Schema.Union([
        Schema.Struct({ type: Schema.tag("function"), name: Schema.String }),
        Schema.Struct({ type: Schema.tag("custom"), name: Schema.String }),
      ]),
    ),
  }),
  OpenResponses.ToolChoice,
  Schema.Struct({ type: Schema.tag("custom"), name: Schema.String }),
  Schema.Struct({ type: Schema.tag("image_generation") }),
])

const OpenAIResponsesCoreFields = {
  ...OpenResponses.coreFields,
  input: Schema.Array(
    Schema.Union([OpenResponses.InputItem, OpenAIResponsesCustomToolItem, OpenAIResponsesHostedToolItem]),
  ),
  tools: optionalArray(OpenAIResponsesTools),
  tool_choice: Schema.optional(OpenAIResponsesToolChoice),
}

const OpenAIResponsesBody = Schema.Struct({
  ...OpenAIResponsesCoreFields,
  stream: Schema.Literal(true),
})
export type OpenAIResponsesBody = Schema.Schema.Type<typeof OpenAIResponsesBody>

const adapter = {
  id: ADAPTER,
  name: NAME,
  restoreHostedToolItem: (item: unknown) => (Schema.is(OpenAIResponsesHostedToolItem)(item) ? item : undefined),
  freeformTools: (request: LLMRequest) =>
    request.model.compatibility?.supportsFreeformTools === true
      ? request.tools.flatMap((tool) =>
          tool.freeform
            ? [{ name: tool.name, wireName: tool.freeform.name ?? tool.name, input: tool.freeform.input }]
            : [],
        )
      : [],
} satisfies OpenResponses.ProviderAdapter

const nativeImageToolInput = (tool: ToolDefinition) => {
  const native = tool.native?.openai
  return ProviderShared.isRecord(native) && native.type === "image_generation" ? native : undefined
}

const nativeImageTool = (tool: ToolDefinition) => {
  const native = nativeImageToolInput(tool)
  return Schema.is(OpenAIResponsesImageGenerationTool)(native) ? native : undefined
}

const lowerTool = Effect.fn("OpenAIResponses.lowerTool")(function* (
  tool: ToolDefinition,
  inputSchema: JsonSchema,
  supportsFreeformTools: boolean,
) {
  const native = nativeImageToolInput(tool)
  if (native !== undefined) {
    if (Schema.is(OpenAIResponsesImageGenerationTool)(native)) return native
    return yield* ProviderShared.invalidRequest("OpenAI Responses image generation tool options are invalid")
  }
  if (tool.freeform && supportsFreeformTools) {
    const properties = ProviderShared.isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : undefined
    const property = properties?.[tool.freeform.input]
    const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : []
    if (
      tool.inputSchema.type !== "object" ||
      !ProviderShared.isRecord(property) ||
      property.type !== "string" ||
      Object.keys(properties ?? {}).length !== 1 ||
      required.length !== 1 ||
      required[0] !== tool.freeform.input
    )
      return yield* ProviderShared.invalidRequest(
        `OpenAI Responses freeform tool ${tool.name} requires exactly one required string input property named ${tool.freeform.input}`,
      )
    const grammar = tool.freeform.grammars?.[0]
    return {
      type: "custom" as const,
      name: tool.freeform.name ?? tool.name,
      description: tool.description,
      ...(grammar
        ? {
            format: {
              type: "grammar" as const,
              syntax: grammar.dialect === "oai-lark" ? ("lark" as const) : ("regex" as const),
              definition: grammar.definition,
            },
          }
        : {}),
    }
  }
  return yield* OpenResponses.lowerTool(NAME, tool, inputSchema)
})

const lowerToolChoice = (
  toolChoice: NonNullable<LLMRequest["toolChoice"]>,
  tools: ReadonlyArray<ToolDefinition>,
  supportsFreeformTools: boolean,
) =>
  ProviderShared.matchToolChoice(NAME, toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) =>
      tools.some((tool) => tool.name === name && nativeImageTool(tool) !== undefined)
        ? ({ type: "image_generation" } as const)
        : supportsFreeformTools && tools.find((tool) => tool.name === name)?.freeform
          ? { type: "custom" as const, name: tools.find((tool) => tool.name === name)?.freeform?.name ?? name }
          : { type: "function" as const, name },
  })

const decodeBody = ProviderShared.validateWith(Schema.decodeUnknownEffect(OpenAIResponsesBody))

const fromRequest = Effect.fn("OpenAIResponses.fromRequest")(function* (request: LLMRequest) {
  const body = yield* OpenResponses.fromRequestWithAdapter(
    LLMRequest.update(request, { tools: [], toolChoice: undefined }),
    adapter,
    request,
  )
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  const supportsFreeformTools = request.model.compatibility?.supportsFreeformTools === true
  const names = request.tools.map((tool) =>
    supportsFreeformTools && tool.freeform ? (tool.freeform.name ?? tool.name) : tool.name,
  )
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate)
    return yield* ProviderShared.invalidRequest(
      `OpenAI Responses has multiple tools with model-facing name ${duplicate}`,
    )
  const parallelToolCalls = OpenResponses.resolveParallelToolCalls(request)
  return yield* decodeBody({
    ...body,
    ...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
    tools:
      request.tools.length === 0
        ? undefined
        : yield* Effect.forEach(request.tools, (tool) =>
            lowerTool(
              tool,
              ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility),
              supportsFreeformTools,
            ),
          ),
    tool_choice:
      body.tool_choice ??
      (request.toolChoice
        ? yield* lowerToolChoice(request.toolChoice, request.tools, supportsFreeformTools)
        : undefined),
  })
})

const hostedToolResult = Effect.fn("OpenAIResponses.hostedToolResult")(function* (item: ResponsesHostedTools.Item) {
  const isError = item.error !== undefined && item.error !== null
  if (item.type === "image_generation_call" && item.result) {
    yield* Effect.fromResult(Encoding.decodeBase64(item.result)).pipe(
      Effect.mapError((cause) =>
        ProviderShared.eventError(ADAPTER, "OpenAI Responses returned invalid image base64", undefined, cause),
      ),
    )
    const format = item.output_format ?? "png"
    return {
      type: "content" as const,
      value: [
        {
          type: "file" as const,
          uri: `data:image/${format};base64,${item.result}`,
          mime: `image/${format}`,
        },
      ],
    }
  }
  return isError ? { type: "error" as const, value: item.error } : { type: "json" as const, value: item }
})

const HOSTED_TOOLS = {
  web_search_call: { name: "web_search", input: (item) => item.action ?? {} },
  web_search_preview_call: { name: "web_search_preview", input: (item) => item.action ?? {} },
  file_search_call: { name: "file_search", input: (item) => ({ queries: item.queries ?? [] }) },
  code_interpreter_call: {
    name: "code_interpreter",
    input: (item) => ({ code: item.code, container_id: item.container_id }),
  },
  computer_call: { name: "computer_use", input: (item) => item.action ?? {} },
  image_generation_call: { name: "image_generation", input: () => ({}), result: hostedToolResult },
  mcp_call: {
    name: "mcp",
    input: (item) => ({ server_label: item.server_label, name: item.name, arguments: item.arguments }),
  },
} as const satisfies ResponsesHostedTools.Definitions

const step = (state: OpenResponses.ParserState, event: OpenResponses.Event) => {
  if (event.type === "response.reasoning_text.delta")
    return event.item_id !== undefined
      ? Effect.succeed(
          OpenResponses.onReasoningDelta(state, event, OpenResponses.outputItemID(state, event) ?? event.item_id),
        )
      : ProviderShared.eventError(ADAPTER, `${event.type} is missing item_id`)
  if (event.type === "response.output_item.done" && event.item && ResponsesHostedTools.isItem(event.item, HOSTED_TOOLS))
    return ResponsesHostedTools.onDone(state, event.item, HOSTED_TOOLS)
  return OpenResponses.step(state, event)
}

export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIResponsesBody,
    from: fromRequest,
  },
  stream: {
    event: OpenResponses.protocol.stream.event,
    initial: (request) => OpenResponses.initial(request, adapter),
    step,
    terminal: OpenResponses.terminal,
  },
})

const endpoint = Endpoint.path<OpenAIResponsesBody>(PATH, { baseURL: DEFAULT_BASE_URL })
const auth = Auth.none

export const httpTransport = HttpTransport.sseJson.with<OpenAIResponsesBody>()
export const channelTransport = OpenResponsesChannel.transport<OpenAIResponsesBody>
export const transport = channelTransport({
  id: ADAPTER,
  name: NAME,
  rotateAfterMs: WEBSOCKET_ROTATE_AFTER_MS,
  headers: (headers) => Headers.set(headers, "openai-beta", headers["openai-beta"] ?? WEBSOCKET_PROTOCOL_HEADER),
})

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  providerMetadataKey: "openai",
  protocol,
  endpoint,
  auth,
  transport,
  defaults: { providerOptions: { store: false, include: ["reasoning.encrypted_content"] } },
})

export * as OpenAIResponses from "./openai-responses.js"
