import { expect, test } from "bun:test"
import { createComputed, createRoot } from "solid-js"
import { isServer } from "solid-js/web"
import { createData, type CreateDataInput } from "../src/solid"
import { OpenCode, type OpenCodeEvent, type SessionInboxUser, type SessionMessageInfo } from "../src/promise"

test("retries transient admission with the same ID and captured body", async () => {
  const bodies: string[] = []
  using fixture = setup(async (request) => {
    bodies.push(await request.text())
    if (bodies.length === 1) return new Response(null, { status: 503 })
    return Response.json({ data: item(JSON.parse(bodies[0]).id) })
  })
  const input = { sessionID, text: "Original", files: [{ uri: "file:///original.txt" }] }
  const sent = fixture.data.session.prompt(input).catch((error: unknown) => error)
  input.text = "Changed"
  input.files[0].uri = "file:///changed.txt"
  await wait(() => bodies.length === 2)
  expect(await sent).toMatchObject({ type: "user" })
  expect(bodies[1]).toBe(bodies[0])
  expect(JSON.parse(bodies[0])).toMatchObject({ text: "Original", files: [{ uri: "file:///original.txt" }] })
  expect(fixture.data.session.message.list(sessionID)).toHaveLength(1)
})

test("retries model selection but runs arbitrary preparation once and preserves admission ordering", async () => {
  const calls: string[] = []
  let modelCalls = 0
  let promptCalls = 0
  using fixture = setup(async (request) => {
    const rpc = request.url.split("/").at(-1)
    const body = await request.json()
    calls.push(rpc === "prompt" ? body.text : rpc)
    if (rpc === "model") {
      modelCalls += 1
      return new Response(null, { status: modelCalls === 1 ? 503 : 204 })
    }
    if (body.text === "First" && ++promptCalls === 1) throw new Error("Connection reset")
    return Response.json({ data: item(body.id) })
  })
  let preparations = 0
  const first = fixture.data.session.prompt({
    sessionID,
    text: "First",
    model: { providerID: "demo", id: "model" },
    prepare: async () => {
      preparations += 1
    },
  })
  const second = fixture.data.session.prompt({ sessionID, text: "Second" })
  await Promise.all([first, second])
  expect(preparations).toBe(1)
  expect(calls).toEqual(["model", "model", "First", "First", "Second"])
})

test.each([400, 401, 404, 409, 422])("does not retry definitive HTTP %i rejection", async (status) => {
  let calls = 0
  using fixture = setup(async () => {
    calls += 1
    return Response.json({ message: "Invalid request" }, { status })
  })
  await expect(fixture.data.session.prompt({ sessionID, text: "Invalid" })).rejects.toBeDefined()
  expect(calls).toBe(1)
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.data.session.message.list(sessionID)).toEqual([])
})

test("an internal server error is ambiguous and retries the original admission", async () => {
  let calls = 0
  using fixture = setup(async (request) => {
    calls += 1
    if (calls === 1) return new Response(null, { status: 500 })
    return Response.json({ data: item((await request.json()).id) })
  })
  expect(await fixture.data.session.prompt({ sessionID, id: "msg_500", text: "Retry" })).toMatchObject({
    id: "msg_500",
  })
  expect(calls).toBe(2)
})

test("cancelling an existing admission reaches the server even while its local retry is gated", async () => {
  const methods: string[] = []
  using fixture = setup(async (request) => {
    methods.push(request.method)
    return new Response(null, { status: 204 })
  })
  fixture.enqueue("msg_existing")
  const gate = Promise.withResolvers<void>()
  const sent = fixture.data.session
    .prompt({ sessionID, id: "msg_existing", text: "Retry", gate: gate.promise })
    .catch((error: unknown) => error)
  await fixture.data.session.pending.cancel(sessionID, "msg_existing")
  expect(await sent).toMatchObject({ reason: "cancelled" })
  expect(methods).toEqual(["DELETE"])
  gate.resolve()
})

