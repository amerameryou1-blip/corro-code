import { HttpRecorder } from "@opencode-ai/http-recorder"
import { NodeSocket } from "@effect/platform-node"
import { Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { LLMClient, RequestExecutor } from "../src/route.js"
import { ImageClient } from "../src/image-client.js"
import type { Service as ImageClientService } from "../src/image-client.js"
import type { Service as LLMClientService } from "../src/route/client.js"
import type { Service as RequestExecutorService } from "../src/route/executor.js"
import { ProviderShared } from "../src/protocols/shared.js"
import {
  recordedEffectGroup,
  type RecordedCaseOptions as RunnerCaseOptions,
  type RecordedGroupOptions,
} from "./recorded-runner.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(__dirname, "fixtures", "recordings")

type RecordedEnv = RequestExecutorService | LLMClientService | ImageClientService | Socket.WebSocketConstructor

type RecordedTestsOptions = RecordedGroupOptions & {
  readonly options?: HttpRecorder.RecorderOptions
}

type RecordedCaseOptions = RunnerCaseOptions & {
  readonly options?: HttpRecorder.RecorderOptions
}

const reasoningRequestBody = (body: string) => {
  const value = ProviderShared.decodeJson(body)
  if (!ProviderShared.isRecord(value) || !Array.isArray(value.input)) return body
  return ProviderShared.encodeJson({
    ...value,
    input: value.input.map((item) => {
      if (!ProviderShared.isRecord(item) || item.type !== "reasoning") return item
      if (!Array.isArray(item.content) || item.content.length > 0) return item
      return Object.fromEntries(Object.entries(item).filter(([key]) => key !== "content"))
    }),
  })
}

export const matchOptionalEmptyReasoningContent: HttpRecorder.RequestMatcher = (incoming, expected) =>
  incoming.method === expected.method &&
  incoming.url === expected.url &&
  [...new Set([...Object.keys(incoming.headers), ...Object.keys(expected.headers)])].every(
    (key) => incoming.headers[key] === expected.headers[key],
  ) &&
  Bun.deepEquals(
    ProviderShared.decodeJson(reasoningRequestBody(incoming.body)),
    ProviderShared.decodeJson(reasoningRequestBody(expected.body)),
  )

const mergeOptions = (
  base: HttpRecorder.RecorderOptions | undefined,
  override: HttpRecorder.RecorderOptions | undefined,
) => {
  if (!base) return override
  if (!override) return base
  return {
    ...base,
    ...override,
    metadata: base.metadata || override.metadata ? { ...base.metadata, ...override.metadata } : undefined,
    redact:
      base.redact || override.redact
        ? {
            ...base.redact,
            ...override.redact,
            headers: [...(base.redact?.headers ?? []), ...(override.redact?.headers ?? [])],
            allowRequestHeaders: [
              ...(base.redact?.allowRequestHeaders ?? []),
              ...(override.redact?.allowRequestHeaders ?? []),
            ],
            allowResponseHeaders: [
              ...(base.redact?.allowResponseHeaders ?? []),
              ...(override.redact?.allowResponseHeaders ?? []),
            ],
            queryParameters: [...(base.redact?.queryParameters ?? []), ...(override.redact?.queryParameters ?? [])],
            jsonFields: [...(base.redact?.jsonFields ?? []), ...(override.redact?.jsonFields ?? [])],
          }
        : undefined,
  }
}

export const recordedTests = (options: RecordedTestsOptions) =>
  recordedEffectGroup<RecordedEnv, never, RecordedTestsOptions, RecordedCaseOptions>({
    duplicateLabel: "recorded cassette",
    options,
    cassetteExists: (cassette) => HttpRecorder.hasCassetteSync(cassette, { directory: FIXTURES_DIR }),
    layer: ({ cassette, metadata, options, caseOptions, recording }) => {
      const recorderOptions = mergeOptions(options.options, caseOptions.options)
      const recorderMetadata = {
        ...recorderOptions?.metadata,
        ...metadata,
      }
      if (recording) {
        if (process.env.CI !== undefined) throw new Error("Unset CI before recording cassettes")
        HttpRecorder.removeCassetteSync(cassette, { directory: FIXTURES_DIR })
      }
      const requestExecutor = RequestExecutor.layer.pipe(
        Layer.provide(
          HttpRecorder.layerFetch(cassette, {
            ...recorderOptions,
            directory: FIXTURES_DIR,
            metadata: recorderMetadata,
          }),
        ),
      )
      const webSocket = HttpRecorder.layerWebSocketConstructor(cassette, {
        ...recorderOptions,
        directory: FIXTURES_DIR,
        metadata: recorderMetadata,
      }).pipe(Layer.provide(NodeSocket.layerWebSocketConstructorWS))
      return Layer.mergeAll(
        requestExecutor,
        LLMClient.layer.pipe(Layer.provide(requestExecutor)),
        ImageClient.layer.pipe(Layer.provide(requestExecutor)),
        webSocket,
      )
    },
  })
