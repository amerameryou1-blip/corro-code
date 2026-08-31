export * as ShellResult from "./result.js"

import type { Shell } from "@opencode-ai/schema/shell"

export type Result = {
  info: Shell.Info
  capture: { output: string; truncated: boolean } | undefined
  reason?: "user"
}

type Output = { output: string; truncated: boolean; exit?: number; timeout?: boolean }

const missing = "Shell command output is no longer available."
export const unavailable: Shell.Output = {
  output: missing,
  cursor: Buffer.byteLength(missing),
  size: Buffer.byteLength(missing),
  truncated: false,
}

export const stopped = "Command stopped by user. Do not restart it unless the user asks."

export function output(result: Result): Output {
  return {
    output: result.capture?.output ?? unavailable.output,
    truncated: result.capture?.truncated ?? false,
    ...(result.info.exit !== undefined ? { exit: result.info.exit } : {}),
    ...(result.info.status === "timeout" ? { timeout: true } : {}),
  }
}

export function notice(output: Pick<Output, "exit" | "timeout">) {
  if (output.timeout) return "Command timed out before completion."
  if (output.exit !== undefined) return `Command exited with code ${output.exit}.`
}

export function metadata(output: Output) {
  return {
    truncated: output.truncated,
    ...(output.exit !== undefined ? { exit: output.exit } : {}),
    ...(output.timeout !== undefined ? { timeout: output.timeout } : {}),
  }
}

export function notification(input: {
  shellID: string
  jobID?: string
  command: string
  state: "completed" | "cancelled" | "error"
  reason?: "user"
  text: string
  output?: Output
}) {
  return {
    text: `<shell id="${input.jobID ?? input.shellID}" state="${input.state}" command="${input.command}">\n${input.text}\n</shell>`,
    metadata: {
      source: "shell",
      shellID: input.shellID,
      ...(input.jobID !== undefined ? { jobID: input.jobID } : {}),
      state: input.state,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.output ? metadata(input.output) : {}),
    },
  }
}

export function userNotification(result: Result) {
  const captured = output(result)
  const status =
    result.reason === "user"
      ? stopped
      : result.info.status === "killed"
        ? "Command cancelled."
        : (notice(captured) ?? "Command exited with code unknown.")
  const message = notification({
    shellID: result.info.id,
    command: result.info.command,
    state: result.info.status === "killed" ? "cancelled" : "completed",
    reason: result.reason,
    text: `${captured.output}\n\n${status}`,
    output: captured,
  })
  return { ...message, text: `The following shell command was executed by the user:\n${message.text}` }
}
