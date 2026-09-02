import { expect, test, type Page } from "@playwright/test"
import type { OpenCodeEvent, SessionMessageInfo } from "@opencode-ai/client/promise"
import { base64Encode } from "@opencode-ai/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/SessionQueueRegression"
const projectID = "proj_session_queue_regression"
const sessionID = "ses_session_queue_regression"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

type InboxRow = {
  id: string
  sessionID: string
  timeCreated: number
  type: "user"
  payload: { text: string; metadata?: Record<string, unknown> }
  delivery: "steer" | "queue"
}

function createQueueMock(seed: string[], messages: SessionMessageInfo[] = []) {
  const rows: InboxRow[] = seed.map((text, index) => ({
    id: `inb_seed_${index + 1}`,
    sessionID,
    timeCreated: 1700000000000 + index,
    type: "user",
    payload: { text },
    delivery: "queue",
  }))
  const events: OpenCodeEvent[] = []
  const prompts: Record<string, unknown>[] = []
  const changes: { inboxID: string; action: "cancel" | "steer" }[] = []
  const log: string[] = []
  let sequence = 0
  const emit = <Type extends OpenCodeEvent["type"]>(
    type: Type,
    data: Extract<OpenCodeEvent, { type: Type }>["data"],
  ) => {
    sequence += 1
    events.push({
      id: `evt_queue_${sequence}`,
      type,
      created: Date.now(),
      durable: { aggregateID: sessionID, seq: sequence, version: type === "session.tool.success" ? 2 : 1 },
      data,
    } as OpenCodeEvent)
  }
  return {
    rows,
    prompts,
    changes,
    log,
    messages,
    emit,
    events: () => events.splice(0),
    onPrompt: (input: { sessionID: string; body: Record<string, unknown> }) => {
      prompts.push(input.body)
      log.push(`prompt:${String(input.body.delivery ?? "steer")}`)
      const row: InboxRow = {
        id: typeof input.body.id === "string" ? input.body.id : `inb_mock_${sequence}`,
        sessionID: input.sessionID,
        timeCreated: Date.now(),
        type: "user",
        payload: {
          text: typeof input.body.text === "string" ? input.body.text : "",
          ...(input.body.metadata === undefined ? {} : { metadata: input.body.metadata as Record<string, unknown> }),
        },
        delivery: input.body.delivery === "queue" ? "queue" : "steer",
      }
      rows.push(row)
      emit("session.inbox.enqueued", {
        sessionID: input.sessionID,
        inboxID: row.id,
        item: { type: "user", payload: row.payload, delivery: row.delivery },
      })
    },
    onInboxChange: (input: { sessionID: string; inboxID: string; action: "cancel" | "steer" }) => {
      changes.push({ inboxID: input.inboxID, action: input.action })
      log.push(`${input.action}:${input.inboxID}`)
      const index = rows.findIndex((row) => row.id === input.inboxID)
      const row = rows[index]
      if (!row) return
      if (input.action === "cancel") {
        rows.splice(index, 1)
        emit("session.inbox.cancelled", { sessionID: input.sessionID, inboxID: input.inboxID })
        return
      }
      row.delivery = "steer"
      emit("session.inbox.delivery.changed", {
        sessionID: input.sessionID,
        inboxID: input.inboxID,
        delivery: "steer",
      })
    },
  }
}

async function openSession(page: Page, mock: ReturnType<typeof createQueueMock>, followUpBehavior?: "queue" | "steer") {
  if (followUpBehavior) {
    await page.addInitScript(
      (behavior) => localStorage.setItem("settings.v3", JSON.stringify({ general: { followUpBehavior: behavior } })),
      followUpBehavior,
    )
  }
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "session-queue-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: { "queue-model": { id: "queue-model", name: "Queue Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "queue-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "session-queue-regression",
        projectID,
        directory,
        title: "Session queue regression",
        version: "dev",
        model: { id: "queue-model", providerID: "opencode" },
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: mock.messages }),
    sessionStatus: () => ({ [sessionID]: { type: "running" } }),
    inbox: () => mock.rows.map((row) => ({ ...row, payload: { ...row.payload } })),
    onPrompt: mock.onPrompt,
    onInboxChange: mock.onInboxChange,
    events: mock.events,
  })
  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  const composer = page.locator('[data-component="composer"]')
  await expectAppVisible(composer)
  // The editor is interactive before provider/model selection finishes loading.
  await expect(composer.getByRole("button", { name: "Queue Model", exact: true })).toBeVisible()
  await expect(composer.getByRole("button", { name: "Queue Model", exact: true })).toBeEnabled()
  await expect(composer.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
  return {
    composer,
    input: composer.locator('[data-component="composer-editor"]'),
    rows: page.locator('[data-component="session-queue-row"]'),
  }
}