test("keeps an exhausted submission visible and manual retry reuses its immutable capture", async () => {
  const bodies: string[] = []
  const models: string[] = []
  let preparations = 0
  using fixture = setup(async (request) => {
    if (request.url.endsWith("/model")) {
      models.push((await request.json()).model.id)
      return new Response(null, { status: 204 })
    }
    bodies.push(await request.text())
    if (bodies.length <= 4) return new Response(null, { status: 502 })
    return Response.json({ data: item(JSON.parse(bodies[0]).id) })
  })
  const input = {
    sessionID,
    text: "Keep me",
    files: [{ uri: "file:///original.txt" }],
    metadata: { source: "original" },
    model: { providerID: "demo", id: "original" },
    prepare: async () => {
      preparations += 1
    },
  }
  const first = fixture.data.session.prompt(input)
  input.text = "Changed"
  input.files[0].uri = "file:///changed.txt"
  input.metadata.source = "changed"
  input.model.id = "changed"
  await expect(first).rejects.toMatchObject({ reason: "failed" })
  const id = JSON.parse(bodies[0]).id
  expect(bodies).toHaveLength(4)
  expect(fixture.data.session.submission.get(sessionID, id)).toMatchObject({ status: "failed", attempt: 4 })
  expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ id, text: "Keep me" }])
  await fixture.api.session.switchModel({ sessionID, model: { providerID: "demo", id: "different" } })
  await fixture.data.session.submission.retry(sessionID, id)
  expect(bodies).toHaveLength(5)
  expect(new Set(bodies).size).toBe(1)
  expect(JSON.parse(bodies[0])).toMatchObject({
    text: "Keep me",
    files: [{ uri: "file:///original.txt" }],
    metadata: { source: "original" },
  })
  expect(models).toEqual(["original", "different", "original"])
  expect(preparations).toBe(1)
  expect(fixture.data.session.submission.get(sessionID, id)).toBeUndefined()
})

test("an enqueue acknowledgement settles a lost response without another POST", async () => {
  const requested = Promise.withResolvers<string>()
  let calls = 0
  using fixture = setup(async (request) => {
    calls += 1
    requested.resolve((await request.json()).id)
    return new Promise((_, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("Closed")), { once: true }),
    )
  })
  const sent = fixture.data.session.prompt({ sessionID, text: "Accepted" })
  const id = await requested.promise
  fixture.enqueue(id)
  expect(await sent).toEqual(item(id))
  expect(calls).toBe(1)
  expect(fixture.data.session.submission.get(sessionID, id)).toBeUndefined()
})

test("accepted HTTP responses retain a preview and same-ID calls join until canonical observation", async () => {
  let calls = 0
  using fixture = setup(async (request) => {
    calls += 1
    return Response.json({ data: item((await request.json()).id) })
  })
  const input = { sessionID, id: "msg_accepted", text: "Original" }
  expect(await fixture.data.session.prompt(input)).toEqual(item(input.id))
  const preview = fixture.data.session.message.list(sessionID)[0]
  expect(preview).toMatchObject({ id: input.id, text: "Accepted" })
  expect(fixture.data.session.message.get(sessionID, input.id)).toBe(preview)
  expect(fixture.data.session.submission.get(sessionID, input.id)).toBeUndefined()
  expect(await fixture.data.session.prompt({ ...input, text: "Must not replace", delivery: "queue" })).toEqual(
    item(input.id),
  )
  expect(await fixture.data.session.submission.retry(sessionID, input.id)).toEqual(item(input.id))
  expect(calls).toBe(1)
  expect(fixture.data.session.message.list(sessionID)[0]).toBe(preview)
  fixture.enqueue(input.id)
  expect(fixture.data.session.message.list(sessionID)).toHaveLength(1)
  fixture.data.session.evict(sessionID)
  expect(fixture.data.session.message.list(sessionID)).toEqual([])
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
})

test("another session can send while one session is retrying", async () => {
  const calls: string[] = []
  using fixture = setup(async (request) => {
    const body = await request.json()
    calls.push(body.text)
    if (body.text === "Blocked") return new Response(null, { status: 503 })
    return Response.json({ data: { ...item(body.id), sessionID: "ses_other" } })
  })
  const first = fixture.data.session
    .prompt({ sessionID, id: "msg_blocked", text: "Blocked" })
    .catch((error: unknown) => error)
  await wait(() => fixture.data.session.submission.get(sessionID, "msg_blocked")?.status === "retrying")
  await fixture.data.session.prompt({ sessionID: "ses_other", text: "Independent" })
  expect(calls).toEqual(["Blocked", "Independent"])
  fixture.dispose()
  expect(await first).toMatchObject({ reason: "cancelled" })
})

