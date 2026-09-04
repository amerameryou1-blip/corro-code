import type { Hooks, PluginInput } from "@opencode-ai/plugin"

// Thinking levels for Corro trial models. The GPU pool rejects native
// reasoning API params, so thinking stays prompt-side: the selected variant
// ("think" / "think-deep" in the model picker) prepends a short instruction
// to the user's message exactly once, at admission time.
export const THINK_PREFIX: Record<string, string> = {
  think: "Think briefly.\n",
  "think-deep": "Think step by step.\n",
}

export function thinkingPrefix(variant: string | undefined): string | undefined {
  if (!variant) return undefined
  return THINK_PREFIX[variant]
}

export async function CorroPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    "chat.message": async (input, output) => {
      if (input.model?.providerID !== "corro") return
      const prefix = thinkingPrefix(input.variant)
      if (!prefix) return
      if (output.message.role !== "user") return
      for (const part of output.parts) {
        if (part.type === "text" && !part.synthetic && !part.ignored) {
          part.text = prefix + part.text
          return
        }
      }
    },
  }
}
