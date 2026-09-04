import { registerCustomTheme } from "@pierre/diffs"
import { CorroTheme } from "./marked-theme"

let registered = false

export function registerCorroTheme() {
  if (registered) return
  registered = true
  registerCustomTheme("Corro", () => Promise.resolve(CorroTheme))
}