test.each(["pending-read", "enqueue", "delivered", "cancelled"])(
  "a foreign-session %s observation cannot settle or remove an explicit-ID submission",
  async (observation) => {
    const calls: string[] = []
    using fixture = setup(async (request) => {
      if (request.method === "GET") {
        if (request.url.endsWith("/inbox")) return Response.json({ data: [item("msg_existing")] })
        return Response.json({
          data: [{ id: "msg_history", type: "user", text: "Owner history", time: { created: 1 } }],
          cursor: {},
        })
      }
      calls.push(new URL(request.url).pathname)
      expect((await request.json()).id).toBe("msg_existing")
      return Response.json({ _tag: "ConflictError", message: "Message belongs to another session" }, { status: 409 })
    })
    await fixture.data.session.message.sync(sessionID)
    fixture.enqueue("msg_existing")
    const history = fixture.data.session.message.get(sessionID, "msg_history")
    const gate = Promise.withResolvers<void>()
    let settled = false
    const sent = fixture.data.session
      .prompt({ sessionID: "ses_other", id: "msg_existing", text: "Foreign local", gate: gate.promise })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    const preview = fixture.data.session.message.get("ses_other", "msg_existing")
    if (observation === "pending-read") await fixture.data.session.pending.sync(sessionID)
    if (observation === "enqueue") fixture.enqueue("msg_existing")
    if (observation === "delivered") {
      const event = {
        id: "evt_delivered",
        created: 20,
        type: "session.inbox.delivered",
        durable: { aggregateID: sessionID, seq: 2, version: 1 },
        data: { sessionID, inboxID: "msg_existing", messageID: "msg_existing" },
      } satisfies OpenCodeEvent
      fixture.emit(event)
      // Also exercise delivery without a remaining pending row.
      fixture.emit(event)
    }
    if (observation === "cancelled")
      fixture.emit({
        id: "evt_cancelled",
        created: 20,
        type: "session.inbox.cancelled",
        durable: { aggregateID: sessionID, seq: 2, version: 1 },
        data: { sessionID, inboxID: "msg_existing" },
      })
    await Bun.sleep(0)
    expect(settled).toBe(false)
    expect(calls).toEqual([])
    expect(fixture.data.session.submission.get("ses_other", "msg_existing")).toMatchObject({
      status: "sending",
      attempt: 0,
    })
    expect(fixture.data.session.message.get("ses_other", "msg_existing")).toBe(preview)
    expect(preview).toMatchObject({ text: "Foreign local" })
    expect(fixture.data.session.pending.list("ses_other")).toMatchObject([{ id: "msg_existing" }])
    const canonical = JSON.stringify({
      messages: fixture.data.session.message.list(sessionID),
      pending: fixture.data.session.pending.list(sessionID),
    })
    gate.resolve()
    expect(await sent).toEqual({ _tag: "ConflictError", message: "Message belongs to another session" })
    expect(calls).toEqual(["/api/session/ses_other/prompt"])
    expect(fixture.data.session.message.list("ses_other")).toEqual([])
    expect(fixture.data.session.pending.list("ses_other")).toEqual([])
    expect(fixture.data.session.submission.get("ses_other", "msg_existing")).toBeUndefined()
    expect(fixture.data.session.message.get(sessionID, "msg_history")).toBe(history)
    expect(
      JSON.stringify({
        messages: fixture.data.session.message.list(sessionID),
        pending: fixture.data.session.pending.list(sessionID),
      }),
    ).toBe(canonical)
  },
)

