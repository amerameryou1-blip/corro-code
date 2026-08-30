import { expect, test } from "bun:test"
import {
  CodeRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  TextRenderable,
  type MarkdownOptions,
  type RenderNodeContext,
} from "@opentui/core"
import { createTestRenderer, MockTreeSitterClient } from "@opentui/core/testing"
import { combineMarkdownRenderers } from "../src/plugin/context"

const code = (language: string) => ({ type: "code" as const, lang: language, text: "content", raw: "" })
const context: RenderNodeContext = {
  syntaxStyle: SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }),
  conceal: false,
  concealCode: false,
  defaultRender: () => null,
}

test("dispatches Markdown code blocks by normalized language", async () => {
  const { renderer } = await createTestRenderer({ width: 20, height: 4 })
  const expected = new TextRenderable(renderer, { content: "expected" })
  const render = (() => expected) satisfies NonNullable<MarkdownOptions["renderNode"]>
  const combined = combineMarkdownRenderers([{ mermaid: render }])!

  expect(combined(code("mermaid title=example"), context)).toBe(expected)
  expect(combined(code("typescript"), context)).toBeUndefined()
  renderer.destroy()
})

test("later Markdown renderer registrations take precedence", async () => {
  const { renderer } = await createTestRenderer({ width: 20, height: 4 })
  const first = new TextRenderable(renderer, { content: "first" })
  const second = new TextRenderable(renderer, { content: "second" })
  const combined = combineMarkdownRenderers([{ mermaid: () => first }, { mermaid: () => second }])!

  expect(combined(code("mermaid"), context)).toBe(second)
  expect(combineMarkdownRenderers([])).toBeFunction()
  renderer.destroy()
})

test.each(["returned", "declined"])("reuses a plugin's %s default code block", async (fallback) => {
  const output = await createTestRenderer({ width: 80, height: 10 })
  const defaults: Array<ReturnType<RenderNodeContext["defaultRender"]>> = []
  const markdown = new MarkdownRenderable(output.renderer, {
    content: "```typescript\nconst fixture = 42\n```",
    syntaxStyle: context.syntaxStyle,
    renderNode: combineMarkdownRenderers([
      {
        typescript: (_token, context) => {
          defaults.push(context.defaultRender())
          return fallback === "returned" ? defaults.at(-1) : undefined
        },
      },
    ]),
  })
  output.renderer.root.add(markdown)
  try {
    const code = markdown.getChildren()[0]
    expect(defaults).toHaveLength(1)
    expect(defaults[0]).toBe(code)
    if (!(code instanceof CodeRenderable)) throw new Error("Expected fenced code")
    expect(code.drawUnstyledText).toBe(false)
    await output.renderOnce()
    await code.highlightingDone
    await output.renderOnce()
    expect(output.captureCharFrame()).toContain("const fixture = 42")
  } finally {
    output.renderer.destroy()
  }
  expect(defaults[0]?.isDestroyed).toBe(true)
})

test.each(["typescript", "text", "unknown-fixture-language", ""])(
  "renders %s fences without losing content",
  async (language) => {
    const output = await createTestRenderer({ width: 80, height: 10 })
    const markdown = new MarkdownRenderable(output.renderer, {
      content: `\`\`\`${language}\nconst fixture = 42\n\`\`\``,
      syntaxStyle: context.syntaxStyle,
      renderNode: combineMarkdownRenderers([]),
    })
    output.renderer.root.add(markdown)
    try {
      await output.renderOnce()
      const code = markdown.getChildren()[0]
      expect(code).toBeInstanceOf(CodeRenderable)
      if (!(code instanceof CodeRenderable)) throw new Error("Expected fenced code")
      await code.highlightingDone
      await output.renderOnce()
      expect(output.captureCharFrame()).toContain("const fixture = 42")
    } finally {
      output.renderer.destroy()
    }
  },
)

test("keeps the fenced code node while streaming", async () => {
  const output = await createTestRenderer({ width: 80, height: 10 })
  const markdown = new MarkdownRenderable(output.renderer, {
    content: "```typescript\nconst fixture = 4",
    internalBlockMode: "top-level",
    streaming: true,
    syntaxStyle: context.syntaxStyle,
    renderNode: combineMarkdownRenderers([]),
  })
  output.renderer.root.add(markdown)
  try {
    await output.renderOnce()
    const code = markdown.getChildren()[0]
    if (!(code instanceof CodeRenderable)) throw new Error("Expected fenced code")
    await code.highlightingDone
    markdown.content = "```typescript\nconst fixture = 42"
    await output.renderOnce()
    expect(markdown.getChildren()[0] === code).toBe(true)
    await code.highlightingDone
    await output.renderOnce()
    expect(output.captureCharFrame()).toContain("const fixture = 42")
    markdown.content += "\n```"
    markdown.streaming = false
    await output.renderOnce()
    const completed = markdown.getChildren()[0]
    if (!(completed instanceof CodeRenderable)) throw new Error("Expected completed fenced code")
    await completed.highlightingDone
    await output.renderOnce()
    expect(output.captureCharFrame()).toContain("const fixture = 42")
  } finally {
    output.renderer.destroy()
  }
})

test.each(["error", "rejection"])(
  "reserves code layout and shows a readable fallback on parser %s",
  async (failure) => {
    const output = await createTestRenderer({ width: 80, height: 10 })
    const pending = Promise.withResolvers<{ error: string }>()
    const client = new MockTreeSitterClient()
    client.highlightOnce = () => pending.promise
    const markdown = new MarkdownRenderable(output.renderer, {
      content: "```typescript\nconst fixture = 42\n```",
      syntaxStyle: context.syntaxStyle,
      treeSitterClient: client,
      renderNode: combineMarkdownRenderers([]),
    })
    output.renderer.root.add(markdown)
    try {
      await output.renderOnce()
      const code = markdown.getChildren()[0]
      if (!(code instanceof CodeRenderable)) throw new Error("Expected fenced code")
      expect(code.isHighlighting).toBe(true)
      const height = code.height
      expect(height).toBeGreaterThan(0)
      expect(output.captureCharFrame()).not.toContain("const fixture")
      if (failure === "error") pending.resolve({ error: "Parser unavailable" })
      if (failure === "rejection") pending.reject(new Error("Worker unavailable"))
      await code.highlightingDone
      await output.renderOnce()
      expect(output.captureCharFrame()).toContain("const fixture = 42")
      expect(code.height).toBe(height)
    } finally {
      pending.resolve({ error: "Parser unavailable" })
      output.renderer.destroy()
      await client.destroy()
    }
  },
)
