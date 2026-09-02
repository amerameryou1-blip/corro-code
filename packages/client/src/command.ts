export namespace Command {
  export type State = Readonly<
    { attempt: number; stage: string } & (
      | { status: "sending" | "accepted" }
      | { status: "retrying"; delay: number; error: unknown }
      | { status: "failed" | "rejected" | "cancelled"; error: unknown }
    )
  >

  export type Context = {
    signal: AbortSignal
    attempt: number
    stage(name: string): void
  }

  export type Operation<Input, Output> = {
    readonly key: string
    readonly group: string
    readonly input: Input
    readonly createdAt: number
    readonly signal: AbortSignal
    readonly state: State
    readonly accepted: Output | undefined
    readonly started: boolean
    readonly request: Promise<Output>
    retry(): Promise<Output>
    cancel(): void
    confirm(output: Output): void
    confirmFrom(load: (signal: AbortSignal) => Promise<Output>): void
  }

  export type Event<Input, Output> = { operation: Operation<Input, Output>; removed: boolean }
  export type Queue = ReturnType<typeof queue>

  export class Error extends globalThis.Error {
    constructor(
      readonly reason: "cancelled" | "failed",
      readonly key: string,
      options?: ErrorOptions,
    ) {
      super(`Command ${key} ${reason}`, options)
      this.name = "Command.Error"
    }
  }

  export function queue() {
    const tails = new Map<string, Promise<unknown>>()
    return {
      pending: (group: string) => tails.has(group),
      run<A>(group: string, fn: () => Promise<A>, options?: { wait?: Promise<unknown>; signal?: AbortSignal }) {
        const previous = tails.get(group)
        const ready = Promise.all([previous, options?.wait])
        const request = interrupt(
          ready.then(() => {
            options?.signal?.throwIfAborted()
            return fn()
          }),
          options?.signal,
        )
        // Cancellation releases this caller, but cannot release an earlier queue owner.
        const tail = Promise.allSettled([previous, request]).then(() => undefined)
        tails.set(group, tail)
        void tail.then(() => {
          if (tails.get(group) === tail) tails.delete(group)
        })
        return request
      },
    }
  }

  export function make<Input, Output>(config: {
    key: (input: Input) => string
    group: (input: Input) => string
    queue: Queue
    execute: (input: Input) => (context: Context) => Promise<Output>
    retry?: { delays: readonly number[]; when: (error: unknown) => boolean }
  }) {
    const operations = new Map<string, Operation<Input, Output>>()
    const listeners = new Set<(event: Event<Input, Output>) => void>()
    let disposed = false

    return {
      get: (key: string) => operations.get(key),
      values: (): readonly Operation<Input, Output>[] => Array.from(operations.values()),
      confirm: (key: string, output: Output) => operations.get(key)?.confirm(output),
      confirmFrom: (key: string, load: (signal: AbortSignal) => Promise<Output>) =>
        operations.get(key)?.confirmFrom(load),
      cancel: (key: string) => operations.get(key)?.cancel(),
      subscribe(listener: (event: Event<Input, Output>) => void) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      dispose() {
        disposed = true
        operations.forEach((operation) => operation.cancel())
        listeners.clear()
      },
      submit(value: Input, options?: { wait?: Promise<unknown>; prepare?: () => Promise<unknown> }) {
        if (disposed) throw new globalThis.Error("Command manager is disposed")
        const input = structuredClone(value)
        const key = config.key(input)
        const group = config.group(input)
        const existing = operations.get(key)
        if (existing) {
          if (existing.group !== group) throw new globalThis.Error(`Command ${key} belongs to another group`)
          return existing
        }

        const abort = new AbortController()
        let state: State = { status: "sending", attempt: 0, stage: "waiting" }
        let accepted: Output | undefined
        let started = false
        let retired = false
        let running = false
        let proof = false
        let preparation: Promise<unknown> | undefined
        let confirmation: Promise<void> | undefined
        let cycle = deferred<Output>()

        function notify(removed = false) {
          listeners.forEach((listener) => listener({ operation, removed }))
        }

        function update(next: State) {
          state = next
          notify()
        }

        function retire(next: State) {
          retired = true
          running = false
          state = next
          operations.delete(key)
          abort.abort()
          notify()
          notify(true)
        }

        const operation: Operation<Input, Output> = {
          key,
          group,
          input,
          createdAt: Date.now(),
          signal: abort.signal,
          get state() {
            return state
          },
          get accepted() {
            return accepted
          },
          get started() {
            return started
          },
          get request() {
            return cycle.promise
          },
          retry() {
            if (retired || running || state.status !== "failed") return cycle.promise
            cycle = deferred<Output>()
            run()
            return cycle.promise
          },
          cancel() {
            if (retired) return
            const error = new Error("cancelled", key)
            if (!running) cycle = deferred<Output>()
            cycle.reject(error)
            retire({ status: "cancelled", attempt: state.attempt, stage: state.stage, error })
          },
          confirm(output) {
            if (retired) return
            accepted = output
            if (!running) cycle = deferred<Output>()
            cycle.resolve(output)
            retire({ status: "accepted", attempt: state.attempt, stage: state.stage })
          },
          confirmFrom(load) {
            if (retired || confirmation) return
            proof = true
            confirmation = interrupt(
              Promise.resolve().then(() => {
                abort.signal.throwIfAborted()
                return load(abort.signal)
              }),
              abort.signal,
            ).then(
              (output) => {
                confirmation = undefined
                operation.confirm(output)
              },
              () => {
                // Keep proof, not a permanently failed lookup: a later echo can retry it.
                confirmation = undefined
              },
            )
          },
        }

        function run() {
          running = true
          state = { status: "sending", attempt: 0, stage: "waiting" }
          const current = cycle
          let exhausted = false
          const request = config.queue.run(
            group,
            async () => {
              update({ status: "sending", attempt: 0, stage: "prepare" })
              preparation ??= Promise.resolve().then(() => {
                abort.signal.throwIfAborted()
                return options?.prepare?.()
              })
              await interrupt(preparation, abort.signal)
              abort.signal.throwIfAborted()
              const execute = config.execute(input)
              for (let attempt = 1; ; attempt++) {
                abort.signal.throwIfAborted()
                update({ status: "sending", attempt, stage: "execute" })
                try {
                  return await interrupt(
                    Promise.resolve().then(() => {
                      abort.signal.throwIfAborted()
                      started = true
                      const result = execute({
                        signal: abort.signal,
                        attempt,
                        stage(name) {
                          if (!retired && running && cycle === current) update({ ...state, stage: name })
                        },
                      })
                      if (!retired) notify()
                      return result
                    }),
                    abort.signal,
                  )
                } catch (error) {
                  abort.signal.throwIfAborted()
                  if (confirmation) await interrupt(confirmation, abort.signal)
                  abort.signal.throwIfAborted()
                  if (!proof && !config.retry?.when(error)) throw error
                  const delay = config.retry?.delays[attempt - 1]
                  if (delay === undefined) {
                    exhausted = true
                    throw error
                  }
                  update({ status: "retrying", attempt, stage: state.stage, delay, error })
                  await pause(delay, abort.signal)
                }
              }
            },
            { wait: options?.wait, signal: abort.signal },
          )
          void request.then(
            (output) => {
              if (retired) return
              running = false
              accepted = output
              current.resolve(output)
              update({ status: "accepted", attempt: state.attempt, stage: state.stage })
            },
            (cause: unknown) => {
              if (retired) return
              running = false
              const error = exhausted || proof ? new Error("failed", key, { cause }) : cause
              current.reject(error)
              const next: State = {
                status: exhausted || proof ? "failed" : "rejected",
                attempt: state.attempt,
                stage: state.stage,
                error,
              }
              if (next.status === "rejected") return retire(next)
              update(next)
            },
          )
          notify()
        }

        operations.set(key, operation)
        run()
        return operation
      },
    }
  }

  function deferred<A>() {
    const result = Promise.withResolvers<A>()
    void result.promise.catch(() => undefined)
    return result
  }

  function interrupt<A>(promise: Promise<A>, signal?: AbortSignal): Promise<A> {
    if (!signal) return promise
    return new Promise<A>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
      void promise.then(
        (value) => {
          signal.removeEventListener("abort", abort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener("abort", abort)
          reject(error)
        },
      )
    })
  }

  function pause(delay: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort)
        resolve()
      }, delay)
      if (signal.aborted) abort()
      else signal.addEventListener("abort", abort, { once: true })
    })
  }
}