test("a projected message acknowledges delivery and a late delivery event preserves canonical order", async () => {
  const requested = Promise.withResolvers<string>()
  using fixture = setup(async (request) => {
    if (request.method === "GET")
      return Response.json({
        data: [
          { id: "msg_answer", type: "assistant", time: { created: 30 }, content: [] },
          { id: await requested.promise, type: "user", text: "Canonical text", time: { created: 25 } },
        ],
        cursor: {},
      })
    requested.resolve((await request.json()).id)
    return new Promise((_, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("Closed")), { once: true }),
    )
  })
  const sent = fixture.data.session.prompt({ sessionID, text: "Original text" })
  const id = await requested.promise
  await fixture.data.session.message.sync(sessionID)
  expect(await sent).toMatchObject({ payload: { text: "Canonical text" }, timeCreated: 25 })
  expect(fixture.data.session.submission.get(sessionID, id)).toBeUndefined()
  const canonical = fixture.data.session.message.list(sessionID)
  expect(canonical.map((row) => row.id)).toEqual([id, "msg_answer"])
  fixture.emit({
    id: "evt_delivered",
    created: 25,
    type: "session.inbox.delivered",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID, inboxID: id, messageID: id },
  })
  expect(fixture.data.session.input.list(sessionID)).toEqual([])
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.data.session.message.list(sessionID).map((row) => row.id)).toEqual([id, "msg_answer"])
  expect(fixture.data.session.message.get(sessionID, id)).toBe(canonical[0])
  fixture.data.session.evict(sessionID)
  expect(fixture.data.session.message.list(sessionID)).toEqual([])
})

test("delivery without an enqueue echo reads canonical content and refreshes authoritative order", async () => {
  const requested = Promise.withResolvers<string>()
  const reads: string[] = []
  using fixture = setup(async (request) => {
    if (request.method === "GET") {
      const row = { id: await requested.promise, type: "user", text: "Canonical text", time: { created: 25 } }
      if (new URL(request.url).pathname.endsWith(`/message/${row.id}`)) {
        reads.push("get")
        return Response.json({ data: row })
      }
      reads.push("list")
      return Response.json({
        data: [{ id: "msg_answer", type: "assistant", time: { created: 30 }, content: [] }, row],
        cursor: {},
      })
    }
    requested.resolve((await request.json()).id)
    return new Promise((_, reject) =>
      request.signal.addEventListener("abort", () => reject(new Error("Closed")), { once: true }),
    )
  })
  const sent = fixture.data.session.prompt({ sessionID, text: "Original text" })
  const id = await requested.promise
  fixture.emit({
    id: "evt_delivered",
    created: 25,
    type: "session.inbox.delivered",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID, inboxID: id, messageID: id },
  })
  expect(await sent).toMatchObject({ payload: { text: "Canonical text" }, timeCreated: 25 })
  expect(reads).toEqual(["get", "list"])
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.data.session.message.list(sessionID).map((row) => row.id)).toEqual([id, "msg_answer"])
  expect(fixture.data.session.message.get(sessionID, id)).toBe(fixture.data.session.message.list(sessionID)[0])
})

test("a cancellation echo stops retries without resurrecting the prompt", async () => {
  let calls = 0
  using fixture = setup(async () => {
    calls += 1
    return new Response(null, { status: 503 })
  })
  const sent = fixture.data.session
    .prompt({ sessionID, id: "msg_cancelled", text: "Cancel" })
    .catch((error: unknown) => error)
  await wait(() => fixture.data.session.submission.get(sessionID, "msg_cancelled")?.status === "retrying")
  fixture.emit({
    id: "evt_cancel",
    created: 20,
    type: "session.inbox.cancelled",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID, inboxID: "msg_cancelled" },
  })
  expect(await sent).toMatchObject({ reason: "cancelled" })
  expect(fixture.data.session.message.list(sessionID)).toEqual([])
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  await Bun.sleep(300)
  expect(calls).toBe(1)
})

