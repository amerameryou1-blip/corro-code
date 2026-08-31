export * as SubagentCompletion from "./subagent-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"

export const STOPPED_BY_USER = "Subagent stopped by user. Do not restart it unless the user asks."

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "status" | "output" | "error" | "notificationID" | "reason"> & {
    recovery: Extract<Job.Recovery, { kind: "subagent" }>
    resume?: boolean
  },
) {
  if (input.status === "running") return
  const recovery = input.recovery
  const text =
    input.status === "completed"
      ? (input.output ?? "Subagent completed without a text response.")
      : input.status === "error"
        ? (input.error ?? "Subagent failed")
        : input.reason === "user"
          ? STOPPED_BY_USER
          : "Subagent cancelled"
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: recovery.parentSessionID,
    ...(input.resume === false || input.reason === "user" ? { resume: false } : {}),
    description: recovery.description,
    text: `<subagent sessionID="${recovery.childSessionID}" state="${input.status}" description="${recovery.description}">\n${text}\n</subagent>`,
    metadata: {
      source: "subagent",
      childID: recovery.childSessionID,
      agent: recovery.agent,
      state: input.status,
      ...(input.reason === "user" ? { reason: "user" } : {}),
    },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