test("follow-up preference controls Enter while Mod+Enter uses the alternate delivery", async ({ page }) => {
  const mock = createQueueMock([])
  const view = await openSession(page, mock, "queue")

  await view.input.fill("queue this follow-up")
  await expect(view.composer.locator('[data-action="composer-alternate-delivery"]')).toContainText("Steer")
  await view.input.press("Enter")
  await expect(view.rows.getByText("queue this follow-up", { exact: true })).toBeVisible()

  await view.input.fill("steer this correction")
  await view.input.press("ControlOrMeta+Enter")
  await expect.poll(() => mock.prompts.map((prompt) => prompt.delivery)).toEqual(["queue", "steer"])
  await expect(view.input).toHaveText("")
})

test("dragging reorders queued prompts", async ({ page }) => {
  const mock = createQueueMock(["first queued prompt", "second queued prompt", "third queued prompt"])
  const view = await openSession(page, mock)
  await expect(view.rows).toHaveCount(3)

  const first = view.rows.filter({ hasText: "first queued prompt" })
  const third = view.rows.filter({ hasText: "third queued prompt" })
  await first.getByRole("button", { name: "Reorder queued prompt" }).hover()
  await page.mouse.down()
  const target = await third.boundingBox()
  if (!target) throw new Error("The target queue row is not visible")
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
  await page.mouse.up()

  await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText([
    "second queued prompt",
    "third queued prompt",
    "first queued prompt",
  ])
  expect(mock.prompts.map((prompt) => prompt.text)).toEqual([
    "second queued prompt",
    "third queued prompt",
    "first queued prompt",
  ])
  expect(mock.changes).toEqual([
    { inboxID: "inb_seed_1", action: "cancel" },
    { inboxID: "inb_seed_2", action: "cancel" },
    { inboxID: "inb_seed_3", action: "cancel" },
  ])
})

test("editing restores the existing draft and replaces only the original queue position", async ({ page }) => {
  const mock = createQueueMock(["first queued prompt", "tighten the error copy", "third queued prompt"])
  const view = await openSession(page, mock)
  const original = view.rows.getByText("tighten the error copy", { exact: true })
  await expect(original).toBeVisible()

  await view.input.fill("my in-progress draft")
  await original.click()
  await expect(view.input).toHaveText("tighten the error copy")
  await expect(view.input).toBeFocused()
  await view.input.press("Escape")
  await expect(view.input).toHaveText("my in-progress draft")

  await original.click()
  await expect(view.input).toHaveText("tighten the error copy")
  await expect(view.input).toBeFocused()
  await view.input.fill("tighten the error copy and add a retry hint")
  await expect(view.input).toHaveText("tighten the error copy and add a retry hint")
  await view.input.press("Enter")

  await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText([
    "first queued prompt",
    "tighten the error copy and add a retry hint",
    "third queued prompt",
  ])
  await expect(view.input).toHaveText("my in-progress draft")
  expect(mock.prompts.map((prompt) => prompt.text)).toEqual([
    "tighten the error copy and add a retry hint",
    "tighten the error copy and add a retry hint",
    "third queued prompt",
  ])
  expect(mock.prompts.every((prompt) => prompt.delivery === "queue" && prompt.resume === false)).toBe(true)
  expect(mock.changes.map((change) => change.action)).toEqual(["cancel", "cancel", "cancel"])
  expect(mock.log[0]).toBe("prompt:queue")
})

