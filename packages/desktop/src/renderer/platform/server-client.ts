import { OpenCodeRpc } from "@opencode-ai/client/promise/websocket"
import type { ServerConnection } from "@opencode-ai/app/desktop"

export function createDesktopServerApi(server: ServerConnection.HttpBase) {
  const api = OpenCodeRpc.make({
    baseUrl: server.url,
    headers: server.password ? { Authorization: `Basic ${btoa(`opencode:${server.password}`)}` } : undefined,
  })
  return { api, dispose: () => api.dispose() }
}
