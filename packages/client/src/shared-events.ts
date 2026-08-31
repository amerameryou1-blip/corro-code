export * as SharedEvents from "./shared-events.js"

export function make<A extends { readonly type: string }>(connect: (signal: AbortSignal) => AsyncIterable<A>) {
  type Completion = { readonly error: unknown } | Record<string, never>
  type Subscriber = {
    push: (value: A) => Promise<void>
    finish: (completion: Completion) => void
  }
  type Connection = {
    controller: AbortController
    subscribers: Set<Subscriber>
    connected?: A
  }

  let current: Connection | undefined
  const delivered = Promise.resolve()

  function stop(connection: Connection) {
    connection.connected = undefined
    connection.controller.abort()
    if (current === connection) current = undefined
  }

  async function run(connection: Connection) {
    let iterator: AsyncIterator<A> | undefined
    let completion: Completion = {}
    try {
      if (connection.controller.signal.aborted) return
      iterator = connect(connection.controller.signal)[Symbol.asyncIterator]()
      while (!connection.controller.signal.aborted) {
        const item = await iterator.next()
        if (item.done || connection.controller.signal.aborted) break
        if (item.value.type === "server.connected") connection.connected = item.value
        await Promise.all(Array.from(connection.subscribers, (subscriber) => subscriber.push(item.value)))
      }
    } catch (error) {
      completion = { error }
    } finally {
      stop(connection)
      try {
        await iterator?.return?.()
      } catch (error) {
        if (!("error" in completion)) completion = { error }
      }
      connection.subscribers.forEach((subscriber) => subscriber.finish(completion))
    }
  }

  return {
    subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<A> {
      return {
        [Symbol.asyncIterator]() {
          const pending: ReturnType<typeof Promise.withResolvers<IteratorResult<A>>>[] = []
          let started = false
          let completion: Completion | undefined
          let connection: Connection | undefined
          const queued: A[] = []

          function finish(result: Completion, discard = false) {
            completion = result
            if (discard) queued.length = 0
            options?.signal?.removeEventListener("abort", abort)
            if (connection?.subscribers.delete(subscriber) && !connection.subscribers.size) stop(connection)
            if (queued.length) return
            pending.splice(0).forEach((request) => {
              if ("error" in result) request.reject(result.error)
              else request.resolve({ done: true, value: undefined })
            })
          }

          function abort() {
            finish({}, true)
          }

          const subscriber: Subscriber = {
            finish,
            push(value) {
              if (completion) return delivered
              const request = pending.shift()
              if (request) {
                request.resolve({ done: false, value })
                return delivered
              }
              queued.push(value)
              return delivered
            },
          }

          function start() {
            if (completion) return
            const fresh = !current
            connection = current ?? {
              controller: new AbortController(),
              subscribers: new Set<Subscriber>(),
            }
            current = connection
            connection.subscribers.add(subscriber)
            if (connection.connected) void subscriber.push(connection.connected)
            if (fresh) void run(connection)
          }

          return {
            next(): Promise<IteratorResult<A>> {
              const value = queued.shift()
              if (value) return Promise.resolve({ done: false, value })
              if (completion) {
                if ("error" in completion) return Promise.reject(completion.error)
                return Promise.resolve({ done: true, value: undefined })
              }
              if (options?.signal?.aborted) {
                abort()
                return Promise.resolve({ done: true, value: undefined })
              }
              const request = Promise.withResolvers<IteratorResult<A>>()
              pending.push(request)
              if (!started) {
                started = true
                options?.signal?.addEventListener("abort", abort, { once: true })
                start()
              }
              return request.promise
            },
            return(): Promise<IteratorResult<A>> {
              finish({}, true)
              return Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }
    },
  }
}
