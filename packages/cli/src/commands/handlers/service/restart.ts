import { EOL } from "os"
import { Effect } from "effect"
import { Service } from "@opencode-ai/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  Commands.commands.service.commands.restart,
  Effect.fn("cli.service.restart")(function* (input) {
    const options = yield* ServiceConfig.options()
    if (!input.preserveTerminals) yield* ServerConnection.shutdownPersistentPty(options).pipe(Effect.ignore)
    yield* Service.stop({ file: options.file, pty: input.preserveTerminals ? "handoff" : "clear" })
    const transport = yield* Service.ensure(options)
    process.stdout.write(transport.url + EOL)
  }),
)