test("a late HTTP success cannot resurrect a cancelled in-flight prompt", async () => {
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  using fixture = setup(async () => {
    requested.resolve()
    return response.promise
  })
  const sent = fixture.data.session
    .prompt({ sessionID, id: "msg_cancelled", text: "Cancel" })
    .catch((error: unknown) => error)
  await requested.promise
  fixture.emit({
    id: "evt_cancel",
    created: 20,
    type: "session.inbox.cancelled",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID, inboxID: "msg_cancelled" },
  })
  expect(await sent).toMatchObject({ reason: "cancelled" })
  response.resolve(Response.json({ data: item("msg_cancelled") }))
  await Bun.sleep(10)
  expect(fixture.data.session.message.list(sessionID)).toEqual([])
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.data.session.input.list(sessionID)).toEqual([])
  expect(fixture.data.session.submission.get(sessionID, "msg_cancelled")).toBeUndefined()
})

test("does not retry arbitrary preparation callbacks", async () => {
  let calls = 0
  using fixture = setup(async () => {
    calls += 1
    return new Response(null, { status: 503 })
  })
  let prepared = 0
  await expect(
    fixture.data.session.prompt({
      sessionID,
      text: "Prepare",
      prepare: async () => {
        prepared += 1
        throw new Error("Preparation failed")
      },
    }),
  ).rejects.toThrow("Preparation failed")
  expect(prepared).toBe(1)
  expect(calls).toBe(0)
})

test("cancellation interrupts backoff and releases a following submission", async () => {
  const calls: string[] = []
  using fixture = setup(async (request) => {
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    const body = await request.json()
    calls.push(body.text)
    if (body.text === "Cancel me") return new Response(null, { status: 503 })
    return Response.json({ data: item(body.id) })
  })
  const first = fixture.data.session
    .prompt({ sessionID, id: "msg_cancel", text: "Cancel me" })
    .catch((error: unknown) => error)
  const second = fixture.data.session.prompt({ sessionID, text: "Next" })
  await wait(() => fixture.data.session.submission.get(sessionID, "msg_cancel")?.status === "retrying")
  await fixture.data.session.pending.cancel(sessionID, "msg_cancel")
  expect(await first).toMatchObject({ reason: "cancelled" })
  await second
  expect(calls).toEqual(["Cancel me", "Next"])
})

test("disposal stops a prompt waiting behind a gate without sending it", async () => {
  let calls = 0
  using fixture = setup(async () => {
    calls += 1
    return Response.json({ data: item("msg_disposed") })
  })
  const gate = Promise.withResolvers<void>()
  const sent = fixture.data.session
    .prompt({ sessionID, text: "Never send", gate: gate.promise })
    .catch((error: unknown) => error)
  fixture.dispose()
  expect(await sent).toMatchObject({ reason: "cancelled" })
  gate.resolve()
  await Bun.sleep(10)
  expect(calls).toBe(0)
})

test("diagnostics exclude prompt data and raw error messages", async () => {
  let calls = 0
  using fixture = setup(async (request) => {
    calls += 1
    if (calls === 1) throw new Error("private transport details")
    return Response.json({ data: item((await request.json()).id) })
  })
  await fixture.data.session.prompt({ sessionID, text: "private prompt", metadata: { private: "private metadata" } })
  expect(fixture.logs).toContainEqual(expect.objectContaining({ stage: "prompt", outcome: "retrying", attempt: 1 }))
  expect(fixture.logs).toContainEqual(expect.objectContaining({ stage: "prompt", outcome: "accepted", attempt: 2 }))
  expect(JSON.stringify(fixture.logs)).not.toContain("private")
})

