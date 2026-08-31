import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Namespace, Tool } from "../src/index.js"

const echo = (name: string, description: string, result: string) =>
  Tool.make({
    name,
    description,
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed(result),
  })

const value = async (runtime: CodeMode.Runtime, code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

const failure = async (runtime: CodeMode.Runtime, code: string) => {
  const result = await Effect.runPromise(runtime.execute(code))
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

describe("nested namespaces", () => {
  const runtime = CodeMode.make({
    tools: [
      Namespace.make({
        name: "api",
        tools: [
          Namespace.make({
            name: "issues",
            tools: [echo("list", "List issues", "listed")],
          }),
        ],
      }),
    ],
  })

  test("nested namespaces appear in the catalog", () => {
    const catalog = runtime.catalog()
    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.path).toBe("api.issues.list")
    expect(catalog[0]?.signature).toStartWith("tools.api.issues.list(input:")
  })

  test("the advertised path is executable", async () => {
    expect(await value(runtime, `return await tools.api.issues.list({})`)).toBe("listed")
  })

  test("intermediate segments enumerate like ordinary namespaces", async () => {
    expect(await value(runtime, `return [Object.keys(tools.api), Object.keys(tools.api.issues)]`)).toEqual([
      ["issues"],
      ["list"],
    ])
  })

  test("search scopes to a nested namespace subtree", async () => {
    const nested = CodeMode.make({
      tools: [
        Namespace.make({
          name: "slack",
          tools: [
            echo("admin", "Admin", "admin"),
            echo("read", "Read Slack", "read"),
            Namespace.make({
              name: "administrator",
              tools: [echo("list", "List administrators", "administrators")],
            }),
          ],
        }),
      ],
    })

    const result = await value(nested, `return search({ query: "", namespace: "slack" })`)
    expect((result as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual([
      "tools.slack.admin",
      "tools.slack.administrator.list",
      "tools.slack.read",
    ])
  })
})

describe("namespaces are not callable", () => {
  const runtime = CodeMode.make({
    tools: [Namespace.make({ name: "issues", tools: [echo("list", "List issues", "list")] })],
  })

  test("a namespace enumerates its children", async () => {
    expect(await value(runtime, `return Object.keys(tools.issues)`)).toEqual(["list"])
  })

  test("search returns executable child paths", async () => {
    const result = await value(runtime, `return search({ query: "", namespace: "issues" })`)
    expect((result as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual(["tools.issues.list"])
    const exact = await value(runtime, `return search({ query: "tools.issues.list" })`)
    expect((exact as { items: Array<{ path: string }> }).items.map((item) => item.path)).toEqual(["tools.issues.list"])
  })

  test("an unknown child under a namespace is an UnknownTool error", async () => {
    const diagnostic = await failure(runtime, `return await tools.issues.missing({})`)
    expect(diagnostic.kind).toBe("UnknownTool")
    expect(diagnostic.message).toContain("Unknown tool 'issues.missing'")
    expect(diagnostic.suggestions).toEqual([
      "The tool may have been removed or renamed. Use search to find available tools.",
    ])
  })

  test("a namespace without its own tool stays non-callable", async () => {
    const diagnostic = await failure(runtime, `return await tools.issues({})`)
    expect(diagnostic.kind).toBe("UnknownTool")
    expect(diagnostic.message).toContain("Tool 'issues' is not callable")
  })
})

describe("tool input diagnostics", () => {
  const runtime = CodeMode.make({
    tools: [
      Namespace.make({
        name: "notes",
        tools: [
          Tool.make({
            name: "echo",
            description: "Echo text",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.String,
            execute: ({ text }) => Effect.succeed(text),
          }),
        ],
      }),
    ],
  })

  test("a schema mismatch suggests searching for the current signature", async () => {
    const diagnostic = await failure(runtime, `return await tools.notes.echo({ message: "hello" })`)
    expect(diagnostic.kind).toBe("InvalidToolInput")
    expect(diagnostic.suggestions).toEqual(["The signature may have changed. Use search to get the current signature."])
  })

  test("a wrong argument count keeps the existing error without a stale-signature hint", async () => {
    const diagnostic = await failure(runtime, `return await tools.notes.echo()`)
    expect(diagnostic.kind).toBe("InvalidToolInput")
    expect(diagnostic.suggestions).toBeUndefined()
  })
})

describe("blocked member names on tool paths", () => {
  const runtime = CodeMode.make({
    tools: [
      echo("prototype", "Prototype tool", "proto"),
      Namespace.make({
        name: "issues",
        tools: [echo("constructor", "Constructor tool", "ctor")],
      }),
      Namespace.make({
        name: "nested",
        tools: [echo("__proto__", "Proto tool", "dunder")],
      }),
    ],
  })

  test("tools may use blocked member names because path segments never touch real properties", async () => {
    expect(runtime.catalog().map((tool) => tool.path)).toEqual(["issues.constructor", "nested.__proto__", "prototype"])
    expect(await value(runtime, `return await tools.prototype({})`)).toBe("proto")
    expect(await value(runtime, `return await tools.issues.constructor({})`)).toBe("ctor")
    expect(await value(runtime, `return await tools.nested.__proto__({})`)).toBe("dunder")
    expect(await value(runtime, `return Object.keys(tools.issues)`)).toEqual(["constructor"])
  })

  test("blocked member access on data values stays blocked", async () => {
    const diagnostic = await failure(runtime, `const x = {}; return x.constructor`)
    expect(diagnostic.message).toContain("constructor")
    expect(Object.keys(Object.prototype)).toEqual([])
  })
})

describe("namespace descriptions", () => {
  const tools = [
    Namespace.make({
      name: "api",
      description: "Workspace",
      tools: [
        echo("admin", "Admin tool", "admin"),
        echo("read", "Read data", "read"),
        Namespace.make({
          name: "users",
          description: "Directory",
          tools: [echo("list", "List users", "users")],
        }),
        Namespace.make({
          name: "invite",
          tools: [echo("send", "Invite user", "invite")],
        }),
      ],
    }),
    Namespace.make({
      name: "other",
      tools: [echo("read", "Read other", "other")],
    }),
  ]
  const runtime = CodeMode.make({ tools })

  test("namespaces with descendant tools are returned in canonical path order", () => {
    const descriptions: ReadonlyArray<CodeMode.NamespaceDescription> = runtime.namespaces()
    expect(descriptions).toEqual([
      { path: "api", description: "Workspace" },
      { path: "api.invite" },
      { path: "api.users", description: "Directory" },
      { path: "other" },
    ])
    expect(CodeMode.make({ tools: [] }).namespaces()).toEqual([])
  })

  test.each(["make", "execute"] as const)(
    "%s searches ancestor descriptions without changing result descriptors",
    async (mode) => {
      for (const [query, scope, paths] of [
        ["Workspace", undefined, ["api.admin", "api.invite.send", "api.read", "api.users.list"]],
        ["Directory", undefined, ["api.users.list"]],
        ["Workspace", "api.users", ["api.users.list"]],
        ["Directory", "api.invite", []],
      ] as const) {
        const code = `return search(${JSON.stringify({ query, namespace: scope })})`
        const result = await Effect.runPromise(
          mode === "make" ? runtime.execute(code) : CodeMode.execute({ tools, code }),
        )
        expect(result).toEqual({
          ok: true,
          value: {
            items: paths.map((path) => ({
              ...runtime.catalog().find((tool) => tool.path === path),
              path: `tools.${path}`,
            })),
            remaining: 0,
            next: null,
          },
          toolCalls: [{ name: "search" }],
        })
      }
    },
  )

  test("namespaces preserve tool descriptions, enumeration, and callability", async () => {
    expect(await value(runtime, `return Object.keys(tools)`)).toEqual(["api", "other"])
    expect(await value(runtime, `return Object.keys(tools.api)`)).toEqual(["admin", "read", "users", "invite"])
    expect(await value(runtime, `return await tools.api.admin({})`)).toBe("admin")
    expect(await value(runtime, `return await tools.api.users.list({})`)).toBe("users")
    expect((await failure(runtime, `return await tools.api.users({})`)).message).toContain("is not callable")
    expect((await failure(runtime, `return await tools.missing({})`)).message).toContain("Unknown tool 'missing'")
  })

  test.each(["with-hyphen", "with space", "constructor", "prototype", "__proto__"])(
    "namespace names allow %s just like tool names",
    async (name) => {
      const runtime = CodeMode.make({
        tools: [
          Namespace.make({
            name,
            description: "Collection",
            tools: [echo("read", "Read", "read")],
          }),
        ],
      })
      expect(runtime.namespaces()).toEqual([{ path: name, description: "Collection" }])
      expect(await value(runtime, `return await tools[${JSON.stringify(name)}].read({})`)).toBe("read")
    },
  )
})

describe("invalid names", () => {
  test("empty names are rejected at make", () => {
    expect(() => CodeMode.make({ tools: [echo("", "Bad", "bad")] })).toThrow("Name cannot be empty.")
    expect(() =>
      CodeMode.make({ tools: [Namespace.make({ name: "", tools: [echo("read", "Read", "read")] })] }),
    ).toThrow("Name cannot be empty.")
  })

  test("names containing '.' are rejected at make and execute", () => {
    expect(() => CodeMode.make({ tools: [echo("issues.list", "Bad", "bad")] })).toThrow("cannot contain '.'")
    expect(() =>
      CodeMode.execute({
        tools: [Namespace.make({ name: "api.admin", tools: [echo("read", "Read", "read")] })],
        code: "return 1",
      }),
    ).toThrow("cannot contain '.'")
  })
})

describe("duplicate names", () => {
  test("duplicate tools at the same level are rejected", () => {
    expect(() =>
      CodeMode.make({
        tools: [echo("list", "First", "first"), echo("list", "Second", "second")],
      }),
    ).toThrow("Duplicate tool path 'list'")
  })

  test("a tool and namespace cannot share a name", () => {
    expect(() =>
      CodeMode.make({
        tools: [
          echo("issues", "All issues", "all"),
          Namespace.make({ name: "issues", tools: [echo("list", "List", "list")] }),
        ],
      }),
    ).toThrow("Duplicate tool path 'issues'")
  })
})
