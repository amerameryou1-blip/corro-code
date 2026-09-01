# OpenCode V2 Promise Plugin API

The Promise plugin API at `@opencode-ai/plugin` is the async/await equivalent of `@opencode-ai/plugin/effect`. It grants plugins the same two in-process capabilities:

- `hook` installs behavior at an OpenCode extension point.
- `reload` reruns every transform hook for a stateful domain.

The Promise API uses Promises instead of Effects for setup, runtime hook
callbacks, hook registration, `reload`, and `Registration.dispose`. Transform
draft callbacks remain synchronous.

## Defining A Plugin

```ts
import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "example",
  setup: async (ctx) => {
    await ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  },
})
```

Plugin setup registers hooks imperatively through each domain's `hook` method.
It may return a synchronous or asynchronous cleanup function. OpenCode awaits
the cleanup when the plugin is unloaded or replaced:

```ts
setup: async (ctx) => {
  const timer = setInterval(refresh, 60_000)
  return () => clearInterval(timer)
}
```

Configuration supplied for the plugin is available as `ctx.options`.

A registration may be removed early through `dispose`:

```ts
const registration = await ctx.catalog.transform(applyCatalog)
await registration.dispose()
```

## Transform Hooks

Transform hooks contribute to stateful domains. The draft editor is synchronous,
so load asynchronous data before registering a transform or reloading its domain:

```ts
const description = await loadReviewerDescription()

await ctx.agent.transform((agent) => {
  agent.update("reviewer", (item) => {
    item.description = description
    item.mode = "subagent"
  })
})
```

Available transform hooks are namespaced by domain:

```ts
ctx.agent.transform
ctx.catalog.transform
ctx.command.transform
ctx.integration.transform
ctx.mcp.transform
ctx.reference.transform
ctx.skill.transform
ctx.tool.transform
ctx.vcs.transform
ctx.websearch.transform
```

## Runtime Hooks

### Experimental Instructions

Register a session-aware instruction source with `ctx.experimental.instructions`.
OpenCode stores its JSON value and appends changes as authoritative system reminders,
without rewriting the existing prompt prefix. This experimental surface may change.

```ts
import { Instruction, Plugin } from "@opencode-ai/plugin"
import { Schema } from "effect"

export default Plugin.define({
  id: "example.review",
  async setup(ctx) {
    await ctx.experimental.instructions.transform((draft) => {
      draft.add({
        key: "example.review/mode",
        codec: Schema.toCodecJson(Schema.String),
        read: ({ agent }) => (agent === "reviewer" ? "Review without editing files." : Instruction.removed),
        render: {
          initial: (rule) => rule,
          changed: (_, rule) => `The review instruction is now: ${rule}`,
          removed: () => "The previous review restriction no longer applies.",
        },
      })
    })
  },
})
```

- `read` receives readonly `sessionID`, the selected `agent` ID, and the session's
  `location` (including project metadata). It runs during instruction preparation,
  not during registration, and may return a value or a Promise. Effect plugins
  return an Effect instead.
- The first value uses `initial`; changed values use `changed`; unchanged values
  add no reminder. `removed(previous)` runs only when a stored value is removed.
  A source that has never had a value emits nothing when it returns `Instruction.removed`.
- Keep keys unique and stable. Renderers must be pure functions of stored values,
  and codecs must remain compatible with historical values. Include meaningful
  revisions in the value when instruction semantics change.
- Return `Instruction.unavailable` for a temporary read failure. Failed reads or
  encoding failures have the same effect: retain the last value, or block the
  initial baseline if no baseline exists.
- `reload()` replays source-registration transforms; it does not wake a session.
  Disposal/unload unregisters sources, but is **not** a narrated withdrawal.
  Keep a source registered and return `Instruction.removed` to narrate a withdrawal.
- Sources use the existing instruction lifecycle; this surface does not change
  compaction, undo, or fork behavior.

### Live Operations

Runtime hooks intercept live operations:

```ts
await ctx.aisdk.hook("sdk", async (event) => {
  if (event.package !== "@ai-sdk/xai") return
  const mod = await import("@ai-sdk/xai")
  event.sdk = mod.createXai(event.options)
})

await ctx.aisdk.hook("language", (event) => {
  if (event.model.providerID !== "xai") return
  event.language = event.sdk.responses(event.model.modelID)
})
```

Session context is mutable immediately before provider dispatch:

```ts
await ctx.session.hook("context", (event) => {
  event.tools.read.description = "Read a file using narrow line ranges."
  delete event.tools.write
})

await ctx.session.hook("retry", (event) => {
  if (event.attempt >= 3) event.decision = { retry: false }
})
```

Promise tools use complete executable tool values with async executors:

```ts
import { Schema } from "effect"

await ctx.tool.transform((tools) => {
  tools.add({
    name: "echo",
    options: { codemode: false },
    description: "Echo text",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
    execute: async ({ text }) => ({ output: { text }, content: text }),
  })
})
```

## Reloading A Domain

When data captured by a transform changes, reload the affected domain:

```ts
let data = await loadCatalog()

await ctx.catalog.transform((catalog) => {
  applyCatalog(data, catalog)
})

data = await loadCatalog()
await ctx.catalog.reload()
```

Available reload operations are:

```ts
ctx.agent.reload()
ctx.catalog.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.mcp.reload()
ctx.reference.reload()
ctx.skill.reload()
ctx.tool.reload()
ctx.vcs.reload()
ctx.websearch.reload()
```
