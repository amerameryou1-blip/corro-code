import { expect, test } from "bun:test"
import {
  CodeRenderable,
  MarkdownRenderable,
  RGBA,
  SyntaxStyle,
  TreeSitterClient,
  t,
  type TextChunk,
} from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { tmpdir } from "./fixture/fixture"

const content = "const cachedValue: number = 42"

test.each([false, true])(
  "cached code paints colored before the next promise resolves, streaming=%s",
  async (streaming) => {
    await using app = await fixture()
    const result = await app.client.highlightOnce(content, "typescript")
    const pending = Promise.withResolvers<typeof result>()
    app.client.highlightOnce = () => pending.promise
    const code = new CodeRenderable(app.renderer, {
      content,
      filetype: "typescript",
      syntaxStyle: app.syntax,
      treeSitterClient: app.client,
      streaming,
      drawUnstyledText: !streaming,
    })
    app.renderer.root.add(code)
    try {
      await app.renderOnce()
      expect(code.isHighlighting).toBe(true)
      expect(app.captureCharFrame()).toContain(content)
      expect(keyword(app)).toEqual(RGBA.fromHex("#ff0000"))
      const first = app.captureSpans()
      pending.resolve(result)
      await code.highlightingDone
      await app.renderOnce()
      expect(app.captureSpans()).toEqual(first)
    } finally {
      pending.resolve(result)
    }
  },
)

test("an uncached code block still paints plaintext before highlighting completes", async () => {
  await using app = await fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<TreeSitterClient["highlightOnce"]>>>()
  app.client.highlightOnce = () => pending.promise
  const code = new CodeRenderable(app.renderer, {
    content,
    filetype: "typescript",
    syntaxStyle: app.syntax,
    treeSitterClient: app.client,
    fg: "#ffffff",
  })
  app.renderer.root.add(code)
  try {
    await app.renderOnce()
    expect(code.isHighlighting).toBe(true)
    expect(app.captureCharFrame()).toContain(content)
    expect(keyword(app)).toEqual(RGBA.fromHex("#ffffff"))
  } finally {
    pending.resolve({ highlights: [] })
    await code.highlightingDone
  }
})

test.each([false, true])("cached Markdown fences paint immediately, nested=%s", async (nested) => {
  await using app = await fixture()
  const result = await app.client.highlightOnce(content, "typescript")
  const pending = Promise.withResolvers<typeof result>()
  app.client.highlightOnce = () => pending.promise
  app.renderer.root.add(
    new MarkdownRenderable(app.renderer, {
      content: nested
        ? `- Example:\n\n  \`\`\`typescript\n  ${content}\n  \`\`\``
        : `\`\`\`typescript\n${content}\n\`\`\``,
      syntaxStyle: app.syntax,
      treeSitterClient: app.client,
      streaming: false,
      internalBlockMode: "top-level",
    }),
  )
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(content)
    expect(keyword(app)).toEqual(RGBA.fromHex("#ff0000"))
  } finally {
    pending.resolve(result)
  }
})

test("cached paint follows current theme, content and language without a sticky seed", async () => {
  await using app = await fixture()
  const second = "const secondCachedValue: number = 7"
  await app.client.highlightOnce(content, "typescript")
  await app.client.highlightOnce(second, "typescript")
  const pending = Promise.withResolvers<Awaited<ReturnType<TreeSitterClient["highlightOnce"]>>>()
  app.client.highlightOnce = () => pending.promise
  const alternate = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" }, keyword: { fg: "#0000ff" } })
  const code = new CodeRenderable(app.renderer, {
    content,
    filetype: "typescript",
    syntaxStyle: app.syntax,
    treeSitterClient: app.client,
    fg: "#ffffff",
  })
  app.renderer.root.add(code)
  try {
    code.syntaxStyle = alternate
    await app.renderOnce()
    expect(keyword(app)).toEqual(RGBA.fromHex("#0000ff"))
    code.content = "const miss = 0"
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("const miss = 0")
    expect(app.captureCharFrame()).not.toContain("cachedValue")
    expect(keyword(app)).toEqual(RGBA.fromHex("#ffffff"))
    code.content = second
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(second)
    expect(keyword(app)).toEqual(RGBA.fromHex("#0000ff"))
    code.filetype = "text"
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(second)
    expect(keyword(app)).toEqual(RGBA.fromHex("#ffffff"))
  } finally {
    pending.resolve({ highlights: [] })
    await code.highlightingDone
    app.renderer.destroy()
    alternate.destroy()
  }
})

test("completed highlights use a bounded LRU and disappear when the client is destroyed", async () => {
  await using app = await fixture()
  const first = await app.client.highlightOnce(content, "typescript")
  expect(app.client.getCachedHighlight(content, "typescript")).toEqual(first)
  expect(await app.client.highlightOnce(content, "typescript")).toEqual(first)
  expect(app.client.getCachedHighlight(content, "javascript")).toBeUndefined()
  await Promise.all(
    Array.from({ length: 499 }, (_, index) => app.client.highlightOnce(`const value${index} = 1`, "typescript")),
  )
  expect(app.client.getCachedHighlight(content, "typescript")).toEqual(first)
  await app.client.highlightOnce("const extra = 1", "typescript")
  expect(app.client.getCachedHighlight("const value0 = 1", "typescript")).toBeUndefined()
  expect(app.client.getCachedHighlight(content, "typescript")).toEqual(first)
  await app.client.destroy()
  expect(app.client.getCachedHighlight(content, "typescript")).toBeUndefined()
})