test("local add, retry status, rejection, and HTTP acknowledgement leave canonical rows untouched", async () => {
  const rejection = Promise.withResolvers<Response>()
  let calls = 0
  using fixture = setup(async (request) => {
    if (request.method === "GET") {
      if (request.url.endsWith("/inbox")) return Response.json({ data: [item("msg_pending")] })
      return Response.json({
        data: [{ id: "msg_history", type: "user", text: "History", time: { created: 1 } }],
        cursor: {},
      })
    }
    const body = await request.json()
    if (body.text === "Accepted") return Response.json({ data: item(body.id) })
    calls += 1
    if (calls === 1) return new Response(null, { status: 503 })
    return rejection.promise
  })
  await fixture.data.session.pending.sync(sessionID)
  await fixture.data.session.message.sync(sessionID)
  const messages = fixture.data.session.message.list(sessionID)
  const pending = fixture.data.session.pending.list(sessionID)
  const content = JSON.stringify({ messages, pending })
  const assertCanonical = () => {
    expect(JSON.stringify({ messages, pending })).toBe(content)
    expect(fixture.data.session.message.list(sessionID).slice(0, 2)).toEqual(messages)
    messages.forEach((row, index) => {
      expect(fixture.data.session.message.list(sessionID)[index]).toBe(row)
      expect(fixture.data.session.message.get(sessionID, row.id)).toBe(row)
    })
    expect(fixture.data.session.pending.list(sessionID)[0]).toBe(pending[0])
  }
  const sent = fixture.data.session
    .prompt({ sessionID, id: "msg_rejected", text: "Reject me" })
    .catch((error: unknown) => error)
  assertCanonical()
  expect(messages.map((row) => row.id)).toEqual(["msg_history", "msg_pending"])
  expect(pending.map((row) => row.id)).toEqual(["msg_pending"])
  expect(fixture.data.session.message.list(sessionID)).toHaveLength(3)
  expect(fixture.data.session.pending.list(sessionID)).toHaveLength(2)
  const preview = fixture.data.session.message.list(sessionID)[2]
  expect(fixture.data.session.message.get(sessionID, "msg_rejected")).toBe(preview)
  await wait(() => fixture.data.session.submission.get(sessionID, "msg_rejected")?.status === "retrying")
  assertCanonical()
  expect(fixture.data.session.message.list(sessionID)[2]).toBe(preview)
  rejection.resolve(new Response(null, { status: 422 }))
  expect(await sent).toBeInstanceOf(Error)
  assertCanonical()
  expect(fixture.data.session.message.list(sessionID)).toBe(messages)
  expect(fixture.data.session.pending.list(sessionID)).toBe(pending)
  await fixture.data.session.prompt({ sessionID, id: "msg_accepted", text: "Accepted" })
  assertCanonical()
  expect(fixture.data.session.message.list(sessionID)).toHaveLength(3)
  expect(fixture.data.session.pending.list(sessionID)).toHaveLength(2)
  fixture.enqueue("msg_accepted")
  expect(fixture.data.session.message.list(sessionID)).toHaveLength(3)
  expect(fixture.data.session.pending.list(sessionID)).toHaveLength(2)
  expect(fixture.data.session.message.get(sessionID, "msg_history")).toBe(messages[0])
  expect(fixture.data.session.pending.list(sessionID)[0]).toBe(pending[0])
})

test("absent snapshots and cache eviction preserve local work until a positive message observation", async () => {
  const gate = Promise.withResolvers<void>()
  const rows: SessionMessageInfo[] = []
  using fixture = setup(async (request) => {
    if (request.method === "GET")
      return Response.json(request.url.endsWith("/inbox") ? { data: [] } : { data: rows, cursor: {} })
    return Response.json({ data: item((await request.json()).id) })
  })
  const sent = fixture.data.session.prompt({ sessionID, id: "msg_local", text: "Local", gate: gate.promise })
  await fixture.data.session.pending.sync(sessionID)
  await fixture.data.session.message.sync(sessionID)
  expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ id: "msg_local", text: "Local" }])
  expect(fixture.data.session.pending.list(sessionID)).toMatchObject([{ id: "msg_local" }])
  gate.resolve()
  await sent
  fixture.data.session.pending.invalidate(sessionID)
  fixture.data.session.message.invalidate(sessionID)
  await fixture.data.session.pending.sync(sessionID)
  await fixture.data.session.message.sync(sessionID)
  expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ id: "msg_local", text: "Accepted" }])
  expect(fixture.data.session.pending.list(sessionID)).toMatchObject([{ id: "msg_local" }])
  fixture.data.session.evict(sessionID)
  expect(fixture.data.session.message.list(sessionID)).toHaveLength(1)
  rows.push({ id: "msg_local", type: "user", text: "Canonical", time: { created: 25 } })
  await fixture.data.session.message.sync(sessionID)
  expect(fixture.data.session.message.list(sessionID)).toEqual(rows)
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  fixture.data.session.evict(sessionID)
  expect(fixture.data.session.message.list(sessionID)).toEqual([])
  expect(fixture.data.session.pending.list(sessionID)).toEqual([])
  expect(fixture.data.session.input.list(sessionID)).toEqual([])
})