for (const action of ["edit", "reorder"] as const) {
  test(`retires an exhausted queue ${action} replacement without offering a standalone retry`, async ({ page }) => {
    const mock = createQueueMock(["first queued prompt", "second queued prompt"])
    const view = await openSession(page, mock)
    const attempts: string[] = []
    await page.route(`**/api/session/${sessionID}/prompt`, (route) => {
      const body = route.request().postDataJSON() as { id: string }
      attempts.push(body.id)
      return route.abort("failed")
    })
    await expect(view.rows).toHaveCount(2)
    const first = view.rows.filter({ hasText: "first queued prompt" })
    if (action === "edit") {
      await first.getByRole("button", { name: "first queued prompt", exact: true }).click()
      await view.input.fill("replacement that cannot be admitted")
      await view.input.press("Enter")
    }
    if (action === "reorder") {
      await first.getByRole("button", { name: "Reorder queued prompt" }).hover()
      await page.mouse.down()
      const target = await view.rows.filter({ hasText: "second queued prompt" }).boundingBox()
      if (!target) throw new Error("The target queue row is not visible")
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
      await page.mouse.up()
    }
    await expect(page.getByText("Request failed", { exact: true })).toBeVisible()
    expect(attempts).toHaveLength(4)
    expect(new Set(attempts).size).toBe(1)
    expect(mock.changes).toEqual([{ inboxID: attempts[0], action: "cancel" }])
    expect(mock.rows.map((row) => row.id)).toEqual(["inb_seed_1", "inb_seed_2"])
    await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText([
      "first queued prompt",
      "second queued prompt",
    ])
    await expect(page.locator('[data-component="prompt-submission"]')).toHaveCount(0)
  })
}