test("parser changes invalidate completed results and failed highlighting stays retryable", async () => {
  await using app = await fixture()
  await app.client.highlightOnce(content, "typescript")
  app.client.addFiletypeParser({
    filetype: "missing-fixture",
    wasm: `${app.directory}/missing.wasm`,
    queries: { highlights: [] },
  })
  expect(app.client.getCachedHighlight(content, "typescript")).toBeUndefined()
  const failed = await app.client.highlightOnce(content, "missing-fixture")
  expect(failed.warning).toBeDefined()
  expect(app.client.getCachedHighlight(content, "missing-fixture")).toBeUndefined()
  expect(await app.client.highlightOnce(content, "missing-fixture")).toEqual(failed)
  await app.client.highlightOnce(content, "typescript")
  await app.client.clearCache()
  expect(app.client.getCachedHighlight(content, "typescript")).toBeUndefined()
})

test("custom highlight transforms do not mutate cached ranges", async () => {
  await using app = await fixture()
  const result = await app.client.highlightOnce(content, "typescript")
  const expected = structuredClone(result)
  result.highlights?.forEach((highlight) => {
    highlight[2] = "comment"
  })
  expect(app.client.getCachedHighlight(content, "typescript")).toEqual(expected)
  const code = new CodeRenderable(app.renderer, {
    content,
    filetype: "typescript",
    syntaxStyle: app.syntax,
    treeSitterClient: app.client,
    onHighlight(highlights) {
      highlights.forEach((highlight) => {
        highlight[2] = "comment"
      })
      return highlights
    },
  })
  app.renderer.root.add(code)
  await app.renderOnce()
  await code.highlightingDone
  expect(app.client.getCachedHighlight(content, "typescript")).toEqual(expected)
})

test.each(["callback", "subclass"])("cached paint does not bypass a custom chunk %s", async (kind) => {
  await using app = await fixture()
  await app.client.highlightOnce(content, "typescript")
  const pending = Promise.withResolvers<TextChunk[]>()
  class DeferredCode extends CodeRenderable {
    protected override transformChunks() {
      return pending.promise
    }
  }
  const Render = kind === "subclass" ? DeferredCode : CodeRenderable
  const code = new Render(app.renderer, {
    content,
    filetype: "typescript",
    syntaxStyle: app.syntax,
    treeSitterClient: app.client,
    fg: "#ffffff",
    onChunks: kind === "callback" ? () => pending.promise : undefined,
  })
  app.renderer.root.add(code)
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(content)
    expect(keyword(app)).toEqual(RGBA.fromHex("#ffffff"))
    pending.resolve(t`Formatted fixture`.chunks)
    await code.highlightingDone
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Formatted fixture")
    expect(app.captureCharFrame()).not.toContain(content)
  } finally {
    pending.resolve(t`Formatted fixture`.chunks)
    await code.highlightingDone
  }
})

test("an explicit initial styled value takes precedence over cached syntax", async () => {
  await using app = await fixture()
  const result = await app.client.highlightOnce(content, "typescript")
  const pending = Promise.withResolvers<typeof result>()
  app.client.highlightOnce = () => pending.promise
  const code = new CodeRenderable(app.renderer, {
    content,
    filetype: "typescript",
    syntaxStyle: app.syntax,
    treeSitterClient: app.client,
    initialStyledText: t`Prepared fixture`,
  })
  app.renderer.root.add(code)
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Prepared fixture")
    expect(app.captureCharFrame()).not.toContain(content)
  } finally {
    pending.resolve(result)
    await code.highlightingDone
  }
})

test("Solid can assign cached content before its syntax style", async () => {
  await using app = await fixture()
  await app.client.highlightOnce(content, "typescript")
  await render(
    () => (
      <code
        {...{
          treeSitterClient: app.client,
          filetype: "typescript",
          content,
          syntaxStyle: app.syntax,
        }}
      />
    ),
    app.renderer,
  )
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain(content)
  expect(keyword(app)).toEqual(RGBA.fromHex("#ff0000"))
})

test.each([false, true])("first layout uses the final conceal setting, cached=%s", async (cached) => {
  await using app = await fixture()
  if (cached) await app.client.highlightOnce("**abcd**", "markdown")
  const pending = Promise.withResolvers<Awaited<ReturnType<TreeSitterClient["highlightOnce"]>>>()
  app.client.highlightOnce = () => pending.promise
  app.resize(4, 12)
  try {
    await render(
      () => (
        <code
          {...{
            treeSitterClient: app.client,
            filetype: "markdown",
            syntaxStyle: app.syntax,
            content: "**abcd**",
            conceal: false,
            wrapMode: "char",
            width: 4,
          }}
        />
      ),
      app.renderer,
    )
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("**ab\ncd**")
    expect(app.renderer.root.getChildren()[0].height).toBe(2)
  } finally {
    pending.resolve({ highlights: [] })
  }
})

function keyword(app: Awaited<ReturnType<typeof fixture>>) {
  return app
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .find((span) => span.text.includes("const"))?.fg
}

async function fixture() {
  const directory = await tmpdir()
  const client = new TreeSitterClient({ dataPath: directory.path })
  const syntax = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" }, keyword: { fg: "#ff0000" } })
  const output = await createTestRenderer({ width: 80, height: 12, useThread: false })
  return {
    ...output,
    client,
    syntax,
    directory: directory.path,
    async [Symbol.asyncDispose]() {
      if (!output.renderer.isDestroyed) output.renderer.destroy()
      syntax.destroy()
      await client.destroy()
      await directory[Symbol.asyncDispose]()
    },
  }
}