test.each(["accepted", "failed"])(
  "an older message page retires %s local work without resurrection on eviction",
  async (status) => {
    const canonical = { id: "msg_older", type: "user", text: "Canonical", time: { created: 1 } }
    let calls = 0
    using fixture = setup(async (request) => {
      if (request.method !== "GET") {
        calls += 1
        if (status === "failed") return new Response(null, { status: 503 })
        return Response.json({ data: item((await request.json()).id) })
      }
      if (request.url.endsWith("/inbox")) return Response.json({ data: [] })
      if (new URL(request.url).searchParams.has("cursor")) return Response.json({ data: [canonical], cursor: {} })
      return Response.json({
        data: [{ id: "msg_newer", type: "assistant", time: { created: 2 }, content: [] }],
        cursor: { next: "older" },
      })
    })
    const sent = fixture.data.session.prompt({ sessionID, id: canonical.id, text: "Local" })
    if (status === "failed") await expect(sent).rejects.toMatchObject({ reason: "failed" })
    if (status === "accepted") await sent
    await fixture.data.session.pending.sync(sessionID)
    await fixture.data.session.message.sync(sessionID)
    expect(fixture.data.session.message.list(sessionID).map((row) => row.id)).toEqual(["msg_newer", canonical.id])
    expect(fixture.data.session.pending.list(sessionID)).toMatchObject([{ id: canonical.id }])
    expect(fixture.data.session.message.more(sessionID)).toBe(true)
    if (status === "failed")
      expect(fixture.data.session.submission.get(sessionID, canonical.id)).toMatchObject({ status: "failed" })
    await fixture.data.session.message.loadMore(sessionID)
    expect(fixture.data.session.message.list(sessionID).map((row) => row.id)).toEqual([canonical.id, "msg_newer"])
    expect(fixture.data.session.message.get(sessionID, canonical.id)).toEqual(canonical)
    expect(fixture.data.session.message.get(sessionID, canonical.id)).toBe(
      fixture.data.session.message.list(sessionID)[0],
    )
    expect(fixture.data.session.pending.list(sessionID)).toEqual([])
    expect(fixture.data.session.input.list(sessionID)).toEqual([])
    expect(fixture.data.session.submission.get(sessionID, canonical.id)).toBeUndefined()
    expect(fixture.data.session.message.more(sessionID)).toBe(false)
    fixture.data.session.evict(sessionID)
    expect(fixture.data.session.message.list(sessionID)).toEqual([])
    expect(fixture.data.session.pending.list(sessionID)).toEqual([])
    expect(calls).toBe(status === "accepted" ? 1 : 4)
  },
)

test.each(["prompt", "compaction"])(
  "local %s first preserves both overlays and serializes admissions",
  async (first) => {
    const promptResponse = Promise.withResolvers<void>()
    const compactResponse = Promise.withResolvers<void>()
    const calls: string[] = []
    using fixture = setup(async (request) => {
      if (request.method === "GET")
        return Response.json(request.url.endsWith("/inbox") ? { data: [] } : { data: [], cursor: {} })
      const body = await request.json()
      if (request.url.endsWith("/prompt")) {
        calls.push("prompt")
        await promptResponse.promise
        return Response.json({ data: item(body.id) })
      }
      calls.push("compaction")
      await compactResponse.promise
      return Response.json({ data: { ...item(body.id), type: "compaction", payload: {} } })
    })
    await fixture.data.session.pending.sync(sessionID)
    await fixture.data.session.message.sync(sessionID)
    const canonicalPending = fixture.data.session.pending.list(sessionID)
    const canonicalMessages = fixture.data.session.message.list(sessionID)
    const submit = (kind: string) =>
      kind === "prompt"
        ? fixture.data.session.prompt({ sessionID, text: "Follow up" })
        : fixture.data.session.compact({ sessionID })
    const second = first === "prompt" ? "compaction" : "prompt"
    const firstRequest = submit(first)
    const secondRequest = submit(second)
    expect(fixture.data.session.pending.list(sessionID).map((row) => row.type)).toEqual([
      first === "prompt" ? "user" : "compaction",
      second === "prompt" ? "user" : "compaction",
    ])
    expect(fixture.data.session.message.list(sessionID)).toMatchObject([{ type: "user", text: "Follow up" }])
    expect(fixture.data.session.input.list(sessionID)).toHaveLength(1)
    expect(canonicalPending).toEqual([])
    expect(canonicalMessages).toEqual([])
    await wait(() => calls.length === 1)
    expect(calls).toEqual([first])
    if (first === "prompt") promptResponse.resolve()
    if (first === "compaction") compactResponse.resolve()
    await firstRequest
    await wait(() => calls.length === 2)
    expect(calls).toEqual([first, second])
    promptResponse.resolve()
    compactResponse.resolve()
    await secondRequest
    expect(fixture.data.session.pending.list(sessionID)).toHaveLength(2)
    expect(fixture.data.session.message.list(sessionID)).toHaveLength(1)
  },
)