for (const delivery of ["steer", "queue"] as const) {
  for (const width of [390, 1440]) {
    test(`recovers independent failed ${delivery} submissions at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 })
      const mock = createQueueMock([])
      const view = await openSession(page, mock, delivery)
      const attempts: { id: string; text: string }[] = []
      const accepted = new Set<string>()
      await page.route(`**/api/session/${sessionID}/prompt`, (route) => {
        const body = route.request().postDataJSON() as { id: string; text: string }
        attempts.push(body)
        return accepted.has(body.id) ? route.fallback() : route.abort("failed")
      })
      const recovery = page.locator('[data-component="prompt-submission"]')
      await view.input.fill("first failed submission")
      await view.input.press("Enter")
      await expect(recovery.getByRole("status")).toHaveText("Could not confirm prompt delivery")
      const firstID = attempts[0].id
      expect(attempts.map((attempt) => attempt.id)).toEqual([firstID, firstID, firstID, firstID])
      await expect(view.input).toHaveText("")

      await view.input.fill("second failed submission")
      await view.input.press("Enter")
      await expect(recovery.getByRole("status")).toHaveText([
        "Could not confirm prompt delivery",
        "Could not confirm prompt delivery",
      ])
      const secondID = attempts[4].id
      expect(secondID).not.toBe(firstID)
      expect(attempts.slice(4).map((attempt) => attempt.id)).toEqual([secondID, secondID, secondID, secondID])
      await expect(view.input).toHaveText("")
      if (delivery === "queue") {
        await expect(view.rows).toHaveCount(2)
        await expect(view.rows.getByRole("button", { name: "first failed submission", exact: true })).toBeDisabled()
        await expect(view.rows.getByRole("button", { name: "second failed submission", exact: true })).toBeDisabled()
        await expect(
          view.rows
            .filter({ hasText: "first failed submission" })
            .getByRole("button", { name: "Reorder queued prompt" }),
        ).toBeDisabled()
        await expect(view.rows.getByRole("button", { name: "Steer", exact: true })).toHaveCount(0)
      }

      await testInfo.attach("failed-submissions", { body: await page.screenshot(), contentType: "image/png" })

      const firstRecovery = page.locator(`[data-component="prompt-submission"][data-submission-id="${firstID}"]`)
      const secondRecovery = page.locator(`[data-component="prompt-submission"][data-submission-id="${secondID}"]`)
      accepted.add(firstID)
      await firstRecovery.getByRole("button", { name: "Retry", exact: true }).click()
      await expect(firstRecovery).toHaveCount(0)
      await expect.poll(() => mock.prompts.map((prompt) => prompt.id)).toEqual([firstID])
      expect(attempts).toHaveLength(9)
      expect(attempts[8]).toEqual(attempts[0])
      await expect(secondRecovery.getByRole("status")).toHaveText("Could not confirm prompt delivery")

      await secondRecovery.getByRole("button", { name: "Cancel", exact: true }).click()
      await expect(recovery).toHaveCount(0)
      await expect.poll(() => mock.changes).toEqual([{ inboxID: secondID, action: "cancel" }])
      await expect(view.input).toHaveText("")
      if (delivery === "queue") {
        await expect(view.rows.locator('[data-action="session-queue-edit"]')).toHaveText(["first failed submission"])
        return
      }
      const messages = page.locator('[data-timeline-row="UserMessage"]')
      await expect(messages).toHaveCount(1)
      await expect(messages).toContainText("first failed submission")
      await expect(messages).toHaveAttribute("data-message-id", firstID)
    })
  }

  test(`keeps recovery visible for an image-only failed ${delivery} submission`, async ({ page }) => {
    const mock = createQueueMock([])
    const view = await openSession(page, mock, delivery)
    await page.route(`**/api/session/${sessionID}/prompt`, (route) => route.abort("failed"))
    const chooser = page.waitForEvent("filechooser")
    await view.composer.getByRole("button", { name: "Add images and files", exact: true }).click()
    await page.getByRole("menuitem", { name: /^Images and files/ }).click()
    await (
      await chooser
    ).setFiles({
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
        "base64",
      ),
    })
    await expect(view.composer.locator('[data-component="composer-attachments"]')).toBeVisible()
    await view.input.press("Enter")
    const recovery = page.locator('[data-component="prompt-submission"]')
    await expect(recovery.getByRole("status")).toHaveText("Could not confirm prompt delivery")
    await expect(recovery.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
    await recovery.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(recovery).toHaveCount(0)
    await expect(view.rows).toHaveCount(0)
    await expect(page.locator('[data-timeline-row="UserMessage"]')).toHaveCount(0)
    await expect(view.composer.locator('[data-component="composer-attachments"]')).toHaveCount(0)
    await expect(view.input).toHaveText("")
  })
}

for (const delivery of ["steer", "queue"] as const) {
  test(`keeps finished tools above a pending ${delivery === "queue" ? "queue-to-steer" : "steer"} follow-up`, async ({
    page,
  }, testInfo) => {
    const model = { id: "queue-model", providerID: "opencode" }
    const userID = "msg_queue_initial_user"
    const assistantID = "msg_queue_continued_assistant"
    const followUp = "U2: Also check the retry path."
    const mock = createQueueMock(
      [],
      [
        { id: userID, type: "user", text: "U1: Inspect the queue ordering.", time: { created: 1700000000000 } },
        {
          id: "msg_queue_initial_assistant",
          type: "assistant",
          agent: "build",
          model,
          content: [{ type: "text", text: "A1: I will inspect the current implementation." }],
          finish: "tool-calls",
          time: { created: 1700000000001, completed: 1700000000002 },
        },
      ],
    )
    const view = await openSession(page, mock, delivery)
    const transcript = page.locator("[data-timeline-virtual-content]")
    const thinking = transcript.locator('[data-timeline-row="Thinking"]')
    await expect(transcript.getByText("A1: I will inspect the current implementation.", { exact: true })).toBeVisible()
    await expect(thinking).toHaveCount(0)
    await expect(view.input).toBeEditable()
    await view.input.fill(followUp)
    await view.input.press("Enter")
    await expect.poll(() => mock.rows.map((row) => row.delivery)).toEqual([delivery])
    await expect(view.input).toHaveText("")

    const inboxID = mock.rows[0].id
    const pending = transcript.locator(`[data-timeline-row="UserMessage"][data-message-id="${inboxID}"]`)
    if (delivery === "queue") {
      const queued = view.rows.filter({ hasText: followUp })
      await expect(queued).toBeVisible()
      await expect(pending).toHaveCount(0)
      await expect(thinking).toHaveCount(0)
      await queued.hover()
      await queued.getByRole("button", { name: "Steer", exact: true }).click()
      await expect.poll(() => mock.changes).toEqual([{ inboxID, action: "steer" }])
    }
    await expect(view.rows).toHaveCount(0)
    await expect(pending).toContainText(followUp)
    await expect(thinking).toHaveCount(0)

    // The next assistant step still belongs to U1: U2 has been admitted, not delivered.
    mock.emit("session.step.started", { sessionID, assistantMessageID: assistantID, agent: "build", model })
    for (const tool of [
      { id: "tool_queue_read", name: "read", input: { path: "src/queue.ts" } },
      { id: "tool_queue_grep", name: "grep", input: { pattern: "retry", path: "src" } },
    ]) {
      const ref = { sessionID, assistantMessageID: assistantID, id: tool.id }
      mock.emit("session.tool.input.started", { ...ref, name: tool.name })
      mock.emit("session.tool.input.ended", { ...ref, text: JSON.stringify(tool.input) })
      mock.emit("session.tool.called", { ...ref, input: tool.input, executed: true })
      mock.emit("session.tool.success", {
        ...ref,
        content: [{ type: "text", text: "Inspection complete." }],
        executed: true,
      })
    }
    mock.emit("session.step.ended", {
      sessionID,
      assistantMessageID: assistantID,
      finish: "tool-calls",
      cost: 0,
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const tools = page.locator('[data-timeline-part-ids="tool_queue_read,tool_queue_grep"]')
    await expect(tools).toBeVisible()
    await expect(tools).toHaveText(/^Used\s*2 Read, Grep$/)
    await expect(tools.locator('[data-slot="basic-tool-tool-title"]')).toHaveText("2 Read, Grep")
    await expect(thinking).toHaveCount(0)
    await expect(pending).toBeVisible()
    expect(mock.rows.map((row) => ({ id: row.id, delivery: row.delivery }))).toEqual([
      { id: inboxID, delivery: "steer" },
    ])
    await transcript.screenshot({ path: testInfo.outputPath("pending-steer.png") })

    // Soft assertions let delivery run too, even when the pending ordering regresses.
    await expect.soft(tools.or(pending)).toHaveText([/^Used\s*2 Read, Grep$/, /U2: Also check the retry path\./])
    await expect
      .soft(transcript.locator('[data-timeline-row="AssistantPart"]').filter({ has: tools }))
      .toHaveAttribute("data-message-id", userID)
    await expect
      .configure({ soft: true })
      .poll(async () => {
        const boxes = await Promise.all([tools.boundingBox(), pending.boundingBox()])
        return boxes.every((box) => box !== null) && boxes[0]!.y + boxes[0]!.height <= boxes[1]!.y
      })
      .toBe(true)

    mock.rows.splice(0, 1)
    mock.emit("session.inbox.delivered", { sessionID, inboxID })
    await expect(thinking).toHaveCount(0)
    await expect(pending).toHaveCount(1)
    await expect(transcript.locator('[data-timeline-row="UserMessage"]')).toHaveCount(2)
    await expect(transcript.locator('[data-timeline-row="AssistantPart"]').filter({ has: tools })).toHaveAttribute(
      "data-message-id",
      userID,
    )

    const later = { sessionID, assistantMessageID: "msg_queue_follow_up_assistant" }
    mock.emit("session.step.started", { ...later, agent: "build", model })
    mock.emit("session.text.started", { ...later, ordinal: 0 })
    mock.emit("session.text.ended", { ...later, ordinal: 0, text: "A3: Now checking the retry path for U2." })
    const response = transcript
      .locator('[data-timeline-row="AssistantPart"]')
      .filter({ hasText: "A3: Now checking the retry path for U2." })
    await expect(response).toHaveAttribute("data-message-id", inboxID)
    await expect(thinking).toHaveCount(0)
    await expect(tools.or(pending).or(response)).toHaveText([
      /^Used\s*2 Read, Grep$/,
      /U2: Also check the retry path\./,
      /A3: Now checking the retry path for U2\./,
    ])
  })
}