test("local changes do not recompute another session's structural selectors", async () => {
  // Bun normally resolves Solid's inert SSR build; exercise real subscriptions.
  if (isServer) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--conditions=browser",
        "test",
        import.meta.path,
        "--test-name-pattern",
        "local changes do not recompute",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, output: code === 0 ? "" : stdout + stderr }).toEqual({ code: 0, output: "" })
    return
  }
  let calls = 0
  using fixture = setup(async (request) => {
    if (request.method === "GET")
      return Response.json(request.url.endsWith("/inbox") ? { data: [] } : { data: [], cursor: {} })
    calls += 1
    return new Response(null, { status: 503 })
  })
  await fixture.data.session.pending.sync("ses_other")
  await fixture.data.session.message.sync("ses_other")
  let computations = 0
  const observer = createRoot((dispose) => {
    createComputed(() => {
      fixture.data.session.message.list("ses_other").map((row) => row.id)
      fixture.data.session.pending.list("ses_other").map((row) => row.type)
      fixture.data.session.input.list("ses_other").slice()
      computations += 1
    })
    return { [Symbol.dispose]: dispose }
  })
  using subscription = observer
  expect(computations).toBe(1)
  const sent = fixture.data.session
    .prompt({ sessionID, id: "msg_local", text: "Local" })
    .catch((error: unknown) => error)
  await wait(() => fixture.data.session.submission.get(sessionID, "msg_local")?.status === "retrying")
  expect(calls).toBe(1)
  expect(computations).toBe(1)
  fixture.enqueue("msg_local")
  await sent
  expect(computations).toBe(1)
  const gate = Promise.withResolvers<void>()
  const other = fixture.data.session
    .prompt({ sessionID: "ses_other", text: "Positive control", gate: gate.promise })
    .catch((error: unknown) => error)
  expect(computations).toBeGreaterThan(1)
  fixture.dispose()
  expect(await other).toMatchObject({ reason: "cancelled" })
  gate.resolve()
})

const sessionID = "ses_retry"
const item = (id: string): SessionInboxUser => ({
  id,
  sessionID,
  type: "user",
  payload: { text: "Accepted" },
  delivery: "steer",
  timeCreated: 10,
})

function setup(handle: (request: Request) => Promise<Response>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const logs: Readonly<Record<string, unknown>>[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => handle(input instanceof Request ? input : new Request(input, init)),
  })
  const root = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      log: {
        info: (_message, data) => {
          if (data) logs.push(data)
        },
      },
    }),
    dispose,
  }))
  const emit = (details: OpenCodeEvent) => listeners.forEach((listener) => listener({ name: details.type, details }))
  return {
    data: root.data,
    api,
    dispose: root.dispose,
    [Symbol.dispose]: root.dispose,
    logs,
    emit,
    enqueue(id: string) {
      emit({
        id: "evt_enqueue",
        created: 10,
        type: "session.inbox.enqueued",
        durable: { aggregateID: sessionID, seq: 1, version: 1 },
        data: { sessionID, inboxID: id, item: { type: "user", payload: { text: "Accepted" }, delivery: "steer" } },
      })
    },
  }
}

async function wait(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for submission")
}
